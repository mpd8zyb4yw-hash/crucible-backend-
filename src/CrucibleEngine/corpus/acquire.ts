// Track C — LIVING CORPUS · deliberate-curation acquisition driver
// Pulls real cross-domain content from approved, key-free sources and feeds it
// through the ingestion pipeline. Deliberate (curated manifest per the domain
// allocation), not organic — the corpus starts toward its target shape; the
// lifecycle system refines from there.
//
// Key-free connectors implemented: Project Gutenberg (plain text classics),
// RFC editor (distributed-systems standards), arXiv API (cross-domain abstracts),
// Stanford Encyclopedia of Philosophy (peer-reviewed reasoning, HTML-stripped).
// Sources requiring bulk archives / API keys (SO dump, NASA NTRS, PubMed bulk)
// are intentionally out of scope for the key-free driver and noted in the manifest.

import { ingestDocument, type IngestDeps, type SourceDoc } from './ingest.js'
import { logGovernance } from './db.js'

const UA = { 'User-Agent': 'CrucibleLivingCorpus/1.0 (research; contact: local)' }

async function fetchText(url: string, timeoutMs = 20000): Promise<string | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { headers: UA, signal: ctrl.signal }).finally(() => clearTimeout(t))
    if (!res.ok) return null
    return await res.text()
  } catch { return null }
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", mdash: '—', ndash: '–',
  hellip: '…', copy: '(c)', reg: '(r)', trade: '(tm)', deg: '°', times: '×', minus: '-',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? ' ')
    .replace(/&#(\d+);/g, (_m, n) => { try { return String.fromCodePoint(parseInt(n, 10)) } catch { return ' ' } })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => { try { return String.fromCodePoint(parseInt(n, 16)) } catch { return ' ' } })
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Connectors ────────────────────────────────────────────────────────────────
export async function fetchGutenberg(id: number): Promise<string | null> {
  // Try the common plain-text layouts.
  for (const url of [
    `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
    `https://www.gutenberg.org/files/${id}/${id}.txt`,
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
  ]) {
    const txt = await fetchText(url)
    if (txt && txt.length > 2000) {
      // Strip Gutenberg license header/footer.
      const start = txt.search(/\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG/i)
      const end = txt.search(/\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG/i)
      const body = txt.slice(start >= 0 ? txt.indexOf('\n', start) + 1 : 0, end >= 0 ? end : undefined)
      return body.trim()
    }
  }
  return null
}

export async function fetchRFC(n: number): Promise<string | null> {
  const txt = await fetchText(`https://www.rfc-editor.org/rfc/rfc${n}.txt`)
  if (!txt || txt.length < 1000) return null
  // Strip form-feed page breaks + page headers/footers.
  return txt.replace(/\f/g, '\n').replace(/^.*\[Page \d+\]\s*$/gim, '').trim()
}

export async function fetchArxiv(category: string, max = 20): Promise<Array<{ title: string; abstract: string }>> {
  const url = `http://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(category)}&start=0&max_results=${max}&sortBy=submittedDate&sortOrder=descending`
  const xml = await fetchText(url)
  if (!xml) return []
  const entries: Array<{ title: string; abstract: string }> = []
  const re = /<entry>([\s\S]*?)<\/entry>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]
    const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    const abstract = (block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    if (abstract.length > 200) entries.push({ title, abstract })
  }
  return entries
}

export async function fetchSEP(slug: string): Promise<string | null> {
  const html = await fetchText(`https://plato.stanford.edu/entries/${slug}/`)
  if (!html) return null
  // The article body lives in #main-text; fall back to whole-page strip.
  const main = html.match(/<div id="main-text">([\s\S]*?)<div id="bibliography"/i)?.[1] ?? html
  const text = stripHtml(main)
  return text.length > 2000 ? text : null
}

// C9 — PubMed abstracts via NCBI E-utilities, key-free (rate-limited to 3 req/s
// without an API key, which the sequential per-topic driver already respects).
// esearch for PMIDs, then efetch XML for title+abstract (regex-parsed — same
// avoid-an-XML-parser convention as fetchArxiv above).
export async function fetchPubMed(query: string, max = 10): Promise<Array<{ title: string; abstract: string }>> {
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${max}&retmode=json`
  const searchRaw = await fetchText(searchUrl)
  if (!searchRaw) return []
  let ids: string[] = []
  try { ids = JSON.parse(searchRaw)?.esearchresult?.idlist ?? [] } catch { return [] }
  if (ids.length === 0) return []

  const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&rettype=abstract&retmode=xml`
  const xml = await fetchText(fetchUrl)
  if (!xml) return []

  const entries: Array<{ title: string; abstract: string }> = []
  const re = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]
    const title = decodeEntities((block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)?.[1] ?? '')).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    const abstractParts = [...block.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map(x => decodeEntities(x[1]).replace(/<[^>]+>/g, ' '))
    const abstract = abstractParts.join(' ').replace(/\s+/g, ' ').trim()
    if (abstract.length > 200) entries.push({ title, abstract })
  }
  return entries
}

// C9 — GitHub top repos by topic, key-free (60 req/hr unauthenticated). Pulls
// the README (raw.githubusercontent.com, no rate limit shared with the API
// quota) from the highest-starred repos as a proxy for "official docs / code."
export async function fetchGithubTopRepos(topic: string, max = 5): Promise<Array<{ repo: string; readme: string }>> {
  const searchUrl = `https://api.github.com/search/repositories?q=topic:${encodeURIComponent(topic)}&sort=stars&order=desc&per_page=${max}`
  const raw = await fetchText(searchUrl, 15000)
  if (!raw) return []
  let items: any[] = []
  try { items = JSON.parse(raw)?.items ?? [] } catch { return [] }

  const out: Array<{ repo: string; readme: string }> = []
  for (const item of items) {
    const fullName = item?.full_name
    if (!fullName) continue
    let readme: string | null = null
    for (const branch of ['main', 'master']) {
      readme = await fetchText(`https://raw.githubusercontent.com/${fullName}/${branch}/README.md`, 10000)
      if (readme) break
    }
    if (readme && readme.length > 500) {
      out.push({ repo: fullName, readme: stripHtml(readme).slice(0, 6000) })
    }
  }
  return out
}

// ── Deliberate curation manifest ──────────────────────────────────────────────
// Maps the spec's priority allocation to concrete, key-free fetches. Each entry's
// reliability + staleness class are set per source type.
interface ManifestEntry {
  kind: 'gutenberg' | 'rfc' | 'arxiv' | 'sep' | 'pubmed' | 'github'
  domain: string
  reliability: number
  staleness: SourceDoc['stalenessClass']
  ids?: number[]            // gutenberg ids / rfc numbers
  arxivCats?: string[]      // arxiv categories
  sepSlugs?: string[]       // SEP entry slugs
  pubmedQueries?: string[]  // pubmed search terms
  githubTopics?: string[]   // github topic tags
}

export const CURATION_MANIFEST: ManifestEntry[] = [
  // Priority 1 — human experience & thought
  { kind: 'sep', domain: 'philosophy', reliability: 0.9, staleness: 'permanent',
    sepSlugs: ['consciousness', 'free-will', 'epistemology', 'ethics-virtue', 'identity-personal', 'time', 'causation-metaphysics', 'emergent-properties', 'scientific-method', 'rationality-historicist'] },
  { kind: 'gutenberg', domain: 'philosophy', reliability: 0.75, staleness: 'permanent',
    ids: [1497 /* Republic */, 3207 /* Leviathan */, 4280 /* Critique of Pure Reason */, 5827 /* Problems of Philosophy */, 2130 /* Nicomachean Ethics */] },
  { kind: 'gutenberg', domain: 'history', reliability: 0.7, staleness: 'permanent',
    ids: [2591 /* Grimm */, 1404 /* Federalist Papers */, 3300 /* Wealth of Nations */] },
  // Priority 2 — cross-domain scientific (abstracts)
  { kind: 'arxiv', domain: 'physics', reliability: 0.7, staleness: 'scientific', arxivCats: ['hep-th', 'quant-ph', 'cond-mat.stat-mech'] },
  { kind: 'arxiv', domain: 'mathematics', reliability: 0.7, staleness: 'permanent', arxivCats: ['math.CO', 'math.NT', 'math.AG'] },
  { kind: 'arxiv', domain: 'biology', reliability: 0.7, staleness: 'scientific', arxivCats: ['q-bio.PE', 'q-bio.NC'] },
  { kind: 'arxiv', domain: 'economics', reliability: 0.7, staleness: 'scientific', arxivCats: ['econ.GN'] },
  { kind: 'arxiv', domain: 'complex-systems', reliability: 0.7, staleness: 'scientific', arxivCats: ['nlin.AO'] },
  // Priority 3/4 — formal reasoning & systems
  { kind: 'rfc', domain: 'networking', reliability: 0.85, staleness: 'engineering',
    ids: [791 /* IP */, 793 /* TCP */, 1122 /* host requirements */, 2616 /* HTTP/1.1 */, 5246 /* TLS */, 6455 /* WebSocket */, 7540 /* HTTP/2 */, 8446 /* TLS 1.3 */] },
  // C9 — bulk key-free sources (deeper per-domain coverage toward 1GB)
  { kind: 'pubmed', domain: 'biology', reliability: 0.85, staleness: 'scientific',
    pubmedQueries: ['CRISPR gene editing', 'neural plasticity memory', 'gut microbiome', 'protein folding prediction', 'cancer immunotherapy'] },
  { kind: 'pubmed', domain: 'cognitive-science', reliability: 0.85, staleness: 'scientific',
    pubmedQueries: ['cognitive load working memory', 'decision making under uncertainty neuroscience'] },
  { kind: 'github', domain: 'computer-science', reliability: 0.65, staleness: 'technology',
    githubTopics: ['distributed-systems', 'compiler', 'machine-learning', 'database', 'operating-system'] },
  { kind: 'github', domain: 'engineering', reliability: 0.65, staleness: 'technology',
    githubTopics: ['systems-programming', 'networking'] },
]

// ── Driver ────────────────────────────────────────────────────────────────────
export interface AcquireOptions {
  byteBudget?: number          // stop after this many ingested bytes (default 50MB this run)
  relationshipBudget?: number  // total relationship-extraction model calls allowed
  onProgress?: (msg: string) => void
}

export async function acquireDeliberately(deps: IngestDeps, opts: AcquireOptions = {}): Promise<{ ingested: number; bytes: number; deduped: number; quarantined: number; relationships: number }> {
  const byteBudget = opts.byteBudget ?? 50 * 1_048_576
  let relBudget = opts.relationshipBudget ?? 200
  const log = opts.onProgress ?? ((m: string) => console.log(m))
  const totals = { ingested: 0, bytes: 0, deduped: 0, quarantined: 0, relationships: 0 }

  for (const entry of CURATION_MANIFEST) {
    if (totals.bytes >= byteBudget) break

    const docs: SourceDoc[] = []
    try {
      if (entry.kind === 'gutenberg') {
        for (const id of entry.ids ?? []) {
          const text = await fetchGutenberg(id)
          if (text) docs.push({ text, domain: entry.domain, source: `gutenberg:${id}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'rfc') {
        for (const n of entry.ids ?? []) {
          const text = await fetchRFC(n)
          if (text) docs.push({ text, domain: entry.domain, source: `rfc:${n}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'sep') {
        for (const slug of entry.sepSlugs ?? []) {
          const text = await fetchSEP(slug)
          if (text) docs.push({ text, domain: entry.domain, source: `sep:${slug}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'arxiv') {
        for (const cat of entry.arxivCats ?? []) {
          const papers = await fetchArxiv(cat, 25)
          for (const p of papers) docs.push({ text: `${p.title}. ${p.abstract}`, domain: entry.domain, source: `arxiv:${cat}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'pubmed') {
        for (const query of entry.pubmedQueries ?? []) {
          const papers = await fetchPubMed(query, 15)
          for (const p of papers) docs.push({ text: `${p.title}. ${p.abstract}`, domain: entry.domain, source: `pubmed:${query}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'github') {
        for (const topic of entry.githubTopics ?? []) {
          const repos = await fetchGithubTopRepos(topic, 5)
          for (const r of repos) docs.push({ text: r.readme, domain: entry.domain, source: `github:${r.repo}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      }
    } catch (e: any) {
      log(`[CORPUS] acquire: source ${entry.kind}/${entry.domain} failed: ${e?.message}`)
      continue
    }

    for (const doc of docs) {
      if (totals.bytes >= byteBudget) break
      const r = await ingestDocument(doc, deps, { relationshipBudget: Math.min(relBudget, 10) })
      totals.ingested += r.ingested; totals.bytes += r.bytes; totals.deduped += r.deduped
      totals.quarantined += r.quarantined; totals.relationships += r.relationships
      relBudget = Math.max(0, relBudget - r.relationships)
      if (r.ingested) log(`[CORPUS] +${r.ingested} chunks (${(r.bytes / 1024).toFixed(0)}KB) from ${doc.source} [${doc.domain}]`)
    }
  }

  logGovernance('acquire', null, `deliberate acquisition cycle: +${totals.ingested} chunks, ${(totals.bytes / 1_048_576).toFixed(2)}MB, ${totals.deduped} deduped, ${totals.quarantined} quarantined`)
  log(`[CORPUS] Acquisition cycle complete — ${totals.ingested} chunks, ${(totals.bytes / 1_048_576).toFixed(2)}MB ingested, ${totals.relationships} relationships, ${totals.deduped} deduped, ${totals.quarantined} quarantined`)
  return totals
}
