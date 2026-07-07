// The agent loop — sustained plan→act→observe on the main request path.
// Provider-agnostic: the server supplies driveTurn (one model turn with tools).
// Lightweight by design: observation compression, hard caps, AbortSignal everywhere.

import fs from 'fs'
import path from 'path'
import { registry } from '../tools/registry'
import { debugBus } from '../debug/bus'
import { buildWorldContext, buildReflectionPrompt, appendWorldFact, appendReflection, touchNode, loadGraph, saveGraph } from '../state/world'
import type { ToolCall, ToolCtx, ToolDef } from '../tools/protocol'
import { maybeCompressMessages } from '../contextManager'
import { createAnchor, validateCompression, deleteAnchor } from '../contextAnchor'

export interface DriveTurnResult {
  text: string
  toolCalls: ToolCall[]
}

export type DriveTurn = (
  messages: Array<Record<string, unknown>>,
  tools: ToolDef[],
  signal?: AbortSignal,
) => Promise<DriveTurnResult>

export interface VerifyResult {
  passed: boolean
  signal: 'compile' | 'test' | 'runtime' | 'lint' | 'none'
  report: string
  hints?: string[]
  /** Set by the verifier when healing should stop (heal cap hit or repeated failure fingerprint). */
  escalate?: boolean
}

export interface AgentLoopOpts {
  goal: string
  projectPath: string
  userId?: string
  driveTurn: DriveTurn
  emit: (event: Record<string, unknown>) => void
  signal?: AbortSignal
  maxIters?: number
  budgetTokens?: number
  /** Section 4 plugs in execution-driven verification; default accepts the final answer. */
  verify?: (finalText: string, ctx: ToolCtx) => Promise<VerifyResult>
  systemPreamble?: string
  allowMutation?: boolean
  /** Remote Brain tier + device id when this request came from a paired device (§5.2). */
  deviceTier?: 'observe' | 'build' | 'full'
  deviceId?: string
  /** Resume from a saved checkpoint — used instead of the default [system, user] start. */
  initialMessages?: Array<Record<string, unknown>>
  /** Called after every iteration with current messages — for checkpoint persistence. */
  onCheckpoint?: (messages: Array<Record<string, unknown>>, iter: number) => void
  /** Step context forwarded into iter_progress events. */
  stepIndex?: number
  stepTotal?: number
  stepIntent?: string
  /** Called when a file-mutating tool writes; used to keep the codebase index fresh. */
  onFileMutated?: (absPaths: string[]) => void
  /** Optional text-only model call for model-assisted context compression.
   *  When provided, compression summaries are model-generated for higher fidelity.
   *  Falls back to structural summarisation when absent. */
  compressCallModel?: (messages: Array<{ role: string; content: string }>) => Promise<string>
}

export interface AgentLoopResult {
  ok: boolean
  finalText: string
  iters: number
  toolCallCount: number
  stopped: 'final' | 'max_iters' | 'budget' | 'cancelled' | 'error' | 'verify_failed'
}

const APPROX_CHARS_PER_TOKEN = 4
/** Cap each observation fed back to the driver — keeps small models fast and cheap. */
const OBSERVATION_CAP_CHARS = 6000
/** Older observations get squashed to this once the transcript outgrows the budget. */
const SQUASHED_CAP_CHARS = 400

/** Returns true when the project directory has no user-authored files (only .crucible/ meta). */
function isFreshWorkspace(projectPath: string): boolean {
  try {
    const entries = fs.readdirSync(projectPath)
    return entries.every(e => e === '.crucible' || e === '.git')
  } catch { return true }
}

export function defaultSystemPreamble(projectPath: string): string {
  const fresh = isFreshWorkspace(projectPath)
  const workspaceNote = fresh
    ? `\nFRESH WORKSPACE: No source files exist here yet. Do NOT try to list_dir or read_file before creating files — the directory is empty. Use write_file to create your first files; it creates parent directories automatically. Start by planning what files you need, then write them.`
    : `\nExisting project — use list_dir and read_file to understand the current structure before making changes.`

  const worldCtx = buildWorldContext()
  return `You are Crucible, an autonomous Mac control and coding agent.
${worldCtx}

RULE 1 — NEVER ask for a specific confirmation phrase or script. If the user asks you to do something, DO IT with your tools. If they say yes/proceed/go ahead/do it/confirm, EXECUTE IMMEDIATELY.
RULE 2 — NEVER output a Python or shell script for the user to run. You have tools. Use them.
RULE 3 — Work step by step: inspect with tools, make changes, verify, then give a final answer. When done, reply with your summary and no tool calls.
${workspaceNote}
IMPORTANT — delegation: for the single hardest algorithmic core of a task (a tricky function, non-obvious algorithm, or subtle edge-case logic), you MUST call ensemble_solve with a self-contained subprompt instead of writing it yourself. The ensemble runs several models in parallel and returns the highest-scored implementation, which is more reliable than your first draft. Then write that candidate to a file and verify it. Use ensemble_solve at most once or twice per task, only for the genuinely hard part — routine glue code you write directly.

AUTONOMOUS RESEARCH: When you encounter something you don't know, can't find in the project, or are unsure about — use web_search immediately. Do not guess. Do not say "I don't have access to real-time information." Search for it, read the results, and use what you find. For coding problems: search for the error message, the library docs, or the approach. For factual questions: search and answer from results. For tasks involving files or images: use download_file to fetch what you need directly.

FILE SYSTEM: You can write files to the project folder, ~/Desktop, ~/Downloads, and ~/Documents. Use absolute paths with ~ expanded (e.g. /Users/justin/Desktop/myfile.txt). For everything else, ask the user first.

MAC CONTROL: You can run any shell command via the run tool. To open apps: open -a AppName. To open URLs: open -a Safari https://url. To create folders: mkdir -p ~/Desktop/FolderName. Execute immediately — never ask the user to run commands themselves.

GLOBAL MEMORY: Use write_global_memory to save durable facts about the USER that should persist across ALL future sessions — preferences, timezone, recurring tools, communication style. Call it whenever you learn something genuinely reusable, not just task-specific. Examples: "User prefers concise responses", "User works in TypeScript", "User is based in Italy". Project-specific facts go in the per-project memory automatically; global memory is only for things true across all projects.

TOOL ACQUISITION: If you need to do something that no existing tool supports, use create_tool to write a new one on the spot. The tool body is a JS async function (receives args, ctx) that returns { ok: boolean, output: string }. It is registered immediately and persisted so future sessions have it too. Only create a tool when the built-in set genuinely cannot do the job — don't duplicate existing tools. To change an existing dynamic tool use update_tool (the old version is archived automatically); rollback_tool restores a prior version if an update made things worse.

EXECUTION OVER SCRIPTING: When the user asks you to delete, move, download, organize, or manipulate files — USE YOUR TOOLS to do it directly. NEVER output a Python script, shell script, or code block for the user to run themselves. NEVER use rm -rf in the run tool — it is blocked. Instead use: delete_file for single files, delete_folder for folders/directories, empty_trash to empty the Trash, move_file to move or rename, download_file to fetch images. Outputting a script instead of acting is a failure.

CONFIRMATION POLICY: You already have permission to act. Do NOT ask the user to confirm with a specific phrase or repeat themselves. If a user says "proceed", "yes", "do it", "go ahead", or similar — that IS confirmation. Execute immediately using your tools.

VERIFY BEFORE REPORTING: After ANY file operation (delete, download, move, rename), you MUST use list_dir or run "ls -la <path>" to confirm the actual state of the folder before reporting results to the user. Never report success based on assumption — only report what you can confirm with a tool call. If the result does not match what was requested, fix it before responding.

Paths may be relative to the project root. Keep outputs concise.

TYPESCRIPT PROJECTS: When creating a new TypeScript project, always follow these rules:
1. Never set "type": "module" in package.json unless the user explicitly asks for ESM.
2. Always use tsx to run TypeScript files — never ts-node. Command: npx tsx src/index.ts
3. Use CommonJS-style imports (no .js extensions on relative imports).
4. Always verify the project runs after scaffolding: use the run tool with npx tsx <entrypoint>.
5. tsconfig.json must have "module": "commonjs" and "esModuleInterop": true.`
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<AgentLoopResult> {
  const {
    goal, projectPath, driveTurn, emit, signal,
    maxIters = 32, budgetTokens = 120_000, verify,
  } = opts

  const ctx: ToolCtx = {
    projectPath,
    userId: opts.userId,
    emit,
    signal,
    allowMutation: opts.allowMutation ?? true,
    deviceTier: opts.deviceTier,
    deviceId: opts.deviceId,
    budget: { remainingTokens: budgetTokens },
    onFileMutated: opts.onFileMutated,
  }

  const tools = registry.list()
  // Resume from checkpoint if initialMessages provided; otherwise start fresh.
  const messages: Array<Record<string, unknown>> = opts.initialMessages
    ? [...opts.initialMessages]
    : [
        { role: 'system', content: opts.systemPreamble ?? defaultSystemPreamble(projectPath) },
        { role: 'user', content: goal },
      ]

  let spentTokens = 0
  let toolCallCount = 0
  const start = Date.now()

  // Context anchor — immutable record of the original goal for compression validation
  const anchorId = `loop_${start}`
  createAnchor(anchorId, goal)

  const spend = (chars: number) => { spentTokens += Math.ceil(chars / APPROX_CHARS_PER_TOKEN) }

  // Error-pattern tracker — detects the agent spinning on the same failure.
  let lastErrorFingerprint = ''
  let consecutiveErrorCount = 0

  /** Inject a corrective hint when the model is looping on the same failure. */
  function maybePushErrorHint(toolResults: Array<{ ok: boolean; output: string; tool: string }>) {
    const errors = toolResults.filter(r => !r.ok)
    if (!errors.length) { lastErrorFingerprint = ''; consecutiveErrorCount = 0; return }

    // Build a fingerprint: tool name + first 60 chars of error message
    const fp = errors.map(e => `${e.tool}:${e.output.slice(0, 60)}`).join('|')
    if (fp === lastErrorFingerprint) {
      consecutiveErrorCount++
    } else {
      lastErrorFingerprint = fp
      consecutiveErrorCount = 1
    }

    if (consecutiveErrorCount < 2) return

    // Classify the error and inject a targeted hint
    const allOutput = errors.map(e => e.output).join(' ')
    let hint: string

    if (/not found|no such file|ENOENT|does not exist/i.test(allOutput)) {
      hint = `SYSTEM HINT: You have tried this path twice and it does not exist. If this is a file you intend to create, use write_file — it creates parent directories automatically. If it is a file you expect to already exist, re-examine the project structure with list_dir before trying again. Do not repeat the same failing path.`
    } else if (/permission denied|EACCES/i.test(allOutput)) {
      hint = `SYSTEM HINT: Permission denied. Try a different path inside the project root, or use the run tool with an appropriate command.`
    } else if (/outside the project root|path.*escape/i.test(allOutput)) {
      hint = `SYSTEM HINT: The path escapes the project root. All file operations must stay within ${projectPath}. Use relative paths or absolute paths inside that directory.`
    } else if (/exit [^0]|command not found|spawn/i.test(allOutput)) {
      hint = `SYSTEM HINT: The shell command is failing repeatedly. Check whether the required tool/runtime is installed, or try a different approach to accomplish the same goal.`
    } else {
      hint = `SYSTEM HINT: The same error has occurred twice in a row (${errors[0].tool}). Stop repeating this approach. Reason about why it is failing and try a fundamentally different method.`
    }

    messages.push({ role: 'user', content: hint })
    consecutiveErrorCount = 0 // reset so we don't spam hints
  }

  for (let iter = 1; iter <= maxIters; iter++) {
    if (signal?.aborted) return done('cancelled', '', iter)
    if (iter === 1) debugBus.emit('agent', 'loop_start', { goal: goal.slice(0, 120), projectPath })
    if (spentTokens >= budgetTokens) return done('budget', '', iter)
    ctx.budget!.remainingTokens = budgetTokens - spentTokens

    // Emit live progress so the UI can show step/iter/elapsed
    emit({
      type: 'iter_progress',
      iter, maxIters,
      stepIndex: opts.stepIndex ?? 0,
      stepTotal: opts.stepTotal ?? 1,
      stepIntent: opts.stepIntent ?? goal.slice(0, 80),
      elapsed: Date.now() - start,
    })

    let turn: DriveTurnResult
    try {
      turn = await driveTurn(messages, tools, signal)
    } catch (e: any) {
      if (signal?.aborted) return done('cancelled', '', iter)
      // All driver candidates failed — attempt emergency compression before giving up.
      // Token-size 413s mean the context is too large; compressing may unlock smaller models.
      const errMsg = String(e?.message ?? e)
      let recovered = false
      if (/413|too.?large|token.*limit|context.?length/i.test(errMsg)) {
        try {
          debugBus.emit('agent', 'emergency_compress', { iter, reason: errMsg.slice(0, 80) }, { severity: 'warn' })
          const comprResult = await maybeCompressMessages(messages, goal, opts.compressCallModel ?? null, true /* force */)
          if (comprResult.compressed) {
            messages.splice(0, messages.length, ...comprResult.messages)
            const discrepancy = validateCompression(anchorId, comprResult.anchorBlock)
            if (discrepancy.patch) messages.push({ role: 'user', content: discrepancy.patch })
            emit({ type: 'thought', text: '[Context compressed — retrying turn]', iter })
            turn = await driveTurn(messages, tools, signal)
            recovered = true
          }
        } catch { /* compression or retry also failed — fall through to error */ }
      }
      if (!recovered) {
        emit({ type: 'agent_error', error: errMsg, iter })
        debugBus.emit('agent', 'agent_error', { error: errMsg, iter }, { severity: 'error' })
        return done('error', errMsg, iter)
      }
    }
    // Defend against a driver returning a partial turn.
    turn = { text: turn?.text ?? '', toolCalls: Array.isArray(turn?.toolCalls) ? turn.toolCalls : [] }
    spend(turn.text.length + JSON.stringify(turn.toolCalls).length)

    if (turn.text.trim()) emit({ type: 'thought', text: turn.text, iter })

    if (turn.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: turn.toolCalls.map(c => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      })
      const results = await Promise.all(turn.toolCalls.map(c => registry.exec(c, ctx)))
      toolCallCount += results.length
      turn.toolCalls.forEach((c, i) => {
        debugBus.emit('tool', c.name, { args: c.args, ok: results[i].ok, output: results[i].output.slice(0, 300) }, { severity: results[i].ok ? 'info' : 'error' })
        const compressed = compressObservation(results[i].output)
        spend(compressed.length)
        messages.push({ role: 'tool', tool_call_id: c.id, content: `(${results[i].ok ? 'ok' : 'error'}) ${compressed}` })
      })
      // Detect repetitive failures and inject a corrective hint before the next turn
      maybePushErrorHint(turn.toolCalls.map((c, i) => ({ ok: results[i].ok, output: results[i].output, tool: c.name })))
      squashOldObservations(messages, spentTokens, budgetTokens)

      // Context compression — fires when raw transcript exceeds ~15k tokens.
      // Model-assisted when compressCallModel is provided; structural fallback otherwise.
      try {
        const comprResult = await maybeCompressMessages(messages, goal, opts.compressCallModel ?? null)
        if (comprResult.compressed) {
          // Replace message array in-place so checkpoint/tool refs stay valid
          messages.splice(0, messages.length, ...comprResult.messages)
          // Validate compressed summary against original anchor
          const discrepancy = validateCompression(anchorId, comprResult.anchorBlock)
          if (discrepancy.patch) {
            messages.push({ role: 'user', content: discrepancy.patch })
          }
          debugBus.emit('agent', 'context_compressed', {
            tokensReclaimed: comprResult.tokensReclaimed,
            discrepancyAction: discrepancy.action,
            missingEntities: discrepancy.missingEntities.length,
            missingRequirements: discrepancy.missingRequirements.length,
          }, { severity: 'info' })
        }
      } catch { /* compression is best-effort — never block the loop */ }

      // Checkpoint after each tool-call round so a drop can resume here
      opts.onCheckpoint?.(messages, iter)
      continue
    }

    // No tool calls — model thinks it's done. Verify before accepting.
    if (verify) {
      const v = await verify(turn.text, ctx)
      emit({ type: 'verify', passed: v.passed, signal: v.signal, report: v.report.slice(0, 1500), escalate: v.escalate ?? false })
      if (!v.passed && v.escalate) {
        // Heal cap hit or same failure repeating — stop honestly instead of thrashing.
        const honest = `Verification is still failing after repeated fix attempts (${v.signal}).\n\nLast report:\n${v.report.slice(0, 2000)}\n\nModel's last summary:\n${turn.text}`
        return { ...done('verify_failed', honest, iter), finalText: honest }
      }
      if (!v.passed) {
        messages.push({ role: 'assistant', content: turn.text })
        messages.push({
          role: 'user',
          content: `Verification failed (${v.signal}):\n${compressObservation(v.report)}` +
            (v.hints?.length ? `\nHints:\n- ${v.hints.join('\n- ')}` : '') +
            '\nFix the problem and verify again.',
        })
        continue
      }
    }
    return done('final', turn.text, iter)
  }
  return done('max_iters', '', maxIters)

  function done(stopped: AgentLoopResult['stopped'], finalText: string, iters: number): AgentLoopResult {
    const ok = stopped === 'final'
    deleteAnchor(anchorId)
    emit({ type: 'agent_done', ok, stopped, iters, toolCallCount, spentTokens, ms: Date.now() - start })
    // Self-reflection — runs async, never blocks the response
    if (ok && finalText) {
      setImmediate(async () => {
        try {
          const reflectionPrompt = buildReflectionPrompt(goal, finalText)
          const reflectionResult = await driveTurn(
            [{ role: 'user', content: reflectionPrompt }], [], signal
          )
          const raw = reflectionResult.text.replace(/```json|```/g, '').trim()
          const parsed = JSON.parse(raw)
          if (parsed.observation) {
            appendReflection({
              ts: Date.now(), task: goal.slice(0, 200),
              observation: parsed.observation,
              principleScores: parsed.principleScores ?? {},
              graphUpdates: (parsed.graphNodes ?? []).map((n: any) => n.id),
            })
          }
          if (Array.isArray(parsed.newFacts)) {
            for (const fact of parsed.newFacts) appendWorldFact(String(fact))
          }
          if (Array.isArray(parsed.graphNodes)) {
            const graph = loadGraph()
            for (const n of parsed.graphNodes) touchNode(graph, n.id, n)
            saveGraph(graph)
          }
          debugBus.emit('agent', 'reflection_complete', { observation: parsed.observation }, { severity: 'info' })
        } catch (e) {
          debugBus.emit('agent', 'reflection_failed', { error: String(e) }, { severity: 'warn' })
        }
      })
    }
    return { ok, finalText, iters, toolCallCount, stopped }
  }
}

/** Never feed raw tool output back verbatim — cap it, keeping head and tail. */
export function compressObservation(output: string, cap = OBSERVATION_CAP_CHARS): string {
  if (output.length <= cap) return output
  const head = output.slice(0, Math.floor(cap * 0.7))
  const tail = output.slice(-Math.floor(cap * 0.25))
  return `${head}\n…[${output.length - cap} chars omitted]…\n${tail}`
}

/** When past 60% of budget, squash all but the 4 most recent tool observations. */
function squashOldObservations(messages: Array<Record<string, unknown>>, spent: number, budget: number) {
  if (spent < budget * 0.6) return
  const toolIdxs = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0)
  for (const i of toolIdxs.slice(0, -4)) {
    const content = String(messages[i].content ?? '')
    if (content.length > SQUASHED_CAP_CHARS) {
      messages[i] = { ...messages[i], content: content.slice(0, SQUASHED_CAP_CHARS) + '…[squashed]' }
    }
  }
}
