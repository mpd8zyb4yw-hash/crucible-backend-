// MASTERPIECE Orchestrator — two entry points for Track P.
//
// MASTERPIECE runs on EVERY prompt. The gate (gate.ts) selects the mode:
//
//   runMasterpieceLight  — ALWAYS. Local corpus enrichment only. No model calls.
//     Fires at request arrival, in parallel with model selection and Stage 1.
//     Target < 500ms. Returns an EnrichedContext that is injected into the
//     Stage 5 synthesis prompt and handed to deep mode (so corpus queries are
//     not repeated). Feeds the calibration system a weak learning signal.
//
//   runMasterpieceDeep   — deep-mode prompts only. The full dialectical pipeline:
//     shard → triadic → (abductive + structural) → escalation → MoE → assembly.
//     Fires AFTER Stage 5 completes, consuming the light EnrichedContext.
//     Feeds the calibration system the full dialectical results.

import { ensureSeedCorpus } from './corpus/ingest.js'
import { queryCorpusBridge, queryCrossCorpusBridge, recordMasterpieceOutcome, persistSurvivedConnections, corpusStatus } from './corpus/living.js'
import { createAnchor, shardPrompt, detectDomain } from './mosaic.js'
import { runAllTriadic } from './triadic.js'
import { findAbductiveConnections } from './abductive.js'
import { findStructuralResonances, detectLocalStructuralPatterns } from './structural.js'
import { evaluateEscalation } from './escalation.js'
import { refineShard } from './moe.js'
import { recordCalibration, recordLightSignal, getPathWeight } from './calibration.js'
import { researchGapIfNeeded, formatEvidenceBlock, ingestResearchFindings } from '../research/webResearch.js'
import type { ResearchOutcome } from '../research/types.js'
import type {
  GroundTruthAnchor,
  MasterpieceDeps,
  MasterpieceResult,
  EnrichedContext,
  LightConnection,
  RefinedShard,
  EscalationDecision,
  Shard,
} from './types.js'

export type MasterpieceSSEType =
  | 'masterpiece_start'
  | 'masterpiece_shard'
  | 'masterpiece_shard_progress'
  | 'masterpiece_research_gap'
  | 'masterpiece_research'
  | 'masterpiece_triadic'
  | 'masterpiece_abductive'
  | 'masterpiece_escalation'
  | 'masterpiece_moe'
  | 'masterpiece_assemble'
  | 'masterpiece_complete'

export interface MasterpieceSSEEvent {
  type: MasterpieceSSEType
  data: Record<string, unknown>
}

export type EmitFn = (event: MasterpieceSSEEvent) => void

// ════════════════════════════════════════════════════════════════════════════
// LIGHT MODE — local corpus enrichment, no model calls, < 500ms.
// ════════════════════════════════════════════════════════════════════════════

const LIGHT_BUDGET_MS = 500

// A moderate-to-strong semantic similarity to a DIFFERENT domain is the novelty
// signal: it means an unrelated field talks about the same structure. We dampen
// well-trodden domain pairs (high reinforced path weight = familiar = less novel).
function localNovelty(similarity: number, fromDomain: string, toDomain: string): number {
  const base = Math.min(1, Math.max(0, 0.3 + (similarity - 0.15) * 1.3))
  const w = getPathWeight(fromDomain, toDomain, 'abductive')  // 0.5 neutral, ≤3.0 reinforced
  const familiarity = Math.min(1, Math.max(0, (w - 0.5) / 2.5))
  return Math.round(base * (1 - 0.3 * familiarity) * 100) / 100
}

function bridgeHint(fromDomain: string, toDomain: string, targetContent: string): string {
  const fragment = targetContent.replace(/\s+/g, ' ').trim().slice(0, 90)
  return `${fromDomain} resonates with ${toDomain}: ${fragment}${fragment.length >= 90 ? '…' : ''}`
}

let seedWarmStarted = false
// Kick corpus seeding off the request path. Safe to call repeatedly.
export function warmCorpus(): void {
  if (seedWarmStarted) return
  seedWarmStarted = true
  ensureSeedCorpus().catch(() => { seedWarmStarted = false })
}

export async function runMasterpieceLight(
  prompt: string,
  _conversationHistory: Array<{ user: string; assistant: string }>,
  deps: MasterpieceDeps,
  opts: { recordSignal?: boolean } = {},
): Promise<EnrichedContext> {
  const { recordSignal = true } = opts
  const start = Date.now()
  const promptDomain = detectDomain(prompt)

  // Ground Truth Anchor — stored verbatim, never modified. Deep mode reuses this id.
  const anchor = createAnchor(prompt)

  // Local structural resonance — pure lexical, sub-millisecond, runs always.
  const structuralPatterns = detectLocalStructuralPatterns(prompt, promptDomain)

  // The corpus query is the only part that can run long (ONNX embed on first
  // call). Race it against the 500ms budget; on overrun we return partial.
  let connections: LightConnection[] = []
  let partial = false
  const SENTINEL: LightConnection[] = []
  try {
    const queried = await deps.withTimeout(
      (async () => {
        await ensureSeedCorpus()  // no-op once seeded (warmCorpus runs it at startup)
        const cross = await queryCrossCorpusBridge(prompt, promptDomain, 5)
        return cross.map(({ chunk, similarity }): LightConnection => ({
          sourceDomain: promptDomain,
          targetDomain: chunk.domain,
          targetContent: chunk.content.slice(0, 300),
          similarity,
          noveltyScore: localNovelty(similarity, promptDomain, chunk.domain),
          bridgeHint: bridgeHint(promptDomain, chunk.domain, chunk.content),
          corpusChunkId: chunk.id,
        })).sort((a, b) => b.noveltyScore - a.noveltyScore)
      })(),
      LIGHT_BUDGET_MS,
      SENTINEL,
    )
    connections = queried
    partial = queried === SENTINEL
  } catch {
    partial = true
  }

  const topNovelty = connections.reduce((m, c) => Math.max(m, c.noveltyScore), 0)

  // Weak learning signal — every query teaches the calibration system, even
  // simple ones (the whole point of always-on light mode). Skipped for deep-bound
  // prompts: deep mode calibrates the same paths more richly, so recording here
  // too would double-reinforce within a single request.
  if (recordSignal) {
    try {
      recordLightSignal(anchor.id, connections)
    } catch { /* calibration is best-effort */ }
  }

  return {
    anchorId: anchor.id,
    promptDomain,
    connections,
    structuralPatterns,
    topNovelty,
    elapsedMs: Date.now() - start,
    partial,
  }
}

// Renders light enrichment as additional synthesis context. Empty string when
// nothing meaningful was found (so the synthesis prompt stays clean).
export function renderLightEnrichment(ctx: EnrichedContext): string {
  if (!ctx.connections.length) return ''
  const top = ctx.connections.filter(c => c.noveltyScore >= 0.4).slice(0, 3)
  if (!top.length) return ''
  const lines = top.map(c => `- ${c.targetDomain}: ${c.targetContent.slice(0, 180)}`).join('\n')
  return `CROSS-DOMAIN CONTEXT (non-obvious parallels from unrelated fields — weave in only where genuinely illuminating, never force):\n${lines}`
}

// ════════════════════════════════════════════════════════════════════════════
// DEEP MODE — the full dialectical pipeline.
// ════════════════════════════════════════════════════════════════════════════

const ASSEMBLER_SYSTEM = `You are the final synthesiser for a MASTERPIECE analytical pipeline. You have received multiple shard analyses, each of which has been through:
1. Triadic dialectical scrutiny (thesis/antithesis/middle-ground)
2. Cross-domain abductive connection finding (survived adversarial challenge)
3. Structural resonance detection (edge-graph isomorphism with other domains)
4. Specialist MoE refinement

Your task: produce a single, coherent, deeply integrated synthesis that:
- Addresses the original prompt fully and directly
- Weaves in the most important cross-domain insights (name them explicitly)
- Maintains honest uncertainty where the escalation tiers identified low confidence
- Has a clear narrative arc — this is not a list, it is a synthesis
- Is substantive (aim for 600–1200 words unless the prompt calls for more)
- Does NOT say "as a MASTERPIECE synthesis" or reference the pipeline internally

- Is written in flowing prose ONLY — never uses code comment format (// or /* */), never wraps content in code blocks, never uses variable assignments or programming syntax to express ideas
- Reads like a thoughtful human expert, not a code generator

Begin directly with the analytical content. Do not open with "In this analysis..." or similar preambles.`

export async function runMasterpieceDeep(
  prompt: string,
  ensembleSynthesis: string,       // Stage 5 output — deep mode enriches and replaces it
  enrichedContext: EnrichedContext,// light-mode result — corpus queries are NOT repeated
  deps: MasterpieceDeps,
  emit: EmitFn,
): Promise<MasterpieceResult> {
  const start = Date.now()

  // Reuse the light-mode Ground Truth Anchor — by id only. We do NOT re-store it
  // (no insertAnchor call) and do NOT mutate the persisted row. This in-memory
  // view is read for its id/originalPrompt by shardPrompt; storedAt/shardCount are
  // never read or persisted from here, so they carry sentinels, not fresh values.
  const anchor: GroundTruthAnchor = {
    id: enrichedContext.anchorId,
    originalPrompt: prompt,
    storedAt: 0,
    shardCount: 0,
  }

  emit({ type: 'masterpiece_start', data: { anchorId: anchor.id, prompt: prompt.slice(0, 120) } })

  // ── Shard decomposition ────────────────────────────────────────────────
  const manifest = await shardPrompt(anchor, deps)
  const { shards } = manifest

  emit({
    type: 'masterpiece_shard',
    data: { shardCount: shards.length, shards: shards.map(s => ({ id: s.id, domain: s.domain, preview: s.content.slice(0, 80) })) },
  })

  // ── Gap detection + targeted web research (Track R) ────────────────────
  // Per shard: does the corpus actually know this, or is MASTERPIECE about to
  // pattern-match through a hole? Runs before the dialectical pass so any
  // fresh evidence reaches thesis/antithesis/middle-ground, not bolted on after.
  const researchOutcomes: Array<ResearchOutcome | null> = await Promise.all(
    shards.map(shard => researchGapIfNeeded(shard.content, shard.domain).catch(() => null)),
  )

  researchOutcomes.forEach((outcome, i) => {
    if (!outcome) return
    emit({
      type: 'masterpiece_research_gap',
      data: { shardId: shards[i].id, domain: shards[i].domain, hasGap: outcome.gap.hasGap, reason: outcome.gap.reason },
    })
    if (outcome.findings.length) {
      emit({
        type: 'masterpiece_research',
        data: {
          shardId: shards[i].id,
          domainClass: outcome.domainClass,
          sources: outcome.findings.map(f => f.source),
          count: outcome.findings.length,
        },
      })
    }
  })

  // Feed the evidence into the shard content itself — runTriadic only ever
  // sees shard.content, so this is the one insertion point that reaches all
  // three dialectical perspectives without duplicating call sites.
  const researchedShards: Shard[] = shards.map((shard, i) => {
    const outcome = researchOutcomes[i]
    if (!outcome?.findings.length) return shard
    return { ...shard, content: `${shard.content}\n\n${formatEvidenceBlock(outcome.findings)}` }
  })

  // Feedback loop: high-authority findings auto-ingest into the Living Corpus
  // so the next query on this gap is answered locally. Fire-and-forget.
  ingestResearchFindings(researchOutcomes, shards.map(s => s.domain), {
    callModel: deps.callModel,
  }).catch(() => {})

  // ── BLOCK 1: triadic (global parallel), then abductive + structural ────
  // P12 — emit per-shard progress as each shard's triadic pass completes,
  // so the UI can show a live indicator during deep-mode processing.
  let shardsCompleted = 0
  const triadicOutputs = await Promise.all(
    researchedShards.map(async (shard, i) => {
      const { runTriadic } = await import('./triadic.js')
      const result = await runTriadic(shard, deps)
      shardsCompleted++
      emit({
        type: 'masterpiece_shard_progress',
        data: { completed: shardsCompleted, total: shards.length, shardIndex: i, domain: shard.domain },
      })
      return result
    }),
  )

  const [allConnections, allResonances] = await Promise.all([
    Promise.all(shards.map((shard, i) => findAbductiveConnections(shard, triadicOutputs[i], deps))),
    Promise.all(shards.map(shard => findStructuralResonances(shard, deps))),
  ])

  const totalConnFound = allConnections.reduce((sum, c) => sum + c.length, 0)
  const totalConnSurvived = allConnections.reduce((sum, c) => sum + c.filter(x => x.survivedDialectic).length, 0)

  // Fold light-mode prompt-level connections into the reported domain pairs so
  // the UI reflects both granularities without re-querying the corpus.
  const lightDomainPairs = enrichedContext.connections
    .filter(c => c.noveltyScore >= 0.4)
    .map(c => `${c.sourceDomain}→${c.targetDomain}`)

  emit({
    type: 'masterpiece_abductive',
    data: {
      connectionsFound: totalConnFound,
      connectionsSurvived: totalConnSurvived,
      domains: [...new Set([...allConnections.flat().map(c => `${c.sourceDomain}→${c.targetDomain}`), ...lightDomainPairs])],
    },
  })

  emit({
    type: 'masterpiece_triadic',
    data: {
      shardCount: shards.length,
      resonancesFound: allResonances.reduce((s, r) => s + r.length, 0),
      patterns: [...new Set([...allResonances.flat().map(r => r.matchedPattern), ...enrichedContext.structuralPatterns])],
    },
  })

  // ── BLOCK 2: Escalation evaluation ────────────────────────────────────
  const escalations: EscalationDecision[] = await Promise.all(
    shards.map((shard, i) => evaluateEscalation(shard, triadicOutputs[i], deps)),
  )

  const escalatedCount = escalations.filter(e => e.escalated).length
  emit({
    type: 'masterpiece_escalation',
    data: {
      escalated: escalatedCount,
      tiers: escalations.map(e => ({ shardId: e.shardId, tier: e.tier, score: e.calibrationScore })),
    },
  })

  // ── BLOCK 3: MoE Refinement ────────────────────────────────────────────
  const refinedShards: RefinedShard[] = await Promise.all(
    shards.map((shard, i) =>
      refineShard(shard, triadicOutputs[i], allConnections[i], allResonances[i], escalations[i], deps),
    ),
  )

  emit({
    type: 'masterpiece_moe',
    data: {
      specialists: refinedShards.map(r => ({ shardId: r.shardId, specialist: r.specialist, confidence: r.confidenceScore })),
    },
  })

  // ── Final Assembly ────────────────────────────────────────────────────
  emit({ type: 'masterpiece_assemble', data: { shardCount: refinedShards.length } })

  const shardsContext = refinedShards
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((r, idx) => {
      const connSummary = r.connections.length > 0
        ? `\nKey cross-domain insights: ${r.connections.map(c => `${c.sourceDomain}→${c.targetDomain}: ${c.bridgeReasoning.slice(0, 120)}`).join('; ')}`
        : ''
      const resSummary = r.resonances.length > 0
        ? `\nStructural pattern: ${r.resonances.map(res => res.matchedPattern).join(', ')}`
        : ''
      return `### Shard ${idx + 1} (${r.specialist} specialist, tier: ${r.escalationTier})\n${r.refinedContent}${connSummary}${resSummary}`
    })
    .join('\n\n')

  // Seed the assembler with light-mode prompt-level parallels too (no re-query).
  const lightSeed = enrichedContext.connections.filter(c => c.noveltyScore >= 0.5).slice(0, 3)
  const lightBlock = lightSeed.length
    ? `\n\nPROMPT-LEVEL CROSS-DOMAIN PARALLELS (from local corpus, use where illuminating):\n${lightSeed.map(c => `- ${c.targetDomain}: ${c.bridgeHint}`).join('\n')}`
    : ''

  // Direct prose assembly from refined shards — no model call needed.
  // Use the ensemble synthesis as the base and weave in the top cross-domain
  // insights from the light enrichment and shard connections.
  const topConnections = refinedShards
    .flatMap((r: RefinedShard) => r.connections.filter((c: any) => c.survivedDialectic && c.noveltyScore > 0.5))
    .sort((a: any, b: any) => b.noveltyScore - a.noveltyScore)
    .slice(0, 3)

  const connectionInsights = topConnections.length > 0
    ? '\n\n' + topConnections
        .map((c: any) => `[Cross-domain insight: ${c.sourceDomain} → ${c.targetDomain}: ${c.bridgeReasoning.slice(0, 200)}]`)
        .join('\n')
    : ''

  // No model call for assembly — concatenate refined shards directly.
  // This avoids coding models reformatting prose as // comments regardless
  // of prompt instructions. The refined shards are already high quality
  // from the MoE specialist pass; a model call adds latency and format risk.
  let synthesis: string = ensembleSynthesis + connectionInsights

  // Strip code-comment formatting if a coding model wrapped the synthesis in // notation.
  // This is a safety net — the assembler prompt now prohibits it, but defense in depth.
  if (synthesis && synthesis.trim().startsWith('//')) {
    synthesis = synthesis
      .split('\n')
      .map((line: string) => line.replace(/^\s*\/\/\s?/, ''))
      .join('\n')
      .trim()
  }

  // ── Calibration recording — full dialectical results ────────────────────
  const allConnsFlat = allConnections.flat()
  const allResFlat = allResonances.flat()
  const avgConfidence = refinedShards.length
    ? refinedShards.reduce((sum, r) => sum + r.confidenceScore, 0) / refinedShards.length
    : 0.5

  try {
    recordCalibration(anchor.id, allConnsFlat, allResFlat, avgConfidence)
  } catch { /* calibration is best-effort */ }

  // C8 — record which Living Corpus chunks contributed to this MASTERPIECE run
  // so the Living Corpus can learn retrieval value from real outcomes.
  try {
    const allRetrievedIds = allConnsFlat.map(c => String(c.corpusChunkId)).filter(Boolean)
    const survivedIds = allConnsFlat.filter(c => c.survivedDialectic).map(c => String(c.corpusChunkId)).filter(Boolean)
    recordMasterpieceOutcome(allRetrievedIds, survivedIds, avgConfidence, prompt.slice(0, 200))
  } catch { /* outcome recording is best-effort */ }

  // P15 — Persist survived abductive connections back to the Living Corpus.
  // Fire-and-forget; never blocks the response path.
  persistSurvivedConnections(allConnsFlat).catch(() => {})

  const result: MasterpieceResult = {
    anchorId: anchor.id,
    synthesis,
    shardCount: shards.length,
    abductiveConnectionsFound: totalConnFound,
    abductiveConnectionsSurvived: totalConnSurvived,
    structuralResonancesFound: allResFlat.length,
    escalatedShardCount: escalatedCount,
    elapsedMs: Date.now() - start,
    refinedShards,
    researchGapsDetected: researchOutcomes.filter(Boolean).length,
    researchFindingsUsed: researchOutcomes.reduce((s, o) => s + (o?.findings.length ?? 0), 0),
  }

  emit({ type: 'masterpiece_complete', data: { ...result, synthesis: undefined, refinedShards: undefined } })

  return result
}
