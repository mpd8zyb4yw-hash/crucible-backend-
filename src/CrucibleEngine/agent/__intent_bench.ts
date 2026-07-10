// ── agent/__intent_bench.ts — offline bench for the local intent router ──
// Run: npx tsx src/CrucibleEngine/agent/__intent_bench.ts
// Pure: resolveLocalIntent is message → plan | null. No daemon, no network.

import { resolveLocalIntent, runLocalPlan } from './localIntentRouter'
import type { ToolResult } from '../tools/protocol'

let failures = 0
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`) } else { console.log(`ok: ${msg}`) }
}

// A fake search_youtube output with three distinct results, in order.
const THREE_RESULTS = [
  'https://www.youtube.com/watch?v=AAAAAAAAAAA  Be.Busta - first',
  'https://www.youtube.com/watch?v=BBBBBBBBBBB  Be.Busta - second',
  'https://www.youtube.com/watch?v=CCCCCCCCCCC  Be.Busta - third',
].join('\n')

async function planOpenedUrl(message: string, searchOut = THREE_RESULTS): Promise<string | null> {
  const plan = resolveLocalIntent(message)
  if (!plan) return null
  let opened: string | null = null
  await runLocalPlan(plan, async (call) => {
    if (call.name === 'search_youtube') return { ok: true, output: searchOut } as ToolResult
    if (call.name === 'open_app') { opened = String(call.args.target ?? ''); return { ok: true, output: 'opened' } as ToolResult }
    return { ok: true, output: '' } as ToolResult
  })
  return opened
}

async function main() {
  // ── THE REPORTED BUG: subject must be "Be.Busta" (not "the third video"),
  //    and the THIRD result must be opened (not the top). ──
  const rep = resolveLocalIntent('Search YouTube for Be.Busta play the third video')
  assert(rep?.intent === 'search_select_media', 'search-then-select intent is recognized')
  assert(rep?.steps[0]?.tool === 'search_youtube' && (rep?.steps[0]?.args?.query) === 'Be.Busta',
    `subject is "Be.Busta", not the selector (got "${rep?.steps[0]?.args?.query}")`)
  assert(await planOpenedUrl('Search YouTube for Be.Busta play the third video') === 'https://www.youtube.com/watch?v=CCCCCCCCCCC',
    'opens the THIRD result, not the top')

  // ── ordinal variants map to the right index ──
  assert(await planOpenedUrl('search youtube for lofi and play the first result') === 'https://www.youtube.com/watch?v=AAAAAAAAAAA', 'first result')
  assert(await planOpenedUrl('find jazz on youtube, open the 2nd video') === 'https://www.youtube.com/watch?v=BBBBBBBBBBB', 'numeric 2nd result')
  assert(await planOpenedUrl('look up cats on youtube play the last one') === 'https://www.youtube.com/watch?v=CCCCCCCCCCC', 'last result')
  assert(await planOpenedUrl('search youtube for cats play the top result') === 'https://www.youtube.com/watch?v=AAAAAAAAAAA', 'top result')

  // ── subject cleaning: service tokens don't leak into the query ──
  const clean = resolveLocalIntent('search for chill beats on youtube, play the second video')
  assert(clean?.steps[0]?.args?.query === 'chill beats', `"on youtube" stripped from subject (got "${clean?.steps[0]?.args?.query}")`)

  // ── an over-asked index clamps to the last available result, never fails ──
  assert(await planOpenedUrl('search youtube for xyzsong play the ninth video') === 'https://www.youtube.com/watch?v=CCCCCCCCCCC', 'over-asked index clamps to last available')

  // ── PRECISION: a bare selector with no search subject defers (null), does NOT
  //    search for the literal words "the third video". ──
  assert(resolveLocalIntent('play the third video') === null, 'bare selector defers to smarter layers (no literal search)')
  assert(resolveLocalIntent('play it') === null, 'pronoun-only command defers')

  // ── REGRESSION: ordinary play/open still work unchanged ──
  const play = resolveLocalIntent('play bohemian rhapsody on youtube')
  assert(play?.intent === 'play_media' && play?.steps[0]?.args?.query === 'bohemian rhapsody', 'plain "play X on youtube" still resolves with the right subject')
  assert(resolveLocalIntent('open Spotify')?.intent === 'open_app', 'open app still resolves')
  assert(resolveLocalIntent('empty the trash')?.intent === 'empty_trash', 'empty trash still resolves')

  // ── a quantity inside a subject is NOT mistaken for a selector ──
  const topN = resolveLocalIntent('search youtube for top 10 songs of 2024')
  assert(topN?.steps[0]?.args?.query === 'top 10 songs of 2024', `"top 10 songs" stays the subject, not a selector (got "${topN?.steps[0]?.args?.query}")`)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
