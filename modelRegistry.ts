import { createRequire } from 'module'
const require = typeof __filename !== 'undefined' ? createRequire(__filename) : createRequire(import.meta.url)

// ─────────────────────────────────────────────────────────────────────────────
// modelRegistry.ts
// Dynamic model selection for Crucible pipeline.
// No provider, model, or role is hardcoded — everything is weighted at runtime.
// ─────────────────────────────────────────────────────────────────────────────

export type PromptType =
  | 'coding'
  | 'reasoning'
  | 'creative'
  | 'factual'
  | 'math'
  | 'general'

export interface ModelEntry {
  id: string
  label: string
  quality: number                  // 1–10 baseline quality
  fit: Record<PromptType, number>  // 1–10 per prompt type
  free: boolean
  provider: 'groq' | 'mistral' | 'openrouter' | 'gemini' | 'huggingface' | 'cloudflare'
  speed: 'fast' | 'standard'      // fast = Groq dedicated inference
  params: number                   // parameter count in billions
  /** Reliable native function-calling — eligible to DRIVE the agent loop. */
  tools?: boolean
}

// ── Driver tier (orchestrator/worker split) ──────────────────────────────────
// The driver is the best available instruction-follower with native tool-calling;
// the cheap ensemble stays the worker tier (exposed to the driver as ensemble_solve).
export function selectDriverCandidates(): ModelEntry[] {
  return MODEL_REGISTRY
    .filter(m => m.tools && m.free && getCircuitState(m.id) !== 'tripped')
    .sort((a, b) =>
      (b.quality - a.quality) ||
      ((b.speed === 'fast' ? 1 : 0) - (a.speed === 'fast' ? 1 : 0)) ||
      (b.params - a.params))
}

// ── Pipeline configuration ────────────────────────────────────────────────────
export interface PipelineConfig {
  parallelCount: number   // how many models to run in parallel (min 2, recommended 3–5)
  wildcardCount: number   // how many of those slots are weighted-random wildcards
}

export const PIPELINE_CONFIG: PipelineConfig = {
  parallelCount: 3,
  wildcardCount: 1,
}

export const SIMPLE_PIPELINE_CONFIG: PipelineConfig = {
  parallelCount: 2,
  wildcardCount: 1,
}

// ── Blocked models (e.g. temporarily rate-limited) ───────────────────────────
export const BLOCKED_MODELS: Set<string> = new Set()

// ── Rate limit tracker ───────────────────────────────────────────────────────
// Tracks recent request counts per provider to penalise approaching-limit models.
// Penalty is applied as a multiplier to the selection score, not a hard block.

interface ProviderUsage {
  count: number
  windowStart: number  // ms timestamp
}

const USAGE_WINDOW_MS   = 60_000  // 1-minute rolling window
const PROVIDER_SOFT_CAP: Record<string, number> = {
  groq:       25,   // penalise above this per minute
  mistral:    20,
  openrouter: 40,
  gemini:     15,
}

const providerUsage: Record<string, ProviderUsage> = {}

export function recordProviderCall(provider: string): void {
  const now = Date.now()
  const u = providerUsage[provider]
  if (!u || now - u.windowStart > USAGE_WINDOW_MS) {
    providerUsage[provider] = { count: 1, windowStart: now }
  } else {
    u.count++
  }
}

function rateLimitPenalty(provider: string): number {
  const u = providerUsage[provider]
  if (!u) return 1.0
  const now = Date.now()
  if (now - u.windowStart > USAGE_WINDOW_MS) return 1.0
  const cap = PROVIDER_SOFT_CAP[provider] ?? 20
  if (u.count < cap * 0.7) return 1.0          // under 70% of cap: no penalty
  if (u.count < cap)       return 0.6          // 70–100% of cap: moderate penalty
  return 0.1                                    // over cap: heavy penalty (near-blocked)
}


// ── Circuit Breaker ───────────────────────────────────────────────────────────
type CircuitState = 'active' | 'tripped' | 'probing'

interface CircuitBreakerEntry {
  state: CircuitState
  trippedAt: number
  cooldownMs: number
  failReason: string
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000      // 5 min default
const MAX_COOLDOWN_MS     = 6 * 60 * 60 * 1000 // 6 hour cap
const MIN_COOLDOWN_MS     = 60 * 1000           // 1 min floor

export const circuitBreakers: Record<string, CircuitBreakerEntry> = {}

export function tripCircuitBreaker(modelId: string, cooldownMs?: number, reason = 'quota'): void {
  const ms = Math.min(Math.max(cooldownMs ?? DEFAULT_COOLDOWN_MS, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS)
  circuitBreakers[modelId] = { state: 'tripped', trippedAt: Date.now(), cooldownMs: ms, failReason: reason }
  console.log(`[Circuit] ${modelId} tripped — cooldown ${Math.round(ms/1000)}s (${reason})`)
}

export function getCircuitState(modelId: string): CircuitState {
  const cb = circuitBreakers[modelId]
  if (!cb) return 'active'
  if (cb.state === 'tripped') {
    if (Date.now() - cb.trippedAt >= cb.cooldownMs) {
      circuitBreakers[modelId].state = 'probing'
      console.log(`[Circuit] ${modelId} cooldown expired — entering probing state`)
      return 'probing'
    }
    return 'tripped'
  }
  return cb.state
}

export function resetCircuitBreaker(modelId: string): void {
  delete circuitBreakers[modelId]
  console.log(`[Circuit] ${modelId} restored to active`)
}

const PROVIDER_FALLBACK_COOLDOWN_MS: Record<string, number> = {
  gemini:      23 * 60 * 60 * 1000, // 23h — daily quota
  groq:        60 * 1000,           // 60s — per-minute burst
  openrouter:  5 * 60 * 1000,       // 5min — varies
  mistral:     5 * 60 * 1000,       // 5min
}

export function parseRetryDelay(errorMessage: string, provider?: string): number | undefined {
  // Parse "retry in Xs" or "Retry-After: X" from error messages
  const secMatch = errorMessage.match(/retry(?:\s+in)?[:\s]+(\d+(?:\.\d+)?)\s*s/i)
  if (secMatch) return Math.ceil(parseFloat(secMatch[1])) * 1000
  const minMatch = errorMessage.match(/retry(?:\s+in)?[:\s]+(\d+(?:\.\d+)?)\s*min/i)
  if (minMatch) return Math.ceil(parseFloat(minMatch[1])) * 60 * 1000
  // No retry header — use provider-aware fallback
  if (provider) {
    const key = Object.keys(PROVIDER_FALLBACK_COOLDOWN_MS).find(k => provider.toLowerCase().includes(k))
    if (key) return PROVIDER_FALLBACK_COOLDOWN_MS[key]
  }
  return undefined
}

// ── Model failure tracking ───────────────────────────────────────────────────
const MODEL_FAILURE_DECAY_MS = 15 * 60 * 1000  // 15 minutes full decay
const modelFailures: Record<string, { count: number; lastFailure: number }> = {}

export function recordModelFailure(modelId: string): void {
  const now = Date.now()
  const f = modelFailures[modelId]
  if (!f || now - f.lastFailure > MODEL_FAILURE_DECAY_MS) {
    modelFailures[modelId] = { count: 1, lastFailure: now }
  } else {
    modelFailures[modelId] = { count: f.count + 1, lastFailure: now }
  }
}

function modelFailurePenalty(modelId: string): number {
  const f = modelFailures[modelId]
  if (!f) return 1.0
  const now = Date.now()
  const age = now - f.lastFailure
  if (age > MODEL_FAILURE_DECAY_MS) return 1.0          // fully decayed
  const decayFactor = 1 - (age / MODEL_FAILURE_DECAY_MS) // 1.0 fresh → 0.0 decayed
  if (f.count >= 3) return 1.0 - (0.9 * decayFactor)   // 3+ failures: up to 90% penalty
  if (f.count === 2) return 1.0 - (0.6 * decayFactor)  // 2 failures: up to 60% penalty
  return 1.0 - (0.3 * decayFactor)                      // 1 failure: up to 30% penalty
}

// ── Model registry ────────────────────────────────────────────────────────────
// Add or remove models here freely. No other file needs to change.

export const MODEL_REGISTRY: ModelEntry[] = [
  // ── Groq ────────────────────────────────────────────────────────────────────
  {
    id: 'groq/llama-3.3-70b-versatile',
    tools: true,
    params: 70,
    free: true,
    label: 'Llama 3.3 70B',
    quality: 8,
    provider: 'groq',
    speed: 'fast',
    fit: { coding: 7, reasoning: 8, creative: 7, factual: 8, math: 7, general: 8 },
  },
  {
    id: 'groq/qwen/qwen3-32b',
    tools: true,
    params: 32,
    free: true,
    label: 'Qwen3 32B',
    quality: 8,
    provider: 'groq',
    speed: 'fast',
    fit: { coding: 9, reasoning: 9, creative: 6, factual: 8, math: 9, general: 8 },
  },
  {
    id: 'groq/llama-3.1-8b-instant',
    tools: true,
    params: 8,
    free: true,
    label: 'Llama 3.1 8B',
    quality: 6,
    provider: 'groq',
    speed: 'fast',
    fit: { coding: 6, reasoning: 6, creative: 6, factual: 6, math: 5, general: 6 },
  },
  {
    id: 'groq/llama-3.2-11b-text-preview',
    params: 11,
    free: true,
    label: 'Llama 3.2 11B',
    quality: 6,
    provider: 'groq',
    speed: 'fast',
    fit: { coding: 6, reasoning: 6, creative: 7, factual: 6, math: 5, general: 6 },
  },
  // ── Mistral ──────────────────────────────────────────────────────────────────
  {
    id: 'mistral/mistral-small-latest',
    tools: true,
    params: 22,
    free: true,
    label: 'Mistral Small',
    quality: 7,
    provider: 'mistral',
    speed: 'standard',
    fit: { coding: 7, reasoning: 7, creative: 8, factual: 7, math: 6, general: 7 },
  },
  // ── OpenRouter (free tier only) ─────────────────────────────────────────────
  {
    id: 'openrouter/openai/gpt-oss-120b:free',
    tools: true,
    params: 120,
    label: 'GPT OSS 120B',
    free: true,
    quality: 9,
    provider: 'openrouter',
    speed: 'standard',
    fit: { coding: 9, reasoning: 9, creative: 8, factual: 9, math: 9, general: 9 },
  },
  {
    id: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
    params: 120,
    label: 'Nemotron 3 Super',
    free: true,
    quality: 9,
    provider: 'openrouter',
    speed: 'standard',
    fit: { coding: 9, reasoning: 9, creative: 7, factual: 8, math: 9, general: 8 },
  },
  {
    id: 'openrouter/google/gemma-4-31b-it:free',
    params: 31,
    label: 'Gemma 4 31B',
    free: true,
    quality: 8,
    provider: 'openrouter',
    speed: 'standard',
    fit: { coding: 8, reasoning: 8, creative: 8, factual: 8, math: 7, general: 8 },
  },
  {
    id: 'openrouter/openai/gpt-oss-20b:free',
    tools: true,
    params: 20,
    label: 'GPT OSS 20B',
    free: true,
    quality: 7,
    provider: 'openrouter',
    speed: 'standard',
    fit: { coding: 8, reasoning: 7, creative: 7, factual: 7, math: 7, general: 7 },
  },
  {
    id: 'openrouter/openrouter/owl-alpha',
    params: 8,
    label: 'Owl Alpha',
    free: true,
    quality: 8,
    provider: 'openrouter',
    speed: 'standard',
    fit: { coding: 8, reasoning: 8, creative: 7, factual: 8, math: 7, general: 8 },
  },
  // ── HuggingFace (via Novita router) ────────────────────────────────────────
  {
    id: 'huggingface/meta-llama/llama-3.1-8b-instruct',
    params: 8, free: true, label: 'Llama 3.1 8B (HF)', quality: 6, provider: 'huggingface', speed: 'fast',
    fit: { coding: 6, reasoning: 6, creative: 6, factual: 6, math: 5, general: 6 },
  },
  {
    id: 'huggingface/meta-llama/llama-3.1-70b-instruct',
    params: 70, free: true, label: 'Llama 3.1 70B (HF)', quality: 8, provider: 'huggingface', speed: 'standard',
    fit: { coding: 7, reasoning: 8, creative: 7, factual: 8, math: 7, general: 8 },
  },
  {
    id: 'huggingface/qwen/qwen2.5-72b-instruct',
    params: 72, free: true, label: 'Qwen 2.5 72B (HF)', quality: 8, provider: 'huggingface', speed: 'standard',
    fit: { coding: 9, reasoning: 8, creative: 7, factual: 8, math: 9, general: 8 },
  },
  // ── Cloudflare Workers AI ────────────────────────────────────────────────────
  {
    id: 'cloudflare/@cf/meta/llama-3.1-8b-instruct',
    params: 8, free: true, label: 'Llama 3.1 8B (CF)', quality: 6, provider: 'cloudflare', speed: 'fast',
    fit: { coding: 6, reasoning: 6, creative: 6, factual: 6, math: 5, general: 6 },
  },
  {
    id: 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    params: 70, free: true, label: 'Llama 3.3 70B (CF)', quality: 8, provider: 'cloudflare', speed: 'standard',
    fit: { coding: 8, reasoning: 8, creative: 7, factual: 8, math: 7, general: 8 },
  },
  {
    id: 'cloudflare/@cf/mistral/mistral-7b-instruct-v0.1',
    params: 7, free: true, label: 'Mistral 7B (CF)', quality: 6, provider: 'cloudflare', speed: 'fast',
    fit: { coding: 6, reasoning: 6, creative: 7, factual: 6, math: 5, general: 6 },
  },
  {
    id: 'cloudflare/@cf/qwen/qwen2.5-coder-32b-instruct',
    params: 32, free: true, label: 'Qwen 2.5 Coder 32B (CF)', quality: 8, provider: 'cloudflare', speed: 'standard',
    fit: { coding: 9, reasoning: 8, creative: 6, factual: 7, math: 8, general: 7 },
  },
  // ── Gemini ───────────────────────────────────────────────────────────────────
  {
    id: 'gemini/gemini-2.0-flash',
    params: 8,
    label: 'Gemini 2.0 Flash',
    free: true,
    quality: 8,
    provider: 'gemini',
    speed: 'standard',
    fit: { coding: 8, reasoning: 8, creative: 8, factual: 9, math: 8, general: 8 },
  },
]

// ── Registry lookup ─────────────────────────────────────────────────────────
export function getModelEntry(id: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find(m => m.id === id)
}

// ── Prompt classifier ────────────────────────────────────────────────────────

const CODING_KEYWORDS    = /\b(code|function|class|implement|debug|refactor|typescript|javascript|python|rust|sql|api|algorithm|bug|error|compile|syntax)\b/i
const MATH_KEYWORDS      = /\b(calculate|equation|integral|derivative|matrix|probability|statistics|proof|theorem|algebra|geometry|calculus)\b/i
const REASONING_KEYWORDS = /\b(analyse|analyze|reason|logic|argument|fallacy|compare|contrast|pros|cons|trade.?off|explain why|should i|decision)\b/i
const CREATIVE_KEYWORDS  = /\b(write|story|poem|creative|fiction|imagine|narrative|character|plot|essay|blog|script|song)\b/i
const FACTUAL_KEYWORDS   = /\b(what is|who is|when did|where is|history|define|explain|summary|overview|fact)\b/i

export function classifyPrompt(message: string): PromptType {
  if (CODING_KEYWORDS.test(message))    return 'coding'
  if (MATH_KEYWORDS.test(message))      return 'math'
  if (REASONING_KEYWORDS.test(message)) return 'reasoning'
  if (CREATIVE_KEYWORDS.test(message))  return 'creative'
  if (FACTUAL_KEYWORDS.test(message))   return 'factual'
  return 'general'
}

// ── Model selection ──────────────────────────────────────────────────────────

export interface SelectedModel {
  id: string
  label: string
  provider: ModelEntry['provider']
  isWildcard: boolean
}

export interface SelectionResult {
  models: SelectedModel[]
  synthesisModelId: string  // highest-scoring model among selected — no provider bias
}

export function selectModels(
  promptType: PromptType,
  config: PipelineConfig = PIPELINE_CONFIG,
  complexity: 'simple' | 'complex' = 'complex',
  mode: 'quorum' | 'code' | 'seeker' = 'quorum'
): SelectionResult {
  const { parallelCount, wildcardCount } = config
  const deterministicCount = Math.max(1, parallelCount - wildcardCount)

  // Score every non-blocked model, applying rate-limit penalty
  // For simple queries: restrict to fast models only
  const eligible = MODEL_REGISTRY
    .filter(m => !BLOCKED_MODELS.has(m.id) && m.free === true && getCircuitState(m.id) !== 'tripped' && (complexity === 'simple' ? m.speed === 'fast' : true))
    .map(m => ({
      ...m,
      score: m.quality * m.fit[promptType] * rateLimitPenalty(m.provider) * modelFailurePenalty(m.id) * (mode === 'code' ? m.fit.coding / 10 + 0.5 : 1),
    }))
    .sort((a, b) => b.score - a.score)

  if (eligible.length === 0) throw new Error('No eligible models available')

  // Top N deterministic slots
  const deterministic = eligible.slice(0, deterministicCount)

  // Remaining pool for wildcard slots — weighted random by quality
  const pool = eligible.slice(deterministicCount)
  const wildcards: typeof eligible = []

  for (let i = 0; i < wildcardCount && pool.length > 0; i++) {
    const totalWeight = pool.reduce((s, m) => s + m.quality, 0)
    let rand = Math.random() * totalWeight
    let picked = pool[pool.length - 1]
    for (const m of pool) {
      rand -= m.quality
      if (rand <= 0) { picked = m; break }
    }
    wildcards.push(picked)
    pool.splice(pool.indexOf(picked), 1)  // no duplicates
  }

  const selected: SelectedModel[] = [
    ...deterministic.map(m => ({ id: m.id, label: m.label, provider: m.provider, isWildcard: false })),
    ...wildcards.map(m => ({ id: m.id, label: m.label, provider: m.provider, isWildcard: true })),
  ]

  // Synthesis = highest raw score among selected — purely merit-based, no provider preference
  const synthesisModelId = selected.reduce((best, m) => {
    const scoreA = eligible.find(e => e.id === best.id)?.score ?? 0
    const scoreB = eligible.find(e => e.id === m.id)?.score ?? 0
    return scoreB > scoreA ? m : best
  }, selected[0]).id

  console.log(`[ModelRegistry] Prompt: ${promptType} | Parallel: ${parallelCount} | Wildcards: ${wildcardCount}`)
  console.log(`[ModelRegistry] Selected: ${selected.map(m => `${m.label}${m.isWildcard ? ' [W]' : ''}`).join(', ')}`)
  console.log(`[ModelRegistry] Synthesis: ${MODEL_REGISTRY.find(r => r.id === synthesisModelId)?.label}`)

  return { models: selected, synthesisModelId }
}

// ── Complexity classifier — drives fast-path vs full pipeline ────────────────
const COMPLEX_INDICATORS = /\b(compare|comparison|difference|trade.?off|pros.?and.?cons|explain.?why|why.?does|why.?is|what.?causes|reason.?for|root.?cause|how.?does.{1,40}work|how.?to.{1,40}(implement|build|design|architect|optimi|refactor|integrat|scale)|walk.?me.?through|what.?happens.?when|design|architect|implement|refactor|debug|optimi[sz]e|analy[sz]e|evaluate|step.?by.?step|in.?detail|comprehensive|multiple|various|several|versus|\bvs\b|better.?than|worse.?than|when.?to.?use|best.?practice|production|at.?scale|real.?world|edge.?case|list.?all|give.?me.?examples|enumerate|what.?are.?the|should.?i|which.?is.?better|recommend|suggest|sequence|workflow|tradeoff|scalab|maintainab|performance|security|vulnerabilit|complexit|algorithm|architecture|pattern|approach|strategy|consideration|implication|consequence|impact|affect|depend|relationship|interact|integrat)\b/i
const MULTI_PART = /[;]|\band\b.{10,}\band\b|(\?.*){2,}/

export function scoreComplexity(message: string): 'simple' | 'complex' {
  const trimmed = message.trim()
  if (trimmed.length > 200) return 'complex'
  if (COMPLEX_INDICATORS.test(trimmed)) return 'complex'
  if (MULTI_PART.test(trimmed)) return 'complex'
  return 'simple'
}
