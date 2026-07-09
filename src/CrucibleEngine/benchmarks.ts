// Benchmark suite — 50 canonical questions with known correct answers.
// Runs after pipeline changes to detect quality regressions.
// The suite grows automatically: when the system gets a question wrong that
// it has never seen before, a minimal version is appended.

import fs from 'fs'
import path from 'path'

export interface Benchmark {
  id: string
  question: string
  promptType: string
  expectedKeywords: string[]   // ALL must appear in a passing answer (case-insensitive)
  forbiddenKeywords: string[]  // ANY of these in the answer = fail
  addedAt: number
  source: 'seed' | 'failure'  // seed = hand-crafted, failure = captured from real failure
}

export interface Regression {
  promptType: string
  prevRate: number
  currRate: number
  drop: number       // prevRate - currRate, > threshold
}

export interface BenchmarkRun {
  id: string
  ts: number
  results: Array<{ benchmarkId: string; passed: boolean; score: number; synthesis: string }>
  passRate: number
  byType: Record<string, { passed: number; total: number }>
  regressions?: Regression[]  // per-promptType drops vs the previous run (persisted, not just logged); absent on pre-existing runs
}

const REGRESSION_DROP = 0.05   // a category pass-rate drop beyond this counts as a regression
const REGRESSION_MIN_PREV = 3  // ignore categories with too few prior samples to be meaningful

// Pure: compare a run's per-type pass rates against the previous run's. Exported so
// the signal is testable and reusable by consumers (rollback/alerting) rather than
// buried in a console.warn.
export function detectRegressions(
  prevByType: BenchmarkRun['byType'] | undefined,
  currByType: BenchmarkRun['byType'],
): Regression[] {
  if (!prevByType) return []
  const out: Regression[] = []
  for (const [pt, curr] of Object.entries(currByType)) {
    const prev = prevByType[pt]
    if (!prev || prev.total < REGRESSION_MIN_PREV || curr.total === 0) continue
    const prevRate = prev.passed / prev.total
    const currRate = curr.passed / curr.total
    if (prevRate - currRate > REGRESSION_DROP) {
      out.push({ promptType: pt, prevRate, currRate, drop: prevRate - currRate })
    }
  }
  return out
}

const benchmarkFile = (dir: string) => path.join(dir, '.crucible', 'benchmarks.json')
const runFile       = (dir: string) => path.join(dir, '.crucible', 'benchmark-runs.json')

function ensureDir(f: string) { fs.mkdirSync(path.dirname(f), { recursive: true }) }

// Seed benchmarks — diverse, unambiguous, stable
const SEED_BENCHMARKS: Benchmark[] = [
  { id: 'b001', question: 'What is the time complexity of binary search?', promptType: 'reasoning', expectedKeywords: ['o(log n)', 'logarithmic'], forbiddenKeywords: ['o(n)', 'linear'], addedAt: 0, source: 'seed' },
  { id: 'b002', question: 'What does the CAP theorem state?', promptType: 'factual', expectedKeywords: ['consistency', 'availability', 'partition'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b003', question: 'What is 17 × 23?', promptType: 'math', expectedKeywords: ['391'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b004', question: 'Write a function to reverse a string in JavaScript', promptType: 'coding', expectedKeywords: ['split', 'reverse', 'join'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b005', question: 'Explain the difference between TCP and UDP', promptType: 'factual', expectedKeywords: ['reliable', 'connection'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b006', question: 'What is the derivative of x²?', promptType: 'math', expectedKeywords: ['2x'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b007', question: 'What does SOLID stand for in software engineering?', promptType: 'factual', expectedKeywords: ['single', 'open', 'liskov', 'interface', 'dependency'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b008', question: 'What is the output of console.log(typeof null) in JavaScript?', promptType: 'coding', expectedKeywords: ['object'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b009', question: 'Explain what a closure is in programming', promptType: 'reasoning', expectedKeywords: ['function', 'scope', 'variable'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b010', question: 'What is the square root of 144?', promptType: 'math', expectedKeywords: ['12'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b011', question: 'What is the difference between == and === in JavaScript?', promptType: 'coding', expectedKeywords: ['type', 'strict', 'coercion'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b012', question: 'What is Big O notation used for?', promptType: 'reasoning', expectedKeywords: ['complexity', 'algorithm', 'performance'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b013', question: 'What is a primary key in a relational database?', promptType: 'factual', expectedKeywords: ['unique', 'identifier', 'row'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b014', question: 'What does REST stand for?', promptType: 'factual', expectedKeywords: ['representational', 'state', 'transfer'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
  { id: 'b015', question: 'What is the Pythagorean theorem?', promptType: 'math', expectedKeywords: ['a²', 'b²', 'c²'], forbiddenKeywords: [], addedAt: 0, source: 'seed' },
]

export function loadBenchmarks(dir: string): Benchmark[] {
  try {
    const saved = JSON.parse(fs.readFileSync(benchmarkFile(dir), 'utf8')) as Benchmark[]
    // Merge seed IDs that may have been added since last save
    const savedIds = new Set(saved.map(b => b.id))
    const missing = SEED_BENCHMARKS.filter(b => !savedIds.has(b.id))
    return [...saved, ...missing]
  } catch {
    return SEED_BENCHMARKS
  }
}

export function saveBenchmarks(dir: string, benchmarks: Benchmark[]) {
  ensureDir(benchmarkFile(dir))
  fs.writeFileSync(benchmarkFile(dir), JSON.stringify(benchmarks, null, 2))
}

export function addFailureBenchmark(dir: string, question: string, promptType: string, expectedKeywords: string[]) {
  const benchmarks = loadBenchmarks(dir)
  const id = `bf${Date.now()}`
  benchmarks.push({ id, question: question.slice(0, 200), promptType, expectedKeywords, forbiddenKeywords: [], addedAt: Date.now(), source: 'failure' })
  saveBenchmarks(dir, benchmarks)
  console.log(`[Benchmarks] Added failure benchmark: "${question.slice(0, 60)}"`)
}

export function evaluateSynthesis(benchmark: Benchmark, synthesis: string): boolean {
  const lower = synthesis.toLowerCase()
  const allExpected = benchmark.expectedKeywords.every(k => lower.includes(k.toLowerCase()))
  const noForbidden = benchmark.forbiddenKeywords.every(k => !lower.includes(k.toLowerCase()))
  return allExpected && noForbidden
}

export function loadRuns(dir: string): BenchmarkRun[] {
  try { return JSON.parse(fs.readFileSync(runFile(dir), 'utf8')) } catch { return [] }
}

function saveRuns(dir: string, runs: BenchmarkRun[]) {
  ensureDir(runFile(dir))
  const capped = runs.slice(-50)  // keep last 50 runs
  fs.writeFileSync(runFile(dir), JSON.stringify(capped, null, 2))
}

export function recordBenchmarkRun(dir: string, results: BenchmarkRun['results']): BenchmarkRun {
  const byType: Record<string, { passed: number; total: number }> = {}
  const benchmarks = loadBenchmarks(dir)
  for (const r of results) {
    const b = benchmarks.find(b => b.id === r.benchmarkId)
    const pt = b?.promptType ?? 'unknown'
    if (!byType[pt]) byType[pt] = { passed: 0, total: 0 }
    byType[pt].total++
    if (r.passed) byType[pt].passed++
  }
  const passed = results.filter(r => r.passed).length
  const runs = loadRuns(dir)
  const prev = runs[runs.length - 1]
  const run: BenchmarkRun = {
    id: `run_${Date.now()}`,
    ts: Date.now(),
    results,
    passRate: results.length ? passed / results.length : 0,
    byType,
    regressions: detectRegressions(prev?.byType, byType),
  }
  runs.push(run)
  saveRuns(dir, runs)
  return run
}

// Run a single benchmark against the pipeline.
// runQuery is injected from server.ts.
export async function runBenchmarkSuite(
  dir: string,
  runQuery: (question: string, promptType: string) => Promise<string>,
  onProgress?: (done: number, total: number) => void
): Promise<BenchmarkRun> {
  const benchmarks = loadBenchmarks(dir)
  const results: BenchmarkRun['results'] = []
  for (let i = 0; i < benchmarks.length; i++) {
    const b = benchmarks[i]
    onProgress?.(i, benchmarks.length)
    try {
      const synthesis = await runQuery(b.question, b.promptType)
      const passed = evaluateSynthesis(b, synthesis)
      results.push({ benchmarkId: b.id, passed, score: passed ? 1 : 0, synthesis: synthesis.slice(0, 300) })
    } catch {
      results.push({ benchmarkId: b.id, passed: false, score: 0, synthesis: '' })
    }
  }
  const run = recordBenchmarkRun(dir, results)
  console.log(`[Benchmarks] Run complete — ${Math.round(run.passRate * 100)}% pass rate`)

  // The regression signal is now computed and PERSISTED on the run (run.regressions),
  // so it's queryable via loadRuns / the benchmarks endpoint and actionable by a
  // consumer (rollback/alerting) — not just a console line that vanishes.
  for (const r of run.regressions ?? []) {
    console.warn(`[Benchmarks] REGRESSION: ${r.promptType} dropped ${(r.drop * 100).toFixed(1)}% (${(r.prevRate * 100).toFixed(0)}%→${(r.currRate * 100).toFixed(0)}%)`)
  }
  return run
}
