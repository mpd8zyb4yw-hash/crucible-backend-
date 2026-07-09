// Regression test for the history-file migration bug class.
//
// Several learning/analytics modules read `.crucible/history.json` as their session
// source, but startup migration renames that file to `history-default.json`, so
// post-migration they all read an absent file and returned [] — silently dead.
// This proves the two wired, core-learning ones (emergent specialization clusters
// and the failure taxonomy) now produce real output from history-default.json.
// Deterministic, no network. Run: npx tsx src/CrucibleEngine/test-history-revival.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { detectEmergentClusters } from './specializationDetector'
import { buildFailureTaxonomy } from './failureTaxonomy'

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ok  ', m) } else { fail++; console.log('  FAIL', m) } }
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'histrev-')); fs.mkdirSync(path.join(d, '.crucible'), { recursive: true }); return d }
const now = Date.now()

// Realistic history-default.json entries (the shape the live pipeline persists).
function sessions(): any[] {
  const s: any[] = []
  // A tight cluster of ≥5 near-identical queries so k-means yields a real cluster.
  for (let i = 0; i < 8; i++) s.push({ ts: now - (40 - i) * 1000, query: 'sort an array of integers ascending efficiently', promptType: 'coding', topScore: 0.82, synthesis: 'Use a comparator sort. '.repeat(20) })
  // A second theme.
  for (let i = 0; i < 8; i++) s.push({ ts: now - (30 - i) * 1000, query: 'explain the causes of the french revolution in detail', promptType: 'factual', topScore: 0.78, synthesis: 'Economic and social factors. '.repeat(20) })
  // Low-score entries WITH synthesis → failures for the taxonomy (need ≥6 < 0.52).
  for (let i = 0; i < 8; i++) s.push({ ts: now - (20 - i) * 1000, query: `tricky ambiguous prompt number ${i} that models flub`, promptType: 'reasoning', topScore: 0.40, synthesis: 'A weak, incomplete attempt. '.repeat(5) })
  return s
}

function main() {
  // ── 1. Emergent specialization clusters now populate from history-default.json.
  {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, '.crucible', 'history-default.json'), JSON.stringify(sessions()))
    const clusters = detectEmergentClusters(dir)
    ok(clusters.length > 0, 'detectEmergentClusters returns clusters from history-default.json (was dead: read migrated-away history.json)')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 2. Failure taxonomy now populates from history-default.json.
  {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, '.crucible', 'history-default.json'), JSON.stringify(sessions()))
    const taxonomy = buildFailureTaxonomy(dir)
    ok(taxonomy.length > 0, 'buildFailureTaxonomy returns failure clusters from history-default.json (was dead)')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 3. Guard: a legacy history.json is now IGNORED (proves the source moved), and
  //    absence of history-default.json is a clean empty, not a crash.
  {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, '.crucible', 'history.json'), JSON.stringify(sessions()))  // legacy only
    ok(detectEmergentClusters(dir).length === 0, 'legacy history.json is no longer the source (correctly empty)')
    ok(buildFailureTaxonomy(dir).length === 0, 'failure taxonomy also ignores the legacy file')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\nhistory-revival regression: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main()
