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

/** Minimal shape we use from a transformers.js text-generation pipeline. */
export type OnnxGenerator = (
  input: unknown,
  opts: Record<string, unknown>,
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
        const { pipeline } = await import('@xenova/transformers')
        const gen = await pipeline('text-generation', repo, { quantized: true })
        return ((input, opts) => (gen as any)(input, opts)) as OnnxGenerator
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

  async function runGeneration(prompt: string, history: { user: string; assistant: string }[], signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return ''
    const gen = await loadGenerator(spec.repo)
    if (!gen) return ''
    const messages = buildMessages(prompt, history)
    try {
      const raw = await gen(messages, {
        max_new_tokens: maxNewTokens,
        temperature,
        do_sample: temperature > 0,
        return_full_text: false,
      })
      if (signal?.aborted) return ''
      return extractGeneratedText(raw, prompt)
    } catch {
      return ''
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
      const history = opts?.history ?? []
      return {
        [Symbol.asyncIterator]() {
          let done = false
          return {
            async next() {
              if (done) return { done: true, value: undefined as any }
              done = true
              void now // reserved for future latency instrumentation; keeps dep injectable
              const text = await runGeneration(prompt, history, opts?.signal)
              return { done: false, value: text }
            },
          }
        },
      }
    },
  }
}
