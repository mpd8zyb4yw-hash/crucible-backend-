// Track R — Intelligent Web Research + Gap Detection · source selector
// Classifies a query into a domain class, then picks the ordered fetcher list
// appropriate for it. "Don't search 'machine learning', search 'DeepSeek R1
// reasoning architecture'" — the caller is responsible for passing a targeted
// query; this module only decides WHICH trustworthy sources to hit.

import type { ResearchDomainClass } from './types.js'
import type { Fetcher } from './sources.js'
import { fetchArxiv, fetchHackerNews, fetchStackExchange, fetchGithub, fetchWikipedia, fetchDdgWeb } from './sources.js'

const CURRENT_EVENTS_RE = /\b(latest|current|today|breaking|this (week|month|year)|announced|released|news|price of|who is (the )?(current|new|acting)|as of \d{4})\b/i
const ACADEMIC_RE = /\b(paper|arxiv|preprint|research|study|theorem|proof|benchmark|dataset|architecture|reasoning model|neural network|hypothesis)\b/i
const TECHNICAL_RE = /\b(error|exception|stack trace|api|library|package|npm|pip|compile|syntax|deprecated|documentation|rfc|http status|config|repo|repository|sdk)\b/i

export function classifyResearchDomain(text: string): ResearchDomainClass {
  if (CURRENT_EVENTS_RE.test(text)) return 'current-events'
  if (ACADEMIC_RE.test(text)) return 'academic'
  if (TECHNICAL_RE.test(text)) return 'technical'
  return 'curated'
}

export const SOURCE_FETCHERS: Record<string, Fetcher> = {
  arxiv: fetchArxiv,
  hackernews: fetchHackerNews,
  stackexchange: fetchStackExchange,
  github: fetchGithub,
  wikipedia: fetchWikipedia,
  ddg: fetchDdgWeb,
}

export function selectSources(cls: ResearchDomainClass): string[] {
  switch (cls) {
    case 'academic': return ['arxiv', 'hackernews']
    case 'current-events': return ['hackernews', 'ddg']
    case 'technical': return ['stackexchange', 'github']
    case 'curated':
    default: return ['wikipedia', 'ddg']
  }
}
