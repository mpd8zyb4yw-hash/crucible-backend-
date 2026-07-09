// Goal autonomy engine — Gap 1.
// Analyzes all of the system's own performance data and formulates a prioritized
// list of specific improvement goals. The background improvement loop calls
// identifyGoals() and acts on the top-priority goal instead of running a fixed
// algorithm — making the improvement direction adaptive, not hardcoded.
//
// Data sources consulted:
//   .crucible/quality-history.json   — per-prompt composite scores + trends
//   .crucible/patterns.json          — per-language error type frequencies + auto-fix rates
//   .crucible/specialization.json    — per-model per-category EMA scores
//   .crucible/triumvirate-log.json   — approve/reject rates per proposal type
//   .crucible/scoring-weights.json   — current weight values (detect drift to extremes)
//   .crucible/history.json           — prompt-type distribution + recent synthesis quality

import fs from 'fs'
import path from 'path'
import { crucibleDir } from './state/session'

// ── Types ─────────────────────────────────────────────────────────────────────

export type GoalCategory =
  | 'prompt_type_quality'   // a prompt category is consistently scoring below average
  | 'error_recovery'        // an error type recurs and often escapes the auto-fix loop
  | 'model_underperformance'// a model consistently underperforms in a category it handles
  | 'weight_drift'          // a scoring dimension has drifted to an extreme
  | 'triumvirate_imbalance' // approve/reject rates suggest thresholds are miscalibrated
  | 'coverage_gap'          // a language/category gets very few pipeline runs (blind spot)

export interface ImprovementGoal {
  id: string
  priority: number          // 1 = highest
  category: GoalCategory
  title: string
  rationale: string
  metric: string            // human-readable name of what to measure
  currentValue: number      // current observed value (0–1 or raw count)
  targetValue: number       // what we're aiming for
  action: GoalAction
}

export type GoalAction =
  | { type: 'tune_scoring'; targetPromptType: string; direction: 'increase' | 'decrease'; dimension: string }
  | { type: 'improve_error_recovery'; language: string; errorType: string }
  | { type: 'retrain_model_bias'; modelId: string; category: string; currentEma: number }
  | { type: 'rebalance_weight'; dimension: string; currentValue: number; nudge: number }
  | { type: 'calibrate_triumvirate'; proposalType: string; currentRate: number; direction: 'tighten' | 'relax' }
  | { type: 'expand_coverage'; category: string; currentCount: number }

export interface GoalReport {
  generatedAt: number
  projectPath: string
  goals: ImprovementGoal[]
  dataSnapshot: {
    qualitySampleSize: number
    recentAvgScore: number
    trend: 'up' | 'down' | 'flat' | 'unknown'
    topErrorType: string | null
    triumvirateRejectRate: number
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return null }
}

function cDir(projectPath: string) { return crucibleDir(projectPath) }

// ── Analysis functions ────────────────────────────────────────────────────────

function analyzeQualityByPromptType(projectPath: string): ImprovementGoal[] {
  const history = readJson<any[]>(path.join(cDir(projectPath), 'quality-history.json'))
  if (!history || history.length < 20) return []
  const goals: ImprovementGoal[] = []

  // Group scores by promptType
  const byType: Record<string, number[]> = {}
  for (const entry of history) {
    const pt = entry.promptType ?? 'general'
    ;(byType[pt] ??= []).push(entry.score ?? 0)
  }
  const globalAvg = history.reduce((s, e) => s + (e.score ?? 0), 0) / history.length

  for (const [pt, scores] of Object.entries(byType)) {
    if (scores.length < 5) continue
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length
    const gap = globalAvg - avg
    if (gap > 0.08) {  // more than 8 points below average
      goals.push({
        id: `quality_gap_${pt}`,
        priority: Math.round(1 + (1 - avg) * 4), // low score → high priority
        category: 'prompt_type_quality',
        title: `Improve ${pt} response quality`,
        rationale: `${pt} prompts average ${(avg * 100).toFixed(0)}% — ${(gap * 100).toFixed(0)} points below the global average of ${(globalAvg * 100).toFixed(0)}%.`,
        metric: `${pt} avg composite score`,
        currentValue: avg,
        targetValue: Math.min(avg + gap * 0.6, 0.85),
        action: { type: 'tune_scoring', targetPromptType: pt, direction: 'increase', dimension: 'functional' },
      })
    }
  }

  return goals
}

function analyzeErrorRecovery(projectPath: string): ImprovementGoal[] {
  const patterns = readJson<Record<string, any>>(path.join(cDir(projectPath), 'patterns.json'))
  if (!patterns) return []
  const goals: ImprovementGoal[] = []

  for (const [lang, langData] of Object.entries(patterns)) {
    if (typeof langData !== 'object') continue
    for (const [errorType, stats] of Object.entries(langData as Record<string, any>)) {
      if (typeof stats !== 'object') continue
      const count: number = stats.count ?? 0
      const fixRate: number = stats.autoFixRate ?? 1
      if (count >= 5 && fixRate < 0.6) {
        goals.push({
          id: `error_recovery_${lang}_${errorType}`,
          priority: Math.round(2 + (1 - fixRate) * 3),
          category: 'error_recovery',
          title: `Fix recurring ${errorType} errors in ${lang}`,
          rationale: `${lang} ${errorType} errors occur ${count} times with only ${(fixRate * 100).toFixed(0)}% auto-fix success. Each escape costs a full model round.`,
          metric: `${lang} ${errorType} auto-fix rate`,
          currentValue: fixRate,
          targetValue: Math.min(fixRate + 0.3, 0.9),
          action: { type: 'improve_error_recovery', language: lang, errorType },
        })
      }
    }
  }

  return goals
}

function analyzeModelUnderperformance(projectPath: string): ImprovementGoal[] {
  const spec = readJson<Record<string, Record<string, number>>>(
    path.join(cDir(projectPath), 'specialization.json')
  )
  if (!spec) return []
  const goals: ImprovementGoal[] = []
  const UNDERPERFORM_THRESHOLD = 0.35  // EMA below this is clearly underperforming

  for (const [modelId, categories] of Object.entries(spec)) {
    for (const [category, ema] of Object.entries(categories)) {
      if (ema < UNDERPERFORM_THRESHOLD) {
        goals.push({
          id: `model_underperf_${modelId}_${category}`,
          priority: 3,
          category: 'model_underperformance',
          title: `Reduce ${modelId.split('/').pop()} routing to ${category} tasks`,
          rationale: `${modelId} has EMA ${(ema * 100).toFixed(0)}% for ${category} — well below the 50% neutral baseline. Selection bias is routing it to tasks it handles poorly.`,
          metric: `${modelId} ${category} EMA`,
          currentValue: ema,
          targetValue: 0.5,
          action: { type: 'retrain_model_bias', modelId, category, currentEma: ema },
        })
      }
    }
  }

  return goals
}

function analyzeWeightDrift(projectPath: string): ImprovementGoal[] {
  const weights = readJson<Record<string, number>>(path.join(cDir(projectPath), 'scoring-weights.json'))
  if (!weights) return []
  const goals: ImprovementGoal[] = []

  // Only the actual scoring dimensions — scoring-weights.json also carries
  // `lastUpdated` (a ms timestamp) and `updateCount` metadata, which are NOT weights.
  // Iterating them treated the timestamp as a dimension and emitted a nonsense
  // "lastUpdated scoring weight is 178363973212000%" goal.
  const SCORING_DIMS = new Set(['similarity', 'functional', 'novelty'])

  // Ideal range: no single dimension should dominate (> 0.55) or be suppressed (< 0.15)
  for (const [dim, val] of Object.entries(weights)) {
    if (!SCORING_DIMS.has(dim)) continue
    if (val > 0.55) {
      goals.push({
        id: `weight_drift_high_${dim}`,
        priority: 3,
        category: 'weight_drift',
        title: `Rebalance over-weighted ${dim} dimension`,
        rationale: `${dim} scoring weight is ${(val * 100).toFixed(0)}% — dominant enough to mask signal from other dimensions and create blind spots.`,
        metric: `${dim} weight`,
        currentValue: val,
        targetValue: 0.45,
        action: { type: 'rebalance_weight', dimension: dim, currentValue: val, nudge: -0.03 },
      })
    } else if (val < 0.15) {
      goals.push({
        id: `weight_drift_low_${dim}`,
        priority: 4,
        category: 'weight_drift',
        title: `Restore suppressed ${dim} dimension`,
        rationale: `${dim} scoring weight is only ${(val * 100).toFixed(0)}% — so low that this quality signal is effectively ignored in selection and synthesis decisions.`,
        metric: `${dim} weight`,
        currentValue: val,
        targetValue: 0.22,
        action: { type: 'rebalance_weight', dimension: dim, currentValue: val, nudge: 0.03 },
      })
    }
  }

  return goals
}

function analyzeTriumvirateBalance(projectPath: string): ImprovementGoal[] {
  const log = readJson<any[]>(path.join(cDir(projectPath), 'triumvirate-log.json'))
  if (!log || log.length < 10) return []
  const goals: ImprovementGoal[] = []

  // Compute approve rate per proposal type over last 50 entries
  const recent = log.slice(-50)
  const byType: Record<string, { approved: number; total: number }> = {}
  for (const entry of recent) {
    const pt = entry.proposalType ?? 'unknown'
    const s = (byType[pt] ??= { approved: 0, total: 0 })
    s.total++
    if (entry.outcome === 'APPROVED') s.approved++
  }

  for (const [proposalType, stats] of Object.entries(byType)) {
    if (stats.total < 5) continue
    const rate = stats.approved / stats.total
    if (rate < 0.1 && stats.total >= 8) {
      // Near-zero approve rate → may be too conservative (blocking legitimate improvements)
      goals.push({
        id: `triumvirate_too_strict_${proposalType}`,
        priority: 3,
        category: 'triumvirate_imbalance',
        title: `Triumvirate may be over-restricting ${proposalType} proposals`,
        rationale: `Only ${(rate * 100).toFixed(0)}% of ${proposalType} proposals approved in the last ${stats.total} debates. If quality is still flat, thresholds may be blocking real improvements.`,
        metric: `${proposalType} approve rate`,
        currentValue: rate,
        targetValue: 0.25,
        action: { type: 'calibrate_triumvirate', proposalType, currentRate: rate, direction: 'relax' },
      })
    } else if (rate > 0.90 && stats.total >= 8) {
      // Near-unanimous approve rate → rubber-stamping, not actually debating
      goals.push({
        id: `triumvirate_rubber_stamp_${proposalType}`,
        priority: 4,
        category: 'triumvirate_imbalance',
        title: `Triumvirate may be rubber-stamping ${proposalType} proposals`,
        rationale: `${(rate * 100).toFixed(0)}% of ${proposalType} proposals are being approved without meaningful debate — the guard is not providing real protection.`,
        metric: `${proposalType} reject rate`,
        currentValue: 1 - rate,
        targetValue: 0.15,
        action: { type: 'calibrate_triumvirate', proposalType, currentRate: rate, direction: 'tighten' },
      })
    }
  }

  return goals
}

function analyzeCoverageGaps(projectPath: string): ImprovementGoal[] {
  const history = readJson<any[]>(path.join(cDir(projectPath), 'history-default.json'))
  if (!history || history.length < 10) return []
  const goals: ImprovementGoal[] = []

  const byType: Record<string, number> = {}
  for (const entry of history) {
    const pt = entry.promptType ?? 'general'
    byType[pt] = (byType[pt] ?? 0) + 1
  }
  const allTypes = ['coding', 'reasoning', 'creative', 'factual', 'math', 'general']
  const total = Object.values(byType).reduce((a, b) => a + b, 0)

  for (const t of allTypes) {
    const count = byType[t] ?? 0
    const frac = count / total
    if (frac < 0.03 && total > 30) {
      goals.push({
        id: `coverage_gap_${t}`,
        priority: 5,
        category: 'coverage_gap',
        title: `${t} tasks underrepresented in pipeline history`,
        rationale: `Only ${count} ${t} queries in ${total} total — ${(frac * 100).toFixed(1)}% share. The system has minimal feedback signal for this category.`,
        metric: `${t} query fraction`,
        currentValue: frac,
        targetValue: 0.05,
        action: { type: 'expand_coverage', category: t, currentCount: count },
      })
    }
  }

  return goals
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Analyze all data sources and return a ranked list of improvement goals. */
export function identifyGoals(projectPath: string): GoalReport {
  const allGoals: ImprovementGoal[] = [
    ...analyzeQualityByPromptType(projectPath),
    ...analyzeErrorRecovery(projectPath),
    ...analyzeModelUnderperformance(projectPath),
    ...analyzeWeightDrift(projectPath),
    ...analyzeTriumvirateBalance(projectPath),
    ...analyzeCoverageGaps(projectPath),
  ]

  // Sort: priority ASC, then by how far current is from target DESC
  allGoals.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    const gapA = Math.abs(a.targetValue - a.currentValue)
    const gapB = Math.abs(b.targetValue - b.currentValue)
    return gapB - gapA
  })

  // Build data snapshot for reporting
  const qHistory = readJson<any[]>(path.join(cDir(projectPath), 'quality-history.json')) ?? []
  const recent10 = qHistory.slice(-10)
  const recentAvg = recent10.length ? recent10.reduce((s, e) => s + (e.score ?? 0), 0) / recent10.length : 0
  const prior10 = qHistory.slice(-20, -10)
  const priorAvg = prior10.length ? prior10.reduce((s, e) => s + (e.score ?? 0), 0) / prior10.length : 0
  const trend = qHistory.length < 20 ? 'unknown'
    : recentAvg > priorAvg + 0.02 ? 'up'
    : recentAvg < priorAvg - 0.02 ? 'down'
    : 'flat'

  const patterns = readJson<any>(path.join(cDir(projectPath), 'patterns.json'))
  let topError: string | null = null
  let topCount = 0
  if (patterns) {
    for (const langData of Object.values(patterns)) {
      if (typeof langData !== 'object') continue
      for (const [et, stats] of Object.entries(langData as Record<string, any>)) {
        if ((stats?.count ?? 0) > topCount) { topCount = stats.count; topError = et }
      }
    }
  }

  const tLog = readJson<any[]>(path.join(cDir(projectPath), 'triumvirate-log.json')) ?? []
  const rejected = tLog.filter(e => e.outcome === 'REJECTED').length
  const tRate = tLog.length > 0 ? rejected / tLog.length : 0

  return {
    generatedAt: Date.now(),
    projectPath,
    goals: allGoals.slice(0, 10), // top 10 goals
    dataSnapshot: {
      qualitySampleSize: qHistory.length,
      recentAvgScore: recentAvg,
      trend: trend as any,
      topErrorType: topError,
      triumvirateRejectRate: tRate,
    },
  }
}

/** Persist latest goal report to .crucible/goals.json */
export function saveGoalReport(projectPath: string, report: GoalReport): void {
  const dir = cDir(projectPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'goals.json'), JSON.stringify(report, null, 2), 'utf-8')
}

export function loadGoalReport(projectPath: string): GoalReport | null {
  return readJson<GoalReport>(path.join(cDir(projectPath), 'goals.json'))
}
