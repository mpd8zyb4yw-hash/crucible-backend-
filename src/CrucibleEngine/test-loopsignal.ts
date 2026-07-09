// Unit test for the fast-path learning signal (loopSignal.ts).
// Deterministic, no network. Run: npx tsx src/CrucibleEngine/test-loopsignal.ts

import fs from 'fs'
import os from 'os'
import path from 'path'
import { recordFastPathOutcome, historyFileFor } from './loopSignal'

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ok  ', m) } else { fail++; console.log('  FAIL', m) } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loopsignal-'))
const read = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return [] } }

function main() {
  // historyFileFor resolves per-user vs default.
  {
    const d = '/x'
    ok(historyFileFor(d, 'u1').endsWith('.crucible/history-u1.json'), 'per-user history file path')
    ok(historyFileFor(d).endsWith('.crucible/history-default.json'), 'default history file path when no user')
    ok(historyFileFor(d, null).endsWith('.crucible/history-default.json'), 'null user → default')
  }

  // Clean answer (not repaired) → no write at all.
  {
    const dir = tmp(); const hf = historyFileFor(dir)
    const wrote = recordFastPathOutcome(hf, { promptType: 'general', query: 'q', answer: 'a', verifierRepaired: false, path: 'simple' })
    ok(wrote === false, 'clean (unrepaired) outcome is a no-op')
    ok(!fs.existsSync(hf), 'no history file created for a clean outcome')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // Repaired answer → exactly one entry with the loop-consumable shape.
  {
    const dir = tmp(); const hf = historyFileFor(dir)
    const wrote = recordFastPathOutcome(hf, { promptType: 'factual', query: 'capital?', answer: 'Paris', verifierRepaired: true, path: 'local_only_synth', model: 'local/apple-fm' })
    ok(wrote === true, 'repaired outcome writes an entry')
    const h = read(hf)
    ok(h.length === 1, 'exactly one entry')
    const e = h[0]
    ok(e.groundTruthVerified === false, 'entry marks groundTruthVerified=false (a hard low)')
    ok(e.promptType === 'factual' && e.path === 'local_only_synth', 'entry carries promptType + provenance path')
    ok(e.topScore === undefined, 'no fake topScore (only the ground-truth verdict carries signal)')
    ok(typeof e.ts === 'number', 'entry has a timestamp')
    ok(Array.isArray(e.models) && e.models[0] === 'local/apple-fm', 'entry records the model')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // Appends to existing history and caps at 200.
  {
    const dir = tmp(); const hf = historyFileFor(dir)
    fs.mkdirSync(path.dirname(hf), { recursive: true })
    fs.writeFileSync(hf, JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ ts: i, promptType: 'general', topScore: 0.8 }))))
    recordFastPathOutcome(hf, { promptType: 'coding', query: 'q', answer: 'a', verifierRepaired: true, path: 'simple' })
    const h = read(hf)
    ok(h.length === 200, 'history stays capped at 200')
    ok(h[h.length - 1].promptType === 'coding' && h[h.length - 1].groundTruthVerified === false, 'newest entry is the appended fast-path low')
    ok(h[0].ts === 1, 'oldest entry evicted (slice from the front)')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // Corrupt existing history → recovers, does not throw, writes a fresh array.
  {
    const dir = tmp(); const hf = historyFileFor(dir)
    fs.mkdirSync(path.dirname(hf), { recursive: true })
    fs.writeFileSync(hf, '{not json at all')
    const wrote = recordFastPathOutcome(hf, { promptType: 'general', query: 'q', answer: 'a', verifierRepaired: true, path: 'offline_mode' })
    ok(wrote === true, 'corrupt history is recovered, not fatal')
    ok(read(hf).length === 1, 'a clean single-entry array is written over the corruption')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\nloop-signal unit: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main()
