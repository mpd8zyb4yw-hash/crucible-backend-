// Regression test for the autonomous improvement pass (autoImprove.ts).
// Proves doImprovementPass actually RUNS and adjusts scoring weights from
// quality-history.json — it used to return early on a legacy 'history.json' the
// startup migration had already renamed away, so the whole pass was dead.
// Deterministic, no network (no callModel set → triumvirate gates are skipped).
// Run: npx tsx src/CrucibleEngine/test-autoimprove.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { doImprovementPass, loadLearnedWeights } from './autoImprove'
import { identifyGoals } from './goalEngine'

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ok  ', m) } else { fail++; console.log('  FAIL', m) } }
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autoimprove-')); fs.mkdirSync(path.join(d, '.crucible'), { recursive: true }); return d }
const writeQ = (dir: string, entries: any[]) => fs.writeFileSync(path.join(dir, '.crucible', 'quality-history.json'), JSON.stringify(entries))

// 20 entries: coding/math dominate the TOP scores, creative/general the bottom —
// so Pass 2 should nudge `functional` up toward the top-scoring distribution.
function codingHeavy(): any[] {
  const h: any[] = []
  for (let i = 0; i < 5; i++) h.push({ promptSnippet: `implement binary search algorithm variant ${i}`, compositeScore: 0.90, promptType: 'coding' })
  for (let i = 0; i < 5; i++) h.push({ promptSnippet: `compute derivative integral matrix problem ${i}`, compositeScore: 0.85, promptType: 'math' })
  for (let i = 0; i < 5; i++) h.push({ promptSnippet: `write imaginative poem about seasons ${i}`,        compositeScore: 0.30, promptType: 'creative' })
  for (let i = 0; i < 5; i++) h.push({ promptSnippet: `general question about various things ${i}`,       compositeScore: 0.35, promptType: 'general' })
  return h
}

async function main() {
  // ── 1. The pass now RUNS with no session-history file present at all — the exact
  //    condition (legacy history.json absent) that used to make it return early.
  {
    const dir = tmp()
    writeQ(dir, codingHeavy())
    const before = loadLearnedWeights(dir)
    ok(before.updateCount === 0, 'baseline: no weights learned yet')
    await doImprovementPass(dir)
    const after = loadLearnedWeights(dir)
    ok(after.updateCount >= 1, 'improvement pass RUNS and persists a weight update (was dead — returned early on legacy history.json)')
    ok(after.functional > 0.45, 'functional weight nudged up toward the top-scoring coding/math distribution')
    ok(Math.abs(after.similarity + after.functional + after.novelty - 1) < 0.02, 'weights renormalised to ~1.0')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 2. Present-but-empty session history is also non-fatal (guards the fix).
  {
    const dir = tmp()
    writeQ(dir, codingHeavy())
    fs.writeFileSync(path.join(dir, '.crucible', 'history-default.json'), '[]')
    await doImprovementPass(dir)
    ok(loadLearnedWeights(dir).updateCount >= 1, 'pass still runs when history-default.json exists but is empty')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 3. Control: Pass 2's own length gate still holds (no premature learning).
  {
    const dir = tmp()
    writeQ(dir, codingHeavy().slice(0, 10))   // < 20 → Pass 2 must not fire
    await doImprovementPass(dir)
    ok(loadLearnedWeights(dir).updateCount === 0, 'under 20 quality samples → no weight change (gate intact)')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 4. No quality history at all → clean no-op, no throw.
  {
    const dir = tmp()
    await doImprovementPass(dir)
    ok(loadLearnedWeights(dir).updateCount === 0, 'no data → clean no-op')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 5. goalEngine weight-drift ignores metadata fields (lastUpdated/updateCount).
  {
    const dir = tmp()
    // A genuinely over-weighted real dimension, plus the metadata the file carries.
    fs.writeFileSync(path.join(dir, '.crucible', 'scoring-weights.json'), JSON.stringify({
      similarity: 0.20, functional: 0.60, novelty: 0.20, lastUpdated: Date.now(), updateCount: 42,
    }))
    const goals = identifyGoals(dir).goals.filter(g => g.category === 'weight_drift')
    ok(goals.some(g => /functional/.test(g.id)), 'weight-drift still flags a genuinely over-weighted real dimension')
    ok(!goals.some(g => /lastUpdated|updateCount/.test(g.id)), 'metadata (lastUpdated/updateCount) is never treated as a scoring dimension')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\nauto-improve regression: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
