// The agent loop — sustained plan→act→observe on the main request path.
// Provider-agnostic: the server supplies driveTurn (one model turn with tools).
// Lightweight by design: observation compression, hard caps, AbortSignal everywhere.

import { registry } from '../tools/registry'
import type { ToolCall, ToolCtx, ToolDef } from '../tools/protocol'

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
  driveTurn: DriveTurn
  emit: (event: Record<string, unknown>) => void
  signal?: AbortSignal
  maxIters?: number
  budgetTokens?: number
  /** Section 4 plugs in execution-driven verification; default accepts the final answer. */
  verify?: (finalText: string, ctx: ToolCtx) => Promise<VerifyResult>
  systemPreamble?: string
  allowMutation?: boolean
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

export function defaultSystemPreamble(projectPath: string): string {
  return `You are Crucible, an autonomous coding agent working in the project at ${projectPath}.
Work step by step: inspect with tools, make changes, run code to verify, then give a final answer.
Call tools when you need to act. When the task is fully done AND verified, reply with your final summary and no tool calls.

IMPORTANT — delegation: for the single hardest algorithmic core of a task (a tricky function, non-obvious algorithm, or subtle edge-case logic), you MUST call ensemble_solve with a self-contained subprompt instead of writing it yourself. The ensemble runs several models in parallel and returns the highest-scored implementation, which is more reliable than your first draft. Then write that candidate to a file and verify it. Use ensemble_solve at most once or twice per task, only for the genuinely hard part — routine glue code you write directly.
Paths may be relative to the project root. Keep outputs concise.`
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<AgentLoopResult> {
  const {
    goal, projectPath, driveTurn, emit, signal,
    maxIters = 16, budgetTokens = 60_000, verify,
  } = opts

  const ctx: ToolCtx = {
    projectPath,
    emit,
    signal,
    allowMutation: opts.allowMutation ?? true,
    budget: { remainingTokens: budgetTokens },
  }

  const tools = registry.list()
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: opts.systemPreamble ?? defaultSystemPreamble(projectPath) },
    { role: 'user', content: goal },
  ]

  let spentTokens = 0
  let toolCallCount = 0
  const start = Date.now()
  const WALL_CLOCK_MS = 5 * 60_000

  const spend = (chars: number) => { spentTokens += Math.ceil(chars / APPROX_CHARS_PER_TOKEN) }

  for (let iter = 1; iter <= maxIters; iter++) {
    if (signal?.aborted) return done('cancelled', '', iter)
    if (spentTokens >= budgetTokens) return done('budget', '', iter)
    if (Date.now() - start > WALL_CLOCK_MS) return done('budget', '', iter)
    ctx.budget!.remainingTokens = budgetTokens - spentTokens

    let turn: DriveTurnResult
    try {
      turn = await driveTurn(messages, tools, signal)
    } catch (e: any) {
      if (signal?.aborted) return done('cancelled', '', iter)
      emit({ type: 'agent_error', error: String(e?.message ?? e), iter })
      return done('error', String(e?.message ?? e), iter)
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
        const compressed = compressObservation(results[i].output)
        spend(compressed.length)
        messages.push({ role: 'tool', tool_call_id: c.id, content: `(${results[i].ok ? 'ok' : 'error'}) ${compressed}` })
      })
      squashOldObservations(messages, spentTokens, budgetTokens)
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
    emit({ type: 'agent_done', ok, stopped, iters, toolCallCount, spentTokens, ms: Date.now() - start })
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
