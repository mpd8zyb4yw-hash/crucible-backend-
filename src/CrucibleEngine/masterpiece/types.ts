// Track P — MASTERPIECE shared types
// Every other masterpiece module imports from here. Never import from
// individual masterpiece modules inside this file (would create cycles).

export type ShardId = string   // `shard-${index}-${anchorId.slice(0,8)}`
export type AnchorId = string  // UUID for the Ground Truth Anchor

// ── Ground Truth Anchor ────────────────────────────────────────────────────
// The original, unmodified prompt. Sacred — never rewritten, never truncated.
// Referenced at every stage for coherence verification and reassembly.
export interface GroundTruthAnchor {
  id: AnchorId
  originalPrompt: string
  storedAt: number
  shardCount: number
}

// ── Mosaic Shards ──────────────────────────────────────────────────────────
export interface Shard {
  id: ShardId
  anchorId: AnchorId
  index: number
  content: string          // the shard text (complete semantic unit, never fragmented)
  domain: string           // detected domain for MoE routing
  tokenEstimate: number
  assignedModelId?: string // which model received this shard in parallel block 1
}

export interface ShardManifest {
  anchorId: AnchorId
  shards: Shard[]
  createdAt: number
}

// ── Triadic Dialectical Pass ───────────────────────────────────────────────
export interface TriadicOutput {
  shardId: ShardId
  thesis: string        // strongest case FOR the shard's claims
  antithesis: string    // strongest case AGAINST the shard's claims
  middleGround: string  // genuine uncertainty map
  modelIds: {           // which model produced which perspective
    thesis: string
    antithesis: string
    middleGround: string
  }
  elapsedMs: number
}

// ── Abductive Connections ──────────────────────────────────────────────────
// A defensible non-obvious cross-domain connection. Only reaches this type
// if it survived the defensibility check — indefensible connections are
// discarded silently before construction.
export interface AbductiveConnection {
  id: string
  shardId: ShardId
  sourceDomain: string        // domain of the shard
  targetDomain: string        // domain of the found connection
  sourceContent: string       // what the connection was found for
  targetContent: string       // the content from the unrelated domain
  bridgeReasoning: string     // the argument for why these domains map
  structuralMirror: string    // what specifically mirrors what
  fragileAssumption: string   // what would make this connection break
  noveltyScore: number        // 0–1; high = non-obvious
  survivedDialectic: boolean  // was it challenged and survived?
  corpusChunkId?: number      // DB id of the source chunk
}

// ── Structural Resonances ─────────────────────────────────────────────────
export type EdgeType =
  | 'depends-on'
  | 'enables'
  | 'constrains'
  | 'contradicts'
  | 'analogizes'
  | 'scales-with'
  | 'emerges-from'

export interface ResonanceEdge {
  fromLabel: string
  toLabel: string
  type: EdgeType
  strength: number
}

export interface StructuralResonance {
  id: string
  shardId: ShardId
  matchedPattern: string           // description of the structural pattern found
  sourceDomain: string             // shard domain
  resonantDomain: string           // where the isomorphism was found
  resonantDescription: string      // what the resonant concept is
  edges: ResonanceEdge[]           // the mapped edge structure
  mappingConfidence: number        // 0–1
}

// ── Escalation Gate ────────────────────────────────────────────────────────
export type EscalationTier = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNVERIFIED'

export interface EscalationDecision {
  shardId: ShardId
  tier: EscalationTier
  calibrationScore: number   // 0–1 composite from triadic coherence
  escalated: boolean         // whether an external model call was made
  externalModelId?: string   // which model was called for escalation
  externalResult?: string    // the escalated shard content
  escalationMs?: number
}

// ── MoE Refinement ────────────────────────────────────────────────────────
export type SpecialistRole = 'researcher' | 'coder' | 'strategist' | 'critic'

export interface MoEAssignment {
  shardId: ShardId
  specialist: SpecialistRole
  reason: string             // why this specialist was assigned
}

export interface RefinedShard {
  shardId: ShardId
  index: number
  originalContent: string
  refinedContent: string     // the specialist's synthesis of all inputs
  specialist: SpecialistRole
  connections: AbductiveConnection[]
  resonances: StructuralResonance[]
  escalationTier: EscalationTier
  confidenceScore: number
}

// ── Calibration ────────────────────────────────────────────────────────────
export interface ReasoningPath {
  id: string
  fromDomain: string
  toDomain: string
  pathType: 'abductive' | 'structural'
  weight: number             // current confidence weight
  noveltyScore: number
  survivedCount: number      // times it survived dialectical pass
  failedCount: number
  lastUsedAt: number
  decayHalfLifeDays: number  // default 30
}

export interface CalibrationRecord {
  anchorId: AnchorId
  connectionIds: string[]    // which abductive connections were used
  pathIds: string[]          // which reasoning paths were exercised
  finalConfidenceScore: number
  userFeedback?: 'positive' | 'negative'  // thumbs up/down if provided
  recordedAt: number
}

// ── MASTERPIECE run result ─────────────────────────────────────────────────
export interface MasterpieceResult {
  anchorId: AnchorId
  synthesis: string
  shardCount: number
  abductiveConnectionsFound: number
  abductiveConnectionsSurvived: number
  structuralResonancesFound: number
  escalatedShardCount: number
  elapsedMs: number
  refinedShards: RefinedShard[]
  researchGapsDetected?: number   // Track R — shards where the corpus had no answer
  researchFindingsUsed?: number   // Track R — web findings folded into the dialectical pass
}

// ── Gate decision ──────────────────────────────────────────────────────────
// The gate is now a MODE SELECTOR, not an on/off switch. Light always runs;
// `mode === 'deep'` means the full pipeline also runs. The canonical definition
// lives in gate.ts; this re-export keeps a single import surface for consumers.
export type { GateDecision } from './gate.js'

// ── Light-mode enrichment ───────────────────────────────────────────────────
// A cross-domain connection found LOCALLY (no model call) by light mode. The
// bridge is a heuristic hint, not a model-defended argument — deep mode upgrades
// promising ones into full AbductiveConnections.
export interface LightConnection {
  sourceDomain: string        // detected domain of the prompt
  targetDomain: string        // domain of the resonant corpus chunk
  targetContent: string       // excerpt from the cross-domain chunk
  similarity: number          // cosine similarity that surfaced it
  noveltyScore: number        // 0–1, computed locally (see runMasterpieceLight)
  bridgeHint: string          // one-line plain-language description of the bridge
  corpusChunkId?: number
}

// The object light mode returns. Injected into the Stage 5 synthesis prompt as
// additional context and handed to deep mode so corpus queries are not repeated.
export interface EnrichedContext {
  anchorId: AnchorId
  promptDomain: string
  connections: LightConnection[]      // sorted by noveltyScore desc
  structuralPatterns: string[]        // canonical patterns the prompt participates in
  topNovelty: number                  // max noveltyScore across connections (0 if none)
  elapsedMs: number
  partial: boolean                    // true if the 500ms budget cut the query short
}

// ── Corpus chunk ───────────────────────────────────────────────────────────
export interface CorpusChunk {
  id: number
  docId: number
  content: string
  domain: string
  confidence: number
  embedding?: Float32Array
  source?: string
  ingestedAt?: number
}

// ── Injected dependencies (to avoid circular imports with server.ts) ────────
export interface MasterpieceDeps {
  callModel: (
    model: { id: string; label: string; provider: string; isWildcard: boolean },
    messages: { role: string; content: string }[],
    opts?: { requestId?: string }
  ) => Promise<string>
  selectModels: (
    promptType: string,
    config?: unknown,
    complexity?: 'simple' | 'complex',
    mode?: string
  ) => { models: Array<{ id: string; label: string; provider: string; isWildcard: boolean }> }
  withTimeout: <T>(promise: Promise<T>, ms: number, fallback: T) => Promise<T>
  requestId?: string
}
