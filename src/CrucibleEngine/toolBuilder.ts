// Natural-language tool builder — design spec §2 (docs/DESIGN_SPEC_TOOL_BUILDER_REMOTE_BRAIN.md).
// Conversational flow: "build me a tool that…" → draft spec → clarifying questions →
// dry run → install. The install gate is structural, not cosmetic: installBuilder()
// refuses any session whose dry run hasn't passed, so a tool can never be reported
// "installed" without a passing, visible verification transcript (§6 "shipped means proven").
//
// Model-agnostic: callers inject `callModel` (free-tier model via the server's selector).
// v1 scope: code-backed tools (the registry executes those natively). Persona-agent tools
// need a runtime the registry doesn't have yet — the extractor detects them and says so
// honestly instead of installing something that wouldn't actually run.

import crypto from 'crypto'
import { compileTool, saveDynamicTool, type DynamicToolRecord } from './tools/dynamicTools'
import { registry } from './tools/registry'
import type { ToolCtx } from './tools/protocol'

export type CallModel = (messages: Array<{ role: string; content: string }>) => Promise<string>

export interface BuilderDraft {
  name: string
  description: string
  kind: 'code' | 'persona_agent'
  params: Record<string, unknown>
  body: string                 // async JS function body (args, ctx) → { ok, output }
  triggerAliases: string[]     // natural-language phrasings that should invoke this tool
}

export interface DryRunStep {
  args: Record<string, unknown>
  ok: boolean
  output: string
}

export interface BuilderSession {
  id: string
  status: 'clarifying' | 'drafted' | 'verified' | 'installed' | 'failed'
  request: string                        // the original "build me a tool that…" message
  restatement: string                    // plain-language readback of the parsed intent
  pendingQuestions: string[]             // asked one at a time, first element is current
  answers: Array<{ question: string; answer: string }>
  draft: BuilderDraft | null
  dryRun: { passed: boolean; transcript: DryRunStep[]; error?: string } | null
  error?: string
  createdAt: number
  updatedAt: number
}

const sessions = new Map<string, BuilderSession>()
const SESSION_TTL_MS = 60 * 60_000

function gcSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, s] of sessions) if (s.updatedAt < cutoff) sessions.delete(id)
}

export function getBuilderSession(id: string): BuilderSession | null {
  return sessions.get(id) ?? null
}

/** Public view: everything except nothing — the whole session is user-facing by design
 *  (the spec requires evidence to be surfaced, not summarized away). */
export function sessionView(s: BuilderSession) {
  return { ...s, currentQuestion: s.pendingQuestions[0] ?? null }
}

// ── Model-output parsing ──────────────────────────────────────────────────────

function parseJsonBlock(text: string): Record<string, unknown> | null {
  // Strip fences, find the outermost object
  const cleaned = text.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(cleaned.slice(start, end + 1)) } catch { return null }
}

const DRAFT_PROMPT = `You convert a user's natural-language tool request into a draft tool spec.
Return ONLY a JSON object with these fields:
{
  "restatement": "one plain-language sentence restating what the tool will do",
  "kind": "code" | "persona_agent",
  "name": "snake_case_name",
  "description": "one sentence, when to use it",
  "triggerAliases": ["2-4 natural phrasings that should invoke it"],
  "params": { JSON Schema object for the args },
  "body": "async JS function body receiving (args, ctx), MUST return { ok: boolean, output: string }. Node built-ins available via require(). No external network calls unless the request requires them.",
  "clarifyingQuestions": ["only questions you genuinely cannot infer an answer to — often an empty array. Never more than 3. One sentence each."]
}
kind is "persona_agent" only when the request is about interviewing/conversing with the user rather than performing an action.
Prefer inferring sensible defaults over asking questions.`

async function generateDraft(session: BuilderSession, callModel: CallModel): Promise<void> {
  const qa = session.answers.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n')
  const raw = await callModel([
    { role: 'system', content: DRAFT_PROMPT },
    { role: 'user', content: `Tool request: ${session.request}${qa ? `\n\nClarifications so far:\n${qa}` : ''}` },
  ])
  const parsed = parseJsonBlock(raw)
  if (!parsed) throw new Error('Model did not return a parseable draft spec.')

  const kind = parsed.kind === 'persona_agent' ? 'persona_agent' : 'code'
  const name = String(parsed.name ?? '').replace(/[^a-z0-9_]/gi, '_').toLowerCase()
  if (!name) throw new Error('Draft spec has no tool name.')

  session.restatement = String(parsed.restatement ?? '').trim()
  session.draft = {
    name,
    description: String(parsed.description ?? '').trim(),
    kind,
    params: (typeof parsed.params === 'object' && parsed.params !== null ? parsed.params : { type: 'object', properties: {} }) as Record<string, unknown>,
    body: String(parsed.body ?? '').trim(),
    triggerAliases: Array.isArray(parsed.triggerAliases) ? parsed.triggerAliases.map(String).slice(0, 4) : [],
  }
  const questions = Array.isArray(parsed.clarifyingQuestions) ? parsed.clarifyingQuestions.map(String).filter(Boolean).slice(0, 3) : []
  session.pendingQuestions = questions
  session.status = questions.length ? 'clarifying' : 'drafted'
  // Draft changed → any previous dry run is stale evidence
  session.dryRun = null
  session.updatedAt = Date.now()
}

// ── Flow ──────────────────────────────────────────────────────────────────────

export async function startBuilder(request: string, callModel: CallModel): Promise<BuilderSession> {
  gcSessions()
  const session: BuilderSession = {
    id: crypto.randomBytes(8).toString('hex'),
    status: 'clarifying',
    request: request.trim(),
    restatement: '',
    pendingQuestions: [],
    answers: [],
    draft: null,
    dryRun: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  if (!session.request) throw new Error('Empty tool request.')
  await generateDraft(session, callModel)
  sessions.set(session.id, session)
  return session
}

/** Answer the current clarifying question (or provide a free-form revision like
 *  "make it less chatty"). Regenerates the draft with the new information. */
export async function replyBuilder(id: string, answer: string, callModel: CallModel): Promise<BuilderSession> {
  const session = sessions.get(id)
  if (!session) throw new Error(`No builder session '${id}'.`)
  if (session.status === 'installed') throw new Error('Session already installed — start a new build to change the tool, or use update_tool.')
  const question = session.pendingQuestions.shift() ?? '(user revision, unprompted)'
  session.answers.push({ question, answer: answer.trim() })
  await generateDraft(session, callModel)
  return session
}

const SAMPLE_ARGS_PROMPT = `Given this tool spec, produce ONE realistic sample invocation for a dry run.
Return ONLY JSON: { "args": { ... } } matching the tool's params schema. Use safe, side-effect-light values.`

/** Compile the draft and execute it against a model-generated sample scenario.
 *  The full transcript is stored on the session — this is the evidence that gates install. */
export async function dryRunBuilder(id: string, ctx: ToolCtx, callModel: CallModel): Promise<BuilderSession> {
  const session = sessions.get(id)
  if (!session) throw new Error(`No builder session '${id}'.`)
  const draft = session.draft
  if (!draft) throw new Error('No draft to dry-run yet.')
  if (session.status === 'clarifying') throw new Error(`Still clarifying — answer: "${session.pendingQuestions[0]}" first (or reply to skip remaining questions).`)

  if (draft.kind === 'persona_agent') {
    session.dryRun = { passed: false, transcript: [], error: 'persona_agent tools are not installable yet — the registry only executes code-backed tools. Rephrase the request as an action the tool performs, or wait for the persona runtime (design spec §2.2).' }
    session.status = 'failed'
    session.updatedAt = Date.now()
    return session
  }

  const transcript: DryRunStep[] = []
  try {
    const run = compileTool(draft.body)

    // Step 1 — empty-args probe: must not throw (returning ok:false is acceptable)
    const probe = await run({}, ctx)
    transcript.push({ args: {}, ok: probe.ok, output: probe.output.slice(0, 2000) })

    // Step 2 — realistic scenario from the model
    let sampleArgs: Record<string, unknown> = {}
    try {
      const raw = await callModel([
        { role: 'system', content: SAMPLE_ARGS_PROMPT },
        { role: 'user', content: JSON.stringify({ name: draft.name, description: draft.description, params: draft.params }) },
      ])
      const parsed = parseJsonBlock(raw)
      if (parsed && typeof parsed.args === 'object' && parsed.args !== null) sampleArgs = parsed.args as Record<string, unknown>
    } catch { /* fall back to empty args — the probe already ran */ }

    if (Object.keys(sampleArgs).length) {
      const result = await run(sampleArgs, ctx)
      transcript.push({ args: sampleArgs, ok: result.ok, output: result.output.slice(0, 2000) })
    }

    // Pass = compiled AND at least one invocation succeeded (an all-ok:false transcript
    // means the tool can't do its job on realistic input — that is a fail, shown as such).
    const passed = transcript.some(t => t.ok)
    session.dryRun = { passed, transcript, error: passed ? undefined : 'No dry-run invocation succeeded — see transcript.' }
    session.status = passed ? 'verified' : 'drafted'
  } catch (e: any) {
    session.dryRun = { passed: false, transcript, error: `Compile/run failed: ${e?.message ?? e}` }
    session.status = 'drafted'
  }
  session.updatedAt = Date.now()
  return session
}

/** Install the verified draft as a v1 dynamic tool. Structurally impossible without
 *  a passed dry run on the CURRENT draft — the "generated, not yet verified" state
 *  can never be presented as installed. */
export function installBuilder(id: string, ctx: ToolCtx): BuilderSession {
  const session = sessions.get(id)
  if (!session) throw new Error(`No builder session '${id}'.`)
  const draft = session.draft
  if (!draft) throw new Error('No draft to install.')
  if (!session.dryRun?.passed) {
    throw new Error('Refusing to install: the current draft has no passing dry run. Run the dry run (and show the user the transcript) first.')
  }
  if (registry.get(draft.name)) throw new Error(`A tool named '${draft.name}' already exists. Rename the draft or update the existing tool.`)

  const run = compileTool(draft.body) // dry run already proved this compiles
  registry.register({ name: draft.name, description: draft.description, params: draft.params, mutates: false, run })

  const record: DynamicToolRecord = {
    name: draft.name,
    description: draft.description,
    params: draft.params,
    body: draft.body,
    createdAt: Date.now(),
    createdBy: 'user_builder',
    useCount: 0,
    successCount: 0,
    lastUsed: null,
    tier: 'session',
    version: 1,
    changeNote: `built via natural-language builder: "${session.request.slice(0, 120)}"`,
    provenance: { source: 'user_authored', importedFrom: null },
    verification: { lastSmokeTest: Date.now(), result: 'pass' },
  }
  saveDynamicTool(ctx.projectPath, record)

  session.status = 'installed'
  session.updatedAt = Date.now()
  return session
}

// ── Trigger capture ───────────────────────────────────────────────────────────
// Deterministic, high-precision detector for "build me a tool that…" phrasings.
// Same philosophy as localIntentRouter: when in doubt return null, never hijack a
// normal chat message.

const BUILD_TRIGGER = /\b(?:build|create|make|write)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+|custom\s+)?(?:tool|command|slash\s*command)\b/i

export function detectBuildRequest(message: string): boolean {
  return BUILD_TRIGGER.test(message)
}
