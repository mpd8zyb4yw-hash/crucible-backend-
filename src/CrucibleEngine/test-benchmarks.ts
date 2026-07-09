// Test for the benchmark regression signal (benchmarks.ts).
// The suite already compared runs, but only console.warn'd the result — now the
// per-promptType regression is computed as a pure function and PERSISTED on each
// run (queryable + actionable). Deterministic, no network.
// Run: npx tsx src/CrucibleEngine/test-benchmarks.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { detectRegressions, recordBenchmarkRun, loadRuns } from './benchmarks'

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ok  ', m) } else { fail++; console.log('  FAIL', m) } }
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-')); fs.mkdirSync(path.join(d, '.crucible'), { recursive: true }); return d }

function main() {
  // ── 1. Pure detector.
  {
    ok(detectRegressions(undefined, { math: { passed: 0, total: 4 } }).length === 0, 'no previous run → no regressions')
    const r = detectRegressions({ math: { passed: 4, total: 4 } }, { math: { passed: 0, total: 4 } })
    ok(r.length === 1 && r[0].promptType === 'math' && Math.abs(r[0].drop - 1) < 1e-9, 'a >5% category drop is detected with prev/curr rates')
    ok(detectRegressions({ math: { passed: 2, total: 2 } }, { math: { passed: 0, total: 2 } }).length === 0, 'too-few prior samples (<3) are ignored')
    ok(detectRegressions({ math: { passed: 0, total: 4 } }, { math: { passed: 4, total: 4 } }).length === 0, 'an improvement is not a regression')
    ok(detectRegressions({ math: { passed: 4, total: 4 } }, { math: { passed: 4, total: 4 } }).length === 0, 'a flat category is not a regression')
  }

  // ── 2. recordBenchmarkRun persists the regression signal on the run.
  {
    const dir = tmp()
    const mathIds = ['b003', 'b006', 'b010', 'b015']   // seed math benchmarks
    const mk = (passed: boolean) => mathIds.map(id => ({ benchmarkId: id, passed, score: passed ? 1 : 0, synthesis: '' }))

    const run1 = recordBenchmarkRun(dir, mk(true))    // math 4/4
    ok(run1.regressions.length === 0, 'first run has no regressions (no baseline)')

    const run2 = recordBenchmarkRun(dir, mk(false))   // math 0/4 → regression
    ok(run2.regressions.some(r => r.promptType === 'math'), 'a degraded second run records a math regression on the run object')

    const persisted = loadRuns(dir)
    ok(persisted.length === 2, 'both runs persisted')
    ok((persisted[1].regressions ?? []).some(r => r.promptType === 'math'), 'the regression is persisted to benchmark-runs.json (queryable, not just logged)')

    const run3 = recordBenchmarkRun(dir, mk(true))    // recovered
    ok(run3.regressions.length === 0, 'recovery clears the regression on the next run')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\nbenchmarks regression: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main()
