// Adaptive tool refinement — design spec §4 (docs/DESIGN_SPEC_TOOL_BUILDER_REMOTE_BRAIN.md).
// Natural-language edits to existing dynamic tools: "make reverse_text uppercase the
// output" → a proposed field-level diff (never a silent overwrite) → a mandatory
// before/after smoke test → versioned apply via updateDynamicTool (07e), so every
// applied refinement is one rollback_tool call away from undone.
//
// The apply gate mirrors the builder's install gate (§4.3): applyRefine() refuses any
// session whose smoke test hasn't passed against the CURRENT proposal.
//
// §4.1 (usage-pattern suggestions) is NOT built yet — it needs per-invocation context
// tagging that doesn't exist. This module covers §4.2 + §4.3.

import crypto from 'crypto'
import { compileTool, loadDynamicTool, updateDynamicTool, listDynamicTools, toolVersion } from './tools/dynamicTools'
import { registry } from './tools/registry'
import { parseJsonBlock, type CallModel } from './toolBuilder'
import type { ToolCtx } from './tools/protocol'

export interface FieldDiff {
  field: 'description' | 'params' | 'body'
  old: string
  new: string
}

export interface SmokeStep {
  args: Record<string, unknown>
  before: { ok: boolean; output: string }
  after: { ok: boolean; output: string }
}

export interface RefineSession {
  id: string
  status: 'proposed' | 'verified' | 'applied' | 'failed'
  toolName: string
  fromVersion: number
  instruction: string
  explanation: string          // model's one-line summary of the change
  diffs: FieldDiff[]
  proposed: { description: string; params: Record<string, unknown>; body: string }
  smoke: { passed: boolean; steps: SmokeStep[]; error?: string } | null
  error?: string
  createdAt: number
  updatedAt: number
}

const sessions = new Map<string, RefineSession>()
const SESSION_TTL_MS = 60 * 60_000

function gcSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, s] of sessions) if (s.updatedAt < cutoff) sessions.delete(id)
}

export function getRefineSession(id: string): RefineSession | null {
  return sessions.get(id) ?? null
}

const REFINE_PROMPT = `You edit an existing tool according to the user's instruction.
You receive the tool's current spec (description, params JSON Schema, body — an async JS
function body receiving (args, ctx) that MUST return { ok: boolean, output: string }).
Apply the instruction with the SMALLEST change that satisfies it. Keep everything else identical.
Return ONLY JSON:
{
  "explanation": "one sentence: what you changed and why it satisfies the instruction",
  "description": "full new description (unchanged if not affected)",
  "params": { full new params schema (unchanged if not affected) },
  "body": "full new body (unchanged if not affected)"
}`

export async function startRefine(
  toolName: string,
  instruction: string,
  projectPath: string,
  callModel: CallModel,
): Promise<RefineSession> {
  gcSessions()
  const record = loadDynamicTool(projectPath, toolName)
  if (!record) throw new Error(`No dynamic tool named '${toolName}'. Only tools created at runtime can be refined.`)
  if (!instruction.trim()) throw new Error('Empty refinement instruction.')

  const raw = await callModel([
    { role: 'system', content: REFINE_PROMPT },
    { role: 'user', content: `Current spec:\n${JSON.stringify({ description: record.description, params: record.params, body: record.body }, null, 2)}\n\nInstruction: ${instruction}` },
  ])
  const parsed = parseJsonBlock(raw)
  if (!parsed) throw new Error('Model did not return a parseable refinement.')

  const proposed = {
    description: String(parsed.description ?? record.description).trim(),
    params: (typeof parsed.params === 'object' && parsed.params !== null ? parsed.params : record.params) as Record<string, unknown>,
    body: String(parsed.body ?? record.body).trim(),
  }

  const diffs: FieldDiff[] = []
  if (proposed.description !== record.description) diffs.push({ field: 'description', old: record.description, new: proposed.description })
  if (JSON.stringify(proposed.params) !== JSON.stringify(record.params)) diffs.push({ field: 'params', old: JSON.stringify(record.params, null, 2), new: JSON.stringify(proposed.params, null, 2) })
  if (proposed.body !== record.body) diffs.push({ field: 'body', old: record.body, new: proposed.body })
  if (!diffs.length) throw new Error('The model proposed no change — rephrase the instruction to be more specific.')

  const session: RefineSession = {
    id: crypto.randomBytes(8).toString('hex'),
    status: 'proposed',
    toolName,
    fromVersion: toolVersion(record),
    instruction: instruction.trim(),
    explanation: String(parsed.explanation ?? '').trim(),
    diffs,
    proposed,
    smoke: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  sessions.set(session.id, session)
  return session
}

const SMOKE_ARGS_PROMPT = `Given this tool spec and the refinement instruction, produce ONE realistic sample
invocation that would demonstrate the difference the refinement makes.
Return ONLY JSON: { "args": { ... } } matching the params schema. Safe, side-effect-light values.`

/** Run old and new bodies against the same scenario(s); the before/after transcript is
 *  the §4.3 evidence. Passing = the NEW body compiled and succeeded on at least one step. */
export async function smokeRefine(id: string, ctx: ToolCtx, callModel: CallModel): Promise<RefineSession> {
  const session = sessions.get(id)
  if (!session) throw new Error(`No refine session '${id}'.`)
  if (session.status === 'applied') throw new Error('Already applied.')
  const record = loadDynamicTool(ctx.projectPath, session.toolName)
  if (!record) throw new Error(`Tool '${session.toolName}' no longer exists.`)
  if (toolVersion(record) !== session.fromVersion) {
    session.status = 'failed'
    session.error = `Tool changed underneath this proposal (now v${toolVersion(record)}, proposal was against v${session.fromVersion}). Start a new refinement.`
    session.updatedAt = Date.now()
    return session
  }

  const steps: SmokeStep[] = []
  try {
    const runOld = compileTool(record.body)
    const runNew = compileTool(session.proposed.body)

    const scenarios: Array<Record<string, unknown>> = [{}]
    try {
      const raw = await callModel([
        { role: 'system', content: SMOKE_ARGS_PROMPT },
        { role: 'user', content: JSON.stringify({ description: session.proposed.description, params: session.proposed.params, instruction: session.instruction }) },
      ])
      const parsed = parseJsonBlock(raw)
      if (parsed && typeof parsed.args === 'object' && parsed.args !== null && Object.keys(parsed.args).length) {
        scenarios.push(parsed.args as Record<string, unknown>)
      }
    } catch { /* empty-args probe still runs */ }

    for (const args of scenarios) {
      const before = await runOld(args, ctx)
      const after = await runNew(args, ctx)
      steps.push({
        args,
        before: { ok: before.ok, output: before.output.slice(0, 2000) },
        after: { ok: after.ok, output: after.output.slice(0, 2000) },
      })
    }

    const passed = steps.some(s => s.after.ok)
    session.smoke = { passed, steps, error: passed ? undefined : 'The refined tool succeeded on no smoke scenario — see before/after transcript.' }
    session.status = passed ? 'verified' : 'proposed'
  } catch (e: any) {
    session.smoke = { passed: false, steps, error: `Compile/run failed: ${e?.message ?? e}` }
    session.status = 'proposed'
  }
  session.updatedAt = Date.now()
  return session
}

/** Apply the verified proposal as a new version and re-register it live.
 *  Structurally impossible without a passed smoke test on the current proposal. */
export function applyRefine(id: string, ctx: ToolCtx): RefineSession {
  const session = sessions.get(id)
  if (!session) throw new Error(`No refine session '${id}'.`)
  if (!session.smoke?.passed) {
    throw new Error('Refusing to apply: this proposal has no passing smoke test. Run the smoke test (and show the user the before/after transcript) first.')
  }
  const record = loadDynamicTool(ctx.projectPath, session.toolName)
  if (!record) throw new Error(`Tool '${session.toolName}' no longer exists.`)
  if (toolVersion(record) !== session.fromVersion) {
    throw new Error(`Tool changed underneath this proposal (now v${toolVersion(record)}). Start a new refinement.`)
  }

  const next = updateDynamicTool(
    ctx.projectPath,
    session.toolName,
    { description: session.proposed.description, params: session.proposed.params, body: session.proposed.body },
    `refinement: "${session.instruction.slice(0, 120)}"`,
    true,
  )
  if (!next) throw new Error('Failed to persist the refinement.')

  const run = compileTool(next.body) // smoke test already proved this compiles
  registry.register({ name: next.name, description: next.description, params: next.params, mutates: false, run })

  session.status = 'applied'
  session.updatedAt = Date.now()
  return session
}

// ── Trigger capture ───────────────────────────────────────────────────────────
// "make <tool> …", "change/update/tweak/refine <tool> …" where <tool> is an existing
// dynamic tool (matched with underscores or spaces). High precision: no known tool
// name in the message → null, the message flows to the normal pipeline.

const REFINE_VERB = /\b(make|change|update|tweak|refine|edit|adjust|improve)\b/i

export function detectRefineRequest(message: string, projectPath: string): { toolName: string; instruction: string } | null {
  if (!REFINE_VERB.test(message)) return null
  const lower = message.toLowerCase()
  for (const record of listDynamicTools(projectPath)) {
    const spaced = record.name.replace(/_/g, ' ')
    if (lower.includes(record.name) || lower.includes(spaced)) {
      return { toolName: record.name, instruction: message.trim() }
    }
  }
  return null
}
