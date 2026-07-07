// ── localModels/registry.ts — PLACEHOLDER, owned by Track A ──
//
// Track A had not landed registry.ts/onnxAdapter.ts/appleFmAdapter.ts when Track B
// needed a real getRegistry() to wire and bench the router/orchestrator end to end.
// This is a minimal stand-in: wraps the existing Apple FM daemon (the one on-device
// model that actually exists today) as a single LocalModel. Track A should replace
// this file wholesale once onnxAdapter.ts (SmolLM2/Gemma) lands — nothing else in
// Track B's code depends on this file's internals, only on getRegistry()'s return
// shape (LocalModel[] from contracts.ts).

import type { LocalModel, LocalModelInfo } from './contracts'

const LOCAL_INFERENCE_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'

const appleFmInfo: LocalModelInfo = {
  id: 'apple-fm',
  family: 'apple-fm',
  params: 3,
  provider: 'local',
  quality: 6,
  fit: { coding: 5, reasoning: 6, creative: 6, factual: 6, math: 4, general: 7 },
  sizeBytes: 0, // resident in the OS, not a downloaded artifact
  installed: true,
  residentRAMBytes: 0,
}

async function* singleChunk(text: string): AsyncIterable<string> {
  yield text
}

const appleFm: LocalModel = {
  info: appleFmInfo,
  async health() {
    try {
      const res = await fetch(`${LOCAL_INFERENCE_URL}/health`, { signal: AbortSignal.timeout(2000) })
      const data = await res.json()
      return data?.available === true
    } catch {
      return false
    }
  },
  generate(prompt, opts) {
    const history = opts?.history ?? []
    const messages = [
      { role: 'system', content: 'You are Crucible, answering entirely on-device. Be accurate and direct.' },
      ...history.flatMap(h => [
        { role: 'user', content: h.user },
        { role: 'assistant', content: h.assistant },
      ]),
      { role: 'user', content: prompt },
    ]
    const gen = async (): Promise<string> => {
      try {
        const res = await fetch(`${LOCAL_INFERENCE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'apple-fm', messages, max_tokens: 1024, temperature: 0.7 }),
          signal: opts?.signal ?? AbortSignal.timeout(30000),
        })
        if (!res.ok) return ''
        const data = await res.json()
        return data.choices?.[0]?.message?.content ?? ''
      } catch {
        return ''
      }
    }
    return {
      [Symbol.asyncIterator]() {
        let done = false
        return {
          async next() {
            if (done) return { done: true, value: undefined as any }
            done = true
            const text = await gen()
            return { done: false, value: text }
          },
        }
      },
    }
  },
}

/** Cached at module scope — health is checked lazily by callers, not on every getRegistry() call. */
export function getRegistry(): LocalModel[] {
  return [appleFm]
}
