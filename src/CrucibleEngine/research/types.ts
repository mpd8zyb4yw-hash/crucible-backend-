// Track R — Intelligent Web Research + Gap Detection · shared types

export interface ResearchFinding {
  content: string        // extracted text (title/snippet/abstract), already trimmed
  source: string          // fetcher label, e.g. 'arXiv', 'HackerNews', 'StackOverflow'
  url: string
  authorityScore: number  // 0..1, source-appropriate trust weight
  publishedAt?: number    // epoch ms, when the source exposes a real date
}

export type ResearchDomainClass = 'academic' | 'current-events' | 'technical' | 'curated'

export interface GapSignal {
  domain: string
  hasGap: boolean
  reason: string
  corpusHits: number
  avgSimilarity: number
  isTimeSensitive: boolean
  domainPriority: number   // from Living Corpus coverage_gaps.priority_score, 0 if not flagged
}

export interface ResearchOutcome {
  gap: GapSignal
  domainClass: ResearchDomainClass
  findings: ResearchFinding[]
}
