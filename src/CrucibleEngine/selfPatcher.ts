// Pipeline self-patcher (Track B1) — the system reads its own per-request quality
// history, identifies a promptType whose synthesised answers are consistently
// scoring low, and proposes a synthesis-prompt refinement. Proposals go through the
// triumvirate; approved patches are written to .crucible/pipeline-patches.json and
// applied to the live Stage 5 synthesis prompt via activePatchText(). A patch whose
// promptType trend degrades after it goes active is auto-reverted.
//
// This is the compounding loop: the pipeline's OWN scoring (topScore per request —
// the max model score the ensemble produced, already computed and persisted) is the
// ground-truth signal, not a separate model asked "is this good?". Weak outcomes on a
// promptType become corrective pressure on that promptType's synthesis prompt, and a
// refinement that fails to help is rolled back — never a premium model.

import fs from 'fs'
import path from 'path'

export interface PipelinePatch {
  id: string
  ts: number
  stage: string
  promptType: string
  problem: string     // what failure mode this addresses
  patch: string       // the new prompt text to apply
  status: 'pending' | 'approved' | 'rejected' | 'active' | 'reverted'
  approvedAt?: number
  revertedAt?: number
  revertReason?: string
}

const patchFile = (dir: string) => path.join(dir, '.crucible', 'pipeline-patches.json')

export function loadPatches(dir: string): PipelinePatch[] {
  try { return JSON.parse(fs.readFileSync(patchFile(dir), 'utf8')) } catch { return [] }
}

export function savePatches(dir: string, patches: PipelinePatch[]) {
  fs.mkdirSync(path.dirname(patchFile(dir)), { recursive: true })
  fs.writeFileSync(patchFile(dir), JSON.stringify(patches, null, 2))
  _activeCache = null  // invalidate the hot-path cache on any write
}

export function getActivePatches(dir: string): PipelinePatch[] {
  return loadPatches(dir).filter(p => p.status === 'active')
}

export function approvePatch(dir: string, id: string): void {
  const patches = loadPatches(dir)
  const p = patches.find(p => p.id === id)
  if (p) { p.status = 'active'; p.approvedAt = Date.now() }
  savePatches(dir, patches)
}

// ── Hot-path application ──────────────────────────────────────────────────────
// Called once per chat request at synthesis-prompt construction. Cached by file
// mtime so the common case (no patches, or unchanged patches) never re-parses.
let _activeCache: { dir: string; mtimeMs: number; active: PipelinePatch[] } | null = null

function loadActive(dir: string): PipelinePatch[] {
  try {
    const st = fs.statSync(patchFile(dir))
    if (_activeCache && _activeCache.dir === dir && _activeCache.mtimeMs === st.mtimeMs) {
      return _activeCache.active
    }
    const active = (JSON.parse(fs.readFileSync(patchFile(dir), 'utf8')) as PipelinePatch[])
      .filter(p => p.status === 'active')
    _activeCache = { dir, mtimeMs: st.mtimeMs, active }
    return active
  } catch { return [] }
}

// Returns the concatenated refinement text for active patches matching this
// promptType + stage, bounded so a runaway patch can't blow the context budget.
// Empty string when nothing applies (the overwhelming common case) — a safe no-op.
export function activePatchText(dir: string, promptType: string, stage: string): string {
  const hits = loadActive(dir).filter(p => p.stage === stage && p.promptType === promptType)
  if (!hits.length) return ''
  return hits.map(p => p.patch).join('\n\n').slice(0, 1200)
}

// ── Proposal ──────────────────────────────────────────────────────────────────
// Ground-truth score for a history entry, tolerant of the several shapes the
// codebase has used (topScore is what the live pipeline actually persists today).
function scoreOf(q: any): number | null {
  const s = q?.compositeScore ?? q?.score ?? q?.topScore
  return typeof s === 'number' && isFinite(s) ? s : null
}

// The signal the loop actually optimises against. A deterministic verifier verdict
// (math eval / counting / factual — persisted as groundTruthVerified) OUTRANKS the
// ensemble's own topScore, because a fluent answer the ensemble scored 0.7 that a
// verifier proved wrong is a worse outcome than a merely mediocre one. A confident
// fail floors the effective score to 0; everything else falls back to topScore.
function effectiveScore(q: any): number | null {
  if (q?.groundTruthVerified === false) return 0
  return scoreOf(q)
}

const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0

// Analyse quality history for one promptType and, if its recent synthesised
// answers are consistently scoring low, propose a synthesis-prompt refinement.
// Returns null when there isn't enough signal or the promptType is healthy.
export function analyseAndPropose(
  _debugHistory: any[],
  qualityHistory: any[],
  promptType: string
): Omit<PipelinePatch, 'id' | 'ts' | 'status'> | null {
  const forType = qualityHistory.filter(q => q?.promptType === promptType && effectiveScore(q) !== null)
  const recent = forType.slice(-40)
  if (recent.length < 8) return null   // not enough data to trust the signal

  const scores = recent.map(q => effectiveScore(q) as number)
  const low = scores.filter(s => s < 0.55)
  const verifierFails = recent.filter(q => q?.groundTruthVerified === false).length
  const lowRate = low.length / recent.length
  // Require both an absolute floor of failures and a meaningful rate, so a couple
  // of hard prompts don't trigger a patch on an otherwise-healthy type.
  if (low.length < 4 || lowRate < 0.25) return null

  const verifierNote = verifierFails > 0 ? `, ${verifierFails} verifier-flagged wrong` : ''
  return {
    stage: 'stage5_synthesis',
    promptType,
    problem: `${promptType}: ${low.length}/${recent.length} recent answers scored below 0.55 (avg ${avg(scores).toFixed(2)}${verifierNote})`,
    patch:
      `For ${promptType} questions specifically: before finalising, restate the exact thing the ` +
      `question asks for and confirm the answer delivers precisely that — nothing missing, nothing ` +
      `extra. Lead with the direct answer, then the reasoning. If the source responses disagree on a ` +
      `key fact, resolve it explicitly rather than averaging or hedging. Prefer a correct, complete, ` +
      `verifiable answer over a fluent one.`,
  }
}

// ── Rollback ────────────────────────────────────────────────────────────────
// Review every active patch against outcomes recorded AFTER it went live. If a
// patch's promptType trend degraded (recent half worse than earlier half) or sits
// below a hard floor, revert it. This is the safety half of the loop: a refinement
// that doesn't demonstrably help is removed, so the system can't drift downward.
export function reviewActivePatches(dir: string, qualityHistory: any[]): string[] {
  const patches = loadPatches(dir)
  const reverted: string[] = []
  let changed = false

  for (const p of patches) {
    if (p.status !== 'active' || !p.approvedAt) continue
    const after = qualityHistory
      .filter(q => q?.promptType === p.promptType && typeof q?.ts === 'number' && q.ts > p.approvedAt!)
      .map(effectiveScore)
      .filter((s): s is number => s !== null)
    if (after.length < 6) continue   // give the patch a fair sample before judging

    const half = Math.floor(after.length / 2)
    const earlier = avg(after.slice(0, half))
    const recent = avg(after.slice(half))
    if (recent < earlier - 0.05 || recent < 0.45) {
      p.status = 'reverted'
      p.revertedAt = Date.now()
      p.revertReason = `post-patch ${p.promptType} trend ${earlier.toFixed(2)}→${recent.toFixed(2)} over ${after.length} outcomes`
      changed = true
      reverted.push(p.id)
      console.log(`[SelfPatcher] REVERTED ${p.id} — ${p.revertReason}`)
    }
  }

  if (changed) savePatches(dir, patches)
  return reverted
}

// Run the full review-analyse-propose-submit cycle. callTriumvirate injected from server.ts.
export async function runSelfPatcher(
  dir: string,
  debugHistory: any[],
  qualityHistory: any[],
  promptTypes: string[],
  callTriumvirate: (proposal: string) => Promise<{ approved: boolean; reason: string }>
): Promise<void> {
  // Safety half first: retire any active patch that hasn't earned its place.
  reviewActivePatches(dir, qualityHistory)

  const patches = loadPatches(dir)
  // Dedupe by (stage, promptType) across everything still on the books — don't
  // re-propose something already pending/active, and don't thrash on one we reverted.
  const existingKeys = new Set(
    patches
      .filter(p => p.status === 'pending' || p.status === 'active' || p.status === 'reverted')
      .map(p => `${p.stage}|${p.promptType}`)
  )

  for (const pt of promptTypes) {
    const proposal = analyseAndPropose(debugHistory, qualityHistory, pt)
    if (!proposal || existingKeys.has(`${proposal.stage}|${proposal.promptType}`)) continue

    console.log(`[SelfPatcher] Proposing patch for ${pt} ${proposal.stage}: ${proposal.problem}`)
    try {
      const { approved, reason } = await callTriumvirate(
        `PIPELINE PATCH PROPOSAL\nStage: ${proposal.stage}\nPrompt type: ${proposal.promptType}\nProblem: ${proposal.problem}\nProposed patch text:\n${proposal.patch}`
      )
      const patch: PipelinePatch = {
        id: `pp_${Date.now()}`,
        ts: Date.now(),
        ...proposal,
        status: approved ? 'active' : 'rejected',
        ...(approved ? { approvedAt: Date.now() } : {}),
      }
      patches.push(patch)
      existingKeys.add(`${proposal.stage}|${proposal.promptType}`)
      console.log(`[SelfPatcher] Patch ${approved ? 'APPROVED (active)' : 'REJECTED'}: ${reason}`)
    } catch (e: any) {
      console.warn('[SelfPatcher] Triumvirate call failed:', e.message)
    }
  }

  if (patches.length > 0) savePatches(dir, patches)
}
