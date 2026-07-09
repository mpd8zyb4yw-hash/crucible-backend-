// Failure taxonomy builder (Track B2) — clusters low-score pipeline responses
// into recurring failure modes using k-means on lightweight feature vectors.
// The taxonomy is stored in .crucible/failure-taxonomy.json and surfaced via
// the debug API so we can see which categories of failure dominate.

import fs from 'fs'
import path from 'path'

export interface FailureCluster {
  id: string
  label: string              // human-readable name derived from keywords
  centroid: number[]         // feature vector centroid
  members: FailureRecord[]   // raw samples (trimmed to last 20)
  count: number
  exampleQuery: string
}

export interface FailureRecord {
  ts: number
  query: string
  synthesis: string
  score: number
  promptType: string
  features: number[]
}

const taxonomyFile = (dir: string) => path.join(dir, '.crucible', 'failure-taxonomy.json')
const SCORE_THRESHOLD = 0.52    // below this is a "failure"
const K = 6                     // number of clusters
const MAX_HISTORY = 200         // look at last N sessions

export function loadTaxonomy(dir: string): FailureCluster[] {
  try { return JSON.parse(fs.readFileSync(taxonomyFile(dir), 'utf8')) } catch { return [] }
}

export function saveTaxonomy(dir: string, clusters: FailureCluster[]) {
  fs.mkdirSync(path.dirname(taxonomyFile(dir)), { recursive: true })
  fs.writeFileSync(taxonomyFile(dir), JSON.stringify(clusters, null, 2))
}

// Feature vector: [shortQuery, questionMark, codeBlock, longSynth, lowWordCount, hasNumbers, promptTypeBits x6]
function featurize(record: { query: string; synthesis: string; promptType: string }): number[] {
  const q = record.query.toLowerCase()
  const s = record.synthesis.toLowerCase()
  const words = s.split(/\s+/).length
  const ptypes = ['coding', 'reasoning', 'creative', 'factual', 'math', 'general']
  return [
    q.length < 30 ? 1 : 0,
    q.includes('?') ? 1 : 0,
    s.includes('```') ? 1 : 0,
    s.length > 800 ? 1 : 0,
    words < 30 ? 1 : 0,
    /\d+/.test(s) ? 1 : 0,
    ...ptypes.map(pt => pt === record.promptType ? 1 : 0),
  ]
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2 }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

function centroid(vecs: number[][]): number[] {
  if (!vecs.length) return []
  const dim = vecs[0].length
  const c = new Array(dim).fill(0)
  for (const v of vecs) for (let i = 0; i < dim; i++) c[i] += v[i]
  return c.map(x => x / vecs.length)
}

function clusterLabel(members: FailureRecord[]): string {
  // Pick the most common prompt type
  const ptCounts: Record<string, number> = {}
  for (const m of members) ptCounts[m.promptType] = (ptCounts[m.promptType] ?? 0) + 1
  const topPt = Object.entries(ptCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'general'
  // Detect common surface signals
  const shortQuery = members.filter(m => m.query.length < 30).length / members.length
  const lowSynth = members.filter(m => m.synthesis.split(/\s+/).length < 30).length / members.length
  const hasCode = members.filter(m => m.synthesis.includes('```')).length / members.length
  if (shortQuery > 0.5) return `Vague ${topPt} queries`
  if (lowSynth > 0.5) return `Thin synthesis on ${topPt}`
  if (hasCode > 0.5) return `Code gen failures (${topPt})`
  return `${topPt} quality issues`
}

// Run k-means on recent failures. Returns updated clusters.
export function buildFailureTaxonomy(dir: string): FailureCluster[] {
  const HISTORY_FILE = path.join(dir, '.crucible', 'history-default.json')
  let sessions: any[] = []
  try { sessions = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { return [] }

  const failures: FailureRecord[] = sessions
    .slice(-MAX_HISTORY)
    .filter(s => (s.topScore ?? s.score ?? 1) < SCORE_THRESHOLD && s.synthesis)
    .map(s => ({
      ts: s.ts,
      query: s.query ?? '',
      synthesis: s.synthesis ?? '',
      score: s.topScore ?? s.score ?? 0,
      promptType: s.promptType ?? 'general',
      features: featurize({ query: s.query ?? '', synthesis: s.synthesis ?? '', promptType: s.promptType ?? 'general' }),
    }))

  if (failures.length < K) return []

  // Init centroids from first K distinct failures
  let centroids = failures.slice(0, K).map(f => [...f.features])

  // k-means — 10 iterations
  let assignments: number[] = new Array(failures.length).fill(0)
  for (let iter = 0; iter < 10; iter++) {
    // Assign
    for (let i = 0; i < failures.length; i++) {
      let best = 0, bestSim = -Infinity
      for (let k = 0; k < K; k++) {
        const sim = cosine(failures[i].features, centroids[k])
        if (sim > bestSim) { bestSim = sim; best = k }
      }
      assignments[i] = best
    }
    // Recompute centroids
    for (let k = 0; k < K; k++) {
      const members = failures.filter((_, i) => assignments[i] === k)
      if (members.length) centroids[k] = centroid(members.map(m => m.features))
    }
  }

  const clusters: FailureCluster[] = []
  for (let k = 0; k < K; k++) {
    const members = failures.filter((_, i) => assignments[i] === k)
    if (!members.length) continue
    clusters.push({
      id: `cluster_${k}`,
      label: clusterLabel(members),
      centroid: centroids[k],
      members: members.slice(-20),
      count: members.length,
      exampleQuery: members[members.length - 1]?.query ?? '',
    })
  }

  clusters.sort((a, b) => b.count - a.count)
  saveTaxonomy(dir, clusters)
  return clusters
}
