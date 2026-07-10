// ── localModels/router.ts — deterministic model-subset picker ──
//
// Reuses the real prompt-type classifier already wired into the pipeline
// (`classifyPrompt` in modelRegistry.ts — same PromptType shape the external
// MODEL_REGISTRY's `fit` vectors use) rather than inventing a parallel
// classifier. The pasted 4-track plan named files that don't exist in this
// repo (intentClassifier.ts, stakesRouter.ts, macCapabilities.ts) — see the
// COLLAB.md note from 2026-07-07 for the reconciliation.

import { classifyPrompt } from '../../../modelRegistry'
import type { LocalModel, RouteDecision } from './contracts'
import type { ResolvedPolicy } from './policy'

export interface RouteOpts {
  registry: LocalModel[]
  policy: ResolvedPolicy
  /** Optional RAM ceiling for concurrently resident models; omitted = no constraint. */
  ramBudgetBytes?: number
}

// Complexity heuristic: multi-part prompts (numbered/lettered lists, "and"/"then"
// connectors) or long prompts warrant more than one model's opinion. Kept
// intentionally simple and dependency-free — no macCapabilities.ts equivalent
// exists yet in this repo.
function isComplexQuery(query: string): boolean {
  const words = query.trim().split(/\s+/).length
  const multiPart = /\(\s*\d+\s*\)|\b\d+[.)]\s|\band\s+then\b|\bfirst\b.*\bthen\b/i.test(query)
  return words > 40 || multiPart
}

function fitScore(model: LocalModel, promptType: ReturnType<typeof classifyPrompt>): number {
  return model.info.fit[promptType] * (model.info.quality / 10)
}

// Diversity-aware subset: take the best-fit model, then fill remaining slots preferring a
// family not already represented (breaking ties by fit). Three near-identical models make a
// weak ensemble — consensus is only meaningful when the members can actually disagree. Mirrors
// the ROADMAP's "concentration = correlated-failure risk" insight, applied to the local pool.
// `ranked` must already be sorted best-fit-first.
function selectDiverse(ranked: LocalModel[], subsetSize: number): LocalModel[] {
  if (subsetSize <= 1 || ranked.length <= 1) return ranked.slice(0, subsetSize)
  const picked: LocalModel[] = [ranked[0]]
  const families = new Set<string>([ranked[0].info.family])
  const pool = ranked.slice(1)
  while (picked.length < subsetSize && pool.length > 0) {
    // Prefer the highest-fit candidate whose family is new; else fall back to the highest-fit left.
    let idx = pool.findIndex(m => !families.has(m.info.family))
    if (idx === -1) idx = 0
    const [next] = pool.splice(idx, 1)
    picked.push(next)
    families.add(next.info.family)
  }
  return picked
}

function withinBudget(models: LocalModel[], ramBudgetBytes?: number): LocalModel[] {
  if (!ramBudgetBytes) return models
  let used = 0
  const kept: LocalModel[] = []
  for (const m of models) {
    if (used + m.info.residentRAMBytes > ramBudgetBytes && kept.length > 0) break
    used += m.info.residentRAMBytes
    kept.push(m)
  }
  return kept
}

export function route(query: string, _history: { user: string; assistant: string }[], opts: RouteOpts): RouteDecision {
  const installed = opts.registry.filter(m => m.info.installed)

  if (installed.length === 0) {
    return { modelIds: [], mode: opts.policy.mode, reason: 'no installed local models' }
  }

  if (opts.policy.mode === 'all') {
    return { modelIds: installed.map(m => m.info.id), mode: 'all', reason: 'user opted into firing every installed model' }
  }

  if (opts.policy.mode === 'single') {
    const chosen = installed.find(m => m.info.id === opts.policy.singleModelId)
    if (chosen) return { modelIds: [chosen.info.id], mode: 'single', reason: `user pinned ${chosen.info.id}` }
    // Pinned model isn't installed — degrade to auto rather than firing nothing.
  }

  // auto
  const promptType = classifyPrompt(query)
  const ranked = [...installed].sort((a, b) => fitScore(b, promptType) - fitScore(a, promptType))
  const complex = isComplexQuery(query)
  const subsetSize = complex ? Math.min(3, ranked.length) : 1
  const picked = withinBudget(selectDiverse(ranked, subsetSize), opts.ramBudgetBytes)
  const chosenIds = picked.length > 0 ? picked.map(m => m.info.id) : [ranked[0].info.id]
  return {
    modelIds: chosenIds,
    mode: 'auto',
    reason: `${promptType} query, ${complex ? 'complex' : 'trivial'} → ${chosenIds.length} model(s)`,
  }
}
