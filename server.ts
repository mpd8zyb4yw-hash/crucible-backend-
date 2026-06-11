import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import express from 'express'
import cors from 'cors'
import Groq from 'groq-sdk'
import { Mistral } from '@mistralai/mistralai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { evaluateIteration, DEFAULT_SCORING_CONFIG, generateContract, getAspectContext } from './src/CrucibleEngine/index'
import type { InterfaceContract } from './src/CrucibleEngine/index'
import fs from 'fs'
import path from 'path'
import { classifyPrompt, selectModels, recordProviderCall, recordModelFailure, PIPELINE_CONFIG, SIMPLE_PIPELINE_CONFIG, getModelEntry, scoreComplexity, tripCircuitBreaker, resetCircuitBreaker, getCircuitState, parseRetryDelay, circuitBreakers } from './modelRegistry'
import type { SelectedModel } from './modelRegistry'
import { createServer } from 'http'
import { buildIndex, queryIndex, getIndexStats } from './src/CrucibleEngine/rag-context'
import { createCheckpoint, rollbackToCheckpoint, getCheckpoints } from './src/CrucibleEngine/checkpoint'
import { registry } from './src/CrucibleEngine/tools/registry'
import { fenceProtocolPrompt, parseFenceToolCall } from './src/CrucibleEngine/tools/protocol'
import type { ToolCtx } from './src/CrucibleEngine/tools/protocol'

const CIRCUIT_STATE_FILE = path.join(process.cwd(), '.circuit-state.json')

function loadCircuitState() {
  try {
    if (fs.existsSync(CIRCUIT_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CIRCUIT_STATE_FILE, 'utf-8'))
      const now = Date.now()
      for (const [id, cb] of Object.entries(parsed) as [string, any][]) {
        if (cb.failReason !== 'decommissioned' && now - cb.trippedAt >= cb.cooldownMs) continue
        circuitBreakers[id] = cb
      }
      console.log(`[Circuit] Loaded ${Object.keys(circuitBreakers).length} persisted state(s)`)
    }
  } catch (e) { console.warn('[Circuit] Failed to load state:', e) }
}

export function saveCircuitState() {
  try {
    fs.writeFileSync(CIRCUIT_STATE_FILE, JSON.stringify(circuitBreakers, null, 2))
  } catch (e) { console.warn('[Circuit] Failed to save state:', e) }
}

loadCircuitState()
import { exec } from 'child_process'
import { prewarmPython } from './src/CrucibleEngine/sandbox'

// ── Exact response cache ──────────────────────────────────────────────────────
interface CachedRound {
  events: object[]
  timestamp: number
}
const responseCache = new Map<string, CachedRound>()
const CACHE_TTL_MS = 60 * 60 * 1000   // 1 hour
const CACHE_MAX    = 200

function cacheKey(message: string): string {
  return message.trim().toLowerCase()
}

function pruneCache() {
  const now = Date.now()
  for (const [k, v] of responseCache) {
    if (now - v.timestamp > CACHE_TTL_MS) responseCache.delete(k)
  }
  if (responseCache.size > CACHE_MAX) {
    const oldest = [...responseCache.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, responseCache.size - CACHE_MAX)
    for (const [k] of oldest) responseCache.delete(k)
  }
}




// ── Dynamic free model refresh from OpenRouter ───────────────────────────────
import { MODEL_REGISTRY } from './modelRegistry'

async function refreshFreeModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${process.env.VITE_OPENROUTER_API_KEY}` }
    })
    if (!res.ok) return
    const { data } = await res.json() as { data: Array<{ id: string; pricing: { prompt: string; completion: string }; name: string }> }
    const freeIds = new Set(
      data
        .filter(m => parseFloat(m.pricing?.prompt ?? '1') === 0 && parseFloat(m.pricing?.completion ?? '1') === 0)
        .map(m => `openrouter/${m.id}`)
    )
    let added = 0, removed = 0
    for (const m of MODEL_REGISTRY) {
      if (m.provider !== 'openrouter') continue
      const wasLive = m.free
      m.free = freeIds.has(m.id)
      if (wasLive && !m.free) removed++
      if (!wasLive && m.free) added++
    }
    console.log(`[ModelRefresh] Free model check complete — +${added} enabled, -${removed} disabled`)
  } catch (e) {
    console.warn('[ModelRefresh] Failed to refresh model list:', e)
  }
}

refreshFreeModels()
setInterval(refreshFreeModels, 6 * 60 * 60 * 1000)

const app = express()
app.use(cors())
app.use(express.json())

const groq    = new Groq({ apiKey: process.env.VITE_GROQ_API_KEY ?? 'missing' })
const mistral = new Mistral({ apiKey: process.env.VITE_MISTRAL_API_KEY ?? 'missing' })
const gemini  = new GoogleGenerativeAI(process.env.VITE_GEMINI_API_KEY ?? '')

const stripThink = (text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => {
      console.log(`[withTimeout] Timed out after ${ms}ms — using fallback`)
      resolve(fallback)
    }, ms))
  ])
}

// ── Unified model caller ──────────────────────────────────────────────────────
// ── Agentic tool-call loop (fence protocol via tool registry) ────────────────
async function callModelAgentic(model: SelectedModel, messages: { role: string; content: string }[], maxIterations = 3): Promise<string> {
  const ctx: ToolCtx = { projectPath: process.cwd(), allowMutation: false }
  const agenticMessages = [...messages]
  if (agenticMessages[0]?.role === 'system') {
    agenticMessages[0] = { ...agenticMessages[0], content: agenticMessages[0].content + fenceProtocolPrompt(registry.list()) }
  }
  for (let i = 0; i < maxIterations; i++) {
    const response = await callModel(model, agenticMessages)
    const toolCall = parseFenceToolCall(response)
    if (!toolCall) return response  // no tool call — final response
    console.log(`[Agentic] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.args)})`)
    const result = await registry.exec(toolCall, ctx)
    agenticMessages.push({ role: 'assistant', content: response })
    agenticMessages.push({ role: 'user', content: `Tool result (${result.ok ? 'ok' : 'error'}):\n${result.output}\n\nContinue your response.` })
  }
  // Max iterations hit — call once more for final answer
  return await callModel(model, agenticMessages)
}

async function callModel(model: SelectedModel, messages: { role: string; content: string }[]): Promise<string> {
  const { id, provider } = model
  recordProviderCall(provider)

  if (provider === 'groq') {
    const modelId = id.replace(/^groq\//, '')
    const isQwen = modelId.includes('qwen')
    const res = await groq.chat.completions.create({
      model: modelId,
      messages,
      stream: false,
      ...(isQwen ? { reasoning_effort: 'none' } : {}),
    } as any)
    const text = res.choices[0]?.message?.content || ''
    return isQwen ? stripThink(text) : text
  }

  if (provider === 'mistral') {
    const modelId = id.replace(/^mistral\//, '')
    const res = await mistral.chat.complete({ model: modelId, messages })
    return (res.choices?.[0]?.message?.content as string) || ''
  }

  if (provider === 'gemini') {
    const modelId = id.replace(/^gemini\//, '')
    const gModel = gemini.getGenerativeModel({ model: modelId })
    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
    const last = messages[messages.length - 1]
    const chat = gModel.startChat({ history })
    const result = await chat.sendMessage(last.content)
    return result.response.text()
  }

  if (provider === 'openrouter') {
    const modelId = id.replace(/^openrouter\//, '')
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VITE_OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://crucible.local',
        'X-Title': 'Crucible',
      },
      body: JSON.stringify({ model: modelId, messages }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenRouter ${res.status}: ${err}`)
    }
    const data = await res.json()
    return data.choices?.[0]?.message?.content || ''
  }

  if (provider === 'huggingface') {
    const modelId = id.replace(/^huggingface\//, '')
    const res = await fetch('https://router.huggingface.co/novita/v3/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VITE_HF_API_KEY}`,
      },
      body: JSON.stringify({ model: modelId, messages, max_tokens: 4096 }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`HuggingFace ${res.status}: ${err}`)
    }
    const data = await res.json()
    return data.choices?.[0]?.message?.content || ''
  }

  if (provider === 'cloudflare') {
    const modelId = id.replace(/^cloudflare\//, '')
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
    const apiKey = process.env.CLOUDFLARE_API_KEY
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Cloudflare ${res.status}: ${err}`)
    }
    const data = await res.json()
    return data.result?.response || ''
  }

  throw new Error(`Unknown provider: ${provider}`)
}

// ── Streaming caller ──────────────────────────────────────────────────────────
async function callModelStreaming(
  model: SelectedModel,
  messages: { role: string; content: string }[],
  onChunk: (text: string) => void
): Promise<string> {
  const { id, provider } = model
  recordProviderCall(provider)

  if (provider === 'groq') {
    const modelId = id.replace(/^groq\//, '')
    const isQwen = modelId.includes('qwen')
    let buf = ''
    const stream = await groq.chat.completions.create({
      model: modelId, messages, stream: true,
      ...(isQwen ? { reasoning_effort: 'none' } : {}),
    } as any)
    for await (const chunk of stream) {
      buf += chunk.choices[0]?.delta?.content || ''
    }
    const clean = isQwen ? stripThink(buf) : buf
    onChunk(clean)
    return clean
  }

  if (provider === 'mistral') {
    const modelId = id.replace(/^mistral\//, '')
    let buf = ''
    const stream = await mistral.chat.stream({ model: modelId, messages })
    for await (const chunk of stream) {
      const text = chunk.data.choices[0]?.delta?.content || ''
      if (text) { buf += text; onChunk(text) }
    }
    return buf
  }

  // Gemini + OpenRouter: buffer and emit at once
  const text = await callModel(model, messages)
  onChunk(text)
  return text
}

// ── /api/config — expose pipeline config to frontend ─────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({ parallelCount: PIPELINE_CONFIG.parallelCount, wildcardCount: PIPELINE_CONFIG.wildcardCount })
})

// ── /api/config — update pipeline config at runtime ──────────────────────────
app.post('/api/config', (req, res) => {
  const { parallelCount, wildcardCount } = req.body
  if (typeof parallelCount === 'number' && parallelCount >= 2) {
    PIPELINE_CONFIG.parallelCount = parallelCount
  }
  if (typeof wildcardCount === 'number' && wildcardCount >= 0) {
    PIPELINE_CONFIG.wildcardCount = Math.min(wildcardCount, PIPELINE_CONFIG.parallelCount - 1)
  }
  console.log(`[Config] Updated: parallelCount=${PIPELINE_CONFIG.parallelCount} wildcardCount=${PIPELINE_CONFIG.wildcardCount}`)
  res.json({ parallelCount: PIPELINE_CONFIG.parallelCount, wildcardCount: PIPELINE_CONFIG.wildcardCount })
})


// ── /api/prewarm — predictive pre-warm on keypress ───────────────────────────
interface PrewarmEntry {
  token: string
  modelId: string
  result: Promise<string>
  resolvedText?: string
  createdAt: number
}
// keyed by `token:modelId`
const prewarmCache = new Map<string, PrewarmEntry>()

function clearPrewarmToken(token: string) {
  for (const key of prewarmCache.keys()) {
    if (key.startsWith(token + ':')) prewarmCache.delete(key)
  }
}

app.post('/api/prewarm', async (req, res) => {
  const { query, token } = req.body
  if (!query || !token) { res.status(400).json({ error: 'Missing query or token' }); return }

  // Cancel any existing prewarm for this token
  clearPrewarmToken(token)

  const promptType = classifyPrompt(query)
  const complexity = scoreComplexity(query)
  const config = complexity === 'simple' ? SIMPLE_PIPELINE_CONFIG : PIPELINE_CONFIG
  const { models } = selectModels(promptType, config, complexity, 'quorum')

  const modelIds: string[] = []
  for (const model of models) {
    const ragContext = getAspectContext(model.id, promptType, 'deterministic', models.indexOf(model))
    const messages = [
      { role: 'system', content: ragContext },
      { role: 'user', content: query },
    ]
    const entry: PrewarmEntry = {
      token,
      modelId: model.id,
      result: Promise.resolve(''),
      createdAt: Date.now(),
    }
    entry.result = callModel(model, messages).then(text => {
      entry.resolvedText = text
      return text
    }).catch(() => '')
    prewarmCache.set(`${token}:${model.id}`, entry)
    modelIds.push(model.id)
  }

  console.log(`[Prewarm] Started — ${models.map(m => m.label).join(', ')}, token: ${token}`)
  res.json({ ok: true, modelIds })
})

app.post('/api/chat', async (req, res) => {
  const { message, mode = 'quorum', prewarmToken } = req.body
  console.log('[/api/chat] Received:', message?.slice(0, 80))

  // ── Consume prewarm if available ─────────────────────────────────────────
  // Store all prewarm results keyed by modelId for fast lookup at Stage 1
  const prewarmResults: Record<string, string> = {}
  if (prewarmToken) {
    for (const [key, pw] of prewarmCache.entries()) {
      if (!key.startsWith(prewarmToken + ':')) continue
      if (Date.now() - pw.createdAt > 30000) continue
      try {
        const text = pw.resolvedText ?? await pw.result
        if (text) {
          prewarmResults[pw.modelId] = text
          console.log(`[Prewarm] HIT — model: ${pw.modelId}, chars: ${text.length}`)
        }
      } catch {}
    }
    clearPrewarmToken(prewarmToken)
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const send = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

  // ── Exact response cache check ───────────────────────────────────────────
  const ck = cacheKey(message)
  const cached = responseCache.get(ck)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log('[Cache] HIT —', message?.slice(0, 60))
    for (const event of cached.events) {
      res.write(`data: ${JSON.stringify({ ...event, cached: true })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  const cacheEvents: object[] = []
  const sendAndRecord = (payload: object) => {
    cacheEvents.push(payload)
    send(payload)
  }



  // ── Model selection ───────────────────────────────────────────────────────
  const promptType = classifyPrompt(message)
  const complexity = scoreComplexity(message)
  console.log(`[Pipeline] Complexity: ${complexity}`)
  const config = complexity === 'simple' ? SIMPLE_PIPELINE_CONFIG : PIPELINE_CONFIG

  // ── Circuit breaker probes ────────────────────────────────────────────────
  const allRegistryModels = Object.values(MODEL_REGISTRY)
  const probingModels = allRegistryModels.filter(m => getCircuitState(m.id) === 'probing')
  if (probingModels.length > 0) {
    console.log(`[CircuitBreaker] Probing ${probingModels.length} model(s): ${probingModels.map(m => m.label).join(', ')}`)
    await Promise.all(probingModels.map(async (m) => {
      try {
        await callModel(m, '.', 1)
        resetCircuitBreaker(m.id); saveCircuitState()
        console.log(`[CircuitBreaker] Probe success — ${m.label} restored`)
      } catch (e: any) {
        const is429 = e.message?.includes('429') || e.message?.includes('quota') || e.message?.includes('rate limit')
        if (is429) {
          tripCircuitBreaker(m.id, parseRetryDelay(e.message, m.provider), 'quota-429'); saveCircuitState()
          console.log(`[CircuitBreaker] Probe failed (429) — ${m.label} re-tripped`)
        } else {
          console.log(`[CircuitBreaker] Probe failed (other) — ${m.label} stays probing`)
        }
      }
    }))
  }

  const { models, synthesisModelId } = selectModels(promptType, config, complexity, mode)
  const synthModel = models.find(m => m.id === synthesisModelId) ?? models[0]

  console.log(`[Pipeline] Prompt type: ${promptType}`)
  console.log(`[Pipeline] Models: ${models.map(m => m.label).join(', ')}`)
  console.log(`[Pipeline] Synthesiser: ${synthModel.label}`)

  send({
    type: 'model_selection',
    models: models.map(m => ({ id: m.id, label: m.label, provider: m.provider, isWildcard: m.isWildcard })),
    synthesisModelId,
    promptType,
    complexity,
  })

  // ── Interface Contract — lock schema before parallel execution ──────────────
  const contract: InterfaceContract = generateContract(message, promptType)
  console.log(`[Contract] Generated for type: ${promptType}`)
  sendAndRecord({ type: 'contract', promptType, requiredStructure: contract.requiredStructure, forbiddenAntipatterns: contract.forbiddenAntipatterns })

  // ── Stage 1 — parallel responses ─────────────────────────────────────────
  console.log('[Stage 1] Starting')
  const responses: Record<string, string> = {}
  const scores: Record<string, number>    = {}
  for (const m of models) { responses[m.id] = ''; scores[m.id] = 0 }

  // Adaptive early-exit: once first model finishes, remaining models get a complexity-aware timeout
  let firstDone = false
  let adaptiveTimer: ReturnType<typeof setTimeout> | null = null
  const modelResolvers: Record<string, () => void> = {}
  const modelPromises = models.map(model => new Promise<void>(resolve => { modelResolvers[model.id] = resolve }))

  const stage1Work = models.map(async (model) => {
    try {
      console.log(`[Stage 1] ${model.label} starting`)
      const modelEntry = getModelEntry(model.id)
      const slotIndex = models.indexOf(model)
      const aspectContext = modelEntry
        ? getAspectContext(model.id, promptType, modelEntry.fit, slotIndex)
        : ''
      const codebaseContext = queryIndex(message)
      const fullSystemPrompt = [
        contract.systemPrompt,
        aspectContext || '',
        codebaseContext ? `// Relevant project files:\n${codebaseContext}` : '',
      ].filter(Boolean).join('\n\n')
      console.log(`[RAG] ${model.label} aspect context injected (${aspectContext.length} chars)${codebaseContext ? ` + ${codebaseContext.length} chars codebase context` : ''})`)
      // ── Use prewarm result if available for this model ───────────────────
      let text: string
      if (prewarmResults[model.id]) {
        text = prewarmResults[model.id]
        console.log(`[Prewarm] Injected into Stage 1 — ${model.label} (${text.length} chars)`)
        sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text })
        delete prewarmResults[model.id]
      } else {
        const s1TimeoutMs = complexity === 'simple' ? 15000 : 30000
        text = await withTimeout(
          callModelStreaming(
            model,
            [{ role: 'system', content: fullSystemPrompt }, { role: 'user', content: message }],
            (chunk) => sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text: chunk })
          ),
          s1TimeoutMs,
          ''
        )
      }
      responses[model.id] = text
      let result = evaluateIteration(
        { proposedSource: text, problemStatement: message, pipelineLayer: 1, promptType, contract },
        DEFAULT_SCORING_CONFIG, 1
      )

      // ── Linter Gate — one remediation pass if contract violated ────────────
      if (!result.shouldAccept && result.score.compositeScore < 0.75 && result.score.critiques.some(c => c.severity === 'blocking' || c.severity === 'major')) {
        console.log(`[Linter] ${model.label} failed gate (score: ${result.score.compositeScore.toFixed(2)}) — issuing remediation`)
        sendAndRecord({ type: 'linter', modelId: model.id, model: model.label, status: 'failed', score: result.score.compositeScore, critiqueText: result.critiqueText })

        const remediated = await withTimeout(
          callModelAgentic(model, [
            { role: 'system', content: contract.systemPrompt },
            { role: 'user', content: message },
            { role: 'assistant', content: text },
            {
              role: 'user',
              content:
                'Your previous response failed the pipeline quality gate. ' +
                'The following issues must be resolved before your response is accepted:\n\n' +
                result.critiqueText +
                '\n\nRewrite your response addressing every issue above. Conform strictly to the contract. You may use file tools if you need to inspect code.',
            },
          ]),
          20000,
          text
        )

        if (remediated && remediated !== text && remediated.length > 50) {
          responses[model.id] = remediated
          result = evaluateIteration(
            { proposedSource: remediated, problemStatement: message, pipelineLayer: 2, promptType, contract },
            DEFAULT_SCORING_CONFIG, 2
          )
          console.log(`[Linter] ${model.label} remediated — new score: ${result.score.compositeScore.toFixed(2)}`)
          sendAndRecord({ type: 'linter', modelId: model.id, model: model.label, status: 'remediated', score: result.score.compositeScore })
          // Stream the remediated text to UI so user sees the improved version
          sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text: '', remediated: true, newText: remediated })
        } else {
          console.log(`[Linter] ${model.label} remediation produced no improvement — keeping original`)
          sendAndRecord({ type: 'linter', modelId: model.id, model: model.label, status: 'unchanged' })
        }
      } else {
        console.log(`[Linter] ${model.label} passed gate (score: ${result.score.compositeScore.toFixed(2)})`)
        sendAndRecord({ type: 'linter', modelId: model.id, model: model.label, status: 'passed', score: result.score.compositeScore })
      }

      scores[model.id] = result.score.compositeScore
      sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text: '', done: true, score: scores[model.id] })
      console.log(`[Stage 1] ${model.label} done, score: ${scores[model.id]}`)
    } catch (e: any) {
      console.error(`[Stage 1] ${model.label} error:`, e.message)
      const is429s1 = e.message?.includes('429') || e.message?.includes('quota') || e.message?.includes('rate limit')
      const isDeadS1 = e.message?.includes('decommissioned') || e.message?.includes('model_decommissioned')
      if (isDeadS1) {
        tripCircuitBreaker(model.id, 30 * 24 * 60 * 60 * 1000, 'decommissioned'); saveCircuitState()
        console.log(`[CircuitBreaker] ${model.label} decommissioned — tripped for 30 days`)
      } else if (is429s1) {
        tripCircuitBreaker(model.id, parseRetryDelay(e.message, model.provider), 'quota-429'); saveCircuitState()
      } else {
        recordModelFailure(model.id)
      }
      sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text: 'Error: ' + e.message, done: true })
    }
    // Signal this model is done
    modelResolvers[model.id]?.()
    // After first completion, start adaptive timer for remaining models
    if (!firstDone) {
      firstDone = true
      const leadScore = scores[model.id] ?? 0
      const waitMs = complexity === 'simple'
        ? 3000
        : leadScore >= 0.85 ? 3000
        : leadScore >= 0.65 ? 5000
        : 8000
      console.log(`[Stage 1] First done (${model.label}, score: ${leadScore.toFixed(2)}) — waiting ${waitMs}ms for remaining`)
      adaptiveTimer = setTimeout(() => {
        for (const m of models) {
          if (scores[m.id] === 0 && !responses[m.id]) {
            console.log(`[Stage 1] Adaptive timeout — dropping ${m.label}`)
            recordModelFailure(m.id)
            modelResolvers[m.id]?.()
          }
        }
      }, waitMs)
    }
  })

  await Promise.all([...stage1Work, ...modelPromises])
  if (adaptiveTimer) clearTimeout(adaptiveTimer)
  console.log('[Stage 1] All done')

  // ── Stage 2 — scores ──────────────────────────────────────────────────────
  sendAndRecord({ type: 'stage', stage: 2, status: 'start' })
  sendAndRecord({ type: 'scores', scores })
  const _mids = Object.keys(scores); const _avg = _mids.length ? _mids.reduce((s, id) => s + scores[id], 0) / _mids.length : 0; sendAndRecord({ type: 'stage', stage: 2, status: 'done', avgScores: scores, pipelineAvg: parseFloat(_avg.toFixed(3)) });

  // ── Rollback Gate — quarantine failed tracks before Stage 3 ─────────────────
  const rolledBack = new Set<string>(
    models
      .filter(m =>
        !responses[m.id] ||
        responses[m.id].startsWith('Error:') ||
        responses[m.id].length < 20 ||
        scores[m.id] < 0.20
      )
      .map(m => m.id)
  )
  if (rolledBack.size > 0) {
    console.log(`[Rollback] Quarantining ${rolledBack.size} track(s): ${[...rolledBack].map(id => models.find(m => m.id === id)?.label).join(', ')}`)
    sendAndRecord({ type: 'rollback', rolledBack: [...rolledBack].map(id => ({ id, reason: responses[id]?.startsWith('Error:') ? 'error' : scores[id] < 0.20 ? 'score-floor' : 'empty' })) })
  }
  let activeModels = models.filter(m => !rolledBack.has(m.id))
  if (activeModels.length === 0) {
    const best = models.reduce((a, b) => (scores[a.id] ?? 0) >= (scores[b.id] ?? 0) ? a : b)
    rolledBack.delete(best.id)
    activeModels = [best]
    console.log(`[Rollback] All tracks failed — keeping best: ${best.label} (score: ${(scores[best.id] ?? 0).toFixed(2)})`)
  }
  console.log(`[Rollback] Active tracks: ${activeModels.map(m => m.label).join(', ')}`)

  // ── Stage 3 — cross-critique (skipped for simple queries) ──────────────────
  const revised: Record<string, string> = {}

  // Early exit: if any model scored >= 0.85, skip Stage 3+4 entirely
  const maxScore = Math.max(...activeModels.map(m => scores[m.id] ?? 0))
  const earlyExit = maxScore >= 0.85
  if (earlyExit) {
    console.log(`[Early Exit] Max score ${maxScore.toFixed(2)} >= 0.85 — skipping Stage 3+4`)
    sendAndRecord({ type: 'stage', stage: 3, status: 'start' })
    sendAndRecord({ type: 'stage', stage: 3, status: 'done' })
    sendAndRecord({ type: 'stage', stage: 4, status: 'start' })
    sendAndRecord({ type: 'stage', stage: 4, status: 'done' })
  } else if (complexity === 'simple') {
    console.log('[Stage 3] Skipped — simple query fast-path')
    sendAndRecord({ type: 'stage', stage: 3, status: 'start' })
    sendAndRecord({ type: 'stage', stage: 3, status: 'done' })
    sendAndRecord({ type: 'stage', stage: 4, status: 'start' })
    sendAndRecord({ type: 'stage', stage: 4, status: 'done' })
  } else {
  // ── Stages 3+4 collapsed — critique-and-revise in one parallel wave ─────────
  console.log('[Stage 3+4] Starting collapsed critique-revise')
  sendAndRecord({ type: 'stage', stage: 3, status: 'start' })
  sendAndRecord({ type: 'stage', stage: 4, status: 'start' })

  for (const m of activeModels) revised[m.id] = ''

  // Each model sees all peer responses and produces its improved answer in one call
  await Promise.all(activeModels.map(async (model) => {
    const peerContext = activeModels
      .filter(m => m.id !== model.id)
      .map(m => `${m.label}'s response:\n${responses[m.id]}`)
      .join('\n\n---\n\n')

    try {
      sendAndRecord({ type: 'critique', criticId: model.id, targetId: model.id, critic: model.label, target: model.label, text: '', status: 'start' })
      const result = await withTimeout(
        callModel(model, [
          {
            role: 'system',
            content:
              mode === 'seeker'
                ? 'You are one model in an adversarial AI pipeline. ' +
                  'You have seen your own analysis and peer analyses. ' +
                  'Your task: attack the peer findings. Find flaws they missed, challenge their assumptions, ' +
                  'identify edge cases and failure modes they overlooked. Be precise and ruthless.'
                : 'You are one model in a multi-model AI pipeline. ' +
                  'You have seen your own response and the responses from peer models. ' +
                  'Your task: produce a single improved response that incorporates the best insights from all responses, ' +
                  'fixes any errors in your original, and adds anything important that was missed. ' +
                  'Be direct and concise. Do not narrate what you are doing — just deliver the improved answer.',
          },
          {
            role: 'user',
            content:
              `Original question: ${message}\n\n` +
              `Your previous response:\n${responses[model.id]}\n\n` +
              `Peer responses for reference:\n${peerContext || 'No peer responses available.'}\n\n` +
              `Write your improved response now.`,
          },
        ]),
        60000,
        responses[model.id]
      )
      revised[model.id] = result || responses[model.id]
      sendAndRecord({ type: 'critique', criticId: model.id, targetId: model.id, critic: model.label, target: model.label, text: revised[model.id], done: true })
      sendAndRecord({ type: 'revision', modelId: model.id, model: model.label, text: revised[model.id] })
    } catch (e: any) {
      console.error(`[Stage 3+4] ${model.label} error:`, e.message)
      const is429s34 = e.message?.includes('429') || e.message?.includes('quota') || e.message?.includes('rate limit')
      const isDeadS34 = e.message?.includes('decommissioned') || e.message?.includes('model_decommissioned')
      if (isDeadS34) {
        tripCircuitBreaker(model.id, 30 * 24 * 60 * 60 * 1000, 'decommissioned'); saveCircuitState()
        console.log(`[CircuitBreaker] ${model.label} decommissioned — tripped for 30 days`)
      } else if (is429s34) {
        tripCircuitBreaker(model.id, parseRetryDelay(e.message, model.provider), 'quota-429'); saveCircuitState()
      } else {
        recordModelFailure(model.id)
      }
      revised[model.id] = responses[model.id]
      sendAndRecord({ type: 'revision', modelId: model.id, model: model.label, text: revised[model.id] })
    }
  }))

  sendAndRecord({ type: 'stage', stage: 3, status: 'done' })
  sendAndRecord({ type: 'stage', stage: 4, status: 'done' })

  } // end complexity === 'complex' block

  // Ensure revised is populated for simple path or early exit (use stage 1 responses directly)
  if (complexity === 'simple' || earlyExit) {
    for (const m of activeModels) {
      revised[m.id] = responses[m.id] || ''
    }
  }

  // ── Stage 5 — synthesis ───────────────────────────────────────────────────
  console.log('[Stage 5] Starting synthesis')
  sendAndRecord({ type: 'stage', stage: 5, status: 'start' })

  // Best synthesiser = highest scorer among active (non-rolled-back) tracks
  const activeSynthModel = activeModels
    .filter(m => revised[m.id] && revised[m.id].length > 0 && !revised[m.id].startsWith('Error:'))
    .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))[0]
    ?? activeModels[0]
    ?? models[0]

  console.log(`[Stage 5] Synthesiser: ${activeSynthModel.label}`)

  const revisedEntries = models
    .filter(m => revised[m.id])
    .map(m => `${m.label} revised response:\n${revised[m.id]}`)
    .join('\n\n')

  try {
    const synthesisText = await withTimeout(
      callModel(activeSynthModel, [
        {
          role: 'system',
          content:
            mode === 'seeker'
              ? 'You are the synthesis layer of an adversarial AI pipeline. ' +
                'You have attack analyses from multiple models. ' +
                'Your job: produce a ranked vulnerability report. ' +
                'Lead with the most critical finding. Be precise, not exhaustive. ' +
                'Format: numbered list, most critical first.'
              : mode === 'code'
              ? 'You are the synthesis layer of a multi-model AI pipeline specialising in code. ' +
                'You have revised responses from different models. ' +
                'Your job: produce ONE definitive, working code solution. ' +
                'Prefer correctness over brevity. Include all necessary code. ' +
                'Explain key decisions briefly after the code block.'
              : 'You are the synthesis layer of a multi-model AI debate pipeline. ' +
                'You have revised responses from different models. ' +
                'Your job: produce ONE definitive, high-quality answer. ' +
                'Combine the strongest elements. Eliminate redundancy. ' +
                'Resolve contradictions using best reasoning. ' +
                'Write as a single coherent response, not a comparison.',
        },
        {
          role: 'user',
          content:
            `Original question: ${message}\n\n` +
            `${revisedEntries}\n\n` +
            `Synthesise these into one definitive answer.`,
        },
      ]),
      45000,
      revised[activeSynthModel.id] || Object.values(revised).find(r => r) || ''
    )
    sendAndRecord({ type: 'synthesis', modelId: activeSynthModel.id, model: activeSynthModel.label, text: synthesisText, done: true })
  } catch (e: any) {
    console.error('[Stage 5] Synthesis error:', e.message)
    const fallback = revised[activeSynthModel.id] || Object.values(revised).find(r => r) || ''
    sendAndRecord({ type: 'synthesis', modelId: activeSynthModel.id, model: activeSynthModel.label, text: fallback, done: true })
  }

  sendAndRecord({ type: 'stage', stage: 5, status: 'done' })
  console.log('[Stage 5] Pipeline complete')


  // ── Write to cache ───────────────────────────────────────────────────────
  pruneCache()
  responseCache.set(ck, { events: cacheEvents, timestamp: Date.now() })
  console.log(`[Cache] STORED — cache size: ${responseCache.size}`)

  res.write('data: [DONE]\n\n')
  res.end()
})

// ── /api/verify — Code execution and self-healing ────────────────────────
app.post('/api/verify', async (req, res) => {
  const { code, language, originalPrompt = '' } = req.body
  if (!code) { res.status(400).json({ error: 'No code provided' }); return }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const send = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

  const { executeCode, detectLanguage } = await import('./src/CrucibleEngine/sandbox')
  const { parseError, attemptAlgorithmicFix, buildSurgicalPrompt } = await import('./src/CrucibleEngine/error-intelligence')

  const lang = language ?? detectLanguage(code)
  send({ type: 'verify_start', language: lang })
  send({ type: 'verify_status', message: 'Running verification...' })

  try {
    // ── Round 1: execute as-is ──────────────────────────────────────────
    const result = await executeCode(code, lang, 5000)

    if (result.success) {
      send({ type: 'verify_status', message: '✓ Executed successfully' })
      send({ type: 'verify_clean' })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // ── Parse the error ─────────────────────────────────────────────────
    const parsed = parseError(result, code)
    send({ type: 'verify_status', message: `⚠ ${parsed.type} error detected — analyzing...` })

    // ── Round 2: attempt algorithmic fix ────────────────────────────────
    if (parsed.fixable) {
      const fix = attemptAlgorithmicFix(code, parsed, lang)
      if (fix.fixed) {
        send({ type: 'verify_status', message: `Applying fix: ${fix.description}` })

        // Re-verify the patched code
        const recheck = await executeCode(fix.code, lang, 5000)
        if (recheck.success) {
          send({ type: 'verify_status', message: '✓ Fixed and verified' })
          send({ type: 'verify_fixed', code: fix.code, patchCount: 1, strategy: fix.strategy })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // Second algorithmic attempt on the patched code
        const parsed2 = parseError(recheck, fix.code)
        if (parsed2.fixable) {
          const fix2 = attemptAlgorithmicFix(fix.code, parsed2, lang)
          if (fix2.fixed) {
            const recheck2 = await executeCode(fix2.code, lang, 5000)
            if (recheck2.success) {
              send({ type: 'verify_status', message: '✓ Fixed and verified' })
              send({ type: 'verify_fixed', code: fix2.code, patchCount: 2, strategy: fix2.strategy })
              res.write('data: [DONE]\n\n')
              res.end()
              return
            }
          }
        }
      }
    }

    // ── Round 3: escalate to surgical model re-injection ────────────────
    send({ type: 'verify_status', message: '⚠ Escalating to model correction...' })
    const surgicalPrompt = buildSurgicalPrompt(originalPrompt, code, parsed, lang)
    send({ type: 'verify_needs_model', error: parsed, surgicalPrompt })

  } catch (e: any) {
    console.error('[Verify] Error:', e.message)
    send({ type: 'verify_failed', error: e.message })
  }

  res.write('data: [DONE]\n\n')
  res.end()
})

app.post('/api/terminal', async (req, res) => {
  const { command } = req.body
  exec(command, { cwd: '/Users/justin/Desktop/crucible' }, (error, stdout, stderr) => {
    res.json({ output: stdout || stderr || error?.message || '' })
  })
})

// ── File Tools (Agentic) ─────────────────────────────────────────────────────
app.post('/api/file/read', (req, res) => {
  const { filePath } = req.body
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: 'File not found' })
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    res.json({ success: true, content, filePath })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/file/write', (req, res) => {
  const { filePath, content, projectPath, message } = req.body
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'filePath and content required' })
  }
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    if (projectPath) createCheckpoint(projectPath, message || 'before edit')
    fs.writeFileSync(filePath, content, 'utf-8')
    console.log(`[FileWrite] ${filePath}`)
    res.json({ success: true, filePath })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/file/list', (req, res) => {
  const { dirPath } = req.body
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ error: 'Directory not found' })
  }
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    res.json({
      success: true,
      entries: entries.map(e => ({ name: e.name, isDir: e.isDirectory() }))
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ── Checkpoint API ────────────────────────────────────────────────────────────
app.post('/api/checkpoint', (req, res) => {
  const { projectPath, message } = req.body
  if (!projectPath) return res.status(400).json({ error: 'projectPath required' })
  const checkpoint = createCheckpoint(projectPath, message || 'manual checkpoint')
  res.json({ success: !!checkpoint, checkpoint })
})

app.post('/api/checkpoint/rollback', (req, res) => {
  const { hash, projectPath } = req.body
  if (!hash || !projectPath) return res.status(400).json({ error: 'hash and projectPath required' })
  const success = rollbackToCheckpoint(hash, projectPath)
  res.json({ success })
})

app.get('/api/checkpoints', (req, res) => {
  const projectPath = req.query.projectPath as string | undefined
  res.json({ checkpoints: getCheckpoints(projectPath) })
})

// ── Codebase Indexer ─────────────────────────────────────────────────────────
app.post('/api/index', async (req, res) => {
  const { rootPath } = req.body
  if (!rootPath || !fs.existsSync(rootPath)) {
    return res.status(400).json({ error: 'Invalid path' })
  }
  try {
    const index = buildIndex(rootPath)
    res.json({ success: true, fileCount: index.files.length, rootPath })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/index/stats', (req, res) => {
  const stats = getIndexStats()
  if (!stats) return res.json({ indexed: false })
  res.json({ indexed: true, ...stats })
})

const httpServer = createServer(app)
httpServer.keepAliveTimeout = 620000
httpServer.headersTimeout   = 630000
httpServer.listen(3001, '0.0.0.0', () => {
  console.log('✅ Crucible server running on port 3001')
  prewarmPython()
})
process.on('SIGTERM', () => httpServer.close())
process.on('SIGINT',  () => httpServer.close())
setInterval(() => {}, 1 << 30)
