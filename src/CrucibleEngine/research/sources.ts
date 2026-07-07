// Track R — Intelligent Web Research + Gap Detection · source fetchers
// Key-free, no-signup connectors only, matching the rest of Crucible's
// acquisition style (academicRetrieval.ts, corpus/acquire.ts): native fetch,
// regex/JSON extraction, no HTML-parser dependency. Every fetcher degrades to
// an empty array on any error — a failed source never breaks the pipeline.

import type { ResearchFinding } from './types.js'

export type Fetcher = (query: string) => Promise<ResearchFinding[]>

const UA = { 'User-Agent': 'CrucibleResearch/1.0 (targeted fetch; key-free sources only)' }

async function fetchTextUrl(url: string, headers: Record<string, string> = UA, timeoutMs = 6000): Promise<string | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(t))
    if (!res.ok) return null
    return await res.text()
  } catch { return null }
}

async function fetchJsonUrl(url: string, headers: Record<string, string> = UA, timeoutMs = 6000): Promise<any | null> {
  const raw = await fetchTextUrl(url, headers, timeoutMs)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}

// ── arXiv — cross-domain preprints, key-free Atom API. High authority: peer-adjacent. ──
export async function fetchArxiv(query: string): Promise<ResearchFinding[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=3`
  const xml = await fetchTextUrl(url)
  if (!xml) return []
  const out: ResearchFinding[] = []
  const re = /<entry>([\s\S]*?)<\/entry>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null && out.length < 3) {
    const block = m[1]
    const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    const summary = (block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    const id = block.match(/<id>(https?:\/\/arxiv\.org\/abs\/[^<]+)<\/id>/)?.[1]
    const published = block.match(/<published>([^<]+)<\/published>/)?.[1]
    if (summary.length < 40) continue
    out.push({
      content: title ? `"${title}": ${summary.slice(0, 400)}` : summary.slice(0, 400),
      source: 'arXiv',
      url: id ?? `https://arxiv.org/abs/${encodeURIComponent(query)}`,
      authorityScore: 0.85,
      publishedAt: published ? Date.parse(published) : undefined,
    })
  }
  return out
}

// ── Hacker News — Algolia search API, key-free. Authority scales with points. ──
export async function fetchHackerNews(query: string): Promise<ResearchFinding[]> {
  const url = `http://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=3`
  const data = await fetchJsonUrl(url)
  const hits = Array.isArray(data?.hits) ? data.hits : []
  return hits
    .filter((h: any) => h?.title)
    .slice(0, 3)
    .map((h: any): ResearchFinding => ({
      content: `${h.title}${h.points != null ? ` (${h.points} points, ${h.num_comments ?? 0} comments)` : ''}`,
      source: 'HackerNews',
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      authorityScore: Math.min(0.9, 0.35 + (Number(h.points) || 0) / 400),
      publishedAt: h.created_at ? Date.parse(h.created_at) : undefined,
    }))
}

// ── Stack Exchange — key-free advanced search (300 req/day unauthenticated). ──
export async function fetchStackExchange(query: string): Promise<ResearchFinding[]> {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=3`
  const data = await fetchJsonUrl(url)
  const items = Array.isArray(data?.items) ? data.items : []
  return items
    .slice(0, 3)
    .map((it: any): ResearchFinding => ({
      content: `${it.title}${it.is_answered ? ' [answered]' : ' [unanswered]'} — score ${it.score ?? 0}`,
      source: 'StackOverflow',
      url: it.link ?? `https://stackoverflow.com/search?q=${encodeURIComponent(query)}`,
      authorityScore: Math.min(0.9, 0.4 + (Number(it.score) || 0) / 60 + (it.is_answered ? 0.15 : 0)),
      publishedAt: it.creation_date ? it.creation_date * 1000 : undefined,
    }))
}

// ── GitHub — public unauthenticated repo search (60 req/hr). Official docs / code proxy. ──
export async function fetchGithub(query: string): Promise<ResearchFinding[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=3`
  const data = await fetchJsonUrl(url, { ...UA, Accept: 'application/vnd.github+json' })
  const items = Array.isArray(data?.items) ? data.items : []
  return items
    .slice(0, 3)
    .map((it: any): ResearchFinding => ({
      content: `${it.full_name}: ${(it.description ?? '').slice(0, 240)} (${it.stargazers_count ?? 0} stars)`,
      source: 'GitHub',
      url: it.html_url ?? `https://github.com/search?q=${encodeURIComponent(query)}`,
      authorityScore: Math.min(0.9, 0.35 + (Number(it.stargazers_count) || 0) / 8000),
      publishedAt: it.pushed_at ? Date.parse(it.pushed_at) : undefined,
    }))
}

// ── Wikipedia — curated/encyclopedic fallback, key-free REST search. ──
export async function fetchWikipedia(query: string): Promise<ResearchFinding[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=${encodeURIComponent(query)}`
  const data = await fetchJsonUrl(url)
  const items = Array.isArray(data?.query?.search) ? data.query.search : []
  return items
    .slice(0, 3)
    .map((it: any): ResearchFinding => ({
      content: `${it.title}: ${stripHtml(it.snippet ?? '')}`,
      source: 'Wikipedia',
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent((it.title ?? '').replace(/ /g, '_'))}`,
      authorityScore: 0.65,
      publishedAt: it.timestamp ? Date.parse(it.timestamp) : undefined,
    }))
}

// ── DuckDuckGo HTML scrape — general web fallback, lowest trust, no key. ──
export async function fetchDdgWeb(query: string): Promise<ResearchFinding[]> {
  const html = await fetchTextUrl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  if (!html) return []
  const out: ResearchFinding[] = []
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < 3) {
    const title = stripHtml(m[2])
    if (title.length < 5) continue
    out.push({ content: title, source: 'Web', url: m[1], authorityScore: 0.35 })
  }
  return out
}
