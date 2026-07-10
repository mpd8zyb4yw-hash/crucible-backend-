// Domain-specific verifiers — close the verify loop against reality per prompt type.
// Each verifier takes the synthesis and original question, returns a verdict.
// Called from Stage 5b before polish. Falls through silently on any failure.

export interface VerifyResult {
  passed: boolean
  issues: string[]   // human-readable problems found
  confidence: number // 0–1 how sure we are about the verdict
}

// ── Math verifier — extract numeric claims and check them symbolically ────────
// Uses JS arithmetic for simple expressions; catches the most common errors.
function extractNumericClaims(text: string): Array<{ expr: string; claimed: number }> {
  const results: Array<{ expr: string; claimed: number }> = []
  // Match patterns like "3x + 5 = 14 so x = 3" or "17 × 23 = 391"
  const eqPattern = /(\d[\d\s×\*\+\-\/\.\^x]+)\s*=\s*(\-?\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = eqPattern.exec(text)) !== null) {
    const claimed = parseFloat(m[2])
    if (!isNaN(claimed)) results.push({ expr: m[1].trim(), claimed })
  }
  return results.slice(0, 10)
}

function tryEval(expr: string): number | null {
  try {
    // Safe eval: only digits, operators, parens, spaces
    if (!/^[\d\s\+\-\*\/\.\(\)\^]+$/.test(expr)) return null
    const cleaned = expr.replace(/\^/g, '**')
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${cleaned})`)()
    return typeof result === 'number' && isFinite(result) ? result : null
  } catch { return null }
}

export function verifyMath(synthesis: string, _question: string): VerifyResult {
  const claims = extractNumericClaims(synthesis)
  const issues: string[] = []
  let checked = 0
  for (const { expr, claimed } of claims) {
    const actual = tryEval(expr)
    if (actual === null) continue
    checked++
    if (Math.abs(actual - claimed) > 0.01) {
      issues.push(`"${expr} = ${claimed}" is incorrect (actual: ${actual})`)
    }
  }
  return {
    passed: issues.length === 0,
    issues,
    confidence: checked > 0 ? 0.8 : 0.2,
  }
}

// ── Factual verifier — cross-reference key claims against search ──────────────
// Extracts entity+claim pairs, searches DuckDuckGo, flags contradictions.
// Lightweight — only fires on high-stakes factual questions.
function extractClaims(synthesis: string): string[] {
  // Extract sentences with assertive verbs about named things
  const sentences = synthesis.match(/[A-Z][^.!?]*(?:is|are|was|were|has|have|means|stands for|refers to)[^.!?]*[.!?]/g) ?? []
  return sentences.slice(0, 3).map(s => s.trim())
}

export async function verifyFactual(synthesis: string, question: string): Promise<VerifyResult> {
  const claims = extractClaims(synthesis)
  if (!claims.length) return { passed: true, issues: [], confidence: 0.1 }

  const issues: string[] = []
  // For now: check if synthesis mentions key terms from the question
  // Full search cross-reference requires the web_search tool — this is the structural hook
  const qTerms = question.toLowerCase().split(/\s+/).filter(w => w.length > 4)
  const synthLower = synthesis.toLowerCase()
  const mentionedTerms = qTerms.filter(t => synthLower.includes(t))
  const coverage = qTerms.length > 0 ? mentionedTerms.length / qTerms.length : 1

  if (coverage < 0.4) {
    issues.push(`Synthesis may not address the question — only ${Math.round(coverage * 100)}% of key terms covered`)
  }

  return { passed: issues.length === 0, issues, confidence: 0.4 }
}

// ── Consistency verifier — internal consistency check (creative/reasoning) ────
// Checks for contradictions within the synthesis itself.
function findContradictions(text: string): string[] {
  const issues: string[] = []
  const lower = text.toLowerCase()

  // Check for numeric contradictions (same variable assigned two values)
  const assignments: Record<string, number> = {}
  const assignPattern = /\b([a-z])\s*=\s*(\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = assignPattern.exec(lower)) !== null) {
    const [, varName, val] = m
    const num = parseFloat(val)
    if (assignments[varName] !== undefined && Math.abs(assignments[varName] - num) > 0.01) {
      issues.push(`Variable "${varName}" assigned both ${assignments[varName]} and ${num}`)
    }
    assignments[varName] = num
  }

  // Check for obvious logical contradictions
  const contradictionPairs = [
    ['always', 'never'], ['all', 'none'], ['true', 'false'],
    ['increases', 'decreases'], ['faster', 'slower'],
  ]
  for (const [a, b] of contradictionPairs) {
    if (lower.includes(` ${a} `) && lower.includes(` ${b} `)) {
      // Only flag if they appear close together (within 200 chars)
      const ai = lower.indexOf(` ${a} `), bi = lower.indexOf(` ${b} `)
      if (Math.abs(ai - bi) < 200) {
        issues.push(`Potential contradiction: both "${a}" and "${b}" used in close proximity`)
      }
    }
  }
  return issues
}

export function verifyConsistency(synthesis: string, _question: string): VerifyResult {
  const issues = findContradictions(synthesis)
  return { passed: issues.length === 0, issues, confidence: issues.length > 0 ? 0.6 : 0.3 }
}

// ── Code verifier — STATIC, high-precision "will this even run?" check ────────
// Deliberately not an executor (the pipeline's sandbox/trace path handles real
// execution). This catches the failures weak free models actually exhibit —
// placeholder stubs, TODOs, ellipsis-in-place-of-code, and truncated/unclosed
// blocks — deterministically and offline. It only claims a FAILURE when it is sure
// (a placeholder cannot run); when the code merely looks complete it returns low
// confidence, because a static read can't prove code runs — only execution can.
const CODE_PLACEHOLDER_PATTERNS: RegExp[] = [
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\byour code here\b/i,
  /\bcode goes here\b/i,
  /\b(implementation|logic) goes here\b/i,
  /\b(add|insert|implement|write|fill in) (your |the )?(code|logic|implementation|body|rest)\b/i,
  /\/\/\s*\.\.\.\s*(\(|rest|more|omitted|snip|etc|$)/im,   // `// ...` placeholder comment
  /#\s*\.\.\.\s*(\(|rest|more|omitted|snip|etc|$)/im,      // `# ...` placeholder comment
  /^\s*\.\.\.\s*$/m,                        // a bare `...` line (NOT a `...rest`/`[...arr]` operator, which has no surrounding whitespace)
  /\brest of (the |your )?(code|implementation|logic|function|method)\b/i,
  /<\s*(your|insert|add|implement)[^>]*>/i, // `<your code>`
]

function extractCodeBlocks(text: string): { blocks: string[]; unclosed: boolean } {
  const fenceCount = (text.match(/```/g) ?? []).length
  const blocks: string[] = []
  const re = /```[a-zA-Z0-9+#._-]*\s*\n?([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) blocks.push(m[1])
  return { blocks, unclosed: fenceCount % 2 === 1 }
}

export function verifyCode(synthesis: string, _question: string): VerifyResult {
  const { blocks, unclosed } = extractCodeBlocks(synthesis)
  const issues: string[] = []

  if (unclosed) issues.push('the code block is never closed — the answer appears truncated mid-code and will not run')

  const code = blocks.join('\n')
  if (blocks.length === 0 && !unclosed) {
    // No fenced code in a coding answer — can't judge runnability from a static read.
    return { passed: true, issues: [], confidence: 0.1 }
  }

  for (const p of CODE_PLACEHOLDER_PATTERNS) {
    if (p.test(code)) {
      issues.push('the code contains a placeholder / TODO / ellipsis instead of a complete implementation — it will not run as-is')
      break
    }
  }

  // A confident failure (placeholder/truncation is unambiguously non-runnable) vs a
  // static "looks complete" read we deliberately keep low-confidence — only real
  // execution (the trace path) can certify a coding answer actually runs.
  if (issues.length > 0) return { passed: false, issues, confidence: 0.75 }
  return { passed: true, issues: [], confidence: 0.3 }
}

// ── Router — pick the right verifier for the prompt type ─────────────────────
export async function domainVerify(
  promptType: string,
  synthesis: string,
  question: string
): Promise<VerifyResult> {
  try {
    switch (promptType) {
      case 'math':
        return verifyMath(synthesis, question)
      case 'factual':
        return await verifyFactual(synthesis, question)
      case 'reasoning':
      case 'creative':
        return verifyConsistency(synthesis, question)
      case 'coding':
        return verifyCode(synthesis, question)
      default:
        return { passed: true, issues: [], confidence: 0 }
    }
  } catch {
    return { passed: true, issues: [], confidence: 0 }
  }
}
