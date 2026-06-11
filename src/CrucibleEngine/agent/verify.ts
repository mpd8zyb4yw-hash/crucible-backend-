// Execution-driven verification — runs the project's real check (test/compile/run)
// and turns failures into structured hints via error-intelligence.
// Anti-thrash: a per-session failure-fingerprint set; the same error signature
// twice → escalate (stop healing, report honestly) instead of burning iterations.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { registry } from '../tools/registry'
import { parseError } from '../error-intelligence'
import type { ExecutionResult, ErrorType, Language } from '../sandbox'
import type { ToolCtx } from '../tools/protocol'
import type { VerifyResult } from './loop'

export interface Verifier {
  verify: (finalText: string, ctx: ToolCtx) => Promise<VerifyResult & { escalate?: boolean }>
  healAttempts: () => number
}

const MAX_HEAL_ATTEMPTS = 3

export function makeVerifier(opts: { command?: string } = {}): Verifier {
  const fingerprints = new Set<string>()
  let attempts = 0
  let runSeq = 0

  return {
    healAttempts: () => attempts,
    async verify(_finalText, ctx) {
      const plan = opts.command
        ? { command: opts.command, signal: 'test' as const }
        : detectCheck(ctx.projectPath)
      if (!plan) return { passed: true, signal: 'none', report: 'No runnable check detected.' }

      const result = await registry.exec(
        { id: `verify_${runSeq++}`, name: 'run', args: { command: plan.command, timeoutMs: 60_000 } },
        { ...ctx, allowMutation: true },
      )
      if (result.ok) return { passed: true, signal: plan.signal, report: result.output.slice(0, 2000) }

      attempts++
      const stderr = result.output
      const hints = extractHints(stderr, ctx.projectPath)
      const fp = fingerprint(stderr)
      const repeated = fingerprints.has(fp)
      fingerprints.add(fp)
      const escalate = repeated || attempts >= MAX_HEAL_ATTEMPTS
      return {
        passed: false,
        signal: plan.signal,
        report: `$ ${plan.command}\n${stderr}`,
        hints,
        escalate,
      }
    },
  }
}

/** Figure out how to check this project: test cmd? compile? just run the entry? */
export function detectCheck(projectPath: string): { command: string; signal: VerifyResult['signal'] } | null {
  const pkgPath = path.join(projectPath, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      const test = pkg.scripts?.test
      if (test && !/no test specified/i.test(test)) return { command: 'npm test --silent', signal: 'test' }
      if (fs.existsSync(path.join(projectPath, 'tsconfig.json'))) return { command: 'npx tsc --noEmit', signal: 'compile' }
    } catch { /* fall through */ }
  }
  let entries: string[] = []
  try { entries = fs.readdirSync(projectPath) } catch { return null }
  // -B: skip __pycache__ — sub-second same-size edits otherwise run stale bytecode.
  const pyTests = entries.filter(f => /^test_.*\.py$|_test\.py$/.test(f))
  if (pyTests.length) return { command: pyTests.map(f => `python3 -B ${f}`).join(' && '), signal: 'test' }
  if (entries.includes('pytest.ini') || entries.includes('conftest.py')) return { command: 'python3 -B -m pytest -q -p no:cacheprovider', signal: 'test' }
  const pyFiles = entries.filter(f => f.endsWith('.py'))
  if (pyFiles.length === 1) return { command: `python3 -B ${pyFiles[0]}`, signal: 'runtime' }
  const jsFiles = entries.filter(f => /\.(mjs|cjs|js)$/.test(f))
  if (jsFiles.length === 1) return { command: `node ${jsFiles[0]}`, signal: 'runtime' }
  return null
}

/** Stable signature of an error: type + symbol + first error line, not addresses/paths. */
export function fingerprint(stderr: string): string {
  const sig = stderr
    .split('\n')
    .filter(l => /error|Error|FAILED|assert|Exception|Traceback/i.test(l))
    .slice(0, 3)
    .join('|')
    .replace(/0x[0-9a-f]+/gi, '')
    .replace(/[/\\][\w./\\-]+/g, '')   // strip paths
    .replace(/\d+/g, 'N')              // strip line numbers / counts
  return crypto.createHash('sha1').update(sig || stderr.slice(0, 200)).digest('hex').slice(0, 12)
}

/** Run stderr through error-intelligence to produce actionable hints. */
export function extractHints(stderr: string, _projectPath: string): string[] {
  const synth: ExecutionResult = {
    success: false,
    output: '',
    error: stderr.slice(0, 4000),
    errorType: classifyStderr(stderr),
    errorLine: extractLine(stderr),
    errorColumn: null,
    executionMs: 0,
    language: guessLanguage(stderr),
  }
  const parsed = parseError(synth, '')
  const hints: string[] = []
  hints.push(`Error type: ${parsed.type}${parsed.symbol ? ` (symbol: ${parsed.symbol})` : ''}${parsed.line ? ` at line ${parsed.line}` : ''}`)
  if (parsed.fixStrategy && parsed.fixStrategy !== 'none') hints.push(`Suggested fix strategy: ${parsed.fixStrategy}`)
  if (parsed.type === 'IMPORT' && parsed.symbol) hints.push(`Missing module '${parsed.symbol}' — install it or remove the dependency.`)
  if (/AssertionError|FAILED/.test(stderr)) hints.push('A test assertion failed — read the expected vs actual values in the report and fix the logic, not the test.')
  return hints
}

function classifyStderr(stderr: string): ErrorType {
  if (/SyntaxError|IndentationError|Unexpected token|Unexpected end of input/.test(stderr)) return 'SYNTAX'
  if (/NameError|is not defined|ReferenceError/.test(stderr)) return 'REFERENCE'
  if (/ModuleNotFoundError|ImportError|Cannot find module/.test(stderr)) return 'IMPORT'
  if (/TypeError/.test(stderr)) return 'TYPE'
  if (/AssertionError|FAILED/.test(stderr)) return 'LOGIC'
  if (/timeout|timed out|killed/.test(stderr)) return 'TIMEOUT'
  return 'RUNTIME'
}

function extractLine(stderr: string): number | null {
  const m = stderr.match(/line (\d+)/) ?? stderr.match(/:(\d+):\d+/)
  return m ? parseInt(m[1], 10) : null
}

function guessLanguage(stderr: string): Language {
  if (/Traceback|\.py\b/.test(stderr)) return 'python'
  if (/at .*\.ts:|\.ts\b/.test(stderr)) return 'typescript'
  return 'javascript'
}
