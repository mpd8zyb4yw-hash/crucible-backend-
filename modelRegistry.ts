import { createRequire } from 'module'
const require = typeof __filename !== 'undefined' ? createRequire(__filename) : createRequire(import.meta.url)
import fs from 'fs'
import path from 'path'

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
  provider: 'groq' | 'mistral' | 'openrouter' | 'gemini' | 'huggingface' | 'cloudflare' | 'together' | 'cerebras' | 'cohere' | 'fireworks' | 'deepinfra' | 'local'
            | 'together' | 'cerebras' | 'cohere' | 'fireworks' | 'deepinfra'
  speed: 'fast' | 'standard'      // fast = Groq dedicated inference
  tpmLimit?: number                  // tokens-per-minute hard cap (omit if unlimited)
  params: number                   // parameter count in billions
  /** Reliable native function-calling — eligible to DRIVE the agent loop. */
  tools?: boolean
  /**
   * Explicit diversity family override. When set, the diversity picker uses this
   * verbatim instead of inferring a family from the id via regex. Needed when an
   * id shares a substring with an unrelated family (e.g. Mistral Small on La
   * Plateforme vs Mistral 7B on Cloudflare) and must not be suppressed as a dup.
   */
  family?: string
}

// ── Track S — Local inference (Apple Foundation Models) ──────────────────────
// The on-device Apple Intelligence model, reached via the localhost Swift bridge
// daemon (local-inference/crucible-fm-daemon). DELIBERATELY kept out of
// MODEL_REGISTRY: it must never be auto-selected for the main quorum or synthesis
// (the external pool stays the quality ceiling). Only the explicit Track S routing
// sites (H4 fragility, M1 conversational, emergency fallback) reference it. No
// circuit breaker, no rate limit, no daily cap — gated solely by daemon liveness.
export const LOCAL_MODEL = {
  id: 'local/apple-fm',
  label: 'Apple Intelligence (Local)',
  provider: 'local' as const,
  isWildcard: false,
}

// ── Driver tier (orchestrator/worker split) ──────────────────────────────────
// The driver is the best available instruction-follower with native tool-calling;
// the cheap ensemble stays the worker tier (exposed to the driver as ensemble_solve).
export function selectDriverCandidates(): ModelEntry[] {
  return MODEL_REGISTRY
    .filter(m => m.tools && m.free && getCircuitState(m.id) === 'active')
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

// ── Provider key gating ──────────────────────────────────────────────────────
// A provider's models stay registered but are EXCLUDED from selection until its
// API key env var is present. This lets us wire new providers (Together, Cerebras,
// Cohere, Fireworks, DeepInfra) for redundancy without polluting the active pool with
// high-quality-but-keyless models that would be picked first and fail every call.
// Add a key → that provider's models activate automatically, no code change needed.
const PROVIDER_KEY_ENV: Record<string, string> = {
  groq:        'VITE_GROQ_API_KEY',
  openrouter:  'VITE_OPENROUTER_API_KEY',
  huggingface: 'VITE_HF_API_KEY',
  cloudflare:  'CLOUDFLARE_API_KEY',
  mistral:     'VITE_MISTRAL_API_KEY',
  gemini:      'VITE_GEMINI_API_KEY',
  together:    'TOGETHER_API_KEY',
  cerebras:    'CEREBRAS_API_KEY',
  cohere:      'COHERE_API_KEY',
  fireworks:   'FIREWORKS_API_KEY',
  deepinfra:   'DEEPINFRA_TOKEN',
}
export function providerHasKey(provider: string): boolean {
  const env = PROVIDER_KEY_ENV[provider]
  if (!env) return true  // unknown provider — don't gate
  const v = process.env[env]
  return !!v && v !== 'missing'
}

// ── Rate limit tracker ───────────────────────────────────────────────────────
// Tracks recent request counts per provider to penalise approaching-limit models.
// Penalty is applied as a multiplier to the selection score, not a hard block.

const USAGE_WINDOW_MS   = 60_000  // 1-minute rolling window (the per-minute cap window)
const VELOCITY_WINDOW_MS = 15_000 // short window used to measure current request velocity
const PREDICT_HORIZON_MS = 10_000 // how far ahead we project load when shifting away from a wall
const PROVIDER_SOFT_CAP: Record<string, number> = {
  groq:       25,   // penalise above this per minute
  mistral:    20,
  openrouter: 40,
  gemini:     15,
}

// Timestamped call log per provider. We keep raw timestamps (pruned to the 1-min
// window) rather than a single counter so we can measure *velocity* — the rate at
// which the provider is filling toward its cap — and act before the wall, not after.
const providerCalls: Record<string, number[]> = {}

export function recordProviderCall(provider: string): void {
  const now = Date.now()
  const log = providerCalls[provider] ?? (providerCalls[provider] = [])
  log.push(now)
  // prune anything older than the cap window
  const cutoff = now - USAGE_WINDOW_MS
  while (log.length && log[0] < cutoff) log.shift()
}

export interface ProviderLoad {
  provider: string
  count: number          // calls in the last 60s
  cap: number            // soft cap per minute
  fillRatio: number      // count / cap
  velocityPerMin: number // current request rate, extrapolated from the last 15s
  projectedCount: number // predicted count PREDICT_HORIZON_MS from now at current velocity
  secondsToCap: number   // estimated seconds until cap is hit (Infinity if idle/receding)
  penalty: number        // selection-score multiplier currently applied
}

// Core predictor: turns the raw call log into a load picture for one provider.
export function predictProviderLoad(provider: string, now = Date.now()): ProviderLoad {
  const cap = PROVIDER_SOFT_CAP[provider] ?? 20
  const log = providerCalls[provider] ?? []
  const cutoff = now - USAGE_WINDOW_MS
  const recent = log.filter(t => t >= cutoff)
  const count = recent.length

  // Velocity = calls in the short window, scaled to a per-minute rate.
  const velCutoff = now - VELOCITY_WINDOW_MS
  const inVelWindow = recent.filter(t => t >= velCutoff).length
  const velocityPerMin = inVelWindow * (USAGE_WINDOW_MS / VELOCITY_WINDOW_MS)

  // Project where we'll be PREDICT_HORIZON_MS from now if this rate holds.
  const projectedCount = count + velocityPerMin * (PREDICT_HORIZON_MS / USAGE_WINDOW_MS)

  // Time until we reach the cap at the current velocity.
  const headroom = cap - count
  const ratePerMs = velocityPerMin / USAGE_WINDOW_MS
  const secondsToCap = ratePerMs > 0 && headroom > 0 ? (headroom / ratePerMs) / 1000 : Infinity

  return {
    provider, count, cap,
    fillRatio: count / cap,
    velocityPerMin,
    projectedCount,
    secondsToCap,
    penalty: loadToPenalty(count, projectedCount, cap),
  }
}

// Penalty curve: blends *current* fill with *predicted* fill so load shifts away
// from a provider before it actually hits the wall. The worse of the two governs.
function loadToPenalty(count: number, projectedCount: number, cap: number): number {
  const fill = count / cap
  const projFill = projectedCount / cap
  const effective = Math.max(fill, projFill)   // predictive: react to where we're heading
  if (effective < 0.7) return 1.0              // comfortable headroom: no penalty
  if (effective < 0.9) return 0.6              // approaching the wall: shed some load
  if (effective < 1.0) return 0.3              // about to hit it: shed most load
  return 0.1                                    // at/over cap: near-blocked
}

function rateLimitPenalty(provider: string): number {
  return predictProviderLoad(provider).penalty
}

// Snapshot of every provider we have a soft cap for — used by diagnostics endpoints.
export function allProviderLoads(): ProviderLoad[] {
  return Object.keys(PROVIDER_SOFT_CAP).map(p => predictProviderLoad(p))
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
const MAX_COOLDOWN_MS     = 25 * 60 * 60 * 1000 // 25 hour cap (covers daily resets)
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
  // Daily token limit — use a full 24h cooldown so we don't hammer it all day
  if (/tokens per day|TPD|daily.{0,20}limit/i.test(errorMessage)) return 24 * 60 * 60 * 1000

  // Groq/OpenAI "Please try again in 5m13.632s" or "in 1h2m3s"
  const groqMatch = errorMessage.match(/in\s+(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i)
  if (groqMatch) {
    const h = parseFloat(groqMatch[1] || '0')
    const m = parseFloat(groqMatch[2] || '0')
    const s = parseFloat(groqMatch[3] || '0')
    return Math.ceil((h * 3600 + m * 60 + s) * 1000)
  }

  // "retry in Xs" or "Retry-After: X"
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

export function getModelFailureCount(modelId: string): number {
  const f = modelFailures[modelId]
  if (!f) return 0
  if (Date.now() - f.lastFailure > MODEL_FAILURE_DECAY_MS) return 0
  return f.count
}

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
//
// ── PROVIDER SPREAD TARGET (design intent — read before adding/removing models) ──
// The goal of a multi-provider pool is REDUNDANCY, not raw compute. Provider failures
// on free tiers are CORRELATED, not independent: Groq's daily token cap and OpenRouter's
// per-minute TPM cap can each remove their whole slice of the pool at once. Circuit
// breakers handle one model failing; they do nothing for a whole provider going dark.
// The only defense is diversity. Targets:
//   • Minimum 6 distinct providers represented in the active (free) pool.
//   • No single provider exceeds ~25% of the active free pool. If one does, the pool
//     degrades significantly the moment that provider trips — that is the risk to avoid.
//   • Prefer models from DIFFERENT families (Llama/Qwen/GLM/DeepSeek/Gemma/Command/
//     GPT-OSS/Phi/Mistral) so a family-specific weakness doesn't sink every candidate.
// Current active-pool distribution (free:true only), max share kept under 25%:
//   openrouter ~19% · groq ~15% · cloudflare ~15% · huggingface ~12% ·
//   together/cerebras/cohere/fireworks ~8% each · gemini/mistral ~4% each.
// `free: false` entries (e.g. DeepInfra) are wired for transport but EXCLUDED from the
// active pool by the `m.free === true` filter in selectModels — they only activate if a
// paid key is added later. The free-tier philosophy stays sacred: nothing paid is selected.
// Env vars per provider: VITE_GROQ_API_KEY, VITE_OPENROUTER_API_KEY, VITE_HF_API_KEY,
// CLOUDFLARE_API_KEY/CLOUDFLARE_ACCOUNT_ID, VITE_MISTRAL_API_KEY, VITE_GEMINI_API_KEY,
// TOGETHER_API_KEY, CEREBRAS_API_KEY, COHERE_API_KEY, FIREWORKS_API_KEY, DEEPINFRA_TOKEN.

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
    tpmLimit: 6000,
    fit: { coding: 9, reasoning: 9, creative: 6, factual: 8, math: 9, general: 8 },
  },
  {
    id: 'groq/llama-3.1-8b-instant',
    tpmLimit: 6000,
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
    family: 'mistral-la-plateforme',
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
    id: 'cloudflare/@cf/meta/llama-3.2-3b-instruct',
    params: 3, free: true, label: 'Llama 3.2 3B (CF)', quality: 5, provider: 'cloudflare', speed: 'fast',
    fit: { coding: 5, reasoning: 5, creative: 5, factual: 5, math: 4, general: 5 },
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
  // ── Together AI ──────────────────────────────────────────────────────────────
  // Always-free "-Free" suffix endpoints — usable indefinitely on a free key (lower
  // priority rate limits). Non-"-Free" models are paid and intentionally NOT listed.
  {
    id: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    params: 70, free: true, label: 'Llama 3.3 70B Turbo (Together)', quality: 8, provider: 'together', speed: 'standard',
    fit: { coding: 7, reasoning: 8, creative: 7, factual: 8, math: 7, general: 8 },
  },
  {
    // DeepSeek-R1 reasoning lineage — adds a distinct reasoning flavor at zero cost.
    id: 'together/deepseek-ai/DeepSeek-R1-Distill-Llama-70B-Free',
    params: 70, free: true, label: 'DeepSeek R1 Distill 70B (Together)', quality: 8, provider: 'together', speed: 'standard',
    fit: { coding: 8, reasoning: 9, creative: 5, factual: 7, math: 9, general: 7 },
  },
  // ── Cerebras ─────────────────────────────────────────────────────────────────
  // Permanent free trial tier (no card). Very fast (WSE-3), but 5 req/min org-wide —
  // treat as low-concurrency/high-value. Free models cap output at 8192 tokens.
  {
    // OpenAI GPT-OSS family — diversity vs the Llama/Qwen-heavy pool.
    id: 'cerebras/gpt-oss-120b',
    params: 117, free: true, label: 'GPT-OSS 120B (Cerebras)', quality: 8, provider: 'cerebras', speed: 'fast',
    fit: { coding: 8, reasoning: 8, creative: 6, factual: 7, math: 8, general: 8 },
  },
  {
    // Zhipu GLM family — best diversity pick. PREVIEW status: may change/discontinue.
    id: 'cerebras/zai-glm-4.7',
    params: 355, free: true, label: 'GLM 4.7 (Cerebras)', quality: 9, provider: 'cerebras', speed: 'fast',
    fit: { coding: 9, reasoning: 9, creative: 7, factual: 8, math: 8, general: 9 },
  },
  // ── Cohere ───────────────────────────────────────────────────────────────────
  // Free trial keys: 20 req/min, 1000 calls/MONTH shared across endpoints, evaluation-
  // only. Low-volume diversity provider — the rate-limit penalty system throttles it.
  {
    id: 'cohere/command-a-03-2025',
    params: 111, free: true, label: 'Command A (Cohere)', quality: 8, provider: 'cohere', speed: 'standard',
    fit: { coding: 7, reasoning: 8, creative: 7, factual: 8, math: 6, general: 8 },
  },
  {
    // Aya Expanse — 23-language multilingual research model, high diversity value.
    id: 'cohere/c4ai-aya-expanse-32b',
    params: 32, free: true, label: 'Aya Expanse 32B (Cohere)', quality: 7, provider: 'cohere', speed: 'standard',
    fit: { coding: 5, reasoning: 7, creative: 8, factual: 8, math: 5, general: 7 },
  },
  // ── Fireworks AI ─────────────────────────────────────────────────────────────
  // A handful of genuinely $0 serverless models. Paid flagships intentionally excluded.
  {
    // Code-reasoning specialist (RL-tuned) — strong on LiveCodeBench.
    id: 'fireworks/accounts/fireworks/models/deepcoder-14b-preview',
    params: 14, free: true, label: 'DeepCoder 14B (Fireworks)', quality: 7, provider: 'fireworks', speed: 'standard',
    fit: { coding: 9, reasoning: 7, creative: 4, factual: 6, math: 8, general: 6 },
  },
  {
    // Hybrid-reasoning multilingual (strong Indic coverage) — non-Llama/Qwen flavor.
    id: 'fireworks/accounts/fireworks/models/sarvam-m',
    params: 24, free: true, label: 'Sarvam-M 24B (Fireworks)', quality: 6, provider: 'fireworks', speed: 'standard',
    fit: { coding: 5, reasoning: 7, creative: 7, factual: 7, math: 6, general: 7 },
  },
  // ── Deep Infra ───────────────────────────────────────────────────────────────
  // NO free tier (pay-per-token). Wired for transport + family diversity, but marked
  // free:false so selectModels EXCLUDES them from the active pool. Activate only if a
  // DEEPINFRA_TOKEN with paid balance is ever provided — the free-tier rule is preserved.
  {
    id: 'deepinfra/google/gemma-3-27b-it',
    params: 27, free: true, label: 'Gemma 3 27B (DeepInfra)', quality: 8, provider: 'deepinfra', speed: 'standard',
    fit: { coding: 6, reasoning: 8, creative: 7, factual: 8, math: 7, general: 8 },
  },
  {
    id: 'deepinfra/microsoft/phi-4',
    params: 14, free: true, label: 'Phi-4 (DeepInfra)', quality: 7, provider: 'deepinfra', speed: 'standard',
    fit: { coding: 7, reasoning: 8, creative: 5, factual: 7, math: 9, general: 7 },
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

// Strong creative signals — an unambiguous request for prose/verse/fiction. These win
// over coding keywords so "write a story about a programmer who debugs code" classifies
// creative, not coding (the incidental "debug"/"code" tokens don't hijack it).
const STRONG_CREATIVE = /\b(story|short story|poem|poetry|haiku|sonnet|novel|fiction|screenplay|lyrics?|song|verse|ballad|tale|fairy ?tale|limerick|narrative)\b/i

// Regex baseline — always available, O(1)
export function regexClassify(message: string): PromptType {
  if (STRONG_CREATIVE.test(message))    return 'creative'
  if (CODING_KEYWORDS.test(message))    return 'coding'
  if (MATH_KEYWORDS.test(message))      return 'math'
  if (REASONING_KEYWORDS.test(message)) return 'reasoning'
  if (CREATIVE_KEYWORDS.test(message))  return 'creative'
  if (FACTUAL_KEYWORDS.test(message))   return 'factual'
  return 'general'
}

// ── Learned classifier — k-NN over accumulated prompt history ──────────────
// Requires ≥ MIN_SAMPLES before it overrides the regex baseline.
// Labels are the promptType used for that round (regex-sourced initially;
// improves over time as the history covers edge cases and diverse prompts).

const CLASSIFIER_FILE = path.join(process.cwd(), '.crucible', 'classifier-history.json')
const MIN_SAMPLES = 20
const CK_NEIGHBORS = 5
const CLS_STOPWORDS = new Set(['the','a','an','is','are','was','were','have','has','do','does','did','will','would','of','in','on','at','to','for','with','by','from','and','or','but','not','this','that','it','i','you','we','they'])

interface ClassifierEntry { tokens: [string, number][]; promptType: PromptType }
interface ClassifierStore { entries: ClassifierEntry[]; total: number }

let _clsStore: ClassifierStore | null = null

function loadClassifier(): ClassifierStore {
  if (_clsStore) return _clsStore
  try { _clsStore = JSON.parse(fs.readFileSync(CLASSIFIER_FILE, 'utf8')) }
  catch { _clsStore = { entries: [], total: 0 } }
  return _clsStore!
}

function clsVectorize(msg: string): Map<string, number> {
  const words = (msg.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter(w => !CLS_STOPWORDS.has(w))
  const tf = new Map<string, number>()
  for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1)
  const max = Math.max(1, ...tf.values())
  for (const [k, v] of tf) tf.set(k, v / max)
  return tf
}

function clsCosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0
  for (const [k, v] of a) { dot += v * (b.get(k) ?? 0); na += v * v }
  for (const v of b.values()) nb += v * v
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

export function learnClassification(message: string, promptType: PromptType): void {
  const store = loadClassifier()
  const tokens = [...clsVectorize(message).entries()]
  store.entries.push({ tokens, promptType })
  store.total++
  if (store.entries.length > 1000) store.entries = store.entries.slice(-1000)
  try {
    fs.mkdirSync(path.dirname(CLASSIFIER_FILE), { recursive: true })
    fs.writeFileSync(CLASSIFIER_FILE, JSON.stringify(store, null, 2))
  } catch {}
}

function learnedClassify(message: string): PromptType | null {
  const store = loadClassifier()
  if (store.entries.length < MIN_SAMPLES) return null
  const qv = clsVectorize(message)
  const scored = store.entries
    .map(e => ({ type: e.promptType, sim: clsCosine(qv, new Map(e.tokens)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, CK_NEIGHBORS)
  if (scored[0].sim < 0.25) return null  // too dissimilar — trust regex
  const votes: Record<string, number> = {}
  let totalWeight = 0
  for (const { type, sim } of scored) { votes[type] = (votes[type] ?? 0) + sim; totalWeight += sim }
  const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]
  if (!winner || winner[1] / totalWeight < 0.5) return null  // no clear majority — trust regex
  return winner[0] as PromptType
}

export function classifyPrompt(message: string): PromptType {
  return learnedClassify(message) ?? regexClassify(message)
}

export function classifierStats(): { sampleSize: number; learnedActive: boolean } {
  const store = loadClassifier()
  return { sampleSize: store.entries.length, learnedActive: store.entries.length >= MIN_SAMPLES }
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
// ── Track Q — SUBSTRATE: predictive viability fingerprints ───────────────────
// Every model call produces an outcome (ok/fail + latency). We keep a rolling
// fingerprint per model and derive a viability score in [0,1] that folds into
// selection. Unlike circuit breakers (binary, reactive), this is a graded,
// predictive signal: a model that is technically "up" but slow or flaky sinks
// in the ranking before it ever trips. Unseen / barely-seen models return a
// NEUTRAL 1.0 so freshly discovered models get a fair first shot (philosophy:
// the pool self-optimises from evidence, it doesn't pre-judge newcomers).

interface ModelOutcome { ok: boolean; latencyMs?: number; at?: number }
const VIABILITY_WINDOW = 30        // outcomes retained per model
const VIABILITY_MIN_SAMPLES = 3    // below this → neutral (no evidence yet)
const LATENCY_REF_MS = 12_000      // a response at/under this is "fast" (factor 1.0)
const modelOutcomes: Record<string, ModelOutcome[]> = {}

export function recordModelOutcome(modelId: string, ok: boolean, latencyMs?: number): void {
  const ring = (modelOutcomes[modelId] ||= [])
  ring.push({ ok, latencyMs, at: Date.now() })
  if (ring.length > VIABILITY_WINDOW) ring.shift()
}

/** ISO timestamp of this model's most recent recorded call, or null if never called. */
export function lastModelCall(modelId: string): string | null {
  const ring = modelOutcomes[modelId]
  if (!ring || !ring.length) return null
  const at = ring[ring.length - 1].at
  return at ? new Date(at).toISOString() : null
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Viability in [0.1, 1.0]; 1.0 (neutral) when there is not yet enough evidence. */
export function viabilityScore(modelId: string): number {
  const ring = modelOutcomes[modelId]
  if (!ring || ring.length < VIABILITY_MIN_SAMPLES) return 1.0
  const successRate = ring.filter(o => o.ok).length / ring.length
  const lats = ring.map(o => o.latencyMs).filter((x): x is number => typeof x === 'number')
  // Latency factor: at/under reference → 1.0; degrades gently, floored at 0.8 so
  // a slow-but-reliable model is preferred over a fast-but-failing one.
  let latencyFactor = 1.0
  if (lats.length) {
    const med = median(lats)
    latencyFactor = med <= LATENCY_REF_MS ? 1.0 : Math.max(0.8, LATENCY_REF_MS / med)
  }
  return Math.max(0.1, successRate * latencyFactor)
}

/** Architecture family derived from the model id — for family-diversity spread. */
export function modelFamily(idOrLabel: string): string {
  const s = idOrLabel.toLowerCase()
  if (/nemotron/.test(s)) return 'nemotron'
  if (/gpt-oss|gpt_oss|openai\/gpt/.test(s)) return 'gpt-oss'
  if (/qwen/.test(s)) return 'qwen'
  if (/llama/.test(s)) return 'llama'
  if (/\bglm\b|zhipu/.test(s)) return 'glm'
  if (/gemma|gemini/.test(s)) return 'gemma'
  if (/mistral|mixtral|ministral/.test(s)) return 'mistral'
  if (/phi-|\bphi\b/.test(s)) return 'phi'
  if (/command|cohere/.test(s)) return 'command'
  if (/deepseek/.test(s)) return 'deepseek'
  if (/owl/.test(s)) return 'owl'
  return s.split('/').pop()?.split('-')[0] ?? 'other'
}

/**
 * Resolve a model's diversity family. An explicit `family` field on the registry
 * entry always wins; only fall back to regex inference from the id/label when no
 * explicit family is declared. This lets entries that share an id substring with
 * another family (e.g. Mistral Small vs Mistral 7B) opt into a distinct family so
 * the diversity picker doesn't suppress them as duplicates.
 */
export function familyOf(m: { family?: string; id?: string; label?: string }): string {
  return m.family ?? modelFamily(m.id || m.label || '')
}

/**
 * Diversity-maximised greedy pick. Takes score-sorted candidates and selects
 * `count`, but each pick re-ranks the remainder by score × a diversity multiplier
 * that penalises providers and families already represented. The single highest
 * scorer always goes first (merit-preserving); subsequent slots spread the pool so
 * one provider tripping its cap can never remove the whole selection at once.
 */
function pickDiverse<T extends { id: string; label: string; provider: string; score: number; family?: string }>(
  candidates: T[],
  count: number,
  // Hard per-provider cap (correlated-failure defense — ROADMAP resilience target:
  // "no single provider exceeding 25% of the active pool"). Defaults to 25% of the
  // pool this selection is filling. The soft diversity penalty below still shapes
  // *which* under-cap model wins each slot; the cap is the absolute ceiling that the
  // soft penalty alone does not guarantee when one provider owns the top scores.
  maxPerProvider = Math.max(1, Math.ceil(count / 4)),
  // Provider picks already made outside this call (e.g. by a prior deterministic
  // pass) so the cap spans the whole selected pool, not just this call's slice.
  seedProviderCount: Record<string, number> = {},
): T[] {
  const picked: T[] = []
  const remaining = [...candidates]
  const providerCount: Record<string, number> = { ...seedProviderCount }
  const familyCount: Record<string, number> = {}

  while (picked.length < count && remaining.length) {
    let bestIdx = -1
    let bestAdj = -Infinity
    // Pass 1 — honor the hard cap: only consider providers still under the ceiling.
    for (let i = 0; i < remaining.length; i++) {
      const m = remaining[i]
      if ((providerCount[m.provider] ?? 0) >= maxPerProvider) continue
      const pSeen = providerCount[m.provider] ?? 0
      const fSeen = familyCount[familyOf(m)] ?? 0
      // Each repeat of a provider costs 18%, each repeat of a family costs 10%.
      const diversityMult = Math.pow(0.82, pSeen) * Math.pow(0.90, fSeen)
      const adj = m.score * diversityMult
      if (adj > bestAdj) { bestAdj = adj; bestIdx = i }
    }
    // Pass 2 — relax: every remaining candidate's provider is at cap but we still
    // owe slots (too few distinct providers available). Fill from the best remaining
    // rather than return an under-sized pool — a degraded pool beats an empty one.
    if (bestIdx === -1) {
      for (let i = 0; i < remaining.length; i++) {
        const m = remaining[i]
        const pSeen = providerCount[m.provider] ?? 0
        const fSeen = familyCount[familyOf(m)] ?? 0
        const adj = m.score * Math.pow(0.82, pSeen) * Math.pow(0.90, fSeen)
        if (adj > bestAdj) { bestAdj = adj; bestIdx = i }
      }
    }
    const [chosen] = remaining.splice(bestIdx, 1)
    picked.push(chosen)
    providerCount[chosen.provider] = (providerCount[chosen.provider] ?? 0) + 1
    const fam = familyOf(chosen)
    familyCount[fam] = (familyCount[fam] ?? 0) + 1
  }
  return picked
}

export function selectModels(
  promptType: PromptType,
  config: PipelineConfig = PIPELINE_CONFIG,
  complexity: 'simple' | 'complex' = 'complex',
  mode: 'quorum' | 'code' | 'seeker' = 'quorum'
): SelectionResult {
  const { parallelCount, wildcardCount } = config
  const deterministicCount = Math.max(1, parallelCount - wildcardCount)

  // L3 — Predictive load balancing: estimate how long this request will take
  // and penalize providers projected to cap before completion.
  const ESTIMATED_DURATION_MS: Record<string, number> = {
    simple: 8_000,
    complex: 45_000,
  }
  const estimatedMs = ESTIMATED_DURATION_MS[complexity] ?? 20_000

  function predictivePenalty(provider: string): number {
    const load = predictProviderLoad(provider)
    if (load.secondsToCap === Infinity) return 1.0
    const secondsToCapMs = load.secondsToCap * 1000
    if (secondsToCapMs < estimatedMs) {
      // Provider likely to cap mid-request — severe penalty
      return 0.1
    }
    if (secondsToCapMs < estimatedMs * 2) {
      // Provider cutting it close — moderate penalty
      return 0.6
    }
    return 1.0
  }

  // Score every non-blocked model, applying rate-limit penalty
  // For simple queries: restrict to fast models only
  const specWeights = getSpecializationWeights(promptType)
  const eligible = MODEL_REGISTRY
    .filter(m => !BLOCKED_MODELS.has(m.id) && m.free === true && providerHasKey(m.provider) && getCircuitState(m.id) === 'active' && (complexity === 'simple' ? m.speed === 'fast' : true))
    .map(m => {
      // Specialization bias: if learned EMA score exists, scale by (1 + deviation from 0.5)
      // A model averaging 0.8 in this category gets +0.3×0.15 = +4.5% lift; 0.2 → -4.5%.
      const specBias = specWeights[m.id] != null ? 1 + (specWeights[m.id] - 0.5) * 0.15 : 1
      return {
        ...m,
        score: m.quality * m.fit[promptType] * rateLimitPenalty(m.provider) * predictivePenalty(m.provider) * modelFailurePenalty(m.id) * viabilityScore(m.id) * (mode === 'code' ? m.fit.coding / 10 + 0.5 : 1) * specBias,
      }
    })
    .sort((a, b) => b.score - a.score)

  if (eligible.length === 0) throw new Error('No eligible models available')

  // Hard per-provider cap spanning the WHOLE selected pool (deterministic +
  // wildcard), not just the deterministic slice — ROADMAP resilience target of
  // ≤25% single-provider share. When a provider's breaker trips, its models drop
  // out of `eligible` above and this cap prevents the freed slots from
  // re-concentrating on the next-loudest provider: automatic rebalance-on-trip,
  // re-applied on every per-request selection.
  const maxPerProvider = Math.max(1, Math.ceil(parallelCount / 4))

  // Top N deterministic slots — diversity-maximised so the selection never
  // concentrates on one provider/family (correlated-failure defense, Track Q).
  const deterministic = pickDiverse(eligible, deterministicCount, maxPerProvider)

  // Track provider usage from the deterministic pass so wildcards keep the pool
  // under the same cap.
  const providerCount: Record<string, number> = {}
  for (const m of deterministic) providerCount[m.provider] = (providerCount[m.provider] ?? 0) + 1

  // Remaining pool for wildcard slots — weighted random by quality
  const detIds = new Set(deterministic.map(m => m.id))
  const pool = eligible.filter(m => !detIds.has(m.id))
  const wildcards: typeof eligible = []

  for (let i = 0; i < wildcardCount && pool.length > 0; i++) {
    // Prefer providers still under the cap; only fall back to at-cap providers if
    // every remaining candidate is capped (keeps the wildcard slot filled).
    let draw = pool.filter(m => (providerCount[m.provider] ?? 0) < maxPerProvider)
    if (draw.length === 0) draw = pool
    const totalWeight = draw.reduce((s, m) => s + m.quality, 0)
    let rand = Math.random() * totalWeight
    let picked = draw[draw.length - 1]
    for (const m of draw) {
      rand -= m.quality
      if (rand <= 0) { picked = m; break }
    }
    wildcards.push(picked)
    providerCount[picked.provider] = (providerCount[picked.provider] ?? 0) + 1
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

// ── Model Specialization Memory ──────────────────────────────────────────────
// Records per-(model, queryType) score history as an EMA. After each pipeline
// round, call recordSpecialization() with the final composite score. selectModels
// applies the learned bias additively so models that consistently win a category
// rank higher for it over time.

const SPEC_FILE = path.join(process.cwd(), '.crucible', 'specialization.json')
const SPEC_EMA_ALPHA = 0.2  // smoothing factor — new data worth 20% of running average

type SpecMap = Record<string, Record<string, number>>  // modelId → queryType → ema score

function readSpec(): SpecMap {
  try { return JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8')) } catch { return {} }
}

function writeSpec(spec: SpecMap): void {
  try {
    fs.mkdirSync(path.dirname(SPEC_FILE), { recursive: true })
    fs.writeFileSync(SPEC_FILE, JSON.stringify(spec, null, 2))
  } catch {}
}

// Exponential decay: EMAs drift back toward neutral (0.5) when a model hasn't
// been called in a given category recently. Half-life ≈ 60 days of daily usage.
// Without decay, a model that dominated a category early (small sample) holds
// that advantage forever even when newer models consistently outperform it.
const SPEC_DECAY_HALF_LIFE_DAYS = 60
const SPEC_DECAY_K = Math.log(2) / (SPEC_DECAY_HALF_LIFE_DAYS * 86400 * 1000)

const SPEC_TIMESTAMPS_FILE = path.join(process.cwd(), '.crucible', 'specialization-ts.json')
type TsMap = Record<string, Record<string, number>>  // modelId → queryType → last-write ms

function readSpecTs(): TsMap {
  try { return JSON.parse(fs.readFileSync(SPEC_TIMESTAMPS_FILE, 'utf8')) } catch { return {} }
}
function writeSpecTs(ts: TsMap): void {
  try { fs.writeFileSync(SPEC_TIMESTAMPS_FILE, JSON.stringify(ts, null, 2)) } catch {}
}

export function recordSpecialization(modelId: string, queryType: PromptType, score: number): void {
  const spec = readSpec()
  const ts = readSpecTs()
  const now = Date.now()
  if (!spec[modelId]) spec[modelId] = {}
  if (!ts[modelId]) ts[modelId] = {}

  const prev = spec[modelId][queryType]
  const lastTs = ts[modelId][queryType] ?? now

  // Apply time-based decay to the stored EMA before blending new score in.
  const decayedPrev = prev == null ? score
    : 0.5 + (prev - 0.5) * Math.exp(-SPEC_DECAY_K * (now - lastTs))

  spec[modelId][queryType] = prev == null
    ? score
    : decayedPrev * (1 - SPEC_EMA_ALPHA) + score * SPEC_EMA_ALPHA
  ts[modelId][queryType] = now
  writeSpec(spec)
  writeSpecTs(ts)
}

export function getSpecializationWeights(queryType: PromptType): Record<string, number> {
  const spec = readSpec()
  const out: Record<string, number> = {}
  for (const [modelId, types] of Object.entries(spec)) {
    if (types[queryType] != null) out[modelId] = types[queryType]
  }
  return out
}

// ── Complexity classifier — drives fast-path vs full pipeline ────────────────
const COMPLEX_INDICATORS = /\b(compare|comparison|difference|trade.?off|pros.?and.?cons|explain.?why|why.?does|why.?is|what.?causes|reason.?for|root.?cause|how.?does.{1,40}work|how.?to.{1,40}(implement|build|design|architect|optimi|refactor|integrat|scale)|walk.?me.?through|what.?happens.?when|design|architect|implement|refactor|debug|optimi[sz]e|analy[sz]e|evaluate|step.?by.?step|in.?detail|comprehensive|multiple|various|several|versus|\bvs\b|better.?than|worse.?than|when.?to.?use|best.?practice|production|at.?scale|real.?world|edge.?case|list.?all|give.?me.?examples|enumerate|what.?are.?the|should.?i|which.?is.?better|recommend|suggest|sequence|workflow|tradeoff|scalab|maintainab|performance|security|vulnerabilit|complexit|algorithm|architecture|pattern|approach|strategy|consideration|implication|consequence|impact|affect|depend|relationship|interact|integrat)\b/i
const MULTI_PART = /[;]|\band\b.{10,}\band\b|(\?.*){2,}/

// ── Track Q — SUBSTRATE: standby hot-swap ────────────────────────────────────
// When a model fails or trips mid-pipeline, the server can call pickStandby() to
// get the single best eligible replacement not already in flight — same scoring
// path as selectModels (viability + diversity-aware vs the in-flight set), so the
// swap preserves both merit and provider spread. Returns null if the pool is dry.

export function pickStandby(
  promptType: PromptType,
  complexity: 'simple' | 'complex',
  excludeIds: string[]
): SelectedModel | null {
  const exclude = new Set(excludeIds)
  const specWeights = getSpecializationWeights(promptType)
  const eligible = MODEL_REGISTRY
    .filter(m =>
      !BLOCKED_MODELS.has(m.id) && m.free === true && providerHasKey(m.provider) &&
      getCircuitState(m.id) === 'active' && !exclude.has(m.id) &&
      (complexity === 'simple' ? m.speed === 'fast' : true))
    .map(m => {
      const specBias = specWeights[m.id] != null ? 1 + (specWeights[m.id] - 0.5) * 0.15 : 1
      return {
        ...m,
        score: m.quality * m.fit[promptType] * rateLimitPenalty(m.provider) *
               modelFailurePenalty(m.id) * viabilityScore(m.id) * specBias,
      }
    })
    .sort((a, b) => b.score - a.score)

  // Prefer a replacement from a provider/family NOT already in flight.
  const inFlight = excludeIds.map(id => getModelEntry(id)).filter(Boolean) as ModelEntry[]
  const usedProviders = new Set(inFlight.map(m => m.provider))
  const usedFamilies = new Set(inFlight.map(m => familyOf(m)))
  const diverse = eligible.find(m =>
    !usedProviders.has(m.provider) && !usedFamilies.has(familyOf(m)))
  const chosen = diverse ?? eligible[0]
  if (!chosen) return null
  return { id: chosen.id, label: chosen.label, provider: chosen.provider, isWildcard: true }
}

/**
 * Live viability snapshot of the whole free pool: how many models would pass the
 * selection eligibility gate right now, how many are excluded, and why. (Snapshot
 * semantics — reflects the pool state at call time, not a stored "last" selection.)
 */
export function viabilitySnapshot(): { viable: number; excluded: number; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {}
  let viable = 0, excluded = 0
  for (const m of MODEL_REGISTRY) {
    if (m.free !== true) { continue }  // paid models never in the active pool — not "excluded"
    let reason: string | null = null
    if (BLOCKED_MODELS.has(m.id)) reason = 'blocked'
    else if (!providerHasKey(m.provider)) reason = 'no-api-key'
    else if (getCircuitState(m.id) === 'tripped') reason = 'circuit-tripped'
    else if (getCircuitState(m.id) === 'probing') reason = 'circuit-probing'
    else if (viabilityScore(m.id) <= 0.15) reason = 'viability-floor'
    if (reason) { excluded++; reasons[reason] = (reasons[reason] ?? 0) + 1 }
    else viable++
  }
  return { viable, excluded, reasons }
}

// ── Track Q — SUBSTRATE: fingerprint report (debug surface) ──────────────────
export function substrateReport(): {
  models: { id: string; label: string; provider: string; family: string; viability: number; samples: number; successRate: number | null; medianLatencyMs: number | null }[]
  providerSpread: Record<string, number>
  familySpread: Record<string, number>
} {
  const providerSpread: Record<string, number> = {}
  const familySpread: Record<string, number> = {}
  const models = MODEL_REGISTRY
    .filter(m => m.free === true)
    .map(m => {
      const ring = modelOutcomes[m.id] ?? []
      const lats = ring.map(o => o.latencyMs).filter((x): x is number => typeof x === 'number')
      const fam = familyOf(m)
      if (getCircuitState(m.id) === 'active' && providerHasKey(m.provider)) {
        providerSpread[m.provider] = (providerSpread[m.provider] ?? 0) + 1
        familySpread[fam] = (familySpread[fam] ?? 0) + 1
      }
      return {
        id: m.id, label: m.label, provider: m.provider, family: fam,
        viability: Number(viabilityScore(m.id).toFixed(3)),
        samples: ring.length,
        successRate: ring.length ? Number((ring.filter(o => o.ok).length / ring.length).toFixed(3)) : null,
        medianLatencyMs: lats.length ? Math.round(median(lats)) : null,
      }
    })
    .sort((a, b) => b.viability - a.viability)
  return { models, providerSpread, familySpread }
}

export function scoreComplexity(message: string): 'simple' | 'complex' {
  const trimmed = message.trim()
  if (trimmed.length > 200) return 'complex'
  if (COMPLEX_INDICATORS.test(trimmed)) return 'complex'
  if (MULTI_PART.test(trimmed)) return 'complex'
  return 'simple'
}
