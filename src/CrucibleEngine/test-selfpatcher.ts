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
  runSelfPatcher, activePatchText, loadPatches, reviewActivePatches, summariseLoopState, type PipelinePatch,
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

  // ── 7. Audit view agrees with the proposer and reflects patch state.
  {
    const hist: any[] = []
    for (let i = 0; i < 20; i++) hist.push({ ts: now - (20 - i) * 1000, promptType: 'coding',  topScore: i < 12 ? 0.40 : 0.72 })
    for (let i = 0; i < 12; i++) hist.push({ ts: now - (12 - i) * 1000, promptType: 'general', topScore: 0.85 })
    const patches: PipelinePatch[] = [
      { id: 'pp_a', ts: now, stage: 'stage5_synthesis', promptType: 'coding', problem: 'x', patch: 'p', status: 'active', approvedAt: now },
      { id: 'pp_b', ts: now, stage: 'stage5_synthesis', promptType: 'math',   problem: 'y', patch: 'p', status: 'reverted' },
    ]
    const st = summariseLoopState(hist, patches, ['coding', 'general', 'math'])
    const surf = (pt: string, stage: string) => st.promptTypes.find(t => t.promptType === pt)!.surfaces.find(s => s.stage === stage)!
    ok(surf('coding', 'stage5_synthesis').wouldPropose === true, 'audit: unhealthy pipeline surface flagged wouldPropose')
    ok(surf('general', 'stage5_synthesis').wouldPropose === false, 'audit: healthy surface not flagged')
    ok(surf('coding', 'stage5_synthesis').activePatchIds.includes('pp_a'), 'audit: active patch attributed to its promptType+surface')
    ok(surf('coding', 'fastpath_answer').activePatchIds.length === 0, 'audit: synthesis patch not shown on the fast-path surface')
    ok(st.patchCounts.active === 1 && st.patchCounts.reverted === 1, 'audit: patch counts by status')
    ok(st.totalPatches === 2, 'audit: total patch count')

    // Drift guard: fast-path-only failures must show wouldPropose on the fastpath
    // surface and NOT the synthesis surface — and match what the proposer does.
    const fh: any[] = []
    for (let i = 0; i < 10; i++) fh.push({ ts: now - (10 - i) * 1000, promptType: 'creative', groundTruthVerified: false, path: 'simple' })
    const dst = summariseLoopState(fh, [], ['creative'])
    const csurf = (stage: string) => dst.promptTypes[0].surfaces.find(s => s.stage === stage)!
    ok(csurf('fastpath_answer').wouldPropose === true, 'audit: fast-path-only failure flags the fastpath surface')
    ok(csurf('stage5_synthesis').wouldPropose === false, 'audit: fast-path-only failure does NOT flag synthesis (no overall-stats drift)')
    // Confirm the audit agrees with the actual proposer for the same data.
    const dir9 = tmp()
    await runSelfPatcher(dir9, [], fh, ['creative'], approveIf(/creative/))
    const proposed = loadPatches(dir9)
    ok(proposed.some(p => p.stage === 'fastpath_answer') && !proposed.some(p => p.stage === 'stage5_synthesis'), 'proposer matches the audit view exactly')
    fs.rmSync(dir9, { recursive: true, force: true })
  }

  // ── 8. Patch surfaces: failures are attributed to the prompt that produced them.
  {
    // Fails ONLY on the fast path (path:'simple') → fastpath_answer, not synthesis.
    const dirF = tmp()
    const fhist: any[] = []
    for (let i = 0; i < 12; i++) fhist.push({ ts: now - (12 - i) * 1000, promptType: 'reasoning', groundTruthVerified: false, path: 'simple' })
    await runSelfPatcher(dirF, [], fhist, ['reasoning'], approveIf(/reasoning/))
    const fp = loadPatches(dirF)
    ok(fp.some(p => p.stage === 'fastpath_answer' && p.status === 'active'), 'fast-path-only failures propose a fastpath_answer patch')
    ok(!fp.some(p => p.stage === 'stage5_synthesis'), 'fast-path-only failures do NOT propose a synthesis patch')
    ok(activePatchText(dirF, 'reasoning', 'fastpath_answer').length > 0, 'fastpath_answer patch applies for its promptType')
    ok(activePatchText(dirF, 'reasoning', 'stage5_synthesis') === '', 'nothing applies on the synthesis surface')
    fs.rmSync(dirF, { recursive: true, force: true })

    // Fails ONLY on the full pipeline (no path) → synthesis, not fastpath.
    const dirP = tmp()
    const phist: any[] = []
    for (let i = 0; i < 20; i++) phist.push({ ts: now - (20 - i) * 1000, promptType: 'coding', topScore: i < 12 ? 0.40 : 0.72 })
    await runSelfPatcher(dirP, [], phist, ['coding'], approveIf(/coding/))
    const pp = loadPatches(dirP)
    ok(pp.some(p => p.stage === 'stage5_synthesis'), 'pipeline-only failures propose a synthesis patch')
    ok(!pp.some(p => p.stage === 'fastpath_answer'), 'pipeline-only failures do NOT propose a fastpath patch')
    fs.rmSync(dirP, { recursive: true, force: true })

    // Fails on BOTH surfaces → both patches proposed independently.
    const dirB = tmp()
    const bhist: any[] = []
    for (let i = 0; i < 20; i++) bhist.push({ ts: now - (40 - i) * 1000, promptType: 'math', topScore: i < 12 ? 0.40 : 0.72 })          // pipeline lows
    for (let i = 0; i < 12; i++) bhist.push({ ts: now - (12 - i) * 1000, promptType: 'math', groundTruthVerified: false, path: 'simple' }) // fastpath lows
    await runSelfPatcher(dirB, [], bhist, ['math'], approveIf(/math/))
    const bp = loadPatches(dirB)
    ok(bp.some(p => p.stage === 'stage5_synthesis') && bp.some(p => p.stage === 'fastpath_answer'), 'both-surface failures propose both patches')
    ok(new Set(bp.map(p => p.id)).size === bp.length, 'distinct patch ids per surface (no collision)')
    fs.rmSync(dirB, { recursive: true, force: true })

    // Non-patchable fast path (offline_mode) drives NEITHER proposable surface.
    const dirN = tmp()
    const nhist: any[] = []
    for (let i = 0; i < 16; i++) nhist.push({ ts: now - (16 - i) * 1000, promptType: 'factual', groundTruthVerified: false, path: 'offline_mode' })
    await runSelfPatcher(dirN, [], nhist, ['factual'], approveIf(/factual/))
    ok(loadPatches(dirN).length === 0, 'a fast path with no patchable prompt (offline_mode) proposes nothing')
    fs.rmSync(dirN, { recursive: true, force: true })
  }

  // ── 9. Rollback is surface-aware: a patch is judged only by its own surface.
  {
    // Seed an active fastpath_answer patch for 'reasoning'.
    const dir = tmp()
    const seed: PipelinePatch[] = [{
      id: 'pp_fp', ts: now, stage: 'fastpath_answer', promptType: 'reasoning',
      problem: 'seed', patch: 'FASTPATH TEXT', status: 'active', approvedAt: now,
    }]
    fs.writeFileSync(path.join(dir, '.crucible', 'pipeline-patches.json'), JSON.stringify(seed))

    // Pipeline outcomes for 'reasoning' degrade badly AFTER approval — but the patch
    // is a fast-path patch, so this must NOT revert it (it can't affect those requests).
    const pipelineNoise: any[] = []
    for (let i = 0; i < 5; i++) pipelineNoise.push({ ts: now + (i + 1) * 1000, promptType: 'reasoning', topScore: 0.70 })
    for (let i = 0; i < 5; i++) pipelineNoise.push({ ts: now + (i + 6) * 1000, promptType: 'reasoning', topScore: 0.30 })
    ok(reviewActivePatches(dir, pipelineNoise).length === 0, 'fast-path patch is NOT reverted by degrading pipeline outcomes')
    ok(loadPatches(dir).find(p => p.id === 'pp_fp')?.status === 'active', 'it stays active')

    // Fast paths only ever record FAILURES (loopSignal writes on repair), so the
    // patch's success signal is the ABSENCE of new fast-path entries; if repairs keep
    // getting recorded after it went active, it isn't helping and the floor reverts it.
    const fastStillFailing: any[] = []
    for (let i = 0; i < 8; i++) fastStillFailing.push({ ts: now + (i + 1) * 1000, promptType: 'reasoning', groundTruthVerified: false, path: 'simple' })
    ok(reviewActivePatches(dir, fastStillFailing).includes('pp_fp'), 'fast-path patch IS reverted when its own surface keeps failing after approval')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 10. North-star scenario: coding answers that the ensemble scored high but
  //    that FAILED to execute (groundTruthVerified:false from the sandbox trace)
  //    must drive a coding synthesis patch — execution failure teaches the loop.
  {
    const dir = tmp()
    const h: any[] = []
    // Full-pipeline coding entries (no `path`): fluent, topScore 0.80, but the code
    // didn't run — exactly what server.ts now records from codeExecVerdict.
    for (let i = 0; i < 16; i++) h.push({ ts: now - (16 - i) * 1000, promptType: 'coding', topScore: 0.80, groundTruthVerified: i < 10 ? false : true })
    await runSelfPatcher(dir, [], h, ['coding'], approveIf(/coding/))
    const p = loadPatches(dir)
    ok(p.some(x => x.stage === 'stage5_synthesis' && x.promptType === 'coding' && x.status === 'active'), 'high-topScore coding answers that failed execution drive a coding synthesis patch')
    ok(!p.some(x => x.stage === 'fastpath_answer'), 'full-pipeline execution failures target synthesis, not the fast path')
    ok(activePatchText(dir, 'coding', 'stage5_synthesis').length > 0, 'the learned coding refinement applies to the code-synthesis prompt')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\nself-patcher regression: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
