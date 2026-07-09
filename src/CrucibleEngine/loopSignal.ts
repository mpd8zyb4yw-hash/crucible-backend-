// Fast-path learning signal (Track B1 companion to selfPatcher.ts).
//
// The full pipeline records a rich history entry (topScore + groundTruthVerified)
// at its very end. But the pipeline has many EARLY-EXIT paths that answer and
// return before that write ever runs — the ensemble-off on-device paths
// (corpus / local ensemble / local-FM synth), the simple-triage tier, the Layer-1
// corpus-first gate, offline mode, and the L2 parallel-workstreams join. Every one
// of those answers was invisible to the self-patcher, so the loop only ever learned
// from full-pipeline requests.
//
// This records a MINIMAL entry for those paths — but only when the deterministic
// verifier actually repaired a real error (`vr.repaired`). That is the one hard,
// model-independent signal available on a fast path: the shipped answer's first
// draft was verifiably wrong. Recording solely on repair means we never flood the
// shared 200-entry history with fast-path noise and never inject a fake positive
// score, so these entries can only ADD negative ground-truth signal for a promptType
// (see selfPatcher.effectiveScore: groundTruthVerified===false floors to 0; a null
// verdict with no topScore is filtered out entirely) and can never dilute the
// full-pipeline signal.

import fs from 'fs'
import path from 'path'

export interface FastPathOutcome {
  promptType: string
  query: string
  answer: string          // the shipped (post-repair) text — for audit only
  verifierRepaired: boolean
  path: string            // provenance label, mirrors the baseline_verify_repaired debug event
  model?: string
}

// The per-user history file the self-patcher's cycle loads (default when unauthenticated).
export function historyFileFor(dir: string, userId?: string | null): string {
  return path.join(dir, '.crucible', userId ? `history-${userId}.json` : 'history-default.json')
}

// Append a fast-path outcome. No-op unless the verifier repaired a real error.
// Fully guarded: history is telemetry — it must never throw on the response path.
// Returns true iff an entry was written (used by tests).
export function recordFastPathOutcome(historyFile: string, o: FastPathOutcome): boolean {
  if (!o.verifierRepaired) return false
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true })
    let hist: any[] = []
    try { hist = JSON.parse(fs.readFileSync(historyFile, 'utf8')) } catch { /* new / corrupt → start fresh */ }
    if (!Array.isArray(hist)) hist = []
    hist.push({
      ts: Date.now(),
      query: o.query,
      promptType: o.promptType,
      models: o.model ? [o.model] : [],
      synthesis: o.answer,
      groundTruthVerified: false,   // repaired ⇒ the first-draft answer was verifiably wrong
      path: o.path,
    })
    if (hist.length > 200) hist = hist.slice(-200)
    fs.writeFileSync(historyFile, JSON.stringify(hist, null, 2))
    return true
  } catch {
    return false
  }
}
