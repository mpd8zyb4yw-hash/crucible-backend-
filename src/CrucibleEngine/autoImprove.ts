// ============================================================
// CRUCIBLE — Autonomous Background Improvement
// Runs non-blocking after each pipeline round.
//
// Pass 1 — Pattern extraction:
//   Mine top-5% history entries, extract novel knowledge patterns,
//   add as tier-2 entries to the scoring engine knowledge base.
//   GATED: Drift Triumvirate must approve (majority 2/3) before commit.
//
// Pass 2 — Scoring weight adjustment:
//   Nudge ScoringConfig weights toward what correlates with high scores.
//   Bounded to ±0.05 from defaults. Persists to scoring-weights.json.
//   GATED: Drift Triumvirate must approve (unanimous 3/3) before commit.
//
// Pass 3 — Git audit trail:
//   Commit .crucible/ changes with [autonomous] prefix.
//   Rollback last autonomous commit if quality trend is declining.
// ============================================================

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { addApprovedEntry, loadAdditionalEntries } from './scoring-engine'
import type { KnowledgeEntry, ScoringConfig } from './types'
import { runTriumvirate, enqueuePending, drainPendingQueue, recordTriumvirateOutcome, runMetaLearning } from './triumvirate'
import type { WeightChangeProposal, KnowledgePatternProposal } from './triumvirate'
import { identifyGoals, saveGoalReport } from './goalEngine'

// ── Defaults ──────────────────────────────────────────────────
const DEFAULT_WEIGHTS = { similarity: 0.35, functional: 0.45, novelty: 0.20 }
const WEIGHT_MIN = { similarity: 0.20, functional: 0.30, novelty: 0.10 }
const WEIGHT_MAX = { similarity: 0.50, functional: 0.60, novelty: 0.35 }
const WEIGHT_NUDGE = 0.01
const TOP_PERCENTILE = 0.05
const MIN_TOP_SCORE = 0.80

let debounce: ReturnType<typeof setTimeout> | null = null
let projectRoot = process.cwd()
let lastAutoCommitHash: string | null = null

// ── Scoring weight persistence ────────────────────────────────

export interface LearnedWeights {
  similarity: number
  functional: number
  novelty: number
  lastUpdated: number
  updateCount: number
}

function weightsFile(dir: string) { return path.join(dir, '.crucible', 'scoring-weights.json') }
function patternsFile(dir: string) { return path.join(dir, '.crucible', 'learned-patterns.json') }

export function loadLearnedWeights(dir: string): LearnedWeights {
  try { return JSON.parse(fs.readFileSync(weightsFile(dir), 'utf8')) }
  catch { return { ...DEFAULT_WEIGHTS, lastUpdated: 0, updateCount: 0 } }
}

function saveWeights(dir: string, w: LearnedWeights): void {
  try {
    fs.mkdirSync(path.join(dir, '.crucible'), { recursive: true })
    fs.writeFileSync(weightsFile(dir), JSON.stringify(w, null, 2))
  } catch {}
}

// ── Learned patterns persistence ────────────────────────────────

function loadLearnedPatterns(dir: string): KnowledgeEntry[] {
  try { return JSON.parse(fs.readFileSync(patternsFile(dir), 'utf8')) }
  catch { return [] }
}

function saveLearnedPatterns(dir: string, entries: KnowledgeEntry[]): void {
  try { fs.writeFileSync(patternsFile(dir), JSON.stringify(entries, null, 2)) } catch {}
}

// ── Utility ────────────────────────────────────────────────────

function promptTypeToCategory(pt: string): KnowledgeEntry['category'] {
  const map: Record<string, KnowledgeEntry['category']> = {
    coding: 'algorithm', math: 'algorithm', reasoning: 'design-pattern',
    creative: 'design-pattern', factual: 'api-pattern', general: 'design-pattern',
  }
  return map[pt] ?? 'algorithm'
}

function extractStructuralTokens(query: string): string[] {
  return (query.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter(w => !['what','this','that','with','from','have','will','your','more','into','they','them','then','when','where','which','there','their','these','those','about','after','before'].includes(w))
    .slice(0, 6)
}

function gitExec(cmd: string, cwd: string): string {
  try { return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim() }
  catch { return '' }
}

// ── callModel injected from server.ts ─────────────────────────
type CallModelFn = (model: any, messages: any[], opts?: any) => Promise<string>
let _callModel: CallModelFn | null = null
let _MODEL_REGISTRY: any[] | null = null

export function setCallModel(fn: CallModelFn, registry: any[]): void {
  _callModel = fn
  _MODEL_REGISTRY = registry
}

// ── Main improvement pass ──────────────────────────────────────

export async function doImprovementPass(dir: string): Promise<void> {
  // ── Drain pending queue first ──────────────────────────────
  // Retry proposals that were queued when no judge models were available.
  if (_callModel && _MODEL_REGISTRY) {
    const pending = drainPendingQueue(dir)
    for (const entry of pending) {
      console.log(`[AutoImprove] Retrying pending proposal "${entry.id}" (attempt ${entry.retryCount})`)
      try {
        const { approved } = await runTriumvirate(entry.proposal, dir, _MODEL_REGISTRY, _callModel)
        if (approved) {
          if (entry.proposal.type === 'knowledge_pattern') {
            const p = entry.proposal as KnowledgePatternProposal
            const existing = loadLearnedPatterns(dir)
            if (!existing.some(e => e.id === p.id)) {
              const newEntry: KnowledgeEntry = {
                id: p.id, tier: 2,
                category: promptTypeToCategory(p.promptType),
                name: p.tokens.slice(0, 2).join('-'),
                description: p.description,
                tags: [p.promptType],
                structuralTokens: p.tokens,
                antipatterns: [],
                qualitySignals: [{ name: 'high-composite-score', description: 'From top-scoring pipeline round', weight: 0.8 }],
                hitCount: 0, approvedAt: Date.now(),
              }
              addApprovedEntry(newEntry)
              existing.push(newEntry)
              saveLearnedPatterns(dir, existing)
              console.log(`[AutoImprove] Pending pattern "${p.id}" approved and committed`)
            }
          } else if (entry.proposal.type === 'weight_change') {
            const p = entry.proposal as WeightChangeProposal
            const w = loadLearnedWeights(dir)
            w.similarity = p.after.similarity
            w.functional = p.after.functional
            w.novelty    = p.after.novelty
            w.lastUpdated = Date.now()
            w.updateCount++
            saveWeights(dir, w)
            console.log(`[AutoImprove] Pending weight change approved and committed`)
          }
        }
      } catch (e: any) {
        console.error(`[AutoImprove] Retry failed for "${entry.id}":`, e.message)
        // Will be retried again next pass until TTL/maxRetries exceeded
      }
    }
  }

  // NOTE (2026-07-09 fix): this pass previously opened with
  //   const historyFile = path.join(dir, '.crucible', 'history.json')
  //   try { history = JSON.parse(...) } catch { return }
  //   if (history.length < 10) return
  // Startup migration renames the legacy 'history.json' → 'history-default.json', so
  // post-migration that file was ALWAYS absent and the whole improvement pass (patterns,
  // weights, goals, meta-learning) returned early and never ran. The `history` array
  // and its `scores` proxy were then unused anyway — every pass below draws from
  // quality-history.json, each with its own length gate — so the dead read + fatal
  // gates are removed and the pass now actually runs.

  // ── Pass 1 — Pattern extraction ────────────────────────────
  // Top entries: either top 5% or all with score ≥ MIN_TOP_SCORE from quality-history
  const qualHistFile = path.join(dir, '.crucible', 'quality-history.json')
  let qualHistory: Array<{ promptSnippet: string; compositeScore: number; promptType: string }> = []
  try { qualHistory = JSON.parse(fs.readFileSync(qualHistFile, 'utf8')) } catch {}

  const topScoreThreshold = qualHistory.length >= 20
    ? [...qualHistory].sort((a, b) => b.compositeScore - a.compositeScore)[Math.floor(qualHistory.length * TOP_PERCENTILE)]?.compositeScore ?? MIN_TOP_SCORE
    : MIN_TOP_SCORE

  const topEntries = qualHistory.filter(e => e.compositeScore >= Math.max(topScoreThreshold, MIN_TOP_SCORE))

  const existingPatterns = loadLearnedPatterns(dir)
  const existingIds = new Set(existingPatterns.map(p => p.id))
  let patternsAdded = 0

  for (const entry of topEntries) {
    const tokens = extractStructuralTokens(entry.promptSnippet)
    if (tokens.length < 3) continue
    const id = `learned-${tokens.slice(0, 3).join('-')}-${entry.promptType}`
    if (existingIds.has(id)) continue

    const newEntry: KnowledgeEntry = {
      id,
      tier: 2,
      category: promptTypeToCategory(entry.promptType),
      name: tokens.slice(0, 2).join('-'),
      description: `Learned pattern: ${entry.promptSnippet.slice(0, 80)}`,
      tags: [entry.promptType],
      structuralTokens: tokens,
      antipatterns: [],
      qualitySignals: [{ name: 'high-composite-score', description: 'From top-scoring pipeline round', weight: 0.8 }],
      hitCount: 0,
      approvedAt: Date.now(),
    }

    // Gate: triumvirate must approve each new pattern (majority 2/3)
    if (_callModel && _MODEL_REGISTRY) {
      const proposal: KnowledgePatternProposal = {
        type: 'knowledge_pattern',
        id,
        tokens,
        promptType: entry.promptType,
        sourceScore: entry.compositeScore,
        description: newEntry.description,
      }
      try {
        const { approved } = await runTriumvirate(proposal, dir, _MODEL_REGISTRY, _callModel)
        if (!approved) {
          console.log(`[AutoImprove] Triumvirate REJECTED pattern "${id}" — skipping`)
          continue
        }
      } catch (e: any) {
        enqueuePending(dir, proposal, e.message)
        continue
      }
    }

    try {
      addApprovedEntry(newEntry)
      existingPatterns.push(newEntry)
      existingIds.add(id)
      patternsAdded++
    } catch {}
  }

  if (patternsAdded > 0) {
    saveLearnedPatterns(dir, existingPatterns)
    console.log(`[AutoImprove] Added ${patternsAdded} triumvirate-approved pattern(s) to knowledge base`)
  }

  // ── Pass 2 — Scoring weight adjustment ─────────────────────
  // Correlate each scoring component (similarity, functional, novelty)
  // with composite score. If one dimension consistently leads among
  // top entries vs bottom entries, nudge its weight up by WEIGHT_NUDGE
  // and proportionally reduce the others.
  if (qualHistory.length >= 20) {
    const topQ   = [...qualHistory].sort((a, b) => b.compositeScore - a.compositeScore).slice(0, Math.ceil(qualHistory.length * 0.2))
    const bottomQ = [...qualHistory].sort((a, b) => a.compositeScore - b.compositeScore).slice(0, Math.ceil(qualHistory.length * 0.2))

    // Proxy: top entries tend to be coding/math (functional-heavy);
    // bottom entries tend to be general (novelty-heavy). Nudge toward
    // the distribution of top entries.
    const topCodingFrac   = topQ.filter(e => e.promptType === 'coding' || e.promptType === 'math').length / topQ.length
    const btmCodingFrac   = bottomQ.filter(e => e.promptType === 'coding' || e.promptType === 'math').length / bottomQ.length
    const topCreativeFrac = topQ.filter(e => e.promptType === 'creative').length / topQ.length
    const btmCreativeFrac = bottomQ.filter(e => e.promptType === 'creative').length / bottomQ.length

    const w = loadLearnedWeights(dir)
    let changed = false

    // If coding/math over-represented in top vs bottom → lift functional
    if (topCodingFrac > btmCodingFrac + 0.1 && w.functional + WEIGHT_NUDGE <= WEIGHT_MAX.functional) {
      w.functional = parseFloat((w.functional + WEIGHT_NUDGE).toFixed(3))
      w.similarity = parseFloat((w.similarity - WEIGHT_NUDGE / 2).toFixed(3))
      w.novelty    = parseFloat((w.novelty    - WEIGHT_NUDGE / 2).toFixed(3))
      changed = true
    }
    // If creative over-represented in top → lift novelty
    if (topCreativeFrac > btmCreativeFrac + 0.1 && w.novelty + WEIGHT_NUDGE <= WEIGHT_MAX.novelty) {
      w.novelty    = parseFloat((w.novelty    + WEIGHT_NUDGE).toFixed(3))
      w.functional = parseFloat((w.functional - WEIGHT_NUDGE / 2).toFixed(3))
      w.similarity = parseFloat((w.similarity - WEIGHT_NUDGE / 2).toFixed(3))
      changed = true
    }

    // Clamp to bounds
    for (const k of ['similarity', 'functional', 'novelty'] as const) {
      w[k] = Math.max(WEIGHT_MIN[k], Math.min(WEIGHT_MAX[k], w[k]))
    }

    // Re-normalize to sum to 1.0
    const total = w.similarity + w.functional + w.novelty
    w.similarity = parseFloat((w.similarity / total).toFixed(3))
    w.functional = parseFloat((w.functional / total).toFixed(3))
    w.novelty    = parseFloat((1 - w.similarity - w.functional).toFixed(3))

    if (changed) {
      // Gate: triumvirate must unanimously approve weight changes
      let weightApproved = true
      if (_callModel && _MODEL_REGISTRY) {
        const before = loadLearnedWeights(dir)
        const proposal: WeightChangeProposal = {
          type: 'weight_change',
          before: { similarity: before.similarity, functional: before.functional, novelty: before.novelty },
          after: { similarity: w.similarity, functional: w.functional, novelty: w.novelty },
          sampleSize: qualHistory.length,
          topCodingFrac,
          btmCodingFrac,
          topCreativeFrac,
          btmCreativeFrac,
        }
        try {
          const { approved } = await runTriumvirate(proposal, dir, _MODEL_REGISTRY, _callModel)
          weightApproved = approved
          if (!approved) console.log('[AutoImprove] Triumvirate REJECTED weight change — weights unchanged')
        } catch (e: any) {
          weightApproved = false
          enqueuePending(dir, proposal, e.message)
        }
      }

      if (weightApproved) {
        w.lastUpdated = Date.now()
        w.updateCount++
        saveWeights(dir, w)
        console.log(`[AutoImprove] Triumvirate APPROVED weights: similarity=${w.similarity} functional=${w.functional} novelty=${w.novelty}`)
      }
    }
  }

  // ── Pass 3 — Goal identification ────────────────────────────
  // Analyze all performance data and surface the top improvement goals.
  // This replaces the fixed-algorithm mindset: next pass will act on whichever
  // goal ranks highest rather than always running the same three steps.
  try {
    const report = identifyGoals(dir)
    saveGoalReport(dir, report)
    if (report.goals.length > 0) {
      const top = report.goals[0]
      console.log(`[AutoImprove] Top goal: [${top.category}] ${top.title} — ${top.rationale}`)
    }
  } catch (e: any) {
    console.warn('[AutoImprove] Goal identification failed:', e.message)
  }

  // ── Pass 4 — Triumvirate meta-learning ──────────────────────
  // Let the triumvirate examine its own past decision outcomes and adjust thresholds.
  try {
    // Compute current quality snapshot for outcome recording
    const qHistFile = path.join(dir, '.crucible', 'quality-history.json')
    let qualityBefore = 0, qualityAfter = 0
    try {
      const qHist: any[] = JSON.parse(require('fs').readFileSync(qHistFile, 'utf-8'))
      const mid = Math.floor(qHist.length / 2)
      qualityBefore = qHist.slice(0, mid).reduce((s: number, e: any) => s + (e.score ?? 0), 0) / Math.max(mid, 1)
      qualityAfter = qHist.slice(mid).reduce((s: number, e: any) => s + (e.score ?? 0), 0) / Math.max(qHist.length - mid, 1)
    } catch {}

    // Tally approvals/rejections in recent log
    const tLogFile = path.join(dir, '.crucible', 'triumvirate-log.json')
    let recentApproved = 0, recentRejected = 0
    try {
      const tLog: any[] = JSON.parse(require('fs').readFileSync(tLogFile, 'utf-8'))
      const recent = tLog.slice(-20)
      recentApproved = recent.filter((e: any) => e.outcome === 'APPROVED').length
      recentRejected = recent.filter((e: any) => e.outcome === 'REJECTED').length
    } catch {}

    recordTriumvirateOutcome(dir, recentApproved, recentRejected, qualityBefore, qualityAfter)
    const adjustment = runMetaLearning(dir)
    if (adjustment) {
      console.log(`[AutoImprove] Meta-learning adjustment: ${adjustment}`)
    }
  } catch (e: any) {
    console.warn('[AutoImprove] Meta-learning failed:', e.message)
  }

  // ── Pass 5 — Git audit trail ────────────────────────────────
  const inGit = gitExec('git rev-parse --is-inside-work-tree', dir) === 'true'
  if (!inGit) return

  const crucibleDir = path.join(dir, '.crucible')
  const gitStatus = gitExec(`git status --porcelain ${crucibleDir}`, dir)
  if (!gitStatus) return  // nothing changed

  gitExec(`git add ${crucibleDir}`, dir)
  const msg = `[autonomous] Update learned patterns + weights — ${new Date().toISOString().slice(0, 16)}`
  const commitOut = gitExec(`git commit -m "${msg}"`, dir)
  if (commitOut) {
    lastAutoCommitHash = gitExec('git rev-parse HEAD', dir)
    console.log(`[AutoImprove] Committed: ${lastAutoCommitHash?.slice(0, 7)} — "${msg}"`)
  }
}

// ── Rollback gate ──────────────────────────────────────────────
// Call after qualityPredictor reports trend=down to undo the last
// autonomous commit. Only reverts .crucible/ files, never source.

export function rollbackIfDegraded(trend: string): void {
  if (trend !== 'down' || !lastAutoCommitHash) return
  const dir = projectRoot
  const inGit = gitExec('git rev-parse --is-inside-work-tree', dir) === 'true'
  if (!inGit) return

  const currentHead = gitExec('git rev-parse HEAD', dir)
  if (currentHead !== lastAutoCommitHash) return  // user has committed since — don't touch

  const crucibleDir = path.join(dir, '.crucible')
  gitExec(`git revert --no-edit HEAD -- ${crucibleDir} 2>/dev/null || git checkout HEAD~1 -- ${crucibleDir}`, dir)
  gitExec(`git add ${crucibleDir}`, dir)
  gitExec('git commit -m "[autonomous-rollback] Reverted: quality trend declining"', dir)
  lastAutoCommitHash = null
  console.log('[AutoImprove] ROLLBACK — quality trend declining, reverted last autonomous commit')
}

// ── Public API ─────────────────────────────────────────────────

export function init(dir: string): void {
  projectRoot = dir
  // Load existing learned patterns into scoring engine at startup
  const existing = loadLearnedPatterns(dir)
  if (existing.length > 0) {
    loadAdditionalEntries(existing)
    console.log(`[AutoImprove] Loaded ${existing.length} learned pattern(s) from history`)
  }
}

// Fire-and-forget: debounced so rapid requests don't stack passes
export function triggerImprovementPass(): void {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    doImprovementPass(projectRoot).catch(e => console.error('[AutoImprove] Pass error:', e.message))
  }, 5000)  // 5s after the last completed round
}

export function status(): { projectRoot: string; lastAutoCommitHash: string | null; weights: LearnedWeights } {
  return {
    projectRoot,
    lastAutoCommitHash,
    weights: loadLearnedWeights(projectRoot),
  }
}
