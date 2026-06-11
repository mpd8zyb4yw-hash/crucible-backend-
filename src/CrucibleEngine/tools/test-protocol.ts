// Section 1 DONE-WHEN smoke test:
// issue a read_file via BOTH the native function-calling path and the JSON-fence
// path and confirm identical ToolResult. Run: npx tsx src/CrucibleEngine/tools/test-protocol.ts
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import Groq from 'groq-sdk'
import { registry } from './registry'
import { parseFenceToolCall, toOpenAITools, fromOpenAIToolCalls } from './protocol'
import type { ToolCtx } from './protocol'

const ctx: ToolCtx = { projectPath: process.cwd(), allowMutation: false }
const TARGET = 'package.json'

async function fencePath() {
  // Simulated weak-model output: prose + one json fence (the protocol's contract).
  const modelText = 'I need to inspect the file first.\n```json\n{"tool": "read_file", "args": {"path": "' + TARGET + '", "limit": 5}}\n```'
  const call = parseFenceToolCall(modelText)
  if (!call) throw new Error('fence parse failed')
  return registry.exec(call, ctx)
}

async function nativePath() {
  const groq = new Groq({ apiKey: process.env.VITE_GROQ_API_KEY })
  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: `Call read_file on path "${TARGET}" with limit 5. Use the tool.` }],
    tools: toOpenAITools(registry.list()) as any,
    tool_choice: 'required',
  })
  const calls = fromOpenAIToolCalls(res.choices[0]?.message)
  if (!calls.length) throw new Error('native path returned no tool_calls')
  const call = calls[0]
  // Models may omit optional args — pin limit so outputs are comparable.
  call.args = { path: String(call.args.path), limit: 5 }
  return registry.exec(call, ctx)
}

const [a, b] = await Promise.all([fencePath(), nativePath()])
console.log('fence :', JSON.stringify(a).slice(0, 120))
console.log('native:', JSON.stringify(b).slice(0, 120))
const identical = a.ok === b.ok && a.output === b.output
console.log(identical ? 'PASS — identical ToolResult from both paths' : 'FAIL — results differ')
process.exit(identical ? 0 : 1)
