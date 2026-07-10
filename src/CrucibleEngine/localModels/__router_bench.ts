// ── localModels/__router_bench.ts — offline, pure bench for router + orchestrator ──
// Run: npx tsx src/CrucibleEngine/localModels/__router_bench.ts
// No network, no real models — everything here is a stub LocalModel.

import type { LocalModel, LocalModelInfo } from './contracts'
import { route } from './router'
import { resolvePolicy } from './policy'
import { orchestrate } from './orchestrator'

let failures = 0
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`) } else { console.log(`ok: ${msg}`) }
}

function stubModel(id: string, fit: Partial<LocalModelInfo['fit']>, opts?: { installed?: boolean; delayMs?: number; fail?: boolean; family?: string }): LocalModel {
  const info: LocalModelInfo = {
    id, family: opts?.family ?? 'stub', params: 1, provider: 'local', quality: 7,
    fit: { coding: 5, reasoning: 5, creative: 5, factual: 5, math: 5, general: 5, ...fit },
    sizeBytes: 0, installed: opts?.installed ?? true, residentRAMBytes: 1,
  }
  return {
    info,
    async health() { return true },
    generate(prompt, genOpts) {
      return {
        [Symbol.asyncIterator]() {
          let done = false
          return {
            async next() {
              if (done) return { done: true, value: undefined as any }
              done = true
              if (opts?.fail) throw new Error('stub failure')
              if (opts?.delayMs) {
                await new Promise((resolve, reject) => {
                  const t = setTimeout(resolve, opts.delayMs)
                  genOpts?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
                })
              }
              return { done: false, value: `[${id}] answer to: ${prompt}` }
            },
          }
        },
      }
    },
  }
}

async function main() {
  // ── auto: trivial query -> 1 model, prefers the higher-fit one ──
  const fast = stubModel('fast-general', { general: 9, factual: 9 })
  const strong = stubModel('strong-coder', { coding: 10, reasoning: 9 })
  const registry = [fast, strong]

  const trivialDecision = route('what time is it', [], { registry, policy: resolvePolicy({}) })
  assert(trivialDecision.mode === 'auto', 'trivial query resolves to auto mode')
  assert(trivialDecision.modelIds.length === 1, 'trivial query picks exactly one model')
  assert(trivialDecision.modelIds[0] === 'fast-general', 'trivial factual query prefers the higher-fit model')

  // ── auto: complex multi-part query -> subset of up to 3 ──
  const complexDecision = route(
    'please (1) refactor this function (2) then write tests and (3) explain the approach in detail',
    [], { registry, policy: resolvePolicy({}) },
  )
  assert(complexDecision.modelIds.length === Math.min(2, registry.length), 'complex query widens the subset (capped by registry size)')

  // ── auto diversity: a complex query must not pick two near-identical same-family models
  //    when a lower-fit but different-family model is available (better consensus inputs) ──
  const smA = stubModel('smol-a', { reasoning: 10 }, { family: 'smollm' })
  const smB = stubModel('smol-b', { reasoning: 9 }, { family: 'smollm' })
  const gem = stubModel('gemma-1', { reasoning: 8 }, { family: 'gemma' })
  const complexPrompt = 'please (1) analyze this (2) then argue the counterpoint (3) and reconcile them'
  const div = route(complexPrompt, [], { registry: [smA, smB, gem], policy: resolvePolicy({}) })
  assert(div.modelIds.length === 3, 'complex query with 3 models picks all 3 (subset cap)')
  // With only 2 slots (RAM budget that fits 2), the diverse picker must include the top model
  // + a different family, not the two same-family top-fit models.
  const twoBudget = route(complexPrompt, [], { registry: [smA, smB, gem], policy: resolvePolicy({}), ramBudgetBytes: 2 })
  assert(twoBudget.modelIds[0] === 'smol-a', 'diverse picker still leads with the best-fit model')
  assert(twoBudget.modelIds.includes('gemma-1') && !twoBudget.modelIds.includes('smol-b'),
    'second slot goes to a different family (gemma) over the same-family runner-up (smol-b)')

  // ── all: every installed model, regardless of fit ──
  const notInstalled = stubModel('uninstalled-model', {}, { installed: false })
  const allDecision = route('anything', [], { registry: [...registry, notInstalled], policy: resolvePolicy({ requestMode: 'all' }) })
  assert(allDecision.mode === 'all', 'all mode reports mode all')
  assert(allDecision.modelIds.length === 2, 'all mode returns every installed model, excluding uninstalled ones')

  // ── single: pinned model ──
  const singleDecision = route('anything', [], { registry, policy: resolvePolicy({ requestMode: 'single', singleModelId: 'strong-coder' }) })
  assert(singleDecision.mode === 'single' && singleDecision.modelIds[0] === 'strong-coder', 'single mode pins the requested model')

  // ── single with unknown model id degrades to auto instead of firing nothing ──
  const badSingle = route('anything', [], { registry, policy: resolvePolicy({ requestMode: 'single', singleModelId: 'does-not-exist' }) })
  assert(badSingle.modelIds.length > 0, 'single mode with an unknown model id degrades to auto rather than empty')

  // ── orchestrator: partial-result tolerance — a failing model never blocks the rest ──
  const okModel = stubModel('ok-model', {})
  const failModel = stubModel('fail-model', {}, { fail: true })
  const outs = await orchestrate({ modelIds: ['ok-model', 'fail-model'], mode: 'all', reason: 'bench' }, 'hi', { registry: [okModel, failModel] })
  assert(outs.length === 2, 'orchestrate returns an output for every requested model')
  assert(outs.find(o => o.modelId === 'ok-model')?.ok === true, 'the healthy model succeeds')
  assert(outs.find(o => o.modelId === 'fail-model')?.ok === false, 'the failing model reports ok:false instead of throwing')

  // ── orchestrator: per-model timeout / cancellation ──
  const slowModel = stubModel('slow-model', {}, { delayMs: 500 })
  const t0 = Date.now()
  const timedOut = await orchestrate({ modelIds: ['slow-model'], mode: 'single', reason: 'bench' }, 'hi', { registry: [slowModel], timeoutMs: 50 })
  const elapsed = Date.now() - t0
  assert(timedOut[0].ok === false, 'a model exceeding its timeout reports ok:false')
  assert(elapsed < 400, `orchestrate respects the per-model timeout instead of waiting the full delay (took ${elapsed}ms)`)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
