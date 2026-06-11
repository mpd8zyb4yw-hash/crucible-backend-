// Section 8 DONE-WHEN: kill a task mid-run, "restart", and the session resumes
// with plan + files intact; writes outside projectPath are blocked.
// Deterministic: scripted planModel + driveTurn, real fs, real session files.
// Run: npx tsx src/CrucibleEngine/state/test-session.ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runPlannedTask } from '../agent/planner'
import { registry } from '../tools/registry'
import {
  saveSession, loadSession, listSessions, latestResumable, newSessionId,
  appendMemory, readMemoryDigest, isWriteAllowed, defaultPermissions, crucibleDir,
} from './session'
import type { DriveTurn } from '../agent/loop'

let failures = 0
const check = (l: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'} — ${l}${c ? '' : ' :: ' + d}`); if (!c) failures++ }
const emit = () => {}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-sess-'))
const T0 = 1_700_000_000_000

// A 3-step plan: write a.py, b.py, c.py. Scripted plan + driver.
const planModel = async () => JSON.stringify([
  { id: 1, intent: 'write a.py', doneCheck: 'a.py exists' },
  { id: 2, intent: 'write b.py', doneCheck: 'b.py exists' },
  { id: 3, intent: 'write c.py', doneCheck: 'c.py exists' },
])

// Driver writes the file named in the step, then finalizes. Aborts after step 1
// via the provided signal to simulate a kill.
function makeDriver(): DriveTurn {
  return async (messages) => {
    const goalMsg = String(messages.find(m => m.role === 'user')?.content ?? '')
    // Match the CURRENT step only (after "Current step:"), not completed-so-far context.
    const current = goalMsg.split('Current step:').pop() ?? goalMsg
    const m = current.match(/write (\w+\.py)/)
    const file = m?.[1]
    const lastWasTool = messages[messages.length - 1]?.role === 'tool'
    if (file && !lastWasTool) {
      return { text: '', toolCalls: [{ id: 'w', name: 'write_file', args: { path: file, content: `# ${file}\nprint("${file}")\n` } }] }
    }
    return { text: `wrote ${file}`, toolCalls: [] }
  }
}

// ── Phase 1: run, but kill (abort) after the first step completes ─────────────
{
  const ac = new AbortController()
  const sessionId = newSessionId(T0)
  let stepsDone = 0
  const persist = (steps: any[], summaries: string[], status: any) => {
    saveSession({ id: sessionId, goal: 'build a,b,c', projectPath: work, steps, completedSummaries: summaries, status, createdAt: T0, updatedAt: T0 })
    stepsDone = steps.filter((s: any) => s.status === 'done').length
    if (stepsDone === 1) ac.abort()   // simulate a kill right after step 1
  }
  await runPlannedTask({
    goal: 'build a,b,c', projectPath: work, driveTurn: makeDriver(),
    planModel, emit, signal: ac.signal, onPersist: persist,
    makeVerify: () => async () => ({ passed: true, signal: 'none', report: '' }),
  })
  check('phase 1 wrote a.py before kill', fs.existsSync(path.join(work, 'a.py')))
  check('phase 1 did NOT write c.py (killed early)', !fs.existsSync(path.join(work, 'c.py')))
  const persisted = loadSession(work, sessionId)
  check('session persisted to .crucible/sessions', persisted !== null && persisted.steps[0].status === 'done')
  check('session dir is under projectPath (not global)', fs.existsSync(path.join(crucibleDir(work), 'sessions')))
}

// ── Phase 2: "restart" — resume from the persisted session ────────────────────
{
  const resumable = latestResumable(work)
  check('latestResumable finds the unfinished session', resumable !== null && resumable.steps.some(s => s.status !== 'done'))
  const result = await runPlannedTask({
    goal: resumable!.goal, projectPath: work, driveTurn: makeDriver(),
    planModel, emit,
    resume: { steps: resumable!.steps, completedSummaries: resumable!.completedSummaries },
    onPersist: (steps, summaries, status) => saveSession({ ...resumable!, steps, completedSummaries: summaries, status, updatedAt: T0 }),
    makeVerify: () => async () => ({ passed: true, signal: 'none', report: '' }),
  })
  check('resumed task completes', result.ok)
  check('resume wrote the remaining files (b.py, c.py)', fs.existsSync(path.join(work, 'b.py')) && fs.existsSync(path.join(work, 'c.py')))
  check('no duplicate work — a.py untouched/intact', fs.readFileSync(path.join(work, 'a.py'), 'utf-8').includes('a.py'))
  check('session marked done after resume', loadSession(work, latestResumable(work)?.id ?? listSessions(work)[0].id)?.status === 'done' || listSessions(work)[0].status === 'done')
}

// ── Safety: writes outside projectPath are blocked ────────────────────────────
{
  const escape = await registry.exec({ id: 'x', name: 'write_file', args: { path: '/tmp/crucible-escape.txt', content: 'no' } }, { projectPath: work, allowMutation: true })
  check('write outside projectPath blocked', !escape.ok && /outside/.test(escape.output), escape.output)
  const perms = defaultPermissions()
  check('isWriteAllowed: inside project = allowed', isWriteAllowed(path.join(work, 'x.py'), work, perms))
  check('isWriteAllowed: outside = denied', !isWriteAllowed('/etc/hosts', work, perms))
  perms.allowOutsideWrites.push('/tmp/allowed-zone')
  check('isWriteAllowed: allow-listed path = allowed', isWriteAllowed('/tmp/allowed-zone/f.txt', work, perms))
}

// ── Project memory: append + digest roundtrip ─────────────────────────────────
{
  appendMemory(work, 'Verify with: `python3 -B test_a.py` (test)', T0)
  appendMemory(work, 'Uses 4-space indentation', T0)
  appendMemory(work, 'Verify with: `python3 -B test_a.py` (test)', T0)   // dup — should be ignored
  const digest = readMemoryDigest(work)
  check('memory digest contains facts', digest.includes('python3 -B test_a.py') && digest.includes('4-space'))
  const dupCount = (fs.readFileSync(path.join(crucibleDir(work), 'memory.md'), 'utf-8').match(/python3 -B test_a\.py/g) ?? []).length
  check('memory de-dupes identical facts', dupCount === 1, `count=${dupCount}`)
}

fs.rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
