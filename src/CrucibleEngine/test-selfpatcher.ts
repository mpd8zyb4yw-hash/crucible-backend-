// Regression net for the self-improvement loop (selfPatcher.ts).
//
// The self-patcher now AUTO-APPLIES triumvirate-approved synthesis-prompt
// refinements at runtime, so a silent regression in its decision logic would
// only surface as degraded answers — caught by user observation, not measurement.
// This harness pins the invariants that make the loop safe to run unattended.
//
// Fully deterministic, no network, no server: stub triumvirate, temp dirs, the
// real history entry shapes the live pipeline persists (topScore for the full
// pipeline; groundTruthVerified with no topScore for the fast path). Run with:
//   npx tsx src/CrucibleEngine/test-selfpatcher.ts
//
// Kept in this session's lane deliberately — imports only selfPatcher.ts, touches
// no server.ts / VGR / foreground-gate code owned by the parallel session.

import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  runSelfPatcher, activePatchText, loadPatches, reviewActivePatches, type PipelinePatch,
} from './selfPatcher'

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ok  ', m) } else { fail++; console.log('  FAIL', m) } }
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'selfpatcher-')); fs.mkdirSync(path.join(d, '.crucible'), { recursive: true }); return d }
const now = Date.now()
const approveIf = (re: RegExp) => async (p: string) => ({ approved: re.test(p), reason: 'test' })

async function main() {
  // ── 1. Proposal fires from the REAL history shape (topScore, not compositeScore).
  //    Guards the field-mismatch bug that made the patcher never propose anything.
  {
    const dir = tmp()
    const hist: any[] = []
    for (let i = 0; i < 20; i++) hist.push({ ts: now - (20 - i) * 1000, promptType: 'coding',  topScore: i < 12 ? 0.40 : 0.72 })
    for (let i = 0; i < 20; i++) hist.push({ ts: now - (20 - i) * 1000, promptType: 'general', topScore: 0.82 })
    await runSelfPatcher(dir, [], hist, ['coding', 'general'], approveIf(/coding/))
    const patches = loadPatches(dir)
    ok(patches.some(p => p.promptType === 'coding' && p.status === 'active'), 'proposes+activates for an unhealthy promptType off topScore')
    ok(!patches.some(p => p.promptType === 'general'), 'healthy promptType gets no patch')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 2. The loop CLOSES: an active patch actually applies, scoped to its type+stage.
  {
    const dir = tmp()
    const patches: PipelinePatch[] = [{
      id: 'pp_x', ts: now, stage: 'stage5_synthesis', promptType: 'coding',
      problem: 'seed', patch: 'CODING REFINEMENT TEXT', status: 'active', approvedAt: now,
    }]
    fs.writeFileSync(path.join(dir, '.crucible', 'pipeline-patches.json'), JSON.stringify(patches))
    ok(activePatchText(dir, 'coding', 'stage5_synthesis').includes('CODING REFINEMENT TEXT'), 'active patch text applies for its promptType+stage')
    ok(activePatchText(dir, 'general', 'stage5_synthesis') === '', 'no bleed to other promptTypes')
    ok(activePatchText(dir, 'coding', 'stage3_critique') === '', 'no bleed to other stages')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 3. Idempotent — a second cycle over the same signal does not duplicate.
  {
    const dir = tmp()
    const hist: any[] = []
    for (let i = 0; i < 20; i++) hist.push({ ts: now - (20 - i) * 1000, promptType: 'coding', topScore: i < 12 ? 0.40 : 0.72 })
    await runSelfPatcher(dir, [], hist, ['coding'], approveIf(/coding/))
    await runSelfPatcher(dir, [], hist, ['coding'], approveIf(/coding/))
    ok(loadPatches(dir).filter(p => p.promptType === 'coding').length === 1, 'no duplicate proposal for same stage+promptType')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 4. Ground truth OUTRANKS topScore: fluent-but-verified-wrong is a hard low;
  //    the same topScore with a passing verdict stays healthy.
  {
    const dirBad = tmp(), dirOk = tmp()
    const bad: any[] = [], good: any[] = []
    for (let i = 0; i < 16; i++) {
      bad.push({ ts: now - (16 - i) * 1000, promptType: 'factual', topScore: 0.75, groundTruthVerified: i < 10 ? false : true })
      good.push({ ts: now - (16 - i) * 1000, promptType: 'factual', topScore: 0.75, groundTruthVerified: true })
    }
    await runSelfPatcher(dirBad, [], bad, ['factual'], approveIf(/factual/))
    await runSelfPatcher(dirOk, [], good, ['factual'], approveIf(/factual/))
    const fp = loadPatches(dirBad).find(p => p.promptType === 'factual')
    ok(!!fp, 'verifier-flagged-wrong at high topScore STILL earns a patch')
    ok(/verifier-flagged wrong/.test(fp?.problem ?? ''), 'problem string credits the verifier signal')
    ok(!loadPatches(dirOk).some(p => p.promptType === 'factual'), 'verifier-passing at the same topScore gets no patch')
    fs.rmSync(dirBad, { recursive: true, force: true }); fs.rmSync(dirOk, { recursive: true, force: true })
  }

  // ── 5. Fast path (no topScore): verifier-flagged lows count, clean nulls ignored.
  {
    const dir = tmp()
    const hist: any[] = []
    for (let i = 0; i < 8; i++)  hist.push({ ts: now - (20 - i) * 1000, promptType: 'reasoning', groundTruthVerified: false, path: 'simple' })
    for (let i = 0; i < 20; i++) hist.push({ ts: now - i * 1000,        promptType: 'reasoning', groundTruthVerified: null,  path: 'simple' })
    await runSelfPatcher(dir, [], hist, ['reasoning'], approveIf(/reasoning/))
    const rp = loadPatches(dir).find(p => p.promptType === 'reasoning')
    ok(!!rp, 'fast-path verifier lows (no topScore) drive a patch')
    ok(/8\/8 recent/.test(rp?.problem ?? ''), 'clean null-verdict entries excluded from the denominator')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 6. Auto-rollback: a patch whose post-approval trend degrades is reverted,
  //    stops applying, and is not re-proposed (no thrash).
  {
    const dir = tmp()
    const base: any[] = []
    for (let i = 0; i < 20; i++) base.push({ ts: now - (20 - i) * 1000, promptType: 'coding', topScore: i < 12 ? 0.40 : 0.72 })
    await runSelfPatcher(dir, [], base, ['coding'], approveIf(/coding/))
    const approvedAt = loadPatches(dir).find(p => p.promptType === 'coding')!.approvedAt!
    const after: any[] = []
    for (let i = 0; i < 5; i++) after.push({ ts: approvedAt + (i + 1) * 1000, promptType: 'coding', topScore: 0.70 })
    for (let i = 0; i < 5; i++) after.push({ ts: approvedAt + (i + 6) * 1000, promptType: 'coding', topScore: 0.42 })
    const reverted = reviewActivePatches(dir, [...base, ...after])
    ok(reverted.length === 1, 'degrading patch is reverted')
    ok(activePatchText(dir, 'coding', 'stage5_synthesis') === '', 'reverted patch stops applying (cache invalidated)')
    await runSelfPatcher(dir, [], base, ['coding'], approveIf(/coding/))
    ok(loadPatches(dir).filter(p => p.promptType === 'coding').length === 1, 'reverted stage+promptType is not re-proposed')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\nself-patcher regression: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
