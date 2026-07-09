// Emergent specialization detection (Track G2) — runs k-means on the query
// embedding space to find clusters of queries that no named prompt type
// captures well. When a cluster is discovered, it's added to the taxonomy and
// the model that consistently scores highest for it is flagged as its specialist.

import fs from 'fs'
import path from 'path'

// Lightweight bag-of-words vectorizer for query clustering
function vectorize(text: string): number[] {
  const tokens = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  const freq: Record<string, number> = {}
  for (const t of tokens) freq[t] = (freq[t] ?? 0) + 1
  // Fixed 20-dim hash projection
  const dim = 20
  const vec = new Array(dim).fill(0)
  for (const [word, count] of Object.entries(freq)) {
    let h = 0
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0
    vec[h % dim] += count
  }
  const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1
  return vec.map(x => x / n)
}

export interface QueryCluster {
  id: string
  label: string           // auto-derived from common n-grams
  centroid: number[]
  topModelId?: string     // model with highest avg score for this cluster
  topModelScore: number
  sampleCount: number
  discoveredAt: number
  exampleQueries: string[]
}

const clusterFile = (dir: string) => path.join(dir, '.crucible', 'query-clusters.json')
const K_EMERGE = 8
const MIN_CLUSTER_SIZE = 5

export function loadClusters(dir: string): QueryCluster[] {
  try { return JSON.parse(fs.readFileSync(clusterFile(dir), 'utf8')) } catch { return [] }
}

export function saveClusters(dir: string, clusters: QueryCluster[]) {
  fs.mkdirSync(path.dirname(clusterFile(dir)), { recursive: true })
  fs.writeFileSync(clusterFile(dir), JSON.stringify(clusters, null, 2))
}

function dot(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0)
}

function norm(v: number[]): number { return Math.sqrt(v.reduce((s, x) => s + x * x, 0)) }

function cosineSim(a: number[], b: number[]): number {
  const na = norm(a), nb = norm(b)
  return na && nb ? dot(a, b) / (na * nb) : 0
}

function centroid(vecs: number[][]): number[] {
  if (!vecs.length) return []
  const dim = vecs[0].length
  const c = new Array(dim).fill(0)
  for (const v of vecs) for (let i = 0; i < dim; i++) c[i] += (v[i] ?? 0)
  return c.map(x => x / vecs.length)
}

// Extract common n-grams from a list of queries to label a cluster
function clusterNgramLabel(queries: string[]): string {
  const bigrams: Record<string, number> = {}
  for (const q of queries) {
    const words = q.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3)
    for (let i = 0; i < words.length - 1; i++) {
      const bg = `${words[i]} ${words[i + 1]}`
      bigrams[bg] = (bigrams[bg] ?? 0) + 1
    }
  }
  const top = Object.entries(bigrams).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0])
  return top.join(', ') || 'misc queries'
}

// Run k-means on recent history to detect emergent query clusters
export function detectEmergentClusters(
  dir: string,
  modelScores?: Map<string, Record<string, number>>  // requestId → {modelId: score}
): QueryCluster[] {
  const HISTORY_FILE = path.join(dir, '.crucible', 'history-default.json')
  let sessions: any[] = []
  try { sessions = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { return [] }

  const recent = sessions.slice(-300).filter(s => s.query)
  if (recent.length < K_EMERGE * 3) return []

  const vecs = recent.map(s => vectorize(s.query))

  // Init centroids from first K queries spread across range
  const step = Math.floor(recent.length / K_EMERGE)
  let centroids = Array.from({ length: K_EMERGE }, (_, k) => [...(vecs[k * step] ?? vecs[0])])

  let assignments: number[] = new Array(recent.length).fill(0)

  // k-means — 8 iterations
  for (let iter = 0; iter < 8; iter++) {
    for (let i = 0; i < vecs.length; i++) {
      let best = 0, bestSim = -Infinity
      for (let k = 0; k < K_EMERGE; k++) {
        const sim = cosineSim(vecs[i], centroids[k])
        if (sim > bestSim) { bestSim = sim; best = k }
      }
      assignments[i] = best
    }
    for (let k = 0; k < K_EMERGE; k++) {
      const memberVecs = vecs.filter((_, i) => assignments[i] === k)
      if (memberVecs.length) centroids[k] = centroid(memberVecs)
    }
  }

  const clusters: QueryCluster[] = []
  for (let k = 0; k < K_EMERGE; k++) {
    const indices = assignments.map((a, i) => a === k ? i : -1).filter(i => i >= 0)
    if (indices.length < MIN_CLUSTER_SIZE) continue
    const members = indices.map(i => recent[i])

    // Find top model for this cluster
    let topModelId: string | undefined
    let topModelScore = 0
    const modelTotals: Record<string, { sum: number; count: number }> = {}
    for (const s of members) {
      if (!s.attribution) continue
      const modelIds = [...new Set(Object.values(s.attribution) as string[])]
      for (const id of modelIds) {
        if (!modelTotals[id]) modelTotals[id] = { sum: 0, count: 0 }
        modelTotals[id].sum += s.topScore ?? 0
        modelTotals[id].count += 1
      }
    }
    for (const [id, { sum, count }] of Object.entries(modelTotals)) {
      const avg = sum / count
      if (avg > topModelScore) { topModelScore = avg; topModelId = id }
    }

    clusters.push({
      id: `qc_${k}`,
      label: clusterNgramLabel(members.slice(-20).map(s => s.query)),
      centroid: centroids[k],
      topModelId,
      topModelScore: parseFloat(topModelScore.toFixed(3)),
      sampleCount: indices.length,
      discoveredAt: Date.now(),
      exampleQueries: members.slice(-3).map(s => (s.query as string).slice(0, 80)),
    })
  }

  clusters.sort((a, b) => b.sampleCount - a.sampleCount)
  saveClusters(dir, clusters)
  return clusters
}
