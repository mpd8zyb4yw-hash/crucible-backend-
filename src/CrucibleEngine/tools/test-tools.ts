// Section 3 DONE-WHEN: edit_file a real file, run its test, search the tree.
// Also unit-checks the inline unified-diff patcher.
// Run: npx tsx src/CrucibleEngine/tools/test-tools.ts
import fs from 'fs'
import path from 'path'
import os from 'os'
import { registry, applyUnifiedPatch } from './registry'
import type { ToolCtx } from './protocol'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-tools-'))
const ctx: ToolCtx = { projectPath: work, allowMutation: true }
const exec = (name: string, args: Record<string, unknown>) => registry.exec({ id: 't', name, args }, ctx)
let failures = 0
function check(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail}`)
  if (!cond) failures++
}

// 1. write a buggy module + test
await exec('write_file', { path: 'calc.py', content: 'def add(a, b):\n    return a - b  # bug\n' })
await exec('write_file', { path: 'test_calc.py', content: 'from calc import add\nassert add(2, 3) == 5, "add broken"\nprint("ok")\n' })

// 2. run test — must fail
const fail = await exec('run', { command: 'python3 test_calc.py' })
check('run detects failing test', !fail.ok && fail.output.includes('add broken'), fail.output.slice(0, 200))

// 3. edit_file fixes the bug (unique-match contract)
const dup = await exec('edit_file', { path: 'calc.py', old: 'return', new: 'RETURN' })
check('edit_file rejects ambiguous? (single match here, so ok)', dup.ok || dup.output.includes('once'), dup.output)
// undo if it applied
if (dup.ok) await exec('edit_file', { path: 'calc.py', old: 'RETURN', new: 'return' })
const edit = await exec('edit_file', { path: 'calc.py', old: 'return a - b  # bug', new: 'return a + b' })
check('edit_file applies surgical fix', edit.ok, edit.output)

// 4. run test — must pass now
const pass = await exec('run', { command: 'python3 test_calc.py' })
check('run confirms fixed test', pass.ok && pass.output.includes('ok'), pass.output.slice(0, 200))

// 5. search the tree
const found = await exec('search', { pattern: 'def add' })
check('search finds definition', found.ok && found.output.includes('calc.py'), found.output.slice(0, 200))

// 6. edit_file uniqueness guard
await exec('write_file', { path: 'dup.txt', content: 'x\nx\n' })
const amb = await exec('edit_file', { path: 'dup.txt', old: 'x', new: 'y' })
check('edit_file refuses non-unique match', !amb.ok && amb.output.includes('more than once'), amb.output)

// 7. unified-diff patcher: multi-hunk, offset line numbers
const orig = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
const patch = ['@@ -2,2 +2,2 @@', ' b', '-c', '+C', '@@ -6,2 +6,2 @@', ' f', '-g', '+G'].join('\n')
const patched = applyUnifiedPatch(orig, patch)
check('patcher applies multi-hunk', patched.ok && patched.text === ['a', 'b', 'C', 'd', 'e', 'f', 'G'].join('\n'), JSON.stringify(patched))
const offPatch = ['@@ -5,2 +5,2 @@', ' b', '-c', '+C'].join('\n')   // wrong line number, right context
const offApplied = applyUnifiedPatch(orig, offPatch)
check('patcher tolerates stale line numbers', offApplied.ok && offApplied.text!.includes('C'), JSON.stringify(offApplied))
const badPatch = ['@@ -1,1 +1,1 @@', '-zzz', '+y'].join('\n')
check('patcher rejects unmatched context', !applyUnifiedPatch(orig, badPatch).ok)

// 8. apply_patch tool end-to-end
await exec('write_file', { path: 'notes.md', content: 'one\ntwo\nthree\n' })
const ap = await exec('apply_patch', { path: 'notes.md', patch: '@@ -2,1 +2,1 @@\n-two\n+TWO' })
check('apply_patch tool works', ap.ok && fs.readFileSync(path.join(work, 'notes.md'), 'utf-8').includes('TWO'), ap.output)

// 9. path safety — mutation outside projectPath is blocked
const escape = await exec('write_file', { path: '/tmp/crucible-escape-test.txt', content: 'nope' })
check('write outside project root blocked', !escape.ok && escape.output.includes('outside'), escape.output)

fs.rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
