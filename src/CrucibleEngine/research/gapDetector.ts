// Track R — Intelligent Web Research + Gap Detection · gap detector
// Answers, per query/shard: "does the corpus actually know this, or am I
// about to pattern-match my way through a hole?" Built entirely on Living
// Corpus signal that already exists (C3): retrieval hits + similarity from
// query.ts, and the per-domain coverage_gaps priority score from lifecycle.ts
// auditGaps(). This module adds no new storage — it reads the same staleness/
// retrieval-hit-rate/confidence-per-domain signal the corpus already tracks
// and turns it into a live, per-query yes/no.

import { queryLivingCorpus } from '../corpus/query.js'
import { getCoverageGaps } from '../corpus/db.js'
import { isTimeDependent } from '../webGrounding.js'
import type { GapSignal } from './types.js'

const MIN_HITS = 2
const MIN_AVG_SIMILARITY = 0.22
const GAP_PRIORITY_THRESHOLD = 0.5

export async function detectGap(query: string, domain: string): Promise<GapSignal> {
  const isTimeSensitive = isTimeDependent(query)

  let corpusHits = 0
  let avgSimilarity = 0
  try {
    const hits = await queryLivingCorpus(query, { topK: 5, minSimilarity: 0.1 })
    corpusHits = hits.length
    avgSimilarity = hits.length ? hits.reduce((s, h) => s + h.similarity, 0) / hits.length : 0
  } catch {
    // Corpus not ready / query failed — treat as a full gap, not a false "covered".
  }

  let domainPriority = 0
  try {
    const gap = getCoverageGaps().find(g => g.domain === domain)
    domainPriority = gap?.priority_score ?? 0
  } catch { /* best-effort */ }

  const sparse = corpusHits < MIN_HITS || avgSimilarity < MIN_AVG_SIMILARITY
  const flaggedDomain = domainPriority > GAP_PRIORITY_THRESHOLD
  const hasGap = isTimeSensitive || sparse || flaggedDomain

  const reason = isTimeSensitive
    ? 'query is time-sensitive — the corpus cannot contain live information'
    : sparse
      ? `sparse local coverage — ${corpusHits} corpus hits, avg similarity ${avgSimilarity.toFixed(2)}`
      : flaggedDomain
        ? `domain "${domain}" is a known coverage gap (priority ${domainPriority.toFixed(2)})`
        : 'sufficient local coverage — no research triggered'

  return { domain, hasGap, reason, corpusHits, avgSimilarity, isTimeSensitive, domainPriority }
}
