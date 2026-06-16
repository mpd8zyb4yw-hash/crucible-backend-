// ============================================================
// CRUCIBLE — Debug Analyzer
// Pattern learning + causal chain analysis.
// Predicts likely error types from accumulated history.
// Persists learned patterns to .crucible/patterns.json
// ============================================================
/// <reference types="node" />

import fs from 'fs'
import path from 'path'
import { debugBus } from './bus'
import type { DebugEvent } from './bus'
import type { Language, ErrorType } from '../sandbox'

export interface ErrorPattern {
  language: Language
  errorType: ErrorType
  count: number
  lastSeen: number
  typicalStrategy: string | null
  autoFixRate: number // 0-1 fraction fixed without model
}

export interface CausalChain {
  requestId: string
  steps: Array<{ ts: number; label: string; outcome: 'ok' | 'fail' | 'fixed' | 'info' }>
  finalOutcome: 'success' | 'fail' | 'pending'
  totalMs: number
}

export interface Prediction {
  language: Language
  likelyErrors: Array<{ errorType: ErrorType; probability: number; suggestion: string }>
}

class DebugAnalyzer {
  private patterns = new Map<string, ErrorPattern>()
  private chains = new Map<string, CausalChain>()
  private patternFile: string | null = null

  constructor() {
    debugBus.subscribe(e => this.ingest(e))
  }

  init(projectPath: string): void {
    this.patternFile = path.join(projectPath, '.crucible', 'patterns.json')
    this.loadPatterns()
  }

  private key(lang: Language, type: ErrorType) { return `${lang}:${type}` }

  private ingest(event: DebugEvent): void {
    const rid = event.requestId
    if (rid) {
      if (!this.chains.has(rid)) {
        this.chains.set(rid, { requestId: rid, steps: [], finalOutcome: 'pending', totalMs: 0 })
        // Evict old chains (keep last 50)
        if (this.chains.size > 50) {
          const oldest = this.chains.keys().next().value
          if (oldest) this.chains.delete(oldest)
        }
      }
      const chain = this.chains.get(rid)!
      chain.steps.push({ ts: event.ts, label: this.labelFor(event), outcome: this.outcomeFor(event) })
    }

    // Update pattern stats
    if (event.type === 'error_detected') {
      const { language, errorType, fixStrategy } = event.data as { language: Language; errorType: ErrorType; fixStrategy: string | null }
      const k = this.key(language, errorType)
      const existing = this.patterns.get(k)
      if (existing) {
        existing.count++
        existing.lastSeen = event.ts
        if (fixStrategy) existing.typicalStrategy = fixStrategy
      } else {
        this.patterns.set(k, { language, errorType, count: 1, lastSeen: event.ts, typicalStrategy: fixStrategy, autoFixRate: 0 })
      }
    }

    if (event.type === 'fix_applied') {
      const { language, errorType, succeeded } = event.data as { language: Language; errorType: ErrorType; succeeded: boolean }
      const k = this.key(language, errorType)
      const p = this.patterns.get(k)
      if (p && succeeded) {
        // Exponential moving average toward 1
        p.autoFixRate = p.autoFixRate * 0.8 + 0.2
      } else if (p) {
        p.autoFixRate = p.autoFixRate * 0.8
      }
      this.persistPatterns()
    }

    if (event.type === 'verify_result' && rid) {
      const chain = this.chains.get(rid)
      if (chain) {
        chain.finalOutcome = (event.data.passed as boolean) ? 'success' : 'fail'
        if (chain.steps.length > 1) {
          chain.totalMs = chain.steps[chain.steps.length - 1].ts - chain.steps[0].ts
        }
      }
    }
  }

  private labelFor(e: DebugEvent): string {
    switch (e.type) {
      case 'model_call':    return `model:${e.data.model ?? '?'}`
      case 'model_result':  return `model done (${e.data.latencyMs ?? '?'}ms)`
      case 'execution_result': return `exec:${e.data.language} ${e.data.success ? 'ok' : 'FAIL'}`
      case 'error_detected':   return `error:${e.data.errorType} line ${e.data.errorLine ?? '?'}`
      case 'fix_applied':   return `fix:${e.data.strategy} → ${e.data.succeeded ? 'ok' : 'fail'}`
      case 'model_fix':     return `model-fix → ${e.data.succeeded ? 'ok' : 'fail'}`
      case 'verify_result': return `verify:${e.data.passed ? 'passed' : 'failed'}`
      case 'agent_iter':    return `iter ${e.data.iter}/${e.data.maxIters}`
      case 'tool_call':     return `tool:${e.data.tool}`
      default:              return e.type
    }
  }

  private outcomeFor(e: DebugEvent): CausalChain['steps'][0]['outcome'] {
    if (e.severity === 'error') return 'fail'
    if (e.severity === 'success') return 'fixed'
    if (e.type.includes('fail') || e.type.includes('error')) return 'fail'
    return 'info'
  }

  predict(language: Language): Prediction {
    const relevant: Array<{ errorType: ErrorType; probability: number; suggestion: string }> = []
    for (const [k, p] of this.patterns) {
      if (!k.startsWith(language)) continue
      const total = Array.from(this.patterns.values())
        .filter(x => x.language === language)
        .reduce((s, x) => s + x.count, 0) || 1
      const prob = Math.min(0.95, p.count / total)
      if (prob < 0.05) continue
      relevant.push({
        errorType: p.errorType,
        probability: prob,
        suggestion: this.suggestionFor(p),
      })
    }
    relevant.sort((a, b) => b.probability - a.probability)
    return { language, likelyErrors: relevant.slice(0, 5) }
  }

  private suggestionFor(p: ErrorPattern): string {
    if (p.typicalStrategy === 'close-bracket') return 'Check brackets/braces — common here'
    if (p.typicalStrategy === 'add-import') return `Missing import for '${p.errorType === 'IMPORT' ? 'module' : 'symbol'}'`
    if (p.typicalStrategy === 'fix-indentation') return 'Indentation inconsistency likely'
    if (p.autoFixRate > 0.7) return `Auto-fixable ${Math.round(p.autoFixRate * 100)}% of the time`
    return `${p.errorType} error — seen ${p.count}×`
  }

  getChain(requestId: string): CausalChain | null {
    return this.chains.get(requestId) ?? null
  }

  allPatterns(): ErrorPattern[] {
    return Array.from(this.patterns.values()).sort((a, b) => b.count - a.count)
  }

  private loadPatterns(): void {
    if (!this.patternFile) return
    try {
      const raw = fs.readFileSync(this.patternFile, 'utf-8')
      const arr: ErrorPattern[] = JSON.parse(raw)
      for (const p of arr) this.patterns.set(this.key(p.language, p.errorType), p)
    } catch { /* no file yet, fresh start */ }
  }

  private persistPatterns(): void {
    if (!this.patternFile) return
    try {
      const dir = path.dirname(this.patternFile)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.patternFile, JSON.stringify(this.allPatterns(), null, 2))
    } catch { /* non-fatal */ }
  }
}

export const debugAnalyzer = new DebugAnalyzer()
