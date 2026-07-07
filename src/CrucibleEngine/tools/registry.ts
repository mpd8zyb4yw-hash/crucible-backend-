// Tool registry — single source of truth for every tool the agent can call.
// Sections 3+ register editing/shell tools here; section 1 ships read_file/list_dir.

import fs from 'fs'
import path from 'path'
import { spawn, execFile } from 'child_process'
import type { ToolCall, ToolCtx, ToolDef, ToolResult } from './protocol'
import { createCheckpoint } from '../checkpoint'
import { compileTool, saveDynamicTool, listDynamicTools, recordToolSuccess, type DynamicToolRecord } from './dynamicTools'
import { appendGlobalMemory } from '../state/session'
import { buildGraphDigest, findEntities, upsertEntity, touchEntities } from '../entityGraph'
import { gFetch, googleServicesStatus } from './googleApis'
import { getUITree, clickElement, typeText } from '../macTools'
import { researchTopic } from '../research/webResearch'

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

// Safe output locations outside the project root
const WHITELISTED_ROOTS = [
  path.join(process.env.HOME ?? '/tmp', 'Desktop'),
  path.join(process.env.HOME ?? '/tmp', 'Downloads'),
  path.join(process.env.HOME ?? '/tmp', 'Documents'),
]

/** Resolve p against projectPath; throw if it escapes the project root or whitelist. */
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
  } else {
    // allowOutside: permit project root AND whitelisted user folders only
    const root = path.resolve(ctx.projectPath) + path.sep
    const inProject = (abs + path.sep).startsWith(root)
    const inWhitelist = WHITELISTED_ROOTS.some(w => (abs + path.sep).startsWith(w + path.sep))
    if (!inProject && !inWhitelist) {
      throw new Error(`Path ${p} is outside permitted locations. Allowed: project folder, Desktop, Downloads, Documents.`)
    }
  }
  return abs
}

// ── Destructive-command guard (Section 8 — destructive op confirmation) ───────
// In autonomous server-side mode there is no interactive confirm channel, so the safe
// default is to BLOCK clearly-destructive shell commands and tell the agent to surface
// them to the user. Set ctx.allowDestructive = true to opt in (e.g. an approved task).
const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\b[^\n]*\s-\w*[rf]/i,                  why: 'recursive/forced delete (rm -rf)' },
  { re: /\bgit\s+push\b[^\n]*(?:--force|--force-with-lease|\s-f\b)/i, why: 'git force-push' },
  { re: /\bgit\s+reset\s+--hard\b/i,                why: 'git reset --hard (discards work)' },
  { re: /\bgit\s+clean\s+-\w*f/i,                   why: 'git clean -f (deletes untracked files)' },
  { re: /\bgit\s+checkout\s+(?:--\s|\.\s*$|-- \.)/i, why: 'git checkout -- (discards changes)' },
  { re: /\b(?:mkfs|fdisk|dd)\b/i,                   why: 'disk-level write' },
  { re: /\bchmod\s+-R\b|\bchown\s+-R\b/i,           why: 'recursive permission/ownership change' },
  { re: /\bsudo\b/i,                                why: 'privilege escalation (sudo)' },
  { re: /\b(?:shutdown|reboot|halt|poweroff)\b/i,   why: 'system power control' },
  { re: />\s*\/dev\/(?:sd|disk|null\/)/i,           why: 'write to a device node' },
  { re: /:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/,         why: 'fork bomb' },
  { re: /\bgit\s+branch\s+-D\b/i,                   why: 'force-delete a git branch' },
]

/** Returns the reason a command is destructive, or null if it's safe to run. */
export function destructiveReason(command: string): string | null {
  for (const { re, why } of DESTRUCTIVE_PATTERNS) if (re.test(command)) return why
  return null
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
    const abs = resolveSafe(String(args.path ?? ''), ctx, { allowOutside: true })
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, String(args.content ?? ''), 'utf-8')
    ctx.onFileMutated?.([abs])
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
    ctx.onFileMutated?.([abs])
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
    ctx.onFileMutated?.([abs])
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
    const danger = destructiveReason(command)
    if (danger && ctx.allowDestructive !== true) {
      return {
        ok: false,
        output: `Blocked: this command looks destructive (${danger}). Destructive operations require explicit user approval. ` +
          `Do not retry — instead, stop and ask the user to confirm, or accomplish the goal a non-destructive way.`,
        meta: { blocked: 'destructive', reason: danger },
      }
    }
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
  description: 'List a directory (shallow). Accepts any absolute path or a path relative to project root. Directories end with /.',
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

// ── OS-scope tools (Section 2 — Desktop workspace + navigation) ──────────────
// These are NOT sandboxed to projectPath — they operate on any path the user owns.
// The destructive guard in `run` already blocks rm -rf etc. These fill the gap
// for legitimate moves, deletes, and app launches the agent needs outside the project.

registry.register({
  name: 'move_file',
  description: 'Move or rename a file or directory. Works anywhere on the filesystem the user can access.',
  params: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path (absolute or relative to project root)' },
      to: { type: 'string', description: 'Destination path (absolute or relative to project root)' },
    },
    required: ['from', 'to'],
  },
  mutates: true,
  async run(args, ctx) {
    const from = resolveSafe(String(args.from ?? ''), ctx, { allowOutside: true })
    const to = resolveSafe(String(args.to ?? ''), ctx, { allowOutside: true })
    if (!fs.existsSync(from)) return { ok: false, output: `Source not found: ${from}` }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
    return { ok: true, output: `Moved ${from} → ${to}` }
  },
})

registry.register({
  name: 'delete_file',
  description: 'Delete a file (not a directory). Refuses to delete directories — use the run tool with rm for that after user confirmation.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to project root)' },
    },
    required: ['path'],
  },
  mutates: true,
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx, { allowOutside: true })
    if (!fs.existsSync(abs)) return { ok: false, output: `File not found: ${abs}` }
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) {
      return { ok: false, output: `${abs} is a directory. Use the run tool with an explicit rm command (subject to destructive guard) after confirming with the user.` }
    }
    fs.unlinkSync(abs)
    return { ok: true, output: `Deleted ${abs}` }
  },
})

registry.register({
  name: 'open_app',
  description: 'Open a file, URL, or application on macOS using the system default handler (equivalent to double-clicking in Finder).',
  params: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'File path, directory path, URL (https://…), or app name (e.g. "Finder", "TextEdit")' },
    },
    required: ['target'],
  },
  async run(args) {
    const target = String(args.target ?? '').trim()
    if (!target) return { ok: false, output: 'A non-empty "target" is required.' }
    // URLs and absolute paths: open directly. App names: use -a flag.
    const isUrl = /^https?:\/\//.test(target)
    const isPath = target.startsWith('/') || target.startsWith('~')
    const openArgs = (isUrl || isPath) ? [target] : ['-a', target]
    return new Promise(resolve => {
      execFile('open', openArgs, (err, _stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message
          if (msg.includes('Unable to find application') || msg.includes('does not exist') || msg.includes('No such file')) {
            resolve({ ok: false, output: `App not found: "${target}" does not appear to be installed on this Mac.` })
          } else {
            resolve({ ok: false, output: `open failed: ${msg}` })
          }
        } else {
          resolve({ ok: true, output: `Opened: ${target}` })
        }
      })
    })
  },
})

registry.register({
  name: 'web_search',
  description: 'Search the web using DuckDuckGo. Use for current events, weather, prices, news, facts, or anything requiring up-to-date information. For location-dependent queries like weather, infer the location from context or conversation history.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  async run(args) {
    const query = String(args.query ?? '').trim()
    if (!query) return { ok: false, output: 'A non-empty "query" is required.' }
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
      })
      const html = await res.text()
      const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim()
      const titles: string[] = []
      const snippets: string[] = []

      // Strategy 1: standard DDG classes
      const titleRe1 = /<a class="result__a"[^>]*>([\s\S]*?)<\/a>/g
      const snippetRe1 = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
      let m
      while ((m = titleRe1.exec(html)) !== null && titles.length < 5) titles.push(strip(m[1]))
      while ((m = snippetRe1.exec(html)) !== null && snippets.length < 5) snippets.push(strip(m[1]))

      // Strategy 2: data-result blocks
      if (titles.length === 0) {
        const blockRe = /<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/g
        while ((m = blockRe.exec(html)) !== null && titles.length < 5) {
          const t = strip(m[1]); if (t.length > 5) titles.push(t)
        }
      }

      // Strategy 3: any <h2> or <h3> near an <a> tag
      if (titles.length === 0) {
        const h2Re = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/g
        while ((m = h2Re.exec(html)) !== null && titles.length < 5) {
          const t = strip(m[1]); if (t.length > 10) titles.push(t)
        }
      }

      if (titles.length === 0) return { ok: false, output: 'No results found. DDG may have changed their markup or blocked the request.' }
      const output = titles.map((t, i) => `${i + 1}. ${t}${snippets[i] ? '\n   ' + snippets[i] : ''}`).join('\n\n')
      return { ok: true, output }
    } catch (e: any) {
      return { ok: false, output: `Search failed: ${e?.message ?? e}` }
    }
  },
})

registry.register({
  name: 'web_research',
  description: 'Targeted research across trustworthy, domain-appropriate sources (arXiv, Hacker News, Stack Overflow, GitHub, Wikipedia, general web) instead of a single generic search. Picks sources automatically based on whether the query is academic, current-events, technical, or general. Use for specific, narrow research questions (e.g. "DeepSeek R1 reasoning architecture") rather than broad topics. Each result is tagged with its source and a 0-1 authority score.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A specific, targeted research query — not a broad topic.' },
    },
    required: ['query'],
  },
  async run(args) {
    const query = String(args.query ?? '').trim()
    if (!query) return { ok: false, output: 'A non-empty "query" is required.' }
    try {
      const findings = await researchTopic(query)
      if (!findings.length) return { ok: false, output: 'No results found across the selected sources.' }
      const output = findings
        .map((f, i) => `${i + 1}. [${f.source}, authority ${f.authorityScore.toFixed(2)}] ${f.content}\n   ${f.url}`)
        .join('\n\n')
      return { ok: true, output }
    } catch (e: any) {
      return { ok: false, output: `Research failed: ${e?.message ?? e}` }
    }
  },
})

registry.register({
  name: 'image_search',
  description: 'Search for images on the web and return direct image URLs. Use this when you need to find and download images.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for' },
      count: { type: 'number', description: 'Number of image URLs to return (default 5, max 20)' },
    },
    required: ['query'],
  },
  async run(args) {
    const query = String(args.query ?? '').trim()
    const count = Math.min(Number(args.count ?? 5), 20)
    if (!query) return { ok: false, output: 'A non-empty "query" is required.' }
    try {
      const url = `https://ddg-webapp-aagd.vercel.app/image?q=${encodeURIComponent(query)}&o=json&l=us-en`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      })
      if (res.ok) {
        const data = await res.json() as any[]
        const urls = data.slice(0, count).map((r: any) => r.image).filter(Boolean)
        if (urls.length > 0) return { ok: true, output: urls.join('\n') }
      }
      // Fallback: scrape DDG images HTML
      const fallback = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' filetype:jpg')}&iax=images&ia=images`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      })
      const html = await fallback.text()
      const imgRe = /https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/gi
      const matches = [...new Set(html.match(imgRe) ?? [])].slice(0, count)
      if (matches.length === 0) return { ok: false, output: 'No image URLs found.' }
      return { ok: true, output: matches.join('\n') }
    } catch (e: any) {
      return { ok: false, output: `Image search failed: ${e?.message ?? e}` }
    }
  },
})

registry.register({
  name: 'download_file',
  description: 'Download a file from a URL and save it to a local path. Validates the file is a real image. Only saves to Desktop, Downloads, Documents, or the project folder.',
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to download from' },
      dest: { type: 'string', description: 'Destination file path (e.g. ~/Desktop/dogs/dog1.jpg)' },
    },
    required: ['url', 'dest'],
  },
  mutates: true,
  async run(args, ctx) {
    const rawDest = String(args.dest ?? '').replace(/^~/, process.env.HOME ?? '')
    if (!rawDest) return { ok: false, output: 'A non-empty "dest" is required.' }
    try { resolveSafe(rawDest, ctx, { allowOutside: true }) } catch (e: any) { return { ok: false, output: e.message } }
    const url = String(args.url ?? '').trim()
    if (!url) return { ok: false, output: 'A non-empty "url" is required.' }
    return new Promise(resolve => {
      const dir = path.dirname(rawDest)
      fs.mkdirSync(dir, { recursive: true })
      const tmpPath = rawDest + '.tmp'
      const child = spawn('curl', ['-L', '--max-time', '15', '--max-filesize', '20000000', '-o', tmpPath, url], { env: process.env })
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('close', code => {
        if (code !== 0) { try { fs.unlinkSync(tmpPath) } catch {} ; return resolve({ ok: false, output: `curl failed: ${stderr.slice(0, 200)}` }) }
        try {
          const buf = fs.readFileSync(tmpPath)
          const size = buf.length
          // Validate magic bytes for common image formats
          const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8
          const isPng = buf[0] === 0x89 && buf[1] === 0x50
          const isWebp = buf.slice(8, 12).toString() === 'WEBP'
          const isGif = buf.slice(0, 3).toString() === 'GIF'
          if (!isJpeg && !isPng && !isWebp && !isGif) {
            fs.unlinkSync(tmpPath)
            return resolve({ ok: false, output: `URL did not return a valid image (got ${size} bytes, wrong format). Try a different URL.` })
          }
          if (size < 5000) {
            fs.unlinkSync(tmpPath)
            return resolve({ ok: false, output: `Downloaded file too small (${size} bytes) — likely a placeholder or error image.` })
          }
          fs.renameSync(tmpPath, rawDest)
          resolve({ ok: true, output: `Downloaded valid image to ${rawDest} (${Math.round(size/1024)}KB)` })
        } catch (e: any) {
          resolve({ ok: false, output: `Validation failed: ${e.message}` })
        }
      })
    })
  },
})

registry.register({
  name: 'delete_folder',
  description: 'Recursively delete a folder and all its contents. Only works on Desktop, Downloads, Documents, or project folder. Use this instead of rm -rf.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Folder path to delete (absolute or relative to project root)' },
    },
    required: ['path'],
  },
  mutates: true,
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx, { allowOutside: true })
    if (!fs.existsSync(abs)) return { ok: false, output: `Folder not found: ${abs}` }
    const stat = fs.statSync(abs)
    if (!stat.isDirectory()) return { ok: false, output: `${abs} is a file, not a folder. Use delete_file instead.` }
    fs.rmSync(abs, { recursive: true, force: true })
    return { ok: true, output: `Deleted folder: ${abs}` }
  },
})

registry.register({
  name: 'empty_trash',
  description: 'Empty the macOS Trash/Recycling bin.',
  params: { type: 'object', properties: {} },
  mutates: true,
  async run() {
    return new Promise(resolve => {
      execFile('osascript', ['-e', 'tell application "Finder" to empty trash'], (err, _, stderr) => {
        if (err) resolve({ ok: false, output: `Failed to empty trash: ${stderr || err.message}` })
        else resolve({ ok: true, output: 'Trash emptied.' })
      })
    })
  },
})

// ── Dynamic tool acquisition (Gap 2) ─────────────────────────────────────────

registry.register({
  name: 'create_tool',
  description: [
    'Write and register a NEW tool at runtime when no existing tool covers the need.',
    'The body is a JS async function body (receives `args` and `ctx`). It must return',
    '{ ok: boolean, output: string }. The tool is live immediately in this session',
    'AND persisted to .crucible/dynamic-tools/ so it reloads on future runs.',
    'Only create a tool when the built-in set genuinely cannot do the job.',
    'EXAMPLE body: "const { execFile } = require(\'child_process\');\n',
    'return new Promise(res => execFile(\'say\', [args.text], e => res({ ok: !e, output: e?.message || \'spoken\' })))"',
  ].join(' '),
  params: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Snake_case tool name (no spaces). Must not clash with an existing tool.' },
      description: { type: 'string', description: 'One sentence describing what this tool does and when to use it.' },
      params: {
        type: 'object',
        description: 'JSON Schema object for the args this tool accepts. Example: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }',
      },
      body: { type: 'string', description: 'Async JS function body. Receives (args, ctx). Must return { ok: boolean, output: string }.' },
    },
    required: ['name', 'description', 'params', 'body'],
  },
  mutates: false,
  async run(args, ctx) {
    const name = String(args.name ?? '').replace(/[^a-z0-9_]/gi, '_').toLowerCase()
    if (!name) return { ok: false, output: 'name is required' }
    if (registry.get(name)) return { ok: false, output: `Tool '${name}' already exists. Choose a different name or use the existing tool.` }

    const description = String(args.description ?? '').trim()
    const body = String(args.body ?? '').trim()
    if (!body) return { ok: false, output: 'body is required' }

    // Parse params schema
    let params: Record<string, unknown>
    try {
      params = typeof args.params === 'object' && args.params !== null
        ? args.params as Record<string, unknown>
        : JSON.parse(String(args.params))
    } catch {
      return { ok: false, output: 'params must be a valid JSON Schema object' }
    }

    // Compile and smoke-test the body
    let runFn: (a: Record<string, unknown>, c: ToolCtx) => Promise<import('./protocol').ToolResult>
    try {
      runFn = compileTool(body)
    } catch (e: any) {
      return { ok: false, output: `Tool body failed to compile: ${e.message}` }
    }

    // Smoke-test: call with empty args — should not throw (may return ok:false, that's fine)
    try {
      await runFn({}, ctx)
    } catch (e: any) {
      return { ok: false, output: `Tool body threw on smoke-test: ${e.message}. Fix the body and try again.` }
    }

    // Register live in this session
    registry.register({ name, description, params, mutates: false, run: runFn })

    // Persist to .crucible/dynamic-tools/
    const record: DynamicToolRecord = {
      name, description, params, body,
      createdAt: Date.now(),
      createdBy: 'agent',
      useCount: 0,
      successCount: 0,
      lastUsed: null,
      tier: 'session',
    }
    try {
      saveDynamicTool(ctx.projectPath, record)
    } catch (e: any) {
      // Registered in-session but persist failed — non-fatal
      return { ok: true, output: `Tool '${name}' registered for this session (persist failed: ${e.message}).` }
    }

    ctx.emit?.({ type: 'tool_created', name, description })
    return { ok: true, output: `Tool '${name}' created and registered. It is now available in this session and all future sessions. Use it like any other tool.` }
  },
})

registry.register({
  name: 'write_global_memory',
  description: 'Write a durable fact to global memory (~/.crucible/world.md). Use this to remember things about the USER (preferences, tools they use, patterns you notice) that should persist across ALL future sessions and projects — not just this one. One fact per call. Keep it short and specific.',
  params: {
    type: 'object',
    properties: { fact: { type: 'string', description: 'A concise fact to remember globally, e.g. "User prefers TypeScript over JavaScript" or "User timezone is Europe/Rome, in Italy"' } },
    required: ['fact'],
  },
  async run(args) {
    const fact = String(args.fact ?? '').trim()
    if (!fact) return { ok: false, output: 'fact must not be empty' }
    appendGlobalMemory(fact, Date.now())
    return { ok: true, output: `Remembered: "${fact}"` }
  },
})

registry.register({
  name: 'list_dynamic_tools',
  description: 'List all custom tools the agent has created for this project. Shows name, description, use count, and creation date.',
  params: { type: 'object', properties: {} },
  async run(_args, ctx) {
    const tools = listDynamicTools(ctx.projectPath)
    if (!tools.length) return { ok: true, output: 'No dynamic tools created yet for this project.' }
    const lines = tools.map(t =>
      `- ${t.name} (used ${t.useCount}x): ${t.description}`
    )
    return { ok: true, output: `Dynamic tools (${tools.length}):\n${lines.join('\n')}` }
  },
})

// J1 — World model as a callable tool
registry.register({
  name: 'query_world_model',
  description: 'Semantic search over the entity graph + knowledge base. Use when you need to know something about the project, user preferences, prior decisions, or any entity Crucible has learned about. Pulls exactly the context needed at the moment rather than loading all context upfront.',
  params: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'The topic, entity name, or question to look up in the world model' },
      depth: { type: 'number', description: 'How many related entities to include (1-3, default 1)' },
    },
    required: ['topic'],
  },
  async run(args, ctx) {
    const topic = String(args.topic ?? '').trim()
    if (!topic) return { ok: false, output: 'topic required' }
    const depth = Math.min(3, Math.max(1, Number(args.depth ?? 1)))
    const digest = buildGraphDigest(topic, depth * 600)
    // Also touch these entities to track query frequency (H3 re-evaluation)
    const entities = findEntities(topic, undefined, 5)
    if (entities.length) touchEntities(entities.map(e => e.label))
    if (!digest) return { ok: true, output: 'No relevant entries found in world model for this topic.' }
    return { ok: true, output: digest }
  },
})

registry.register({
  name: 'search_youtube',
  description: [
    'Search YouTube and return REAL video URLs with verified video IDs.',
    'ALWAYS use this tool when the user asks to play, open, queue, or put on a YouTube video.',
    'NEVER construct youtube.com/watch?v= URLs from model knowledge — video IDs hallucinated',
    'from training data will be dead links. This tool fetches live search results and returns',
    'only URLs with real video IDs extracted from YouTube\'s own response.',
    'Returns up to 5 results: title, channel, duration, and a verified watch URL.',
    'Pass the best result URL to open_app to actually play it.',
  ].join(' '),
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms — be specific (e.g. "relaxing rain sleep music 1 hour")' },
      count: { type: 'number', description: 'Number of results to return (default 3, max 5)' },
    },
    required: ['query'],
  },
  async run(args) {
    const query = String(args.query ?? '').trim()
    if (!query) return { ok: false, output: '"query" is required.' }
    const count = Math.min(5, Math.max(1, Number(args.count ?? 3)))

    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
      if (!res.ok) return { ok: false, output: `YouTube returned HTTP ${res.status}` }
      const html = await res.text()

      // YouTube embeds all search result data as JSON in ytInitialData
      const match = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/)
        ?? html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*(?:\/\/|<)/)
      if (!match) return { ok: false, output: 'Could not parse YouTube search results (page structure changed).' }

      let data: any
      try { data = JSON.parse(match[1]) } catch { return { ok: false, output: 'Failed to parse YouTube response JSON.' } }

      // Navigate the ytInitialData structure to reach video renderers
      const contents: any[] =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents
        ?? data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents?.[1]?.itemSectionRenderer?.contents
        ?? []

      interface VideoResult { videoId: string; title: string; channel: string; duration: string }
      const videos: VideoResult[] = []
      for (const item of contents) {
        if (videos.length >= count) break
        const vr = item?.videoRenderer
        if (!vr?.videoId) continue
        const videoId: string = vr.videoId
        // Validate ID format — YouTube IDs are exactly 11 alphanumeric/-/_ chars
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue
        const title: string = vr.title?.runs?.[0]?.text ?? vr.title?.simpleText ?? 'Unknown'
        const channel: string = vr.ownerText?.runs?.[0]?.text ?? vr.shortBylineText?.runs?.[0]?.text ?? 'Unknown'
        const duration: string = vr.lengthText?.simpleText ?? ''
        videos.push({ videoId, title, channel, duration })
      }

      if (videos.length === 0) return { ok: false, output: 'No video results found. Try a different query.' }

      const lines = videos.map((v, i) =>
        `${i + 1}. ${v.title}\n   Channel: ${v.channel}${v.duration ? `  |  Duration: ${v.duration}` : ''}\n   URL: https://www.youtube.com/watch?v=${v.videoId}`
      )
      return {
        ok: true,
        output: `YouTube search results for "${query}":\n\n${lines.join('\n\n')}\n\nPick the best match and call open_app with its URL.`,
      }
    } catch (e: any) {
      return { ok: false, output: `search_youtube failed: ${e?.message ?? e}` }
    }
  },
})

// ── Google API tools — require Google sign-in with appropriate scopes ─────────

registry.register({
  name: 'gmail_search',
  description: 'Search the user\'s Gmail inbox. Returns subject, sender, date, and snippet for each match. Use for finding emails, checking messages, reading correspondence.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query (same syntax as Gmail search box, e.g. "from:boss subject:meeting after:2024/1/1")' },
      maxResults: { type: 'number', description: 'Max emails to return (default 10, max 20)' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'gmail_search requires an authenticated user session.' }
    const q = String(args.query ?? '').trim()
    const max = Math.min(20, Math.max(1, Number(args.maxResults ?? 10)))
    try {
      const list = await gFetch(uid, `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`)
      const messages: any[] = list.messages ?? []
      if (!messages.length) return { ok: true, output: 'No emails found matching that query.' }
      const details = await Promise.all(messages.slice(0, max).map(async (m: any) => {
        const msg = await gFetch(uid, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)
        const headers: any[] = msg.payload?.headers ?? []
        const h = (name: string) => headers.find((h: any) => h.name === name)?.value ?? ''
        return `[${m.id}] From: ${h('From')}\nDate: ${h('Date')}\nSubject: ${h('Subject')}\nSnippet: ${msg.snippet ?? ''}`
      }))
      return { ok: true, output: details.join('\n\n---\n\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'gmail_read',
  description: 'Read the full body of a specific Gmail message by ID. Get the message ID from gmail_search first.',
  params: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'Gmail message ID from gmail_search results' },
    },
    required: ['messageId'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'gmail_read requires an authenticated user session.' }
    try {
      const msg = await gFetch(uid, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${args.messageId}?format=full`)
      const headers: any[] = msg.payload?.headers ?? []
      const h = (name: string) => headers.find((x: any) => x.name === name)?.value ?? ''
      const extractBody = (part: any): string => {
        if (part?.body?.data) return Buffer.from(part.body.data, 'base64').toString('utf8')
        if (part?.parts) return part.parts.map(extractBody).join('\n')
        return ''
      }
      const body = extractBody(msg.payload)
      return {
        ok: true,
        output: `From: ${h('From')}\nTo: ${h('To')}\nDate: ${h('Date')}\nSubject: ${h('Subject')}\n\n${body.slice(0, 4000)}`,
      }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'gmail_send',
  description: 'Send an email via Gmail. Use only when explicitly asked by the user to send an email.',
  mutates: true,
  params: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Plain text email body' },
      cc: { type: 'string', description: 'CC email address (optional)' },
    },
    required: ['to', 'subject', 'body'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'gmail_send requires an authenticated user session.' }
    const to = String(args.to ?? '')
    const subject = String(args.subject ?? '')
    const body = String(args.body ?? '')
    const cc = String(args.cc ?? '')
    const raw = [
      `To: ${to}`,
      cc ? `Cc: ${cc}` : '',
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].filter(Boolean).join('\r\n')
    const encoded = Buffer.from(raw).toString('base64url')
    try {
      const res = await gFetch(uid, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        body: JSON.stringify({ raw: encoded }),
      })
      return { ok: true, output: `Email sent. Message ID: ${res.id}` }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'calendar_list',
  description: 'List upcoming Google Calendar events. Returns title, time, location, and description.',
  params: {
    type: 'object',
    properties: {
      maxResults: { type: 'number', description: 'Max events to return (default 10)' },
      days: { type: 'number', description: 'How many days ahead to look (default 7)' },
      calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
    },
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'calendar_list requires an authenticated user session.' }
    const max = Math.min(50, Number(args.maxResults ?? 10))
    const days = Number(args.days ?? 7)
    const calId = encodeURIComponent(String(args.calendarId ?? 'primary'))
    const timeMin = new Date().toISOString()
    const timeMax = new Date(Date.now() + days * 86400000).toISOString()
    try {
      const data = await gFetch(uid, `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?maxResults=${max}&timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`)
      const items: any[] = data.items ?? []
      if (!items.length) return { ok: true, output: 'No upcoming events found.' }
      const lines = items.map(e => {
        const start = e.start?.dateTime ?? e.start?.date ?? ''
        return `• ${e.summary ?? '(no title)'}\n  When: ${start}\n  Location: ${e.location ?? 'none'}\n  ${e.description?.slice(0, 200) ?? ''}`
      })
      return { ok: true, output: lines.join('\n\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'calendar_create',
  description: 'Create a Google Calendar event. Use when the user asks to schedule, book, or add something to their calendar.',
  mutates: true,
  params: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title' },
      start: { type: 'string', description: 'Start time in ISO 8601 format (e.g. 2025-06-15T14:00:00+01:00)' },
      end: { type: 'string', description: 'End time in ISO 8601 format' },
      description: { type: 'string', description: 'Event description (optional)' },
      location: { type: 'string', description: 'Location (optional)' },
      attendees: { type: 'string', description: 'Comma-separated email addresses of attendees (optional)' },
    },
    required: ['title', 'start', 'end'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'calendar_create requires an authenticated user session.' }
    const attendeeList = String(args.attendees ?? '').split(',').map(e => e.trim()).filter(Boolean).map(e => ({ email: e }))
    try {
      const event = await gFetch(uid, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        body: JSON.stringify({
          summary: args.title,
          start: { dateTime: args.start },
          end: { dateTime: args.end },
          description: args.description ?? '',
          location: args.location ?? '',
          attendees: attendeeList,
        }),
      })
      return { ok: true, output: `Event created: "${event.summary}" on ${event.start?.dateTime}\nLink: ${event.htmlLink}` }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'drive_search',
  description: 'Search Google Drive for files. Returns file names, types, and links.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query — supports Drive query syntax (e.g. "name contains \'report\'" or "type:document modified>2024-01-01")' },
      maxResults: { type: 'number', description: 'Max files (default 10)' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'drive_search requires an authenticated user session.' }
    const q = String(args.query ?? '')
    const max = Math.min(20, Number(args.maxResults ?? 10))
    try {
      const data = await gFetch(uid, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${max}&fields=files(id,name,mimeType,modifiedTime,webViewLink,size)`)
      const files: any[] = data.files ?? []
      if (!files.length) return { ok: true, output: 'No files found.' }
      const lines = files.map(f => `[${f.id}] ${f.name}\n  Type: ${f.mimeType}\n  Modified: ${f.modifiedTime ?? ''}\n  Link: ${f.webViewLink ?? 'n/a'}`)
      return { ok: true, output: lines.join('\n\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'drive_read',
  description: 'Read the text content of a Google Drive file. Works for Google Docs, Sheets (as CSV), and plain text files. Get the file ID from drive_search.',
  params: {
    type: 'object',
    properties: {
      fileId: { type: 'string', description: 'Google Drive file ID from drive_search' },
      mimeType: { type: 'string', description: 'File MIME type (e.g. application/vnd.google-apps.document). Used to choose export format.' },
    },
    required: ['fileId'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'drive_read requires an authenticated user session.' }
    const id = String(args.fileId)
    const mime = String(args.mimeType ?? '')
    try {
      let content: string
      if (mime.includes('google-apps.document')) {
        content = await gFetch(uid, `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain`)
      } else if (mime.includes('google-apps.spreadsheet')) {
        content = await gFetch(uid, `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/csv`)
      } else {
        content = await gFetch(uid, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`)
      }
      return { ok: true, output: String(content).slice(0, 6000) }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'contacts_search',
  description: 'Search the user\'s Google Contacts. Returns names, emails, and phone numbers.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Name or email to search for' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'contacts_search requires an authenticated user session.' }
    const q = encodeURIComponent(String(args.query ?? ''))
    try {
      const data = await gFetch(uid, `https://people.googleapis.com/v1/people:searchContacts?query=${q}&readMask=names,emailAddresses,phoneNumbers`)
      const results: any[] = data.results ?? []
      if (!results.length) return { ok: true, output: 'No contacts found.' }
      const lines = results.map(r => {
        const p = r.person
        const name = p?.names?.[0]?.displayName ?? 'Unknown'
        const email = p?.emailAddresses?.map((e: any) => e.value).join(', ') ?? ''
        const phone = p?.phoneNumbers?.map((e: any) => e.value).join(', ') ?? ''
        return `${name}${email ? `\n  Email: ${email}` : ''}${phone ? `\n  Phone: ${phone}` : ''}`
      })
      return { ok: true, output: lines.join('\n\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'youtube_search_api',
  description: 'Search YouTube using the official API — more reliable than scraping. Returns video titles, channels, and URLs. Use in preference to search_youtube when the user has signed in with Google.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms' },
      maxResults: { type: 'number', description: 'Number of results (default 5, max 10)' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'youtube_search_api requires Google sign-in.' }
    const q = String(args.query ?? '')
    const max = Math.min(10, Number(args.maxResults ?? 5))
    try {
      const data = await gFetch(uid, `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(q)}&maxResults=${max}`)
      const items: any[] = data.items ?? []
      if (!items.length) return { ok: true, output: 'No results found.' }
      const lines = items.map((item: any) => {
        const s = item.snippet
        return `${s.title}\n  Channel: ${s.channelTitle}\n  URL: https://www.youtube.com/watch?v=${item.id.videoId}`
      })
      return { ok: true, output: lines.join('\n\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'fitness_activity',
  description: 'Get the user\'s Google Fit activity data — steps, calories, distance, active minutes.',
  params: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'How many days back to fetch (default 7, max 30)' },
    },
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'fitness_activity requires Google sign-in.' }
    const days = Math.min(30, Number(args.days ?? 7))
    const endMs = Date.now()
    const startMs = endMs - days * 86400000
    const body = {
      aggregateBy: [
        { dataTypeName: 'com.google.step_count.delta' },
        { dataTypeName: 'com.google.calories.expended' },
        { dataTypeName: 'com.google.distance.delta' },
        { dataTypeName: 'com.google.active_minutes' },
      ],
      bucketByTime: { durationMillis: 86400000 },
      startTimeMillis: startMs,
      endTimeMillis: endMs,
    }
    try {
      const data = await gFetch(uid, 'https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
        method: 'POST', body: JSON.stringify(body),
      })
      const buckets: any[] = data.bucket ?? []
      const lines = buckets.map(b => {
        const date = new Date(Number(b.startTimeMillis)).toLocaleDateString()
        const vals = (typeName: string) => {
          const ds = b.dataset?.find((d: any) => d.dataSourceId?.includes(typeName))
          return ds?.point?.[0]?.value?.[0]?.intVal ?? ds?.point?.[0]?.value?.[0]?.fpVal ?? 0
        }
        const steps = vals('step_count')
        const cals = Math.round(Number(vals('calories')))
        const dist = (Number(vals('distance')) / 1000).toFixed(2)
        const active = vals('active_minutes')
        return `${date}: ${steps} steps, ${cals} kcal, ${dist} km, ${active} active min`
      })
      return { ok: true, output: lines.join('\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'analytics_report',
  description: 'Run a Google Analytics 4 report. Returns page views, sessions, and user metrics for a given date range.',
  params: {
    type: 'object',
    properties: {
      propertyId: { type: 'string', description: 'GA4 property ID (numeric, e.g. "123456789"). Find it in Google Analytics → Admin → Property Settings.' },
      days: { type: 'number', description: 'Date range in days (default 28)' },
      metric: { type: 'string', description: 'Metric to report: sessions | activeUsers | screenPageViews | bounceRate (default: sessions)' },
    },
    required: ['propertyId'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'analytics_report requires Google sign-in.' }
    const propId = String(args.propertyId ?? '').replace(/^properties\//, '')
    const days = Number(args.days ?? 28)
    const metric = String(args.metric ?? 'sessions')
    const body = {
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: metric }],
    }
    try {
      const data = await gFetch(uid, `https://analyticsdata.googleapis.com/v1beta/properties/${propId}:runReport`, {
        method: 'POST', body: JSON.stringify(body),
      })
      const rows: any[] = data.rows ?? []
      if (!rows.length) return { ok: true, output: 'No data returned. Check the property ID and date range.' }
      const lines = rows.map(r => `${r.dimensionValues?.[0]?.value}: ${r.metricValues?.[0]?.value}`)
      const total = rows.reduce((s, r) => s + Number(r.metricValues?.[0]?.value ?? 0), 0)
      return { ok: true, output: `${metric} for last ${days} days (property ${propId}):\n${lines.join('\n')}\n\nTotal: ${total}` }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'maps_directions',
  description: 'Get driving, walking, or transit directions between two places using Google Maps.',
  params: {
    type: 'object',
    properties: {
      origin: { type: 'string', description: 'Starting address or place name' },
      destination: { type: 'string', description: 'Destination address or place name' },
      mode: { type: 'string', description: 'Travel mode: driving | walking | transit | bicycling (default: driving)' },
    },
    required: ['origin', 'destination'],
  },
  async run(args) {
    const key = process.env.GOOGLE_MAPS_API_KEY
    if (!key) return { ok: false, output: 'GOOGLE_MAPS_API_KEY not set in .env.local' }
    const origin = encodeURIComponent(String(args.origin))
    const dest   = encodeURIComponent(String(args.destination))
    const mode   = String(args.mode ?? 'driving')
    try {
      const r = await fetch(`https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${dest}&mode=${mode}&key=${key}`)
      const data = await r.json() as any
      if (data.status !== 'OK') return { ok: false, output: `Google Maps: ${data.status} — ${data.error_message ?? ''}` }
      const leg = data.routes?.[0]?.legs?.[0]
      const steps = (leg?.steps ?? []).map((s: any) => `  • ${(s.html_instructions ?? '').replace(/<[^>]+>/g, '')} (${s.duration?.text})`)
      return {
        ok: true,
        output: `Directions from "${args.origin}" to "${args.destination}" by ${mode}:\nDistance: ${leg?.distance?.text}  |  ETA: ${leg?.duration?.text}\n\n${steps.join('\n')}`,
      }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'knowledge_graph_search',
  description: 'Search Google\'s Knowledge Graph for facts about people, places, organisations, and concepts. Returns structured entity data.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Entity name or concept to look up' },
      limit: { type: 'number', description: 'Max results (default 3)' },
    },
    required: ['query'],
  },
  async run(args) {
    const key = process.env.GOOGLE_KG_API_KEY ?? process.env.VITE_GEMINI_API_KEY  // fallback to same project key
    if (!key) return { ok: false, output: 'GOOGLE_KG_API_KEY not set in .env.local' }
    const q = encodeURIComponent(String(args.query))
    const limit = Math.min(5, Number(args.limit ?? 3))
    try {
      const r = await fetch(`https://kgsearch.googleapis.com/v1/entities:search?query=${q}&limit=${limit}&indent=True&key=${key}`)
      const data = await r.json() as any
      const items: any[] = data.itemListElement ?? []
      if (!items.length) return { ok: true, output: 'No Knowledge Graph results found.' }
      const lines = items.map(item => {
        const e = item.result
        return `${e.name} (${e['@type']?.join(', ') ?? 'entity'})\n  ${e.description ?? ''}\n  ${e.detailedDescription?.body?.slice(0, 300) ?? ''}`
      })
      return { ok: true, output: lines.join('\n\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'custom_search',
  description: 'Run a Google Custom Search. More accurate than DuckDuckGo scraping. Use when web_search returns poor results.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      num: { type: 'number', description: 'Number of results (default 5, max 10)' },
    },
    required: ['query'],
  },
  async run(args) {
    const key = process.env.GOOGLE_CSE_API_KEY
    const cx  = process.env.GOOGLE_CSE_CX
    if (!key || !cx) return { ok: false, output: 'GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX must be set in .env.local' }
    const q   = encodeURIComponent(String(args.query))
    const num = Math.min(10, Number(args.num ?? 5))
    try {
      const r = await fetch(`https://www.googleapis.com/customsearch/v1?q=${q}&num=${num}&key=${key}&cx=${cx}`)
      const data = await r.json() as any
      const items: any[] = data.items ?? []
      if (!items.length) return { ok: true, output: 'No results found.' }
      const lines = items.map((item: any) => `${item.title}\n  ${item.link}\n  ${item.snippet ?? ''}`)
      return { ok: true, output: lines.join('\n\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'google_services_status',
  description: 'Check which Google services are connected and available for this session. Call this before using any google_* tool if unsure.',
  params: { type: 'object', properties: {} },
  async run(_args, ctx) {
    if (!ctx.userId) return { ok: true, output: 'Not authenticated — no Google services available.' }
    const status = googleServicesStatus(ctx.userId)
    const lines = Object.entries(status).map(([k, v]) => `${v ? '[x]' : '[ ]'} ${k}`)
    return { ok: true, output: `Google services for this session:\n${lines.join('\n')}` }
  },
})

// ── Step 9: Remote Brain — Mac accessibility tools ───────────────────────────

registry.register({
  name: 'get_ui_tree',
  description:
    'Dump the macOS Accessibility tree of the currently focused window as structured text. ' +
    'Returns a list of UI elements (buttons, text fields, menus, links) with their roles and titles. ' +
    'Use this to understand what is on screen before clicking or typing. ' +
    'Call before click_element or type_text to identify the correct target.',
  params: { type: 'object', properties: {} },
  async run() {
    const result = await getUITree()
    return { ok: true, output: result }
  },
})

registry.register({
  name: 'click_element',
  description:
    'Click a UI element on the Mac by its visible title or partial title. ' +
    'Call get_ui_tree first to see what elements are available. ' +
    'Pass the element title as shown in the tree — partial matches are tried automatically.',
  params: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The visible title or label of the element to click' },
      app: { type: 'string', description: 'Optional: name of the target app (defaults to frontmost app)' },
    },
    required: ['title'],
  },
  mutates: true,
  async run(args) {
    const result = await clickElement(String(args.title), args.app ? String(args.app) : undefined)
    return { ok: !result.startsWith('Click failed') && !result.startsWith('Element not found'), output: result }
  },
})

registry.register({
  name: 'type_text',
  description:
    'Type text into the currently focused field on the Mac. ' +
    'Use click_element first to focus the correct input field, then call type_text to enter text. ' +
    'For pressing Enter/Return after typing, include \\n in the text or call type_text with just "\\n".',
  params: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to type into the focused field' },
    },
    required: ['text'],
  },
  mutates: true,
  async run(args) {
    const result = await typeText(String(args.text ?? ''))
    return { ok: !result.startsWith('Type failed'), output: result }
  },
})
