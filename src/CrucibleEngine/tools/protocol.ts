// Tool protocol — provider-portable tool calling.
// Two modes, one contract:
//   1. Native: providers with OpenAI-compatible function-calling (Groq, Mistral,
//      OpenRouter) or Gemini functionDeclarations get the registry as JSON-schema
//      tools and return structured tool_calls.
//   2. Fence fallback: models without native support emit ONE ```json fence with
//      {"tool": name, "args": {...}}. Parsed with a balanced-brace scan, not regex.

export interface ToolCtx {
  projectPath: string
  /** Remaining token budget for the enclosing loop; tools may consult it to cap output. */
  budget?: { remainingTokens: number }
  /** Stream an event to the client (SSE). */
  emit?: (event: Record<string, unknown>) => void
  signal?: AbortSignal
  /** When false, mutating tools (write/edit/run) must refuse. */
  allowMutation?: boolean
}

export interface ToolResult {
  ok: boolean
  output: string
  truncated?: boolean
  meta?: Record<string, unknown>
}

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  params: Record<string, unknown>
  /** Marks tools that mutate state — gated by ctx.allowMutation. */
  mutates?: boolean
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

// ── Native-mode adapters ──────────────────────────────────────────────────────

/** OpenAI-compatible `tools` array (Groq / Mistral / OpenRouter). */
export function toOpenAITools(defs: ToolDef[]) {
  return defs.map(d => ({
    type: 'function' as const,
    function: { name: d.name, description: d.description, parameters: d.params },
  }))
}

/** Gemini functionDeclarations. */
export function toGeminiTools(defs: ToolDef[]) {
  return [{ functionDeclarations: defs.map(d => ({ name: d.name, description: d.description, parameters: d.params })) }]
}

/** Normalize OpenAI-style tool_calls from a chat completion message. */
export function fromOpenAIToolCalls(message: any): ToolCall[] {
  const calls = message?.tool_calls ?? []
  return calls.map((c: any, i: number) => ({
    id: c.id ?? `call_${i}`,
    name: c.function?.name ?? '',
    args: safeParseJSON(c.function?.arguments) ?? {},
  })).filter((c: ToolCall) => c.name)
}

/** Normalize Gemini functionCalls(). */
export function fromGeminiFunctionCalls(calls: Array<{ name: string; args: object }> | undefined): ToolCall[] {
  return (calls ?? []).map((c, i) => ({ id: `call_${i}`, name: c.name, args: (c.args as Record<string, unknown>) ?? {} }))
}

// ── Fence-mode (fallback) ─────────────────────────────────────────────────────

export function fenceProtocolPrompt(defs: ToolDef[]): string {
  const list = defs.map(d =>
    `- ${d.name}: ${d.description}\n  args schema: ${JSON.stringify(d.params)}`).join('\n')
  return `
You can call tools. To call one, reply with EXACTLY ONE fenced json block and nothing else:
\`\`\`json
{"tool": "<name>", "args": { ... }}
\`\`\`
Available tools:
${list}
After you receive the tool result, continue. When you have the final answer, reply normally with NO json fence.`
}

/**
 * Extract a single {"tool","args"} call from model text.
 * Strategy: find a \`\`\`json fence (or any fence) — else the first '{' — then take
 * the balanced-brace JSON object from there. Tolerant of prose around the fence.
 */
export function parseFenceToolCall(text: string): ToolCall | null {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  const candidates: string[] = []
  if (fence) candidates.push(fence[1])
  candidates.push(text)
  for (const src of candidates) {
    const obj = extractBalancedJSON(src)
    if (obj && typeof obj.tool === 'string') {
      return { id: 'fence_0', name: obj.tool, args: (obj.args as Record<string, unknown>) ?? {} }
    }
  }
  return null
}

/** First balanced top-level {...} in the string, JSON-parsed; null if none parses. */
function extractBalancedJSON(src: string): Record<string, unknown> | null {
  let start = src.indexOf('{')
  while (start !== -1) {
    let depth = 0, inStr = false, esc = false
    for (let i = start; i < src.length; i++) {
      const ch = src[i]
      if (esc) { esc = false; continue }
      if (ch === '\\' && inStr) { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const parsed = safeParseJSON(src.slice(start, i + 1))
          if (parsed) return parsed
          break
        }
      }
    }
    start = src.indexOf('{', start + 1)
  }
  return null
}

export function safeParseJSON(s: unknown): Record<string, unknown> | null {
  if (typeof s !== 'string') return null
  try { return JSON.parse(s) } catch { return null }
}
