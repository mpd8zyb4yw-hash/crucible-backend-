// ── localModels/orchestrator.ts — parallel fan-out over a RouteDecision ──

import type { LocalModel, ModelOutput, RouteDecision } from './contracts'

export interface OrchestrateOpts {
  registry: LocalModel[]
  history?: { user: string; assistant: string }[]
  /** Per-model timeout; a slow model never blocks the others. Default 20s. */
  timeoutMs?: number
  signal?: AbortSignal
}

async function runOne(model: LocalModel, prompt: string, opts: OrchestrateOpts): Promise<ModelOutput> {
  const t0 = Date.now()
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  opts.signal?.addEventListener('abort', onAbort)
  const timeoutMs = opts.timeoutMs ?? 20000
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    let text = ''
    for await (const chunk of model.generate(prompt, { history: opts.history, signal: ac.signal })) {
      text += chunk
    }
    return { modelId: model.info.id, text, latencyMs: Date.now() - t0, ok: text.trim().length > 0 }
  } catch {
    return { modelId: model.info.id, text: '', latencyMs: Date.now() - t0, ok: false }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** Fires every model named in the decision in parallel; failures/timeouts degrade to ok:false, never throw and never block the others. */
export async function orchestrate(decision: RouteDecision, prompt: string, opts: OrchestrateOpts): Promise<ModelOutput[]> {
  const byId = new Map(opts.registry.map(m => [m.info.id, m]))
  const models = decision.modelIds.map(id => byId.get(id)).filter((m): m is LocalModel => !!m)
  if (models.length === 0) return []
  return Promise.all(models.map(m => runOne(m, prompt, opts)))
}
