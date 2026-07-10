// ── localModels/onnxAdapter.ts — text-generation LocalModel over transformers.js (Track A) ──
//
// Wraps an on-device ONNX chat model (SmolLM2 / Gemma family, run via @xenova/transformers)
// as a LocalModel that satisfies ../contracts. Mirrors the proven lazy-load pattern already
// used for embeddings in masterpiece/corpus/embed.ts: dynamic import, cache the pipeline,
// flip an availability flag off the moment a load fails, and degrade gracefully to an empty
// result (ok:false upstream) instead of throwing. No network at request time — transformers.js
// serves the model from its local cache; if the artifact isn't there, the model reports
// unhealthy and the orchestrator simply skips it (partial-result tolerance).
//
// Everything that touches @xenova/transformers is behind an injectable `loadGenerator` dep so
// the prompt-building / output-extraction / abort / error logic is unit-benchable offline with a
// fake engine (see __onnx_bench.ts). The default loader is the only part that needs real weights.

import type { LocalModel, LocalModelInfo } from './contracts'

/** Minimal shape we use from a transformers.js text-generation pipeline.
 *  `onToken`, when provided, is called with each decoded token as it streams — the default
 *  loader wires it to a transformers.js TextStreamer; a generator that ignores it simply runs
 *  non-streaming and the adapter falls back to emitting the final text as one chunk. */
export type OnnxGenerator = (
  input: unknown,
  opts: Record<string, unknown>,
  onToken?: (token: string) => void,
) => Promise<unknown>

export interface OnnxDeps {
  /** Loads (and caches) the generation pipeline for `repo`. Returns null if unavailable. */
  loadGenerator: (repo: string) => Promise<OnnxGenerator | null>
  now?: () => number
}

/** A ChatML-ish message list the pipeline's tokenizer chat-template consumes. */
export function buildMessages(
  prompt: string,
  history: { user: string; assistant: string }[] = [],
): { role: string; content: string }[] {
  return [
    { role: 'system', content: 'You are Crucible, answering entirely on-device. Be accurate and direct. If you are unsure, say so plainly rather than inventing specifics.' },
    ...history.flatMap(h => [
      { role: 'user', content: h.user },
      { role: 'assistant', content: h.assistant },
    ]),
    { role: 'user', content: prompt },
  ]
}

/**
 * Normalize the many shapes transformers.js text-generation can return into the assistant's
 * reply text. Handles: an array of chat messages (chat-template mode — take the last
 * assistant turn), an array of `{ generated_text }` records, a single record, or a raw string
 * (strip the echoed prompt prefix when present). Pure + total — never throws.
 */
export function extractGeneratedText(raw: unknown, promptText: string): string {
  const fromGenerated = (g: unknown): string => {
    if (typeof g === 'string') {
      // Some pipelines echo the prompt; drop it if the output starts with it.
      return g.startsWith(promptText) ? g.slice(promptText.length).trim() : g.trim()
    }
    if (Array.isArray(g)) {
      // Chat-template mode returns the full message list; the reply is the last assistant turn.
      const assistants = g.filter((m: any) => m && m.role === 'assistant')
      const last = assistants[assistants.length - 1] ?? g[g.length - 1]
      return typeof last?.content === 'string' ? last.content.trim() : ''
    }
    return ''
  }

  if (raw == null) return ''
  if (typeof raw === 'string') return fromGenerated(raw)
  if (Array.isArray(raw)) {
    const first = raw[0] as any
    if (first && 'generated_text' in first) return fromGenerated(first.generated_text)
    // Already a bare message list.
    return fromGenerated(raw)
  }
  if (typeof raw === 'object' && 'generated_text' in (raw as any)) {
    return fromGenerated((raw as any).generated_text)
  }
  return ''
}

export interface OnnxModelSpec {
  info: LocalModelInfo
  /** HF repo id transformers.js resolves, e.g. 'HuggingFaceTB/SmolLM2-1.7B-Instruct'. */
  repo: string
  maxNewTokens?: number
  temperature?: number
}

/** The default loader: dynamic-import transformers.js and build a text-generation pipeline,
 *  cached per repo. Any failure (package missing, weights not cached, no network) flips the
 *  repo to permanently-unavailable for the process, exactly like the embedder does. */
const _generators = new Map<string, Promise<OnnxGenerator | null>>()
const _deadRepos = new Set<string>()
async function defaultLoadGenerator(repo: string): Promise<OnnxGenerator | null> {
  if (_deadRepos.has(repo)) return null
  let pending = _generators.get(repo)
  if (!pending) {
    pending = (async () => {
      try {
        const mod = await import('@xenova/transformers')
        const { pipeline } = mod
        const TextStreamer = (mod as any).TextStreamer
        const gen = await pipeline('text-generation', repo, { quantized: true })
        return ((input, opts, onToken) => {
          let streamer: unknown
          if (onToken && TextStreamer) {
            streamer = new TextStreamer((gen as any).tokenizer, { skip_prompt: true, callback_function: onToken })
          }
          return (gen as any)(input, streamer ? { ...opts, streamer } : opts)
        }) as OnnxGenerator
      } catch {
        _deadRepos.add(repo)
        return null
      }
    })()
    _generators.set(repo, pending)
  }
  return pending
}

export function createOnnxModel(spec: OnnxModelSpec, deps?: Partial<OnnxDeps>): LocalModel {
  const loadGenerator = deps?.loadGenerator ?? defaultLoadGenerator
  const now = deps?.now ?? Date.now
  const maxNewTokens = spec.maxNewTokens ?? 512
  const temperature = spec.temperature ?? 0.7

  // Streams tokens as they decode: a push (TextStreamer callback) → pull (async iterator)
  // bridge with a simple queue + one-slot waiter. If the generator never streams a token
  // (a non-streaming engine, or no TextStreamer), the final returned text is emitted as one
  // chunk instead — so downstream (which just concatenates chunks) is identical either way.
  async function* streamGeneration(
    prompt: string,
    history: { user: string; assistant: string }[],
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    void now // reserved for latency instrumentation; keeps the dep injectable
    if (signal?.aborted) return
    const gen = await loadGenerator(spec.repo)
    if (!gen) return
    const messages = buildMessages(prompt, history)

    const queue: string[] = []
    let wake: (() => void) | null = null
    let finished = false
    let streamedAny = false
    const bump = () => { if (wake) { const w = wake; wake = null; w() } }

    const onToken = (token: string) => {
      if (signal?.aborted || !token) return
      queue.push(token)
      streamedAny = true
      bump()
    }

    const run = (async () => {
      try {
        const raw = await gen(
          messages,
          { max_new_tokens: maxNewTokens, temperature, do_sample: temperature > 0, return_full_text: false, signal },
          onToken,
        )
        // Non-streaming fallback: nothing pushed via onToken → emit the extracted final text.
        if (!streamedAny && !signal?.aborted) {
          const text = extractGeneratedText(raw, prompt)
          if (text) queue.push(text)
        }
      } catch {
        // swallow — a failed generation simply yields whatever streamed before the throw
      } finally {
        finished = true
        bump()
      }
    })()

    try {
      while (true) {
        if (queue.length > 0) { yield queue.shift()!; continue }
        if (finished || signal?.aborted) break
        await new Promise<void>(res => { wake = res })
      }
    } finally {
      await run // never leave the generation promise dangling
    }
  }

  return {
    info: spec.info,
    async health() {
      // Healthy iff the pipeline can be constructed (weights present in the local cache).
      const gen = await loadGenerator(spec.repo).catch(() => null)
      return gen != null
    },
    generate(prompt, opts) {
      return streamGeneration(prompt, opts?.history ?? [], opts?.signal)
    },
  }
}
