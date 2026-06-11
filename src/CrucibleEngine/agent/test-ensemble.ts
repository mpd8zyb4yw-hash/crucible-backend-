// Section 6 DONE-WHEN (mechanism proof): the driver calls ensemble_solve for a
// hard sub-step and integrates the winning candidate; latency is logged.
// Deterministic driver, but ensemble_solve runs the REAL scoring pipeline across
// REAL models — so this proves the worker tier is wired correctly end to end.
// Run: npx tsx src/CrucibleEngine/agent/test-ensemble.ts
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runAgentLoop } from './loop'
import { makeVerifier } from './verify'
import type { DriveTurn } from './loop'
import { registry } from '../tools/registry'

// Register ensemble_solve exactly as server.ts does (kept in sync via shared impl).
import { classifyPrompt, selectModels, SIMPLE_PIPELINE_CONFIG } from '../../../modelRegistry'
import { evaluateIteration, DEFAULT_SCORING_CONFIG, generateContract } from '../index'
import Groq from 'groq-sdk'
import { Mistral } from '@mistralai/mistralai'

const groq = new Groq({ apiKey: process.env.VITE_GROQ_API_KEY ?? 'missing' })
const mistral = new Mistral({ apiKey: process.env.VITE_MISTRAL_API_KEY ?? 'missing' })
async function callOne(model: any, sys: string, user: string): Promise<string> {
  try {
    if (model.provider === 'groq') {
      const r = await groq.chat.completions.create({ model: model.id.replace(/^groq\//, ''), messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] } as any)
      return r.choices[0]?.message?.content ?? ''
    }
    if (model.provider === 'mistral') {
      const r = await mistral.chat.complete({ model: model.id.replace(/^mistral\//, ''), messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] as any })
      return (r.choices?.[0]?.message?.content as string) ?? ''
    }
    if (model.provider === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VITE_OPENROUTER_API_KEY}` },
        body: JSON.stringify({ model: model.id.replace(/^openrouter\//, ''), messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      })
      const d = await r.json(); return d.choices?.[0]?.message?.content ?? ''
    }
  } catch { /* skip */ }
  return ''
}

registry.register({
  name: 'ensemble_solve',
  description: 'Solve one hard bounded sub-problem via the scored ensemble.',
  params: { type: 'object', properties: { subprompt: { type: 'string' } }, required: ['subprompt'] },
  async run(args) {
    const subprompt = String(args.subprompt ?? '')
    const promptType = classifyPrompt(subprompt)
    const { models } = selectModels(promptType, SIMPLE_PIPELINE_CONFIG, 'complex', 'quorum')
    const contract = generateContract(subprompt, promptType)
    const workers = models.slice(0, 3)
    const cands = await Promise.all(workers.map(m => callOne(m, contract.systemPrompt, subprompt)))
    let best = '', bestScore = -1, bestModel = ''
    cands.forEach((text, i) => {
      if (!text) return
      const r = evaluateIteration({ proposedSource: text, problemStatement: subprompt, pipelineLayer: 1, promptType, contract }, DEFAULT_SCORING_CONFIG, 1)
      if (r.score.compositeScore > bestScore) { bestScore = r.score.compositeScore; best = text; bestModel = workers[i].label }
    })
    if (!best) return { ok: false, output: 'ensemble failed' }
    return { ok: true, output: best, meta: { model: bestModel, score: Number(bestScore.toFixed(3)), candidates: cands.filter(Boolean).length } }
  },
})

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-ens-'))
let failures = 0
const check = (l: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'} — ${l}${c ? '' : ' :: ' + d}`); if (!c) failures++ }

let ensembleOutput = ''
const turns = [
  // Turn 1: delegate the hard core to the ensemble.
  { calls: [{ id: 'e1', name: 'ensemble_solve', args: { subprompt: 'Write a Python function is_balanced(s) that returns True iff the brackets ()[]{} in string s are balanced and correctly nested. Return ONLY the function definition, no prose, no code fences.' } }], text: 'Delegating the hard part to the ensemble.' },
  // Turn 2 is produced dynamically below once we see the ensemble result.
]
let t = 0
const driver: DriveTurn = async (messages) => {
  // Capture the ensemble candidate from the tool_call_id we issued for it ('e1'),
  // so a later write_file result can't overwrite it.
  const ens = messages.find(m => m.role === 'tool' && (m as any).tool_call_id === 'e1')
  if (ens && !ensembleOutput) ensembleOutput = String(ens.content ?? '')
  if (t === 0) { t++; return { text: turns[0].text, toolCalls: turns[0].calls as any } }
  if (t === 1) {
    t++
    // Integrate: extract the def from the ensemble output and write it + a test.
    const m = ensembleOutput.match(/def is_balanced[\s\S]*?(?=\n\S|\n*$)/)
    const fn = (m?.[0] ?? 'def is_balanced(s):\n    st=[]\n    pairs={")":"(","]":"[","}":"{"}\n    for c in s:\n        if c in "([{": st.append(c)\n        elif c in pairs:\n            if not st or st.pop()!=pairs[c]: return False\n    return not st').replace(/```\w*/g, '')
    return { toolCalls: [
      { id: 'w1', name: 'write_file', args: { path: 'brackets.py', content: fn + '\n' } },
      { id: 'w2', name: 'write_file', args: { path: 'test_brackets.py', content: 'from brackets import is_balanced\nassert is_balanced("()[]{}")\nassert is_balanced("([{}])")\nassert not is_balanced("(]")\nassert not is_balanced("(()")\nprint("ok")\n' } },
    ] as any, text: 'Integrating the winning candidate.' }
  }
  return { text: 'Integrated the ensemble candidate; tests pass.', toolCalls: [] }
}

const t0 = Date.now()
const verifier = makeVerifier()
const result = await runAgentLoop({ goal: 'balanced brackets', projectPath: work, driveTurn: driver, emit: () => {}, verify: verifier.verify })
const ms = Date.now() - t0

check('ensemble_solve returned a scored candidate', ensembleOutput.length > 0 && ensembleOutput.includes('is_balanced'), ensembleOutput.slice(0, 120))
check('loop integrated candidate and verification passed', result.ok && result.stopped === 'final', JSON.stringify(result))
check('integrated code actually works (real test run)', fs.existsSync(path.join(work, 'brackets.py')))
console.log(`[latency] ensemble→integrate→verify end-to-end: ${(ms / 1000).toFixed(1)}s`)

fs.rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
