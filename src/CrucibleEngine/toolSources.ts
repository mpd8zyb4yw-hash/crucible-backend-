// GitHub subscriptions & tool discovery — design spec §3
// (docs/DESIGN_SPEC_TOOL_BUILDER_REMOTE_BRAIN.md).
//
// Users subscribe to GitHub owners/repos; a crawl extracts lightweight manifests
// (heuristics over folder conventions — skills/, tools/, agents/, commands/,
// .claude/skills/) into a searchable local index. Matches are surfaced during the
// builder flow as suggestions, never redirects (§3.3). Imports go through the same
// structural gates as everything else: license check first (§3.4), then the
// compile + smoke gate — an import that can't run in the registry is rejected
// honestly, not installed as decoration.
//
// Free-tier: unauthenticated GitHub API (60 req/h) or GITHUB_TOKEN when present.
// The fetch function is injectable so tests run with zero network.

import fs from 'fs'
import path from 'path'
import { compileTool, saveDynamicTool, loadDynamicTool, type DynamicToolRecord } from './tools/dynamicTools'
import { registry } from './tools/registry'
import type { ToolCtx } from './tools/protocol'

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>

export interface SourceSub {
  owner: string
  repo: string | null      // null = all public repos of the owner
  addedAt: number
}

export interface SourceCard {
  repo: string             // owner/name
  path: string             // directory or file within the repo
  name: string
  description: string
  kind: 'code' | 'skill_md' | 'unknown'
  license: string | null   // SPDX id, 'NOASSERTION', or null when the repo has none
  updatedAt: string | null
  defaultBranch: string
}

interface SourceIndex {
  builtAt: number
  cards: SourceCard[]
}

function sourcesFile(baseDir: string): string {
  return path.join(baseDir, '.crucible', 'tool-sources.json')
}
function indexFile(baseDir: string): string {
  return path.join(baseDir, '.crucible', 'tool-sources-index.json')
}

export function listSources(baseDir: string): SourceSub[] {
  try { return JSON.parse(fs.readFileSync(sourcesFile(baseDir), 'utf-8')) } catch { return [] }
}

function saveSources(baseDir: string, subs: SourceSub[]): void {
  fs.mkdirSync(path.dirname(sourcesFile(baseDir)), { recursive: true })
  fs.writeFileSync(sourcesFile(baseDir), JSON.stringify(subs, null, 2), 'utf-8')
}

export function addSource(baseDir: string, owner: string, repo: string | null): SourceSub[] {
  const subs = listSources(baseDir)
  const clean = { owner: owner.trim().toLowerCase(), repo: repo?.trim().toLowerCase() || null, addedAt: Date.now() }
  if (!clean.owner || !/^[a-z0-9-]+$/i.test(clean.owner)) throw new Error('Invalid GitHub owner.')
  if (clean.repo && !/^[a-z0-9._-]+$/i.test(clean.repo)) throw new Error('Invalid GitHub repo name.')
  if (!subs.some(s => s.owner === clean.owner && s.repo === clean.repo)) subs.push(clean)
  saveSources(baseDir, subs)
  return subs
}

export function removeSource(baseDir: string, owner: string, repo: string | null): SourceSub[] {
  const subs = listSources(baseDir).filter(s => !(s.owner === owner.toLowerCase() && s.repo === (repo?.toLowerCase() || null)))
  saveSources(baseDir, subs)
  return subs
}

export function loadIndex(baseDir: string): SourceIndex {
  try { return JSON.parse(fs.readFileSync(indexFile(baseDir), 'utf-8')) } catch { return { builtAt: 0, cards: [] } }
}

function saveIndex(baseDir: string, index: SourceIndex): void {
  fs.mkdirSync(path.dirname(indexFile(baseDir)), { recursive: true })
  fs.writeFileSync(indexFile(baseDir), JSON.stringify(index, null, 2), 'utf-8')
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'crucible-tool-sources', Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return h
}

async function ghJson(fetchFn: FetchLike, url: string): Promise<any | null> {
  try {
    const r = await fetchFn(url, { headers: ghHeaders() })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

// ── Manifest detection (§3.2 — heuristics; no LLM needed for the common cases) ─

const TOOL_DIRS = /^(?:\.claude\/)?(skills|tools|agents|commands|plugins)\//i
const CODE_EXT = /\.(js|mjs|cjs|ts)$/i
const SKILL_MD = /(?:^|\/)(SKILL|skill)\.md$/

/** Group a repo tree into tool cards: one card per direct child of a tool dir
 *  (skills/foo/** → card "foo"), plus single-file tools directly in the dir. */
export function detectCards(repoFull: string, defaultBranch: string, treePaths: string[], license: string | null, updatedAt: string | null): SourceCard[] {
  const groups = new Map<string, { files: string[]; kind: SourceCard['kind'] }>()
  for (const p of treePaths) {
    const m = p.match(TOOL_DIRS)
    if (!m) continue
    const afterDir = p.slice(m[0].length)
    if (!afterDir) continue
    const seg = afterDir.split('/')
    const key = seg.length === 1 ? p : p.slice(0, m[0].length) + seg[0]   // file directly in dir, or subdir
    const g = groups.get(key) ?? { files: [], kind: 'unknown' as const }
    g.files.push(p)
    if (SKILL_MD.test(p) || (seg.length === 1 && /\.md$/i.test(p))) g.kind = 'skill_md'
    else if (CODE_EXT.test(p) && g.kind !== 'skill_md') g.kind = 'code'
    groups.set(key, g)
  }
  const cards: SourceCard[] = []
  for (const [key, g] of groups) {
    const name = key.split('/').pop()!.replace(CODE_EXT, '').replace(/\.md$/i, '')
    if (!name || name.startsWith('.')) continue
    cards.push({
      repo: repoFull, path: key, name,
      description: '',            // filled lazily from README/SKILL.md head on import/search detail
      kind: g.kind,
      license, updatedAt, defaultBranch,
    })
  }
  return cards
}

/** Crawl one repo into cards. Returns null when the repo is unreachable. */
export async function crawlRepo(fetchFn: FetchLike, owner: string, repo: string): Promise<SourceCard[] | null> {
  const meta = await ghJson(fetchFn, `https://api.github.com/repos/${owner}/${repo}`)
  if (!meta) return null
  const branch = meta.default_branch ?? 'main'
  const license = meta.license?.spdx_id ?? null
  const tree = await ghJson(fetchFn, `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`)
  if (!tree?.tree) return []
  const paths = (tree.tree as Array<{ path: string; type: string }>).filter(e => e.type === 'blob').map(e => e.path)
  return detectCards(`${owner}/${repo}`, branch, paths, license, meta.pushed_at ?? null)
}

/** Rebuild the index across all subscriptions (§3.1 "indexed" mode).
 *  Unreachable repos are reported, never silently indexed as empty — "0 tools"
 *  must mean "we looked and found none", not "GitHub was down" (§6). */
export async function rebuildIndex(baseDir: string, fetchFn: FetchLike): Promise<SourceIndex & { errors: string[] }> {
  const subs = listSources(baseDir)
  const cards: SourceCard[] = []
  const errors: string[] = []
  for (const sub of subs) {
    const repos: string[] = []
    if (sub.repo) repos.push(sub.repo)
    else {
      const list = await ghJson(fetchFn, `https://api.github.com/users/${sub.owner}/repos?per_page=30&sort=pushed`)
      if (Array.isArray(list)) repos.push(...list.map((r: any) => r.name))
      else errors.push(`could not list repos for '${sub.owner}' (unreachable or rate-limited)`)
    }
    for (const repo of repos) {
      const found = await crawlRepo(fetchFn, sub.owner, repo)
      if (found) cards.push(...found)
      else errors.push(`could not crawl ${sub.owner}/${repo} (unreachable or rate-limited)`)
    }
  }
  const index = { builtAt: Date.now(), cards }
  // Only persist when at least one source was actually reachable — a total outage
  // must not wipe a previously good index.
  if (!subs.length || errors.length < subs.length || cards.length) saveIndex(baseDir, index)
  return { ...index, errors }
}

/** Search the index (§3.1 both modes start here; §3.3 builder surfacing uses this).
 *  Generic build-request words are stopworded (every card lives under tools/ or
 *  skills/, so "tool" matches everything) and terms are stem-matched loosely
 *  ("grills" → "grill"). */
const SEARCH_STOPWORDS = new Set(['build', 'make', 'create', 'write', 'tool', 'tools', 'skill', 'skills', 'agent', 'agents', 'command', 'commands', 'that', 'with', 'the', 'this', 'and', 'for', 'can', 'you', 'before', 'when', 'custom', 'new'])

export function searchIndex(baseDir: string, query: string, limit = 5): SourceCard[] {
  const stem = (t: string) => t.replace(/(?:ing|ers|er|es|s)$/, '')
  const terms = query.toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length > 2 && !SEARCH_STOPWORDS.has(t))
    .map(stem).filter(t => t.length > 2)
  if (!terms.length) return []
  const scored = loadIndex(baseDir).cards.map(c => {
    const hay = `${c.name.replace(/[-_]/g, ' ')} ${c.path.replace(/[-_/]/g, ' ')} ${c.repo.replace(/[-_/]/g, ' ')} ${c.description}`.toLowerCase()
    const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)
    return { c, score }
  }).filter(s => s.score > 0)
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.c)
}

// ── License gate (§3.4) ───────────────────────────────────────────────────────

const LICENSE_BLOCK: string[] = []   // explicit disallow-reuse licenses would go here
const LICENSE_WARN = ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'CC-BY-SA-4.0']

export function licenseGate(spdx: string | null): { allowed: boolean; warning: string | null } {
  if (spdx === null || spdx === 'NOASSERTION') {
    return { allowed: true, warning: 'No license detected — all rights reserved by default. Import for personal use only; do not redistribute.' }
  }
  if (LICENSE_BLOCK.includes(spdx)) return { allowed: false, warning: `License ${spdx} disallows reuse.` }
  if (LICENSE_WARN.some(l => spdx.startsWith(l))) {
    return { allowed: true, warning: `License ${spdx} is copyleft/share-alike — derivative tools may carry obligations.` }
  }
  return { allowed: true, warning: null }
}

// ── Import (§3.4) — license gate → fetch source → same compile+smoke gate ────

export interface ImportResult {
  installed: boolean
  name: string
  warning: string | null
  reason?: string          // why it was NOT installed
}

export async function importTool(
  baseDir: string,
  fetchFn: FetchLike,
  card: SourceCard,
  ctx: ToolCtx,
): Promise<ImportResult> {
  const gate = licenseGate(card.license)
  if (!gate.allowed) return { installed: false, name: card.name, warning: gate.warning, reason: gate.warning ?? 'license blocked' }

  if (card.kind === 'skill_md') {
    return {
      installed: false, name: card.name, warning: gate.warning,
      reason: 'This is a prompt-skill (markdown). Crucible has no persona runtime yet (design spec §2.2) — importing it would install something that cannot run. Use it as reference for a fresh build instead.',
    }
  }

  // Fetch the code file (single file, or the first code file in the directory)
  const filePath = CODE_EXT.test(card.path) ? card.path : null
  if (!filePath) {
    return { installed: false, name: card.name, warning: gate.warning, reason: 'Directory imports are not supported yet — pick a single-file tool.' }
  }
  const raw = await fetchFn(`https://raw.githubusercontent.com/${card.repo}/${card.defaultBranch}/${filePath}`, { headers: ghHeaders() })
  if (!raw.ok) return { installed: false, name: card.name, warning: gate.warning, reason: `Could not fetch source (${raw.status}).` }
  const source = await raw.text()
  if (source.length > 100_000) return { installed: false, name: card.name, warning: gate.warning, reason: 'Source too large to import as a tool body.' }

  const name = card.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase()
  if (loadDynamicTool(ctx.projectPath, name) || registry.get(name)) {
    return { installed: false, name, warning: gate.warning, reason: `A tool named '${name}' already exists.` }
  }

  // The imported file must behave as an async (args, ctx) => {ok, output} body.
  // Most arbitrary GitHub files won't — the gate rejects them honestly (§6).
  let run
  try {
    run = compileTool(source)
    const probe = await run({}, ctx)
    // compileTool normalizes contract violations and throws into ok:false wrapper
    // messages rather than throwing — treat those as gate failures.
    if (!probe.ok && /^Dynamic tool (must return|threw)/.test(probe.output)) throw new Error(probe.output)
  } catch (e: any) {
    return {
      installed: false, name, warning: gate.warning,
      reason: `Failed the smoke gate: ${e?.message ?? e}. The file is not in Crucible's tool-body format (async body receiving (args, ctx), returning { ok, output }). Adapt it via the builder instead.`,
    }
  }

  registry.register({ name, description: card.description || `Imported from ${card.repo}/${card.path}`, params: { type: 'object', properties: {} }, mutates: false, run })
  const record: DynamicToolRecord = {
    name,
    description: card.description || `Imported from ${card.repo}/${card.path}`,
    params: { type: 'object', properties: {} },
    body: source,
    createdAt: Date.now(),
    createdBy: 'import',
    useCount: 0, successCount: 0, lastUsed: null,
    tier: 'session',
    version: 1,
    changeNote: `imported from ${card.repo}@${card.defaultBranch}:${card.path}`,
    provenance: { source: 'imported', importedFrom: `${card.repo}@${card.defaultBranch}:${card.path}` },
    verification: { lastSmokeTest: Date.now(), result: 'pass' },
  }
  saveDynamicTool(ctx.projectPath, record)
  return { installed: true, name, warning: gate.warning }
}
