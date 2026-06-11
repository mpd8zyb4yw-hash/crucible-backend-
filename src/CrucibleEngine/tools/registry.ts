// Tool registry — single source of truth for every tool the agent can call.
// Sections 3+ register editing/shell tools here; section 1 ships read_file/list_dir.

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import type { ToolCall, ToolCtx, ToolDef, ToolResult } from './protocol'
import { createCheckpoint } from '../checkpoint'

const tools = new Map<string, ToolDef>()

// Checkpoint before file mutations, at most once per minute per project.
const FILE_MUTATORS = new Set(['write_file', 'edit_file', 'apply_patch'])
const lastCheckpoint = new Map<string, number>()
function checkpointBeforeMutation(toolName: string, ctx: ToolCtx) {
  if (!FILE_MUTATORS.has(toolName)) return
  const now = Date.now()
  if (now - (lastCheckpoint.get(ctx.projectPath) ?? 0) < 60_000) return
  lastCheckpoint.set(ctx.projectPath, now)
  try { createCheckpoint(ctx.projectPath, `pre-${toolName}`) } catch { /* non-fatal */ }
}

export const registry = {
  register(def: ToolDef) {
    tools.set(def.name, def)
  },
  list(): ToolDef[] {
    return [...tools.values()]
  },
  get(name: string): ToolDef | undefined {
    return tools.get(name)
  },
  async exec(call: ToolCall, ctx: ToolCtx): Promise<ToolResult> {
    const def = tools.get(call.name)
    if (!def) return { ok: false, output: `Unknown tool: ${call.name}. Available: ${[...tools.keys()].join(', ')}` }
    if (def.mutates && ctx.allowMutation === false) {
      return { ok: false, output: `Tool ${call.name} mutates state and is not permitted in this context.` }
    }
    if (ctx.signal?.aborted) return { ok: false, output: 'Cancelled.' }
    checkpointBeforeMutation(call.name, ctx)
    ctx.emit?.({ type: 'tool_call', id: call.id, tool: call.name, args: call.args })
    try {
      const result = await def.run(call.args, ctx)
      ctx.emit?.({ type: 'tool_result', id: call.id, tool: call.name, ok: result.ok, output: result.output.slice(0, 2000), truncated: result.truncated ?? false })
      return result
    } catch (e: any) {
      const result = { ok: false, output: `Tool ${call.name} threw: ${e?.message ?? e}` }
      ctx.emit?.({ type: 'tool_result', id: call.id, tool: call.name, ok: false, output: result.output })
      return result
    }
  },
}

// ── Path safety ───────────────────────────────────────────────────────────────

/** Resolve p against projectPath; throw if it escapes the project root or is empty. */
export function resolveSafe(p: string, ctx: ToolCtx, { allowOutside = false } = {}): string {
  if (!p || typeof p !== 'string' || !p.trim()) {
    throw new Error('A non-empty "path" argument is required.')
  }
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(ctx.projectPath, p)
  if (!allowOutside) {
    const root = path.resolve(ctx.projectPath) + path.sep
    if (!(abs + path.sep).startsWith(root)) {
      throw new Error(`Path ${p} is outside the project root (${ctx.projectPath})`)
    }
  }
  return abs
}

const MAX_OUTPUT_CHARS = 24_000

/** Read a file for mutation tools, returning a clean error (never throwing EISDIR/ENOENT). */
function readFileChecked(abs: string): { ok: true; content: string } | { ok: false; output: string } {
  if (!fs.existsSync(abs)) return { ok: false, output: `File not found: ${abs}. Create it with write_file first.` }
  if (fs.statSync(abs).isDirectory()) return { ok: false, output: `${abs} is a directory, not a file. Pass a file path.` }
  return { ok: true, content: fs.readFileSync(abs, 'utf-8') }
}

export function capOutput(s: string, max = MAX_OUTPUT_CHARS): { output: string; truncated: boolean } {
  if (s.length <= max) return { output: s, truncated: false }
  return { output: s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`, truncated: true }
}

// ── Tiny inline unified-diff patcher (no deps) ───────────────────────────────
// Locates each hunk by its context+deletion lines (exact match scan from the
// hunk's declared position outward), so stale line numbers still apply.
export function applyUnifiedPatch(text: string, patch: string): { ok: boolean; text?: string; hunks?: number; error?: string } {
  const lines = text.split('\n')
  const patchLines = patch.split('\n')
  let hunks = 0
  let i = 0
  while (i < patchLines.length) {
    const header = patchLines[i].match(/^@@\s*-(\d+)(?:,\d+)?\s*\+\d+(?:,\d+)?\s*@@/)
    if (!header) { i++; continue }
    const declaredStart = parseInt(header[1], 10) - 1
    const oldBlock: string[] = []
    const newBlock: string[] = []
    i++
    while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
      const l = patchLines[i]
      if (l.startsWith('-')) oldBlock.push(l.slice(1))
      else if (l.startsWith('+')) newBlock.push(l.slice(1))
      else if (l.startsWith(' ') || l === '') { oldBlock.push(l.slice(1)); newBlock.push(l.slice(1)) }
      else if (l.startsWith('\\')) { /* "\ No newline" — ignore */ }
      else break
      i++
    }
    if (oldBlock.length === 0 && newBlock.length === 0) continue
    const pos = findBlock(lines, oldBlock, declaredStart)
    if (pos === -1) return { ok: false, error: `Hunk ${hunks + 1} context not found:\n${oldBlock.slice(0, 5).join('\n')}` }
    lines.splice(pos, oldBlock.length, ...newBlock)
    hunks++
  }
  if (hunks === 0) return { ok: false, error: 'No @@ hunks found in patch.' }
  return { ok: true, text: lines.join('\n'), hunks }
}

/** Exact block match scanning outward from the declared position. */
function findBlock(lines: string[], block: string[], near: number): number {
  const matches = (at: number) => block.every((b, j) => lines[at + j] === b)
  const limit = lines.length - block.length
  if (near >= 0 && near <= limit && matches(near)) return near
  for (let d = 1; d <= Math.max(near, limit - near); d++) {
    if (near - d >= 0 && matches(near - d)) return near - d
    if (near + d <= limit && matches(near + d)) return near + d
  }
  return -1
}

// ── Search backends ───────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'server-dist', '.crucible', '.vite', 'app'])
const BINARY_EXT = /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|mp4|mov|zip|gz|pdf|lock)$/i

function searchRipgrep(pattern: string, dir: string, max: number): Promise<string[] | null> {
  return new Promise(resolve => {
    const child = spawn('rg', ['-n', '--no-heading', '-m', String(max), '-e', pattern, '.'], { cwd: dir })
    let out = '', failed = false
    child.on('error', () => { failed = true; resolve(null) })  // rg not installed
    child.stdout.on('data', d => { if (out.length < 200_000) out += d.toString() })
    child.on('close', code => {
      if (failed) return
      if (code !== 0 && code !== 1) return resolve(null)       // 1 = no matches
      resolve(out.split('\n').filter(Boolean).slice(0, max))
    })
  })
}

function searchJSWalk(pattern: string, dir: string, max: number): string[] | null {
  let re: RegExp
  try { re = new RegExp(pattern) } catch { return null }
  const results: string[] = []
  const walk = (d: string) => {
    if (results.length >= max) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (results.length >= max) return
      const full = path.join(d, e.name)
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full); continue }
      if (BINARY_EXT.test(e.name)) continue
      let content: string
      try { if (fs.statSync(full).size > 1_000_000) continue; content = fs.readFileSync(full, 'utf-8') } catch { continue }
      content.split('\n').forEach((line, idx) => {
        if (results.length < max && re.test(line)) results.push(`${path.relative(dir, full)}:${idx + 1}:${line.slice(0, 300)}`)
      })
    }
  }
  walk(dir)
  return results
}

// ── Built-in tools (section 1) ────────────────────────────────────────────────

registry.register({
  name: 'read_file',
  description: 'Read a file. Returns numbered lines. Supports offset/limit for large files.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute, or relative to project root)' },
      offset: { type: 'number', description: '1-based line to start from' },
      limit: { type: 'number', description: 'Max lines to return' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx, { allowOutside: true })
    if (!fs.existsSync(abs)) return { ok: false, output: `File not found: ${abs}` }
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) return { ok: false, output: `${abs} is a directory — use list_dir.` }
    const lines = fs.readFileSync(abs, 'utf-8').split('\n')
    const offset = Math.max(1, Number(args.offset ?? 1))
    const limit = Math.min(Number(args.limit ?? 2000), 5000)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
    const { output, truncated } = capOutput(numbered)
    return { ok: true, output, truncated: truncated || offset - 1 + limit < lines.length, meta: { totalLines: lines.length } }
  },
})

registry.register({
  name: 'write_file',
  description: 'Create or overwrite a file with the given content. Parent dirs are created.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to project root or absolute within it)' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  mutates: true,
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, String(args.content ?? ''), 'utf-8')
    return { ok: true, output: `Wrote ${String(args.content ?? '').length} chars to ${abs}` }
  },
})

registry.register({
  name: 'edit_file',
  description: 'Surgical edit: replace an exact old string with a new string. The old string must appear exactly once in the file.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old: { type: 'string', description: 'Exact text to replace (must be unique in the file)' },
      new: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old', 'new'],
  },
  mutates: true,
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx)
    const read = readFileChecked(abs)
    if (!read.ok) return read
    const oldStr = String(args.old ?? ''), newStr = String(args.new ?? '')
    if (!oldStr) return { ok: false, output: 'old must be non-empty' }
    const content = read.content
    const first = content.indexOf(oldStr)
    if (first === -1) return { ok: false, output: `old string not found in ${abs}. Read the file and match exactly (including whitespace).` }
    if (content.indexOf(oldStr, first + 1) !== -1) return { ok: false, output: `old string appears more than once in ${abs} — include more surrounding context to make it unique.` }
    fs.writeFileSync(abs, content.slice(0, first) + newStr + content.slice(first + oldStr.length), 'utf-8')
    ctx.emit?.({ type: 'diff', path: abs, old: oldStr.slice(0, 1000), new: newStr.slice(0, 1000) })
    return { ok: true, output: `Edited ${abs} (replaced ${oldStr.length} chars with ${newStr.length}).` }
  },
})

registry.register({
  name: 'apply_patch',
  description: 'Apply a unified diff to a file (multi-hunk). Hunks are located by context lines, so slightly-off line numbers still apply.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to patch' },
      patch: { type: 'string', description: 'Unified diff body (@@ hunks with context, -, + lines)' },
    },
    required: ['path', 'patch'],
  },
  mutates: true,
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx)
    const read = readFileChecked(abs)
    if (!read.ok) return read
    const patchBody = String(args.patch ?? '')
    if (!patchBody.trim()) return { ok: false, output: 'A non-empty "patch" argument (unified diff) is required.' }
    const result = applyUnifiedPatch(read.content, patchBody)
    if (!result.ok) return { ok: false, output: result.error! }
    fs.writeFileSync(abs, result.text!, 'utf-8')
    ctx.emit?.({ type: 'diff', path: abs, patch: String(args.patch).slice(0, 2000) })
    return { ok: true, output: `Patched ${abs}: ${result.hunks} hunk(s) applied.` }
  },
})

registry.register({
  name: 'search',
  description: 'Search file contents in the project for a pattern (regex). Returns file:line: matches.',
  params: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern' },
      dir: { type: 'string', description: 'Subdirectory to search (default: project root)' },
      maxResults: { type: 'number', description: 'Max matching lines (default 50)' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const dir = resolveSafe(String(args.dir ?? '.'), ctx, { allowOutside: true })
    const maxResults = Math.min(Number(args.maxResults ?? 50), 200)
    const pattern = String(args.pattern ?? '')
    const viaRg = await searchRipgrep(pattern, dir, maxResults)
    const lines = viaRg ?? searchJSWalk(pattern, dir, maxResults)
    if (lines === null) return { ok: false, output: `Invalid regex: ${pattern}` }
    const { output, truncated } = capOutput(lines.join('\n') || '(no matches)')
    return { ok: true, output, truncated, meta: { count: lines.length } }
  },
})

registry.register({
  name: 'run',
  description: 'Run a shell command in the project root. Returns stdout/stderr and exit code. 30s timeout.',
  params: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (max 120000)' },
    },
    required: ['command'],
  },
  mutates: true,
  async run(args, ctx) {
    const command = String(args.command ?? '')
    const timeoutMs = Math.min(Number(args.timeoutMs ?? 30_000), 120_000)
    return new Promise<ToolResult>(resolve => {
      const child = spawn('/bin/zsh', ['-c', command], { cwd: ctx.projectPath, env: process.env })
      let out = ''
      const cap = (s: string) => { if (out.length < 100_000) out += s }
      child.stdout.on('data', d => cap(d.toString()))
      child.stderr.on('data', d => cap(d.toString()))
      const timer = setTimeout(() => { child.kill('SIGKILL'); out += `\n[killed: ${timeoutMs}ms timeout]` }, timeoutMs)
      const onAbort = () => { child.kill('SIGKILL'); out += '\n[killed: cancelled]' }
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      child.on('close', code => {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
        const { output, truncated } = capOutput(out)
        resolve({ ok: code === 0, output: `exit ${code}\n${output}`, truncated, meta: { exitCode: code } })
      })
      child.on('error', e => {
        clearTimeout(timer)
        resolve({ ok: false, output: `spawn failed: ${e.message}` })
      })
    })
  },
})

registry.register({
  name: 'list_dir',
  description: 'List a directory (shallow). Directories end with /.',
  params: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path (default: project root)' } },
    required: [],
  },
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? '.'), ctx, { allowOutside: true })
    if (!fs.existsSync(abs)) return { ok: false, output: `Directory not found: ${abs}` }
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter(e => e.name !== 'node_modules' && e.name !== '.git')
      .map(e => e.isDirectory() ? `${e.name}/` : e.name)
      .sort()
    const { output, truncated } = capOutput(entries.join('\n'))
    return { ok: true, output, truncated }
  },
})
