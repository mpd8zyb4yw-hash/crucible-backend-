// Driver-model access for the agent loop and planner.
// Section 6 turns this into tiered orchestrator/worker selection.

import Groq from 'groq-sdk'
import { toOpenAITools, fromOpenAIToolCalls } from '../tools/protocol'
import type { DriveTurn } from './loop'

export const DRIVER_MODEL = 'llama-3.3-70b-versatile'

let _groq: Groq | null = null
function groq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: process.env.VITE_GROQ_API_KEY ?? 'missing' })
  return _groq
}

const stripThink = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

/** One native tool-calling turn against the driver model. */
export const nativeDriveTurn: DriveTurn = async (messages, tools, _signal) => {
  const res = await groq().chat.completions.create({
    model: DRIVER_MODEL,
    messages: messages as any,
    tools: toOpenAITools(tools) as any,
    tool_choice: 'auto',
    temperature: 0.2,
  } as any)
  const msg = res.choices[0]?.message
  return { text: stripThink(msg?.content ?? ''), toolCalls: fromOpenAIToolCalls(msg) }
}

/** Plain text completion on the driver model (planner, summaries). */
export async function driverComplete(messages: Array<{ role: string; content: string }>): Promise<string> {
  const res = await groq().chat.completions.create({
    model: DRIVER_MODEL,
    messages: messages as any,
    temperature: 0.1,
  } as any)
  return stripThink(res.choices[0]?.message?.content ?? '')
}
