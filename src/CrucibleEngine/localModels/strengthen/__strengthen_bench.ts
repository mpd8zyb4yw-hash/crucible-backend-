// ── localModels/strengthen/__strengthen_bench.ts — offline, pure bench for consensus ──
// Run: npx tsx src/CrucibleEngine/localModels/strengthen/__strengthen_bench.ts
// No network, no real models — every ModelOutput here is a literal.

import type { ModelOutput } from '../contracts'
import { strengthen } from './index'

let failures = 0
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`) } else { console.log(`ok: ${msg}`) }
}

function out(modelId: string, text: string, ok = true): ModelOutput {
  return { modelId, text, latencyMs: 1, ok }
}

function main() {
  // ── degenerate: nothing usable ──
  const none = strengthen('q', [out('a', '', false), out('b', '   ', true)])
  assert(none.answer === '' && none.confidence === 0, 'no successful outputs -> empty, zero confidence')

  // ── single model: passthrough ──
  const one = strengthen('q', [out('solo', 'The capital of France is Paris.')])
  assert(one.answer.includes('Paris') && one.contributors.length === 1 && one.method === 'single-model',
    'single successful output passes through as single-model')

  // ── consensus: two models agree, one is off-topic garbage. Central answer wins, NOT the longest. ──
  const agree1 = 'Photosynthesis converts sunlight, water and carbon dioxide into glucose and oxygen in the chloroplast.'
  const agree2 = 'In the chloroplast, plants use sunlight to turn water and carbon dioxide into glucose and oxygen.'
  const garbageLong = 'Banana banana banana ' + 'lorem ipsum dolor sit amet consectetur '.repeat(20)
  const consensus = strengthen('how does photosynthesis work', [
    out('m1', agree1),
    out('m2', agree2),
    out('m3', garbageLong),
  ])
  assert(consensus.answer === agree1 || consensus.answer === agree2,
    'the corroborated answer wins over a longer off-topic output')
  assert(!consensus.contributors.includes('m3'), 'off-topic garbage is not counted as a contributor')
  assert(consensus.contributors.length === 2, 'both agreeing models are credited as contributors')
  assert(consensus.method.startsWith('consensus'), `agreeing outputs report a consensus method (got ${consensus.method})`)

  // ── salient short answer: shared number across models -> high-agreement boost ──
  const salient = strengthen('how many r in strawberry', [
    out('m1', 'There are 3 r letters in the word strawberry.'),
    out('m2', 'The word strawberry contains 3 r characters.'),
    out('m3', 'Strawberry has 3 letter r in it.'),
  ])
  assert(salient.method === 'consensus-salient-agreement', `shared number triggers the salient path (got ${salient.method})`)
  assert(salient.confidence >= 0.7, `unanimous short numeric answer earns high confidence (got ${salient.confidence})`)

  // ── split pool: no real agreement -> low-agreement method, damped confidence ──
  const split = strengthen('opinion question', [
    out('m1', 'Cats are the superior companion animal for apartment living overall.'),
    out('m2', 'Quantum chromodynamics describes the strong nuclear interaction between quarks.'),
  ])
  assert(split.method === 'central-low-agreement', `disjoint outputs report low agreement (got ${split.method})`)
  assert(split.confidence <= 0.6, `a split pool does not manufacture high confidence (got ${split.confidence})`)

  // ── contested numeric answer: models disagree on THE number -> flagged + damped ──
  // The old code scored this as 0.5 "agreement" and still RAISED confidence. It must now
  // be recognized as a disagreement and drop below the normal floor.
  const contested = strengthen('how many moons does jupiter have', [
    out('m1', 'Jupiter has 79 moons.'),
    out('m2', 'Jupiter has 95 moons.'),
    out('m3', 'The answer is 88 moons.'),
  ])
  assert(contested.method === 'contested-numeric', `disagreeing numbers report contested-numeric (got ${contested.method})`)
  assert(contested.confidence < 0.5, `a contested numeric answer falls below the free-tier floor (got ${contested.confidence})`)

  // ── lone dissenter on a factual number is still flagged (2 agree, 1 differs) ──
  const dissent = strengthen('how many r in strawberry', [
    out('m1', 'There are 3 r in strawberry.'),
    out('m2', 'Strawberry has 3 r.'),
    out('m3', 'Strawberry has 2 r.'),
  ])
  assert(dissent.method === 'contested-numeric', `a 2-vs-1 numeric split is flagged (got ${dissent.method})`)
  assert(dissent.confidence < salient.confidence, 'a split answer earns less confidence than the unanimous one')

  // ── incidental numbers in prose must NOT trigger a false contradiction ──
  // Both agree on the concept; the differing incidental numbers (year vs height) are not
  // short-answer payloads, so no contested flag.
  const prose = strengthen('describe the eiffel tower', [
    out('m1', 'The Eiffel Tower is a wrought-iron lattice tower in Paris built for the 1889 World Fair as its centerpiece attraction.'),
    out('m2', 'A wrought-iron lattice tower in Paris, the Eiffel Tower stands 330 meters tall and draws millions of visitors each year.'),
  ])
  assert(prose.method !== 'contested-numeric', `incidental prose numbers do not manufacture a contradiction (got ${prose.method})`)

  // ── near-miss numeric: pure formatting difference ("3" vs "3.0") is NOT a contradiction ──
  const fmt = strengthen('how many r in strawberry', [
    out('m1', '3'),
    out('m2', '3.0'),
    out('m3', '3'),
  ])
  assert(fmt.method !== 'contested-numeric', `"3" vs "3.0" is agreement, not a split (got ${fmt.method})`)
  assert(fmt.confidence >= 0.7, `formatting-equal numbers still earn the salient boost (got ${fmt.confidence})`)

  // ── tolerance: values within 1% collapse to one, so a rounding gap is not contested ──
  const roundish = strengthen('pi to two places', [
    out('m1', '3.14'),
    out('m2', '3.141'),
    out('m3', '3.14'),
  ])
  assert(roundish.method !== 'contested-numeric', `near-equal numbers within tolerance are not contested (got ${roundish.method})`)

  // ── genuine spread beyond tolerance is STILL flagged (guards against over-collapsing) ──
  const realSplit = strengthen('how many moons does saturn have', [
    out('m1', '83'),
    out('m2', '146'),
    out('m3', '83'),
  ])
  assert(realSplit.method === 'contested-numeric', `a real >1% split is still flagged (got ${realSplit.method})`)

  // ── contested yes/no: models split on polarity -> flagged + damped ──
  const yesno = strengthen('is 51 a prime number', [
    out('m1', 'Yes.'),
    out('m2', 'No, it is not.'),
    out('m3', 'Yes, it is prime.'),
  ])
  assert(yesno.method === 'contested-categorical', `split yes/no reports contested-categorical (got ${yesno.method})`)
  assert(yesno.confidence < 0.5, `a contested yes/no falls below the free-tier floor (got ${yesno.confidence})`)

  // ── contested single entity: models name different answers -> flagged + damped ──
  const entity = strengthen('capital of australia', [
    out('m1', 'Sydney'),
    out('m2', 'The answer is Canberra.'),
    out('m3', 'Melbourne'),
  ])
  assert(entity.method === 'contested-categorical', `split entity names report contested-categorical (got ${entity.method})`)
  assert(entity.confidence < 0.5, `a contested entity answer falls below the floor (got ${entity.confidence})`)

  // ── unanimous yes/no: agreement boosts confidence, no contradiction ──
  const agreeYes = strengthen('is water wet', [
    out('m1', 'Yes.'),
    out('m2', 'Yes, it is.'),
    out('m3', 'Yes.'),
  ])
  assert(agreeYes.method !== 'contested-categorical', `unanimous yes is not flagged contested (got ${agreeYes.method})`)
  assert(agreeYes.confidence >= 0.7, `unanimous short categorical answer earns high confidence (got ${agreeYes.confidence})`)

  // ── prose that merely starts with "yes" is NOT a short categorical payload ──
  const proseYes = strengthen('explain recursion', [
    out('m1', 'Yes indeed recursion is when a function calls itself to solve a smaller instance of the same problem repeatedly.'),
    out('m2', 'No single base case means infinite recursion, so a terminating condition is what stops the self-referential calls.'),
  ])
  assert(proseYes.method !== 'contested-categorical', `long prose leading with yes/no is not a categorical contradiction (got ${proseYes.method})`)

  // ── confidence is always within the free-tier corroboration band ──
  for (const r of [one, consensus, salient, split]) {
    assert(r.confidence >= 0.5 && r.confidence <= 0.9, `confidence stays in [0.5,0.9] (got ${r.confidence})`)
  }
  // contested results may (intentionally) dip below the normal floor, but never below 0.3
  for (const r of [contested, dissent, yesno, entity]) {
    assert(r.confidence >= 0.3 && r.confidence < 0.5, `contested confidence in [0.3,0.5) (got ${r.confidence})`)
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
