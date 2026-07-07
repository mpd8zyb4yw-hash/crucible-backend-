// ── localModels/policy.ts — auto/all/single firing-mode decision ──
//
// `all` means literally every installed model in the registry — the explicit
// "always use all models" opt-in. `single` pins one model id. `auto` (default)
// defers to router.ts's deterministic subset pick.

import type { FireMode } from './contracts'

export interface PolicyOpts {
  /** Per-query override from the request body, e.g. `{ mode: 'all' }`. */
  requestMode?: FireMode
  /** Persisted user setting (Settings tab, Track D owns the UI for this). */
  persistedMode?: FireMode
  /** Only used when mode === 'single'. */
  singleModelId?: string
}

export interface ResolvedPolicy {
  mode: FireMode
  singleModelId?: string
}

const VALID_MODES: FireMode[] = ['auto', 'all', 'single']

function isFireMode(v: unknown): v is FireMode {
  return typeof v === 'string' && (VALID_MODES as string[]).includes(v)
}

/** Per-query override wins over the persisted setting; unknown/missing values fall back to 'auto'. */
export function resolvePolicy(opts: PolicyOpts): ResolvedPolicy {
  const mode = isFireMode(opts.requestMode) ? opts.requestMode : (isFireMode(opts.persistedMode) ? opts.persistedMode : 'auto')
  if (mode === 'single' && !opts.singleModelId) {
    return { mode: 'auto' } // single with no model chosen is not a valid state — degrade safely
  }
  return { mode, singleModelId: mode === 'single' ? opts.singleModelId : undefined }
}
