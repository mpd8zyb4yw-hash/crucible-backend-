// Session state, project memory, and permissions (Section 8).
// Everything lives under <projectPath>/.crucible/ — NEVER a shared global app dir,
// so two projects never cross-contaminate. Sessions persist after each step so a
// usage cutoff (or a server kill) resumes the agent TASK, not just the chat.

import fs from 'fs'
import path from 'path'
import type { Step } from '../agent/planner'

export interface SessionState {
  id: string
  goal: string
  projectPath: string
  steps: Step[]
  completedSummaries: string[]
  status: 'running' | 'done' | 'failed'
  createdAt: number
  updatedAt: number
}

// ── Paths ─────────────────────────────────────────────────────────────────────
export function crucibleDir(projectPath: string): string {
  return path.join(projectPath, '.crucible')
}
function sessionsDir(projectPath: string): string {
  return path.join(crucibleDir(projectPath), 'sessions')
}
function sessionFile(projectPath: string, id: string): string {
  return path.join(sessionsDir(projectPath), `${id}.json`)
}
export function memoryFile(projectPath: string): string {
  return path.join(crucibleDir(projectPath), 'memory.md')
}

function ensureDirs(projectPath: string) {
  fs.mkdirSync(sessionsDir(projectPath), { recursive: true })
}

// ── Session persistence ───────────────────────────────────────────────────────
export function saveSession(state: SessionState): void {
  ensureDirs(state.projectPath)
  state.updatedAt = Date.now()
  // Atomic write: tmp + rename, so a kill mid-write can't corrupt the file.
  const dst = sessionFile(state.projectPath, state.id)
  const tmp = `${dst}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
  fs.renameSync(tmp, dst)
}

export function loadSession(projectPath: string, id: string): SessionState | null {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(projectPath, id), 'utf-8'))
  } catch { return null }
}

export function listSessions(projectPath: string): SessionState[] {
  try {
    return fs.readdirSync(sessionsDir(projectPath))
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json'))
      .map(f => loadSession(projectPath, f.replace(/\.json$/, '')))
      .filter((s): s is SessionState => s !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch { return [] }
}

/** Most recent session still running with at least one unfinished step. */
export function latestResumable(projectPath: string): SessionState | null {
  return listSessions(projectPath).find(s =>
    s.status === 'running' && s.steps.some(st => st.status !== 'done')) ?? null
}

export function newSessionId(seed: number): string {
  // Deterministic given seed (no Date.now/random here) — caller passes a timestamp.
  return `s_${seed.toString(36)}`
}

// ── Project memory ────────────────────────────────────────────────────────────
// Durable facts about the project (build cmd, test cmd, conventions). Appended as
// markdown bullets; a compressed digest is injected into the driver preamble.
export function appendMemory(projectPath: string, fact: string, when: number): void {
  const f = fact.trim()
  if (!f) return
  ensureDirs(projectPath)
  const file = memoryFile(projectPath)
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '# Project memory\n\n'
  // De-dupe: skip if this exact fact is already recorded.
  if (existing.includes(`- ${f}`)) return
  fs.appendFileSync(existing ? file : file, `- ${f}  <!-- ${new Date(when).toISOString()} -->\n`, 'utf-8')
}

export function readMemoryDigest(projectPath: string, maxChars = 1200): string {
  const file = memoryFile(projectPath)
  if (!fs.existsSync(file)) return ''
  const bullets = fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => l.trim().startsWith('- '))
    .map(l => l.replace(/\s*<!--.*?-->\s*$/, '').trim())
  if (!bullets.length) return ''
  let digest = bullets.join('\n')
  if (digest.length > maxChars) digest = digest.slice(0, maxChars) + '\n…'
  return `Known facts about this project:\n${digest}`
}

// ── Permissions / safety ──────────────────────────────────────────────────────
export interface Permissions {
  /** Absolute paths outside projectPath that mutation is explicitly allowed to touch. */
  allowOutsideWrites: string[]
}

export function defaultPermissions(): Permissions {
  return { allowOutsideWrites: [] }
}

/** True if a mutation at `abs` is permitted given the project root + allow-list. */
export function isWriteAllowed(abs: string, projectPath: string, perms: Permissions): boolean {
  const root = path.resolve(projectPath) + path.sep
  if ((path.resolve(abs) + path.sep).startsWith(root)) return true
  return perms.allowOutsideWrites.some(p => path.resolve(abs).startsWith(path.resolve(p)))
}
