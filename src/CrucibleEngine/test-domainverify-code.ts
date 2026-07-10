// Test for the static coding verifier (domainVerifiers.verifyCode / domainVerify 'coding').
// It must catch weak-model non-runnable output (placeholders, TODOs, ellipsis,
// truncation) with HIGH PRECISION — never flagging valid spread/rest syntax.
// Deterministic, no network, no execution. Run:
//   npx tsx src/CrucibleEngine/test-domainverify-code.ts

import { verifyCode, domainVerify } from './domainVerifiers'

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ok  ', m) } else { fail++; console.log('  FAIL', m) } }
const fence = (code: string, lang = 'ts') => `Here you go:\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\nThat solves it.`

function main() {
  // ── Flags non-runnable output (passed:false, confident).
  const flagged: Array<[string, string]> = [
    ['TODO stub',        fence('function add(a, b) {\n  // TODO: implement\n}')],
    ['FIXME',            fence('function f() {\n  return 1 // FIXME broken\n}')],
    ['your code here',   fence('def solve():\n    # your code here\n    pass')],
    ['comment ellipsis', fence('function g() {\n  const x = 1\n  // ... rest of logic\n}')],
    ['bare ellipsis',    fence('class A {\n  method() {\n    ...\n  }\n}')],
    ['rest-of phrase',   fence('function big() {\n  doStart()\n  // rest of the implementation\n}')],
  ]
  for (const [name, syn] of flagged) {
    const r = verifyCode(syn, 'write it')
    ok(r.passed === false && r.confidence > 0.5, `flags: ${name}`)
  }

  // ── Truncated / unclosed block is flagged.
  {
    const r = verifyCode('```ts\nfunction f() {\n  return doThing(', 'x')
    ok(r.passed === false && /truncated/.test(r.issues.join(' ')), 'flags truncated / unclosed code block')
  }

  // ── HIGH PRECISION: valid code that uses spread/rest must NOT be flagged.
  const clean: Array<[string, string]> = [
    ['rest param',       fence('function sum(...args) {\n  return args.reduce((a, b) => a + b, 0)\n}')],
    ['array spread',     fence('const merged = [...a, ...b]\nexport { merged }')],
    ['object rest',      fence('const { id, ...rest } = props\nconsole.log(rest)')],
    ['plain function',   fence('export function reverse(s) {\n  return s.split("").reverse().join("")\n}')],
    ['spread call',      fence('const max = Math.max(...nums)')],
  ]
  for (const [name, syn] of clean) {
    const r = verifyCode(syn, 'write it')
    ok(r.passed === true && r.confidence < 0.5, `clean (no false positive): ${name}`)
  }

  // ── A static "looks complete" read is deliberately LOW confidence (only execution
  //    can certify runnability) — so it never claims groundTruthVerified=true.
  {
    const r = verifyCode(fence('const x = 2 + 2'), 'q')
    ok(r.passed === true && r.confidence <= 0.3, 'clean code stays low-confidence (does not over-claim without executing)')
  }

  // ── No code block → no judgement.
  {
    const r = verifyCode('Binary search is O(log n) because it halves the range each step.', 'q')
    ok(r.passed === true && r.confidence < 0.2, 'no code block → no judgement (very low confidence)')
  }

  // ── Router dispatches 'coding' to verifyCode.
  {
    void (async () => {
      const r = await domainVerify('coding', fence('function f() { /* TODO */ }'), 'q')
      ok(r.passed === false && r.confidence > 0.5, "domainVerify routes 'coding' to the static code verifier")
      console.log(`\ndomain-verify-code: ${pass} passed, ${fail} failed`)
      process.exit(fail ? 1 : 0)
    })()
  }
}

main()
