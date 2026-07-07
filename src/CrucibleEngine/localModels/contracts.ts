// ── localModels/contracts.ts — FROZEN shared interface for the on-device ensemble ──
//
// Every module under src/CrucibleEngine/localModels/ codes against this file.
// Do not edit signatures here without a coordination note in COLLAB.md — other
// tracks build against these shapes independently.
//
// Provenance: drafted by Track B (2026-07-07) because Track A had not yet landed
// a contracts.ts when this track needed to start. If Track A lands a conflicting
// version, reconcile via COLLAB.md — this file is not precious, the interface
// stability is.

export interface LocalModelInfo {
  id: string
  family: 'smollm' | 'gemma' | 'apple-fm' | string
  params: number
  provider: 'local'
  quality: number
  fit: {
    coding: number
    reasoning: number
    creative: number
    factual: number
    math: number
    general: number
  }
  sizeBytes: number
  installed: boolean
  residentRAMBytes: number
}

export interface LocalModel {
  info: LocalModelInfo
  generate(prompt: string, opts?: { history?: { user: string; assistant: string }[]; signal?: AbortSignal }): AsyncIterable<string>
  health(): Promise<boolean>
}

export type FireMode = 'auto' | 'all' | 'single'

export interface RouteDecision {
  modelIds: string[]
  mode: FireMode
  reason: string
}

export interface ModelOutput {
  modelId: string
  text: string
  latencyMs: number
  ok: boolean
}

export interface StrengthenResult {
  answer: string
  contributors: string[]
  confidence: number
  method: string
}
