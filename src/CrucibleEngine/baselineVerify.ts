// Universal verification baseline — every exit that emits a single-model answer
// without going through the full multi-model pipeline (A0 ensemble-off, the
// `simple` triage tier) must still pass through a deterministic check + one
// cheap local self-repair attempt before it reaches the user.
//
// This exists because domainVerify() (math/factual/consistency) and the Stage
// 5b critic/polish loop already give the FULL pipeline a self-refinement pass —
// but A0 and the simple tier were built to skip the pipeline entirely for speed,
// which meant they also skipped every verification step. That gap is what let a
// weak on-device model's raw, unchecked guess reach the user unfiltered. The fix
// per the free-tier philosophy is not a better/premium model — it's making sure
// no answer, on any path, exits without at least one verify+repair pass.
import { domainVerify } from './domainVerifiers'

export interface BaselineVerifyResult {
  text: string
  repaired: boolean
  issues: string[]
}

export async function verifyAndRepair(
  question: string,
  promptType: string,
  text: string,
  repair: (system: string, user: string) => Promise<string>,
  repairTimeoutMs = 8000,
): Promise<BaselineVerifyResult> {
  let issues: string[] = []
  try {
    const dv = await domainVerify(promptType, text, question)
    if (!dv.passed && dv.issues.length > 0 && dv.confidence > 0.5) issues = dv.issues
  } catch { /* non-blocking — verifier failure must never break the response */ }

  if (issues.length === 0) return { text, repaired: false, issues: [] }

  try {
    const repairPromise = repair(
      'You are correcting a draft answer. Fix ONLY the flagged issues — do not rewrite ' +
      'unrelated parts, do not add new claims, keep the same voice and length. Return ONLY ' +
      'the corrected answer, nothing else.',
      `Question: ${question}\n\nDraft answer:\n${text}\n\nFLAGGED ISSUES (fix these):\n${issues.map(i => `- ${i}`).join('\n')}`,
    )
    const repaired = await Promise.race([
      repairPromise,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('repair timeout')), repairTimeoutMs)),
    ])
    const cleaned = repaired.trim()
    // Sanity floor: a repair that collapsed to near-nothing is worse than the
    // flagged original — keep the original and surface the issues instead.
    if (cleaned && cleaned.length > text.length * 0.4) {
      return { text: cleaned, repaired: true, issues }
    }
  } catch { /* fall through to original text below */ }

  return { text, repaired: false, issues }
}
