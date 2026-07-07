// ── localModels/strengthen/index.ts — PLACEHOLDER, owned by Track C ──
//
// Track C had not landed the real consensus/oracle-tiebreak/cross-critique
// pipeline when Track B needed to wire the server.ts seam end to end. This is
// a minimal stand-in: picks the longest successful output (best-of-1 when
// there's only one model, which is the actual registry state today since
// Track A hasn't landed the SmolLM2/Gemma adapters yet). Replace wholesale
// once strengthen/** lands — Track B only depends on the StrengthenResult shape.

import type { ModelOutput, StrengthenResult } from '../contracts'

export function strengthen(_query: string, outputs: ModelOutput[]): StrengthenResult {
  const successful = outputs.filter(o => o.ok && o.text.trim().length > 0)
  if (successful.length === 0) {
    return { answer: '', contributors: [], confidence: 0, method: 'placeholder-no-successful-outputs' }
  }
  const best = successful.reduce((a, b) => (b.text.length > a.text.length ? b : a))
  return {
    answer: best.text,
    contributors: [best.modelId],
    confidence: successful.length > 1 ? 0.5 : 0.6,
    method: successful.length > 1 ? 'placeholder-longest-of-n' : 'placeholder-single-model',
  }
}
