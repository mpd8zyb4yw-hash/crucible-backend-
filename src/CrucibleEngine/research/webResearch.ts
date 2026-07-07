// Track R — Intelligent Web Research + Gap Detection · orchestrator
// Ties the gap detector to the source selector: only fetch when the corpus
// actually has a hole, then only from the sources appropriate to what kind of
// hole it is. Findings are returned pre-formatted with recency + authority so
// they can be handed straight to the triadic dialectical pass as evidence.

import { detectGap } from './gapDetector.js'
import { classifyResearchDomain, selectSources, SOURCE_FETCHERS } from './selector.js'
import { ingestDocument, type IngestDeps } from '../corpus/ingest.js'
import type { StalenessClass } from '../corpus/db.js'
import type { ResearchFinding, ResearchOutcome } from './types.js'

const RESEARCH_TIMEOUT_MS = 6000
const MAX_FINDINGS = 4
const MIN_INGEST_AUTHORITY = 0.6

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then(v => { clearTimeout(t); resolve(v) }).catch(() => { clearTimeout(t); resolve(fallback) })
  })
}

// Gap-gated research: only fetches the web when the corpus genuinely doesn't
// know. This is the "MASTERPIECE flags mid-reasoning" path — called per shard.
export async function researchGapIfNeeded(text: string, domain: string): Promise<ResearchOutcome | null> {
  const gap = await detectGap(text, domain)
  if (!gap.hasGap) return null

  const domainClass = classifyResearchDomain(text)
  const sourceNames = selectSources(domainClass)
  const query = text.slice(0, 200).replace(/\s+/g, ' ').trim()

  const results = await Promise.all(
    sourceNames.map(name => withTimeout(SOURCE_FETCHERS[name](query), RESEARCH_TIMEOUT_MS, [] as ResearchFinding[])),
  )

  const findings = results
    .flat()
    .sort((a, b) => b.authorityScore - a.authorityScore)
    .slice(0, MAX_FINDINGS)

  return { gap, domainClass, findings }
}

// Ungated research for direct tool use (agent explicitly asked for it — no
// corpus-gap check needed, the caller already decided it wants live sources).
export async function researchTopic(query: string): Promise<ResearchFinding[]> {
  const domainClass = classifyResearchDomain(query)
  const sourceNames = selectSources(domainClass)
  const trimmed = query.slice(0, 200).replace(/\s+/g, ' ').trim()
  const results = await Promise.all(
    sourceNames.map(name => withTimeout(SOURCE_FETCHERS[name](trimmed), RESEARCH_TIMEOUT_MS, [] as ResearchFinding[])),
  )
  return results.flat().sort((a, b) => b.authorityScore - a.authorityScore).slice(0, MAX_FINDINGS)
}

// Formats findings as an evidence block for the triadic pass — each line
// carries source, authority, and recency, so thesis/antithesis/middle-ground
// can weigh them rather than treat them as unattributed fact.
export function formatEvidenceBlock(findings: ResearchFinding[]): string {
  if (!findings.length) return ''
  const now = Date.now()
  const lines = findings.map(f => {
    const recency = describeRecency(f.publishedAt, now)
    return `- [${f.source} · authority ${f.authorityScore.toFixed(2)} · ${recency}] ${f.content} (${f.url})`
  }).join('\n')
  return `[LIVE WEB RESEARCH — fetched just now because the local corpus had a gap]\n${lines}\n\nWeigh higher-authority, fresher sources more heavily. Where this conflicts with training data, treat it as current ground truth.`
}

function describeRecency(publishedAt: number | undefined, now: number): string {
  if (publishedAt == null || Number.isNaN(publishedAt)) return 'recency unknown'
  const ageDays = Math.max(0, Math.round((now - publishedAt) / 86_400_000))
  if (ageDays <= 2) return 'today'
  if (ageDays <= 30) return `${ageDays}d old`
  if (ageDays <= 365) return `${Math.round(ageDays / 30)}mo old`
  return `${Math.round(ageDays / 365)}y old`
}

const DOMAIN_CLASS_TO_STALENESS: Record<string, StalenessClass> = {
  'academic': 'scientific',
  'current-events': 'current',
  'technical': 'technology',
  'curated': 'permanent',
}

// Feedback loop: high-authority findings auto-ingest into the Living Corpus so
// the next query on the same gap is answered locally instead of re-fetching.
// Fire-and-forget by design — never blocks the response path.
export async function ingestResearchFindings(
  outcomes: Array<ResearchOutcome | null>,
  domainByOutcome: string[],
  deps: IngestDeps = {},
): Promise<number> {
  let ingested = 0
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i]
    if (!outcome || !outcome.findings.length) continue
    const domain = domainByOutcome[i] ?? outcome.gap.domain
    const staleness = DOMAIN_CLASS_TO_STALENESS[outcome.domainClass] ?? 'current'
    for (const f of outcome.findings) {
      if (f.authorityScore < MIN_INGEST_AUTHORITY) continue
      try {
        const result = await ingestDocument({
          text: `${f.content}\n\nSource: ${f.url}`,
          domain,
          source: `webresearch:${f.source}:${f.url}`,
          sourceReliability: f.authorityScore,
          stalenessClass: staleness,
        }, deps, { relationshipBudget: 0 })
        ingested += result.ingested
      } catch { /* best-effort — a failed ingest never breaks research */ }
    }
  }
  return ingested
}
