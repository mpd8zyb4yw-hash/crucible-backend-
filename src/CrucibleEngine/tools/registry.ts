// Tool registry — single source of truth for every tool the agent can call.
// Sections 3+ register editing/shell tools here; section 1 ships read_file/list_dir.

import fs from 'fs'
import path from 'path'
import type { ToolCall, ToolCtx, ToolDef, ToolResult } from './protocol'

const tools = new Map<string, ToolDef>()

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

/** Resolve p against projectPath; throw if it escapes the project root. */
export function resolveSafe(p: string, ctx: ToolCtx, { allowOutside = false } = {}): string {
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

export function capOutput(s: string, max = MAX_OUTPUT_CHARS): { output: string; truncated: boolean } {
  if (s.length <= max) return { output: s, truncated: false }
  return { output: s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`, truncated: true }
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
