// ── localModels/registry.ts — on-device model registry (Track A) ──
//
// Composes the LocalModel[] the router/orchestrator fan out over. Two model families today:
//
//   1. Apple Foundation Models — the OS-resident chat daemon (port 11435). Always listed;
//      health()-gated at call time. This is the one model guaranteed present on a Mac.
//   2. ONNX chat models (SmolLM2 / Gemma) run via @xenova/transformers (onnxAdapter.ts).
//      These are only listed when their weights are actually cached on disk — an uninstalled
//      model must not enter the pool and waste a fan-out slot on a guaranteed ok:false. So the
//      registry probes the transformers.js cache dir synchronously and includes an ONNX model
//      iff its artifact is present. In an environment with nothing downloaded (e.g. CI), this
//      returns exactly [apple-fm] — identical to the previous behavior.
//
// The cache probe is injectable (`RegistryDeps.exists`) so the include/exclude logic is
// benched offline without touching the filesystem (see __registry_bench.ts).

import fs from 'fs'
import path from 'path'
import type { LocalModel, LocalModelInfo } from './contracts'
import { createOnnxModel, type OnnxModelSpec } from './onnxAdapter'

const LOCAL_INFERENCE_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'

// ── Apple Foundation Models daemon ──────────────────────────────────────────────
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

// ── ONNX chat candidates (transformers.js) ──────────────────────────────────────
// Small, genuinely on-device instruct models. fit/quality are conservative priors the
// router uses for auto-mode selection; they can be tuned as real bench data accrues.
export const ONNX_CANDIDATES: OnnxModelSpec[] = [
  {
    repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    maxNewTokens: 768,
    info: {
      id: 'smollm2-1.7b', family: 'smollm', params: 1.7, provider: 'local', quality: 6,
      fit: { coding: 6, reasoning: 6, creative: 6, factual: 5, math: 5, general: 6 },
      sizeBytes: 1_800_000_000, installed: false, residentRAMBytes: 2_000_000_000,
    },
  },
  {
    repo: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    maxNewTokens: 512,
    info: {
      id: 'smollm2-360m', family: 'smollm', params: 0.36, provider: 'local', quality: 4,
      fit: { coding: 4, reasoning: 4, creative: 5, factual: 4, math: 3, general: 5 },
      sizeBytes: 380_000_000, installed: false, residentRAMBytes: 500_000_000,
    },
  },
  {
    repo: 'Xenova/gemma-2-2b-it',
    maxNewTokens: 768,
    info: {
      id: 'gemma-2-2b', family: 'gemma', params: 2, provider: 'local', quality: 7,
      fit: { coding: 6, reasoning: 7, creative: 7, factual: 6, math: 5, general: 7 },
      sizeBytes: 2_400_000_000, installed: false, residentRAMBytes: 2_600_000_000,
    },
  },
]

export interface RegistryDeps {
  /** True iff the given transformers.js repo has weights cached locally. Injectable for tests. */
  exists?: (repo: string) => boolean
}

/** transformers.js v2 caches under TRANSFORMERS_CACHE (or ./.cache), one dir per repo. */
function transformersCacheDirs(): string[] {
  const dirs = [process.env.TRANSFORMERS_CACHE, path.join(process.cwd(), '.cache'), path.join(process.cwd(), 'node_modules', '@xenova', 'transformers', '.cache')]
  return dirs.filter((d): d is string => !!d)
}

function defaultRepoInstalled(repo: string): boolean {
  return transformersCacheDirs().some(dir => fs.existsSync(path.join(dir, repo)))
}

/** Returns every on-device model available RIGHT NOW: Apple FM plus any ONNX candidate whose
 *  weights are cached. Health is checked lazily by callers, not here. */
export function getRegistry(deps?: RegistryDeps): LocalModel[] {
  const exists = deps?.exists ?? defaultRepoInstalled
  const onnx = ONNX_CANDIDATES
    .filter(spec => exists(spec.repo))
    .map(spec => createOnnxModel({ ...spec, info: { ...spec.info, installed: true } }))
  return [appleFm, ...onnx]
}
