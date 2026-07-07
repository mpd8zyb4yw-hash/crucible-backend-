// Track R — Intelligent Web Research + Gap Detection · public entry point
export * from './types.js'
export { detectGap } from './gapDetector.js'
export { classifyResearchDomain, selectSources } from './selector.js'
export { researchGapIfNeeded, researchTopic, formatEvidenceBlock, ingestResearchFindings } from './webResearch.js'
