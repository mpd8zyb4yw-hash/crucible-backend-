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
//      models most reliably converge on the truth. Symmetrically, when those short
//      answers CONTRADICT (79 vs 95, "Yes" vs "No", "Paris" vs "London") confidence is
//      damped below the floor and the split is surfaced as an honest-uncertainty signal.
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

/**
 * Numeric-consensus signal for the short-answer regime. When several cheap models are each
 * asked for a value, the NUMBER is the payload — so their agreement (or disagreement) on it is
 * the strongest available truth signal. We only trust a number as "the answer" when the output
 * is short (a number in a long prose reply is incidental, e.g. a year or a measurement) and
 * carries exactly one distinct number.
 *
 * Returns:
 *   • `agreement` — fraction of short-numeric answers sharing the most common value. Drives the
 *      existing positive confidence boost when models converge (agreement ~1.0).
 *   • `contested` — TRUE when the short-numeric answers genuinely DISAGREE (>=2 distinct values,
 *      no strong majority). This is the case the old code silently rewarded: 2 say "3", 2 say
 *      "5" scored 0.5 and still *raised* confidence. A contested factual number must instead
 *      LOWER confidence and be surfaced, so the ensemble reports honest uncertainty.
 */
function numericConsensus(prepped: { tokens: string[] }[]): { agreement: number; contested: boolean } {
  const answers = prepped
    .map(p => ({ short: p.tokens.length <= 12, nums: new Set(p.tokens.filter(t => /^\d+(\.\d+)?$/.test(t))) }))
    .filter(a => a.short && a.nums.size === 1)
    .map(a => [...a.nums][0])
  if (answers.length < 2) return { agreement: 0, contested: false }
  const counts = new Map<string, number>()
  for (const v of answers) counts.set(v, (counts.get(v) ?? 0) + 1)
  const top = Math.max(...counts.values())
  const agreement = top / answers.length
  // Contested = real spread with no strong (>=75%) majority. A lone dissenter on a factual
  // number is worth flagging — for on-device models it usually means one of them is wrong.
  const contested = counts.size >= 2 && agreement < 0.75
  return { agreement, contested }
}

// Polarity markers for yes/no answers. NOTE: `contentTokens` strips "no"/"not" as stopwords,
// so polarity MUST be read from the raw text, not the token set.
const AFFIRM = new Set(['yes', 'yeah', 'yep', 'yup', 'correct', 'true', 'affirmative', 'agreed', 'indeed'])
const NEGATE = new Set(['no', 'nope', 'nah', 'false', 'incorrect', 'negative'])
// Light framing words to peel off a one-entity answer ("the answer is Paris" -> "paris").
const FRAMING = new Set(['answer', 'result', 'response', 'value', 'its'])

/**
 * Categorical-consensus signal — the short-answer sibling of {@link numericConsensus} for
 * NON-numeric payloads. Two regimes, both meaningful only when the output is short (a terse
 * reply is the answer; the same word inside prose is incidental):
 *
 *   • yes/no polarity — the reply LEADS with an affirmative/negative marker. Read from raw
 *     text because "no"/"not" are stopword-stripped from the token set.
 *   • single entity — after stopwords + light framing are removed exactly one non-numeric
 *     content token remains ("Paris", "London"). That token is the answer value.
 *
 * Returns the same shape as numericConsensus: `agreement` (fraction sharing the top value,
 * drives the salient boost) and `contested` (>=2 distinct values, no >=75% majority — a
 * genuine "Yes" vs "No" or "Paris" vs "London" split that must LOWER confidence).
 */
function categoricalConsensus(prepped: { out: ModelOutput; tokens: string[] }[]): { agreement: number; contested: boolean } {
  const valueOf = (p: { out: ModelOutput; tokens: string[] }): string | null => {
    const words = p.out.text.toLowerCase().match(/[a-z']+/g) ?? []
    if (words.length === 0 || words.length > 8) return null // only short replies carry a categorical payload
    // yes/no polarity wins if the answer leads with a marker.
    const first = words[0]
    if (AFFIRM.has(first)) return 'yes'
    if (NEGATE.has(first)) return 'no'
    // single-entity: peel framing tokens, require exactly one remaining non-numeric token.
    const core = p.tokens.filter(t => !FRAMING.has(t))
    if (core.length === 1 && !/^\d+(\.\d+)?$/.test(core[0])) return core[0]
    return null
  }
  const answers = prepped.map(valueOf).filter((v): v is string => v !== null)
  if (answers.length < 2) return { agreement: 0, contested: false }
  const counts = new Map<string, number>()
  for (const v of answers) counts.set(v, (counts.get(v) ?? 0) + 1)
  const top = Math.max(...counts.values())
  const agreement = top / answers.length
  const contested = counts.size >= 2 && agreement < 0.75
  return { agreement, contested }
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
  const numeric = numericConsensus(prepped)
  const categorical = categoricalConsensus(prepped)
  // A contested SHORT answer — a split number OR a split yes-no / entity — is the strongest
  // disagreement signal we have. Either kind damps trust identically.
  const contested = numeric.contested || categorical.contested
  const salient = Math.max(numeric.agreement, categorical.agreement)
  const corroborationFrac = contributors.length / n
  let confidence =
    0.45 +
    0.30 * clusterAgreement +       // do the backing outputs actually converge?
    0.15 * (corroborationFrac - 0.5) + // does a majority back the spine?
    0.20 * (contested ? 0 : salient) // shared short-answer boost — never while contested
  // Let a contested short answer fall below the normal free-tier floor to report honest doubt.
  if (contested) confidence -= 0.25
  confidence = Math.min(0.9, confidence)
  confidence = Math.max(contested ? 0.3 : 0.5, confidence)

  const method =
    numeric.contested ? 'contested-numeric'
    : categorical.contested ? 'contested-categorical'
    : salient >= 0.5 ? 'consensus-salient-agreement'
    : clusterAgreement >= 0.25 ? 'consensus-central'
    : 'central-low-agreement'

  return {
    answer: spine.out.text,
    contributors,
    confidence: Math.round(confidence * 100) / 100,
    method,
  }
}
