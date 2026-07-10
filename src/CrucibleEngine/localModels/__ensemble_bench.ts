// ── localModels/__ensemble_bench.ts — end-to-end offline bench for the on-device ensemble ──
// Run: npx tsx src/CrucibleEngine/localModels/__ensemble_bench.ts
//
// The per-module benches (router / onnx / strengthen) each cover one seam. This one wires the
// real route() → orchestrate() → strengthen() chain together over canned multi-family stub
// models, so an integration regression (e.g. a routing change that starves consensus, or an
// orchestrator change that drops the ok flag strengthen relies on) is caught even when every
// unit bench still passes. No network, no weights — every model is a literal-output stub.

import type { LocalModel, LocalModelInfo } from './contracts'
import { route } from './router'
import { resolvePolicy } from './policy'
import { orchestrate } from './orchestrator'
import { strengthen } from './strengthen/index'
import { availablePool, shouldFireEnsemble } from './gate'

let failures = 0
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`) } else { console.log(`ok: ${msg}`) }
}

function cannedModel(id: string, family: string, text: string, opts?: { installed?: boolean; fail?: boolean; fit?: Partial<LocalModelInfo['fit']> }): LocalModel {
  const info: LocalModelInfo = {
    id, family, params: 1, provider: 'local', quality: 7,
    fit: { coding: 5, reasoning: 6, creative: 5, factual: 6, math: 5, general: 6, ...opts?.fit },
    sizeBytes: 0, installed: opts?.installed ?? true, residentRAMBytes: 1,
  }
  return {
    info,
    async health() { return !opts?.fail },
    generate() {
      return {
        [Symbol.asyncIterator]() {
          let done = false
          return {
            async next() {
              if (done) return { done: true, value: undefined as any }
              done = true
              if (opts?.fail) throw new Error('canned failure')
              return { done: false, value: text }
            },
          }
        },
      }
    },
  }
}

async function run(query: string, registry: LocalModel[], mode?: 'all' | 'single', singleId?: string) {
  const policy = resolvePolicy({ requestMode: mode, singleModelId: singleId })
  const decision = route(query, [], { registry, policy })
  const outputs = await orchestrate(decision, query, { registry })
  const result = strengthen(query, outputs)
  return { decision, outputs, result }
}

async function main() {
  const complex = 'please (1) explain photosynthesis (2) then give the balanced equation (3) and note where it happens'
  const agreeA = 'Photosynthesis converts sunlight, water and carbon dioxide into glucose and oxygen inside the chloroplast.'
  const agreeB = 'In the chloroplast, plants turn water and carbon dioxide into glucose plus oxygen using sunlight.'
  const wrong  = 'Photosynthesis is how animals digest protein in the stomach using bile and acid enzymes.'

  // ── all-mode consensus: two families agree, one disagrees → agreed answer wins ──
  const reg = [
    cannedModel('smol', 'smollm', agreeA),
    cannedModel('gemma', 'gemma', agreeB),
    cannedModel('mistral', 'mistral', wrong),
  ]
  const all = await run(complex, reg, 'all')
  assert(all.decision.modelIds.length === 3, 'all-mode fans out over every installed model')
  assert(all.outputs.filter(o => o.ok).length === 3, 'orchestrator returns three ok outputs')
  assert(all.result.answer === agreeA || all.result.answer === agreeB, 'consensus picks a corroborated answer, not the outlier')
  assert(all.result.answer !== wrong && !all.result.contributors.includes('mistral'), 'the disagreeing model is excluded from contributors')
  assert(all.result.method.startsWith('consensus'), `agreement yields a consensus method (got ${all.result.method})`)
  assert(all.result.contributors.length === 2, 'both agreeing models are credited')

  // ── auto-mode on a complex query still routes a diverse multi-model subset that reaches consensus ──
  const auto = await run(complex, reg)
  assert(auto.decision.mode === 'auto' && auto.decision.modelIds.length >= 2, 'complex auto query fans out to >1 model')
  const autoFamilies = new Set(auto.decision.modelIds.map(id => reg.find(m => m.info.id === id)!.info.family))
  assert(autoFamilies.size === auto.decision.modelIds.length, 'auto subset is family-diverse (no duplicate families)')

  // ── partial failure: one model throws, consensus still forms from the survivors ──
  const withFail = [
    cannedModel('smol', 'smollm', agreeA),
    cannedModel('gemma', 'gemma', agreeB),
    cannedModel('broken', 'mistral', '', { fail: true }),
  ]
  const partial = await run(complex, withFail, 'all')
  assert(partial.outputs.find(o => o.modelId === 'broken')?.ok === false, 'a throwing model degrades to ok:false, never blocks the run')
  assert(partial.result.answer.trim().length > 0 && partial.result.contributors.length === 2, 'consensus still forms from the two survivors')

  // ── single-mode: pins one model, strengthen reports single-model passthrough ──
  const single = await run(complex, reg, 'single', 'gemma')
  assert(single.decision.modelIds.length === 1 && single.decision.modelIds[0] === 'gemma', 'single-mode pins the requested model')
  assert(single.result.answer === agreeB && single.result.method === 'single-model', 'single-mode result is a clean passthrough')

  // ── total wipeout: every model fails → empty result, no throw ──
  const allFail = [cannedModel('a', 'x', '', { fail: true }), cannedModel('b', 'y', '', { fail: true })]
  const wipeout = await run(complex, allFail, 'all')
  assert(wipeout.result.answer === '' && wipeout.result.confidence === 0, 'a fully-failed pool yields an empty, zero-confidence result')

  // ── gate: availablePool + shouldFireEnsemble (the server's on-device decision, unit-level) ──
  const apple = cannedModel('apple-fm', 'apple-fm', 'x')
  const onnx1 = cannedModel('smollm2-1.7b', 'smollm', 'x')
  const onnx2 = cannedModel('gemma-2-2b', 'gemma', 'x')

  assert(availablePool([apple], true).length === 1, 'apple-fm is in the pool when its daemon is up')
  assert(availablePool([apple], false).length === 0, 'apple-fm is dropped from the pool when its daemon is down')
  assert(availablePool([apple, onnx1], false).map(m => m.info.id).join() === 'smollm2-1.7b',
    'ONNX stays in the pool even when apple-fm is down')

  // common single-Apple-FM Mac: no opt-in, one model up → do NOT fire (falls to single-FM synth)
  assert(shouldFireEnsemble([apple], { explicit: false, appleFmAvailable: true }) === false,
    'single Apple-FM pool without opt-in does not fire the ensemble')
  // explicit opt-in fires even on a single model
  assert(shouldFireEnsemble([apple], { explicit: true, appleFmAvailable: true }) === true,
    'explicit opt-in fires the ensemble on any non-empty pool')
  // >1 usable model auto-fires
  assert(shouldFireEnsemble([apple, onnx1], { explicit: false, appleFmAvailable: true }) === true,
    'a >1-model pool auto-fires the ensemble')
  // Apple FM down but one ONNX cached → fire (only on-device route)
  assert(shouldFireEnsemble([onnx1], { explicit: false, appleFmAvailable: false }) === true,
    'a lone ONNX model fires when Apple FM is down (only on-device route)')
  // nothing usable → never fire
  assert(shouldFireEnsemble([], { explicit: true, appleFmAvailable: false }) === false,
    'an empty pool never fires, even with explicit opt-in')

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
