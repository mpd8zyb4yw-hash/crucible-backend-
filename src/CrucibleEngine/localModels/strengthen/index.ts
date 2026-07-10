// ── localModels/strengthen/index.ts — on-device consensus strengthener (Track C) ──
//
// Free-tier philosophy in one module: several small on-device models each produce a
// weak-to-middling answer; instead of trusting the loudest (longest) one, we measure
// how much the outputs AGREE with each other and let the group's consensus pick and
// grade the answer. "Garbage in, gold out" via client-side processing, zero API calls.
//
// The algorithm is deliberately pure, deterministic, and offline (no embedding model,
// no network) so it runs anywhere the ensemble runs and is trivially benched:
//
//   1. Normalize each successful output into a content-token set + bigram shingles.
//   2. Build a pairwise lexical-agreement matrix (Jaccard over tokens and shingles).
//   3. Centrality = a model's mean agreement with every other model. The most central
//      output is the one the group corroborates most — that becomes the answer spine,
//      NOT simply the longest text.
//   4. Contributors = every model whose output materially agrees with the spine, since
//      they independently corroborate it.
//   5. Confidence rises with genuine convergence (mean pairwise agreement) and with the
//      number of corroborating models, and is damped when the pool is small or split.
//   6. Short factual answers (a shared number / yes-no / one salient token across
//      outputs) get a dedicated high-agreement boost — that's the case where cheap
//      models most reliably converge on the truth.
//
// Track B depends only on the StrengthenResult shape (see ../contracts).

import type { ModelOutput, StrengthenResult } from '../contracts'

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'as', 'that', 'this',
  'these', 'those', 'it', 'its', 'from', 'into', 'about', 'so', 'than', 'too', 'very', 'can',
  'will', 'just', 'not', 'no', 'do', 'does', 'did', 'has', 'have', 'had', 'you', 'your', 'i',
  'we', 'they', 'he', 'she', 'them', 'their', 'our', 'my', 'me', 'us', 'here', 'there', 'also',
  'which', 'what', 'when', 'where', 'who', 'how', 'why', 'because', 'would', 'could', 'should',
])

function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`*_>#\-]+/g, ' ')
    .replace(/[^a-z0-9\s.]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^\.+|\.+$/g, ''))
    // keep numbers even when single-digit (a lone "3" is a salient short answer);
    // otherwise require length > 1 to drop noise like stray letters.
    .filter(t => (/\d/.test(t) || t.length > 1) && !STOPWORDS.has(t))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  for (const t of small) if (large.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function bigrams(tokens: string[]): Set<string> {
  const s = new Set<string>()
  for (let i = 0; i < tokens.length - 1; i++) s.add(tokens[i] + ' ' + tokens[i + 1])
  return s
}

/** Blend of unigram and bigram Jaccard — bigrams reward shared phrasing/ordering, unigrams shared topic. */
function agreement(a: { toks: Set<string>; bis: Set<string> }, b: { toks: Set<string>; bis: Set<string> }): number {
  return 0.6 * jaccard(a.toks, b.toks) + 0.4 * jaccard(a.bis, b.bis)
}

/** Salient short-answer signal: shared numbers or a single dominant token across outputs. */
function sharedSalient(prepped: { tokens: string[] }[]): number {
  // Numbers are the highest-signal short answers cheap models converge on.
  const numSets = prepped.map(p => new Set(p.tokens.filter(t => /^\d+(\.\d+)?$/.test(t))))
  const withNums = numSets.filter(s => s.size > 0)
  if (withNums.length >= 2) {
    const counts = new Map<string, number>()
    for (const s of withNums) for (const n of s) counts.set(n, (counts.get(n) ?? 0) + 1)
    const top = Math.max(...counts.values())
    return top / withNums.length // fraction of number-bearing outputs sharing the top number
  }
  return 0
}

export function strengthen(_query: string, outputs: ModelOutput[]): StrengthenResult {
  const successful = outputs.filter(o => o.ok && o.text.trim().length > 0)

  if (successful.length === 0) {
    return { answer: '', contributors: [], confidence: 0, method: 'no-successful-outputs' }
  }
  if (successful.length === 1) {
    return { answer: successful[0].text, contributors: [successful[0].modelId], confidence: 0.6, method: 'single-model' }
  }

  const prepped = successful.map(o => {
    const tokens = contentTokens(o.text)
    return { out: o, tokens, toks: new Set(tokens), bis: bigrams(tokens) }
  })

  const n = prepped.length
  // Pairwise agreement matrix + per-output centrality (mean agreement with the rest).
  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  const centrality: number[] = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = agreement(prepped[i], prepped[j])
      sim[i][j] = s
      sim[j][i] = s
      centrality[i] += s
      centrality[j] += s
    }
    centrality[i] /= n - 1
  }

  // Spine = most central output. Tie-break toward a substantive-but-not-bloated length
  // (favor the median-ish length so one runaway verbose output can't win on words alone).
  const lengths = prepped.map(p => p.out.text.length).sort((a, b) => a - b)
  const medianLen = lengths[Math.floor(lengths.length / 2)]
  let spineIdx = 0
  let spineScore = -Infinity
  prepped.forEach((p, i) => {
    const lenPenalty = Math.abs(p.out.text.length - medianLen) / (medianLen + 1)
    const score = centrality[i] - 0.15 * lenPenalty
    if (score > spineScore) { spineScore = score; spineIdx = i }
  })

  const spine = prepped[spineIdx]

  // Contributors: models that materially corroborate the spine.
  const CORROBORATE = 0.18
  const corroboratorIdx = prepped
    .map((_, i) => i)
    .filter(i => i !== spineIdx && sim[spineIdx][i] >= CORROBORATE)
  const contributors = [spineIdx, ...corroboratorIdx].map(i => prepped[i].out.modelId)

  // Convergence is measured over the cluster that backs the spine, NOT the whole pool —
  // a couple of off-topic outliers must not drag down a genuine two-model agreement.
  const clusterAgreement = corroboratorIdx.length === 0
    ? 0
    : corroboratorIdx.reduce((s, i) => s + sim[spineIdx][i], 0) / corroboratorIdx.length

  // Confidence: convergence-driven, damped for small/split pools, boosted by salient
  // short-answer agreement. Clamped to a sane free-tier ceiling — this is corroboration,
  // not certainty.
  const salient = sharedSalient(prepped)
  const corroborationFrac = contributors.length / n
  let confidence =
    0.45 +
    0.30 * clusterAgreement +       // do the backing outputs actually converge?
    0.15 * (corroborationFrac - 0.5) + // does a majority back the spine?
    0.20 * salient                  // shared number / short answer across models
  confidence = Math.max(0.5, Math.min(0.9, confidence))

  const method =
    salient >= 0.5 ? 'consensus-salient-agreement'
    : clusterAgreement >= 0.25 ? 'consensus-central'
    : 'central-low-agreement'

  return {
    answer: spine.out.text,
    contributors,
    confidence: Math.round(confidence * 100) / 100,
    method,
  }
}
