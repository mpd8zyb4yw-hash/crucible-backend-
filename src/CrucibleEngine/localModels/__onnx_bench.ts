// ── localModels/__onnx_bench.ts — offline bench for the ONNX adapter + registry ──
// Run: npx tsx src/CrucibleEngine/localModels/__onnx_bench.ts
// No @xenova/transformers, no weights, no filesystem — everything is injected/faked.

import { createOnnxModel, extractGeneratedText, buildMessages, type OnnxGenerator, type OnnxModelSpec } from './onnxAdapter'
import { getRegistry, ONNX_CANDIDATES } from './registry'
import type { LocalModelInfo } from './contracts'

let failures = 0
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`) } else { console.log(`ok: ${msg}`) }
}

async function drain(it: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const c of it) out += c
  return out
}

const info: LocalModelInfo = {
  id: 'test-onnx', family: 'smollm', params: 1, provider: 'local', quality: 5,
  fit: { coding: 5, reasoning: 5, creative: 5, factual: 5, math: 5, general: 5 },
  sizeBytes: 1, installed: true, residentRAMBytes: 1,
}
const spec: OnnxModelSpec = { repo: 'test/repo', info }

function main() {
  // ── extractGeneratedText: the shapes transformers.js actually returns ──
  assert(extractGeneratedText([{ generated_text: 'hello world' }], 'q') === 'hello world',
    'string generated_text passes through')
  assert(extractGeneratedText([{ generated_text: 'PROMPTanswer' }], 'PROMPT') === 'answer',
    'echoed prompt prefix is stripped')
  const chat = [{ generated_text: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'the reply' },
  ] }]
  assert(extractGeneratedText(chat, 'hi') === 'the reply', 'chat-template message list -> last assistant turn')
  assert(extractGeneratedText(null, 'q') === '' && extractGeneratedText({}, 'q') === '' && extractGeneratedText('str', 'q') === 'str',
    'null/unknown/raw-string shapes are handled without throwing')

  // ── buildMessages: system + history + prompt, in order ──
  const msgs = buildMessages('now', [{ user: 'a', assistant: 'b' }])
  assert(msgs[0].role === 'system' && msgs[msgs.length - 1].content === 'now' && msgs.length === 4,
    'buildMessages emits system + flattened history + final user prompt')

  return (async () => {
    // ── happy path: adapter drives the injected generator and extracts the reply ──
    let seenInput: any = null
    const okGen: OnnxGenerator = async (input, _opts) => { seenInput = input; return [{ generated_text: [{ role: 'assistant', content: 'generated answer' }] }] }
    const model = createOnnxModel(spec, { loadGenerator: async () => okGen })
    const text = await drain(model.generate('the question'))
    assert(text === 'generated answer', 'adapter returns the extracted generation')
    assert(Array.isArray(seenInput) && seenInput[seenInput.length - 1].content === 'the question',
      'adapter passes a chat message list ending in the user prompt')
    assert((await model.health()) === true, 'health is true when the generator loads')

    // ── unavailable: loader returns null (weights not cached) -> empty + unhealthy ──
    const dead = createOnnxModel(spec, { loadGenerator: async () => null })
    assert(await drain(dead.generate('q')) === '', 'unavailable model yields empty output, never throws')
    assert((await dead.health()) === false, 'health is false when the generator cannot load')

    // ── generator throws mid-run -> degrades to empty, not a thrown error ──
    const boom = createOnnxModel(spec, { loadGenerator: async () => (async () => { throw new Error('inference blew up') }) as unknown as OnnxGenerator })
    assert(await drain(boom.generate('q')) === '', 'a throwing generator degrades to empty output')

    // ── abort before run -> empty, generator never invoked ──
    let called = false
    const guarded = createOnnxModel(spec, { loadGenerator: async () => (async () => { called = true; return 'x' }) as unknown as OnnxGenerator })
    const ac = new AbortController(); ac.abort()
    assert(await drain(guarded.generate('q', { signal: ac.signal })) === '' && !called,
      'a pre-aborted request short-circuits without invoking the generator')

    // ── registry: nothing cached -> exactly [apple-fm] (unchanged CI behavior) ──
    const bare = getRegistry({ exists: () => false })
    assert(bare.length === 1 && bare[0].info.id === 'apple-fm', 'empty cache -> registry is apple-fm only')

    // ── registry: a cached ONNX repo is included and marked installed ──
    const target = ONNX_CANDIDATES[0].repo
    const withOnnx = getRegistry({ exists: repo => repo === target })
    assert(withOnnx.length === 2, 'one cached ONNX model is added to the pool')
    const added = withOnnx.find(m => m.info.id === ONNX_CANDIDATES[0].info.id)
    assert(!!added && added.info.installed === true, 'the included ONNX model is flagged installed')

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
    process.exit(failures === 0 ? 0 : 1)
  })()
}

main()
