// ── localModels/gate.ts — on-device availability + ensemble-fire decision (pure) ──
//
// The A0 path in server.ts has to decide two things before running the on-device ensemble:
//   1. which models are actually usable right now, and
//   2. whether to run the ensemble at all vs. fall through to the single-FM synth.
// That logic is subtle (Apple FM health vs. cached ONNX weights, and the "Apple FM down but
// ONNX present" case where the ensemble is the ONLY on-device route) so it lives here as pure
// functions that are unit-benched, rather than inline and untested in server.ts.

import type { LocalModel } from './contracts'

/** The models usable at this instant: an ONNX model whenever its weights are cached (it's in the
 *  registry), the Apple FM daemon only when its health check passed. */
export function availablePool(registry: LocalModel[], appleFmAvailable: boolean): LocalModel[] {
  return registry.filter(m => (m.info.id === 'apple-fm' ? appleFmAvailable : true))
}

/** Fire the ensemble when the client opts in explicitly, when the usable pool has more than one
 *  model (auto consensus beats a single call), OR when Apple FM is down but at least one ONNX
 *  model is cached (then the ensemble is the only on-device route). Never fire on an empty pool. */
export function shouldFireEnsemble(
  pool: LocalModel[],
  opts: { explicit: boolean; appleFmAvailable: boolean },
): boolean {
  if (pool.length === 0) return false
  return opts.explicit || pool.length > 1 || (!opts.appleFmAvailable && pool.length >= 1)
}
