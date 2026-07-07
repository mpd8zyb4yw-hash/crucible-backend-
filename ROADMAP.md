# Crucible — Master Roadmap & Handoff

> **READ THIS FIRST — every model, every session, before any coding work.**
>
> This file is the single source of truth for what Crucible is, what exists, and what's
> planned. All previous handoff docs have been removed in favor of this one. Do not create
> new handoff/status docs — **edit and refine this file instead.**
>
> **Rules for working in this repo:**
> 1. **Verify, never guess.** Before marking anything `[x]` done, confirm the feature actually
>    exists AND is wired into the running server/UI — not just present as an unused module.
>    Grep for callers. A file existing is not the same as a feature shipping.
> 2. **Free-tier philosophy is sacred.** Crucible's whole premise is free models working
>    together, self-refining through the pipeline. Motto: "garbage in, gold out." If output is
>    weak, the fix is *more client-side processing* (planning, scoring, verification, polish,
>    context) — **never** swapping in a premium model.
> 3. **UI rules:** no emojis anywhere (UI or model output); no stock/external images (visuals
>    are self-authored: SVG/canvas/WebGL/CSS); text must stay inside its boxes (wordBreak);
>    animations ease in/out, fast and clean, not jarring.
>    **Mobile + desktop, always:** every UI change must work on BOTH form factors. Crucible is
>    mobile-first AND desktop-capable — when you touch layout, spacing, font size, tap targets,
>    or overflow, verify it holds at narrow (phone) and wide (desktop) widths. Use the existing
>    responsive primitives (e.g. `CollapsibleCode` collapses on mobile / expands on desktop,
>    media queries / `crucible-*` classes). Never ship a change that only looks right on one.
>    **Refinement preserves the UI shape:** when the verify/refinement pass updates an answer,
>    it must keep the original rendered layout (fenced code stays a code block, prose stays
>    prose) and change only the content — see `applyFixedCode()` in `src/App.tsx`.
> 4. **Run commands:** backend `nohup npx tsx server.ts > /tmp/crucible-server.log 2>&1 < /dev/null & disown`
>    (port 3001; plain `&` gets reaped between turns). Frontend: vite via `.claude/launch.json`
>    config `crucible-vite` (~port 5180). Never `npm run build`. Engine code under
>    `src/CrucibleEngine/` runs via `tsx`, not typechecked by the app tsconfig.
>
> Checkbox legend: `[x]` done & verified in code · `[~]` partial (note what's missing) · `[ ]` not built.

---

## AUDIT FINDINGS — June 13 2026

> **THE BASELINE RESET POINT. Read this before trusting any prior "verified" result.**

**Key architectural insight: the pipeline was unreachable on every non-conversational
request from the moment Track L was implemented until this audit.** A temporal-dead-zone
`ReferenceError` (`uncertaintyResult` used at line 1072, declared with `const` at line 1106)
threw on every request that wasn't caught by the M1 conversational early-return — which is
*every real query*. Express does not catch async throws, so the SSE stream hung open with no
`[DONE]`. Even when that was bypassed, a second crash (`decomposition.subtasks` undefined)
threw immediately after.

The practical consequence: **for the entire window between Track L landing and this audit,
no ensemble synthesis ever ran for a substantive prompt.** Every "answer" the system appeared
to produce in that window was single-model fallback or a hung stream — not the multi-model
debate-and-synthesize pipeline. Any track marked `[x]` "verified" by firing a real query
during that window was verified against a broken path and must be re-confirmed.

**This is the baseline reset point. Everything after the server restart that closed this
audit is the first time the real pipeline has actually run end-to-end on a real query.**

### Bugs found and fixed in this audit

- **[x] TDZ `ReferenceError` on `uncertaintyResult`** — used at `server.ts:1072`, declared with
  `const` at line 1106. `const` is not hoisted, so it threw on *every* non-conversational
  request *before the pipeline body even started*. This was the primary cause of "requests
  never complete." Fixed by hoisting the `lookupUncertainty()` declaration above first use.
- **[x] L2 interface mismatch** — the L2 block read `decomposition.subtasks` and `subtask.intent`,
  but `decompose()` returns `{ nodes }` where nodes have `.goal`. `undefined.length` threw in an
  unprotected gap. Replaced with a purpose-built `extractSubtasks(): string[]`.
- **[x] Decomposer regex missed parenthetical numbering** — the splitter only matched line-start
  `1.` / `1)` / `-`, never inline `(1) (2) (3)`, which is how most prose multi-part prompts
  (including the neuromorphic benchmark) are written. Result: 0 subtasks detected, L2 never fired.
  New extractor handles parenthetical, numbered, lettered, bullet, and connector formats, and is
  sequence-validated to reject false positives (`$4.99`, `Python 2.7`).
- **[x] Stage 5 synthesis payload overload, no token guard** — both synthesis builders joined
  *all* model responses uncapped. On a complex topic where 8 models each write ~800 words, the
  combined prompt exceeds free-tier context windows → provider `413 request too large`. Added
  `boundedSynthEntries()`: rank by score, cap per-model and total char budget.
- **[x] N3 domain injection mutated `workingMessage` before `decompose()`** — domain context was
  prepended to `workingMessage`, shifting the numbered list off position 0 and breaking the
  decomposer's structural matching. Fixed: decompose the *original* `message`, never `workingMessage`.
- **[x] `withTimeout` timer leak** — the timeout timer was never cleared when the wrapped promise
  won the race, so it fired a misleading `[withTimeout] Timed out` log after fast successes and
  held a timer for the full duration. Fixed with `.finally(clearTimeout)`.
- **[x] Agent handler had no try/catch around `runAgentLoop`/`runPlannedTask`** — a throw leaked the
  25s keepalive `setInterval` and hung the SSE stream. Wrapped in try/catch/finally so `endAgent()`
  always runs.
- **[x] No top-level safety net on the chat pipeline** — the L1/L2/domain/model-selection region
  (where the two crashes lived) had no catch ensuring `res.end()`. Any throw there hung the client
  forever. Added a pipeline-wide try/catch that emits an `error` event and closes the stream.

### New roadmap items from this audit

- **[~] Provider resilience target** — minimum 6 distinct providers, no single provider exceeding
  25% of the active pool, automatic rebalancing when a provider trips its circuit breaker.
  Candidate providers to add: Together AI, Cerebras, Cohere, Perplexity API, Fireworks AI, Deep
  Infra. *(This session: 5 providers wired into the registry + a generic OpenAI-compatible
  transport. Automatic rebalancing-on-trip not yet built.)*
- **[~] Automated smoke-test CI** — run the benchmark suite automatically at the start/end of every
  significant implementation session, before marking any track complete. This audit found a
  pipeline-breaking TDZ bug that sat undetected for hours; a 2-minute smoke test after each session
  would have caught it immediately. *(This session: benchmark suite added — `npm run smoke`. The
  run-it-automatically-every-session hook is not yet built.)*
- **[ ] Token budget guard** — no Stage 1 or Stage 5 model call should fire without a pre-dispatch
  token estimate check against the target model's context window. `413` errors should be
  *architecturally impossible*, not handled reactively by circuit breakers after the fact.
  *(The Stage 5 `boundedSynthEntries()` cap is a partial mitigation; the general pre-dispatch
  estimator is not built.)*

---

## ARCHITECTURAL NOTES — for future sessions

> Hard-won insights. Don't rediscover these the painful way.

- **Decompose the original `message`, never `workingMessage`.** Domain-context injection (N3) and
  prompt hardening (E2) rewrite `workingMessage` *before* decomposition would run. Prepending a
  `[Domain context: …]` header shifts the prompt's `(1) (2) …` structure off position 0 and breaks
  the decomposer's regex. Always decompose the original, unmodified prompt.
- **Stage 5 synthesis payload scales with `model_count × response_length`.** On complex technical
  topics, 8+ models each writing ~800 words overflows free-tier context windows (`413`). The
  governing principle: cap each model's contribution and/or limit to the top models by score.
  *(Currently implemented in `boundedSynthEntries()`: per-model cap 3000 chars, total budget
  12000 chars, ranked by score. Tune down toward ~600 chars/model or top-3-only if `413`s recur
  on a degraded pool.)*
- **Provider concentration is correlated-failure risk, not independent-failure risk.** Groq's daily
  limits and OpenRouter's per-minute TPM caps can *simultaneously* remove the majority of the
  high-quality pool. Circuit breakers handle individual model failures but do nothing for a whole
  provider going down at once. The mitigation is provider *diversity* (see Provider resilience
  target), not better per-model retry.
- **L2 decomposition threshold is 3+ subtasks.** A prompt with exactly 2 independent parts still
  runs the normal sequential pipeline. Consider lowering the threshold to 2 for long prompts above a
  token threshold, where even a 2-way parallel split is a meaningful latency win.
- **Verify Track I is actually wired before calling it complete.** The Critic (I5) is wired, but the
  meta-router (`runMetaRouter`, Track I) was *imported with zero invocations* anywhere in the
  request path — it was dead weight removed in this audit. "A file exists" ≠ "a feature ships."
  Grep for callers of every Track I component before marking the track done.
- **An SSE stream that hangs open with no `[DONE]` is the signature of a silent async crash.** When
  an unhandled `throw` occurs in async code *between* try/catch blocks in `server.ts`, Express does
  not catch it, the response is never ended, and the client waits forever. If a request hangs
  indefinitely, look for unprotected async code between try/catch boundaries — that is almost always
  where the throw is escaping.

---

## DEBUG INFRASTRUCTURE — How to Use It

> **This section is for developers and models working in this codebase.**
> The debug bus is invisible to end users. It runs in the background on every server
> request and is the fastest way to understand what the system is doing, trace an error
> to its source, or predict where a problem will occur next. Read this before grep-searching
> through source code.

### What it is

A central event bus (`src/CrucibleEngine/debug/bus.ts`) that every major subsystem emits
into. Events are stored in a 500-event in-memory ring buffer and broadcast to any SSE
subscribers in real time. A companion analyzer (`src/CrucibleEngine/debug/analyzer.ts`)
watches the stream and learns error patterns across sessions, persisting them to
`.crucible/patterns.json`.

### When you hit a bug — start here, not grep

**Step 0 — one-call full-system snapshot (do this first):**
```
npm run diag        # → curl -s http://localhost:3001/api/diag | python3 -m json.tool
```
`GET /api/diag` returns a complete snapshot of every subsystem in one response —
pipeline (requests/avg-score/cache-hit-rate/last-request), models (registry with
circuit state + tpm headroom + last-call per model), substrate (live viability
check + diversity score + standby pool + hot-swaps), masterpiece (light/deep fire
counts + last gate decision + novelty + corpus-hit-rate), anima (truth-store size +
avg confidence + last valence + recent truths), corpus (chunks/size/domains/gaps),
and the last 10 error events. Each block is independently guarded — one failing
subsystem yields `{ error }` for that block, never a 500. Counters are session-scoped
(reset on restart); persistent stats come from their own stores. This is almost
always enough to localize an issue without reading a single log line.

**Step 1 — get the live event stream:**
```
curl http://localhost:3001/api/debug/stream
```
This streams every event as it happens. You'll see `model_call → model_result → verify_start
→ execution_result(fail) → error_detected → fix_applied → verify_result` in order. The
causal chain shows you *exactly* which step broke and what error was classified.

**Step 2 — pull history if the server is already running:**
```
curl "http://localhost:3001/api/debug/history?n=50"
```
Returns the last 50 events as JSON. Look at `severity: "error"` entries first.

**Step 3 — trace a specific request:**
```
curl http://localhost:3001/api/debug/chain/<requestId>
```
Every event emitted during a single request shares the same `requestId`. Gives you the
complete A→B→C story for one verify or chat call.

**Step 4 — check model health:**
```
curl http://localhost:3001/api/debug/topology
```
Shows all registered models with their circuit-breaker state (`active` / `tripped` /
`probing`). If responses are degraded, a tripped provider is the first thing to check.

**Step 5 — check error patterns:**
```
curl http://localhost:3001/api/debug/patterns
```
Shows accumulated `(language, errorType)` statistics with auto-fix rates. If the same
SYNTAX error keeps escaping the algorithmic fixer, this is where you see it.

### All HTTP endpoints

| Endpoint | What it gives you |
|---|---|
| `GET /api/debug/stream` | SSE live feed — all events in real time |
| `GET /api/debug/history?n=N` | Last N events as JSON (default 100, max 500) |
| `GET /api/debug/chain/:requestId` | All events for one request, in order |
| `GET /api/debug/patterns?lang=X` | Learned error patterns + prediction for language X |
| `GET /api/debug/topology` | All models, providers, circuit states, uptime |
| `GET /api/debug/substrate` | Track Q: per-model viability fingerprints + provider/family spread |
| `GET /api/diag` | **One-call full-system snapshot** — every subsystem (pipeline, models, substrate, masterpiece, anima, corpus, errors) in a single JSON. Run `npm run diag`. Start here. |

### How to emit from a new module

```typescript
import { debugBus } from '../debug/bus'

// Basic event
debugBus.emit('category', 'event_type', { key: 'value' })

// With severity and requestId for causal chain linking
debugBus.emit('verify', 'my_check', { result: 'ok' }, { severity: 'success', requestId })
```

Categories: `model` | `pipeline` | `verify` | `execution` | `agent` | `tool` | `circuit` | `system`
Severities: `info` | `warn` | `error` | `success`

### How to subscribe from a new server module

```typescript
import { debugBus } from './src/CrucibleEngine/debug/bus'
import { debugAnalyzer } from './src/CrucibleEngine/debug/analyzer'

// Live subscription (returns unsubscribe fn)
const unsub = debugBus.subscribe(event => {
  if (event.severity === 'error') console.error('[ALERT]', event)
})

// Read patterns and predict likely errors before running code
const prediction = debugAnalyzer.predict('python')
// → { likelyErrors: [{ errorType: 'SYNTAX', probability: 0.6, suggestion: '...' }] }
```

### Key source files

| File | Role |
|---|---|
| `src/CrucibleEngine/debug/bus.ts` | Singleton event bus — ring buffer + SSE pub/sub |
| `src/CrucibleEngine/debug/analyzer.ts` | Pattern learner + causal chain builder |
| `src/DebugPanel.tsx` | Re-export shim (server-side import convenience) |
| `.crucible/patterns.json` | Persisted error pattern history (auto-created) |

### What the self-heal loop looks like in the bus

A successful auto-fix produces this event sequence (visible in `/api/debug/stream`):

```
verify    verify_start        info    { language, codeLen }
execution execution_result    error   { language, success: false, errorType: "SYNTAX" }
verify    error_detected      warn    { errorType, errorLine, fixStrategy: "close-bracket" }
verify    fix_applied         info    { strategy: "close-bracket", pass: 0, succeeded: false }
execution execution_result    success { language, success: true }
verify    fix_applied         success { strategy, succeeded: true }
verify    verify_result       success { passed: true, patchCount: 1 }
```

If you see `verify_result { passed: false }` after `model_fix`, all three rounds (algorithmic
× 2, model × 1) failed. The error type and the last `execution_result` error field tell you
exactly what to fix next.

---

## FOUNDATION — Complete (verified)

- [x] Multi-model parallel pipeline — `server.ts` Stage 1, parallel `callModel`
- [x] Interface contract anti-hallucination system — `src/CrucibleEngine/contract-generator.ts`
- [x] Adversarial cross-critique and synthesis — `server.ts` Stages 3–5
- [x] Circuit breakers and provider failover — `tripCircuitBreaker`, `.circuit-state.json`
- [x] Complexity classifier and fast-path — `complexity` flag, simple-path early exit
- [x] Predictive pre-warm on keypress — `/api/prewarm`, `App.tsx handleInput`
- [x] Agentic loop with plan/act/observe/repeat — `src/CrucibleEngine/agent/loop.ts`, `driver.ts`
- [x] Self-healing verification with failure fingerprinting — `/api/verify`, `error-intelligence.ts`
- [x] Ensemble-as-tool (scoring pipeline as callable worker) — `ensemble_solve` tool in loop preamble
- [x] Checkpoint and rollback system — `checkpoint.ts`, `.crucible-checkpoints.json`
- [x] Live agent UI (todos, diffs, terminal, verify badge) — `App.tsx AgentPanel`

## SECTION 8 — State, Memory, Safety  *(mostly built — verify before extending)*

Implementation lives in `src/CrucibleEngine/state/session.ts`, wired into the agent path in `server.ts` (~line 455).

- [x] Per-project `.crucible/` data directory — `crucibleDir()`, dir exists & used
- [x] Resumable sessions — `latestResumable()`/`saveSession()` wired into `/api/chat` agent path
- [x] Project memory (`memory.md`) — `readMemoryDigest()` injected at agent start; `appendMemory()` records verify commands. **Partial gap:** automatic capture of build/test commands & conventions is minimal — only verify commands are written so far.
- [~] Permission gates — writes outside `projectPath` ARE blocked at the tool layer (`tools/registry.ts` `resolveSafe`). **Missing:** the `isWriteAllowed()`/`Permissions` API in `session.ts` is still unused dead code; an interactive "confirm to override" path is not built (autonomous server-side mode has no confirm channel — current model is block-by-default + opt-in flag).
- [x] Destructive op confirmation (delete, force-push, outside-root writes) — `destructiveReason()` in `tools/registry.ts` blocks `rm -rf`, force-push, `reset --hard`, `git clean -f`, `sudo`, `dd`/`mkfs`, recursive chmod/chown, power control, fork bombs, etc. Blocked by default in the `run` tool; opt in via `ctx.allowDestructive`. 20/20 detector tests pass.

---

## TIER 1 — Productization  *(Months 1–2, ~$80K)*

### Deployment
- [ ] Move from Electron to web SaaS
- [ ] Auth system (email + GitHub OAuth)
- [ ] Usage tiers and billing
- [ ] Onboarding that works without a terminal
- [ ] Real domain, SSL, production infra

### Data Foundation
- [ ] Opt-in user data collection with explicit consent
- [ ] GDPR compliant (critical for EU/Italy)
- [ ] Every query stores: prompt, all responses, scores, winner, critique, synthesis (the training-data flywheel)
- [ ] Pipeline rounds already persist to `.crucible/history.json` (capped 200) — this is the raw flywheel data.
      Unlocking it = consent layer + cloud sync + the Flywheel special track (smarter routing, specialization
      memory, response genealogy, prompt hardening, quality predictor — see below)

### Performance
- [~] Exact response cache (hash-matched instant replay) — `responseCache` exists in `server.ts` (`cached` flag surfaces in UI). Verify hashing covers mode/prompt fully before marking done.
- [x] Semantic cache (paraphrase match returns cached with note) — `server.ts`: on exact-cache miss, `semanticLookup()` scans cached queries by content-word token-cosine (`vectorize` + `cosineSim`, minimal plural-`s` stemmer, stopword-filtered) and replays the best match ≥0.82 similarity, tagging events `cached + semantic`. Local & instant, no premium model (per philosophy); cosine/vec isolated so a real embedding backend can drop in later. UI: the cached badge reads `similar · N%` with the matched query in a tooltip. Verified: 7/7 paraphrase/distinct-intent test matrix + live hit (1.00 on "What is the capital of France?" ≈ "Tell me the capital of France").
- [x] Response-time dashboard per model per provider — `recordLatency()` in `_emitModelResult`; rolling 50-sample window; `GET /api/debug/latency` returns avg/p50/p95 per model sorted by avg latency

## TIER 2 — The Moat Deepens  *(Months 2–3, ~$100K)*

### Autonomous Background Improvement
- [x] `src/CrucibleEngine/autoImprove.ts` — non-blocking, debounced 5s after each pipeline round
- [x] Identifies top entries by composite score (top 5% threshold from quality-history, min 0.80)
- [x] Extracts tier-2 KnowledgeEntry from top entries, calls `addApprovedEntry()`, persists to `.crucible/learned-patterns.json`; loaded into scoring engine at startup via `loadAdditionalEntries()`
- [x] Scoring weights: nudges `ScoringConfig.weights` ±0.01 based on promptType distribution of top-vs-bottom entries; bounded (similarity 0.20–0.50, functional 0.30–0.60, novelty 0.10–0.35); persists to `.crucible/scoring-weights.json`
- [x] `SCORING_CONFIG` in server.ts merges DEFAULT_SCORING_CONFIG with learned weights; reloaded after each round and at startup; all `evaluateIteration` calls use it
- [x] Every `.crucible/` change committed to git with `[autonomous]` prefix + ISO timestamp
- [x] Rollback: if `qualityPredictor.stats().trend === 'down'`, `rollbackIfDegraded()` reverts last autonomous commit
- [x] `GET /api/autonomous/status` — projectRoot, lastAutoCommitHash, current weights

### The Drift Prevention Triumvirate
- [x] Three specialized judge models running in parallel — `src/CrucibleEngine/triumvirate.ts`
- [x] Each pre-prompted with a distinct mandate: STABILITY (destabilization risk), EFFICACY (evidence quality), DIVERSITY (ensemble breadth)
- [x] They debate every proposed autonomous change before it commits — judges run in parallel, 8s timeout, conservative REJECT on failure
- [x] Unanimous approval (3/3) required for scoring-weight changes
- [x] Majority (2/3) required for knowledge-base pattern additions
- [x] Full debate log stored in `.crucible/triumvirate-log.json` (capped 200 entries); `GET /api/autonomous/debates`
- [x] Pending proposal queue — proposals that fail review (no models available, all judges timed out) saved to `.crucible/triumvirate-pending.json`; retried at the top of every subsequent improvement pass; auto-cleaned after 7 days or 5 retry attempts

### Fine-tuned Worker Model
- [ ] Fine-tune Llama 3 8B / Mistral 7B on curated gold-standard responses
- [ ] Host on Hugging Face Spaces (credentials already in stack)
- [ ] Route complex edge cases to this model as a specialized worker

### Cloudflare Edge Inference
- [ ] Route fast simple queries to Cloudflare Workers AI (creds already in `.env.local`)
- [ ] Sub-100ms responses for classified simple queries (free tier)

## TIER 3 — Distribution  *(Months 3–4, ~$120K)*

### VS Code Extension
- [ ] Right-click any function → run through ensemble
- [ ] Inline diff viewer (what changed and why)
- [ ] Agent loop accessible from command palette

### GitHub Action
- [ ] `crucible-review` on every PR automatically
- [ ] Scores the diff against contract
- [ ] Posts critique as PR comment + suggests improvements before merge

### Public API
- [ ] `POST /v1/score` — submit code, get composite score + critique
- [ ] `POST /v1/ensemble` — run the full adversarial pipeline
- [ ] Tiered pricing — free for open source, paid for commercial

### Opt-in Distributed Compute
- [ ] "Contribute your idle GPU, get free premium access" (explicit opt-in at onboarding)
- [ ] Small quantized model shards distributed across opted-in devices
- [ ] Aggregated back to central model during low-usage windows

## TIER 4 — Enterprise  *(Months 4–6, ~$200K)*

### Self-hosted Deployment
- [ ] Docker container, one-command install
- [ ] Bring your own API keys
- [ ] Air-gapped deployment option

### Enterprise Features
- [ ] SSO (SAML, Okta, Active Directory)
- [ ] Audit logs for every agent action
- [ ] Role-based permissions
- [ ] Custom model registry (plug in internal models)
- [ ] SLA + dedicated support

### Project Intelligence
- [ ] Index entire codebase on first run
- [ ] Persistent semantic understanding of architecture
- [ ] Every response informed by actual codebase, not generic knowledge
- [ ] Remembers conventions/patterns/decisions across sessions

## TIER 5 — The Organism  *(Month 6+, ongoing)*

### Recursive Self-Improvement Loop
- [ ] Background process running 24/7
- [ ] Identifies gold-standard outputs automatically
- [ ] Routes them through drift-prevention triumvirate
- [ ] Approved patterns integrated into knowledge base
- [ ] Scoring weights updated autonomously (with full audit trail + human override)

### Training Data Marketplace
- [ ] Accumulated scored query/response pairs become a sellable asset

### Model Evolution
- [ ] Fine-tuned worker model improves with every user session
- [ ] Scoring engine tunes itself on real usage patterns
- [ ] Classifier improves from actual query distributions

---

## SPECIAL TRACK — The Flywheel  *(every query compounds)*

> Every query that runs through Crucible generates a scored dataset: prompt, all model responses,
> scores, winner, critique, synthesis. Six months of real usage produces something no amount of
> money can buy quickly. These tracks are how that raw data becomes compounding advantage.

### Smarter Routing (replace regex classifier)
- [x] `classifyPrompt` now tries k-NN (k=5) over `.crucible/classifier-history.json` before falling back to regex
- [x] Feature vector: tf-normalized token cosine; min 20 samples + min 0.25 cosine similarity before k-NN overrides regex; majority-vote confidence gate (>50% weight) prevents uncertain overrides
- [x] `learnClassification(message, promptType)` called on every pipeline round — history grows automatically
- [x] `GET /api/classifier/stats` — sampleSize + learnedActive flag
- [ ] Label source is currently regex-derived — improve by back-labeling from winning model's promptType fit when score clearly wins one category

### Model Specialization Memory
- [x] After each completed round, write `(model_id, query_type, score)` to `.crucible/specialization.json` — EMA (α=0.2) smoothing via `recordSpecialization()` in `modelRegistry.ts`
- [x] `getSpecializationWeights(queryType)` returns per-model EMA score for that category
- [x] `selectModels` in `modelRegistry.ts` applies the bias at selection time — `specBias = 1 + (ema - 0.5) * 0.15` (±4.5% at extremes, additive to existing score)
- [x] Tracks all PromptType categories: coding / reasoning / creative / factual / math / general
- [x] Surfaces in `/api/debug/topology` — e.g. `"Qwen3 32B: factual +14.0% · creative -3.0%"`
- [x] Exponential decay with 60-day half-life: EMAs drift back toward neutral (0.5) based on time since last call. Timestamps stored in `.crucible/specialization-ts.json`. Prevents early-winner lock-in. `recordSpecialization` applies decay before blending new score.

### Response Genealogy
- [x] After Stage 5, run attribution pass: split synthesis into sentences (>20 chars), cosine-match each to best model response using existing `vectorize`/`cosineSim`
- [x] `attribution: { sentenceIdx: modelId }` and `contributionRates: { modelId: fraction }` stored alongside each history entry in `.crucible/history.json`
- [x] Synthesis survivors get an extra specialization signal: `recordSpecialization(id, promptType, 0.5 + rate * 0.5)` — models that actually make it into the answer get stronger bias than Stage 1 score alone
- [x] Emits `genealogy_computed` to debug bus with contribution rates per request
- [x] Feeds specialization memory — models that never survive into synthesis get no contribution signal even if they scored well

### Adversarial Prompt Hardening
- [x] Before Stage 1, rewrites prompt via fastest non-tripped Groq model with precision-extraction prompt
- [x] `workingMessage` (hardened) is what models receive; `message` (original) kept for display, history, polish, and cache key
- [x] Falls through silently to original on any failure or >2s timeout — never blocks the pipeline
- [x] Controlled by feature flag `PROMPT_HARDENING=true` in `.env.local`
- [x] Emits `prompt_hardened` event to debug bus when active
- [ ] A/B score the hardened vs raw prompt on the first 100 queries to validate the lift

### Cross-Session Quality Predictor
- [x] `src/CrucibleEngine/qualityPredictor.ts` — same architecture as debugAnalyzer; persists to `.crucible/quality-history.json` (max 500 entries)
- [x] Feature vector: tf-normalized tokens (0.7 weight) + structural scalars: lengthBucket, hasCode, questionCount, isComplex, wordCount (0.3 weight)
- [x] `qualityPredictor.predict(prompt)` — k-NN (k=7) returns `{ predictedScore, confidence, recentAvg, trend, sampleSize }`
- [x] Wired into pipeline: `confidence < 0.3 && sampleSize > 10` → force full pipeline (overrides 'simple' classification); `confidence ≥ 0.5 && predictedScore ≥ 0.8` → lower early-exit threshold 0.85→0.75
- [x] `qualityPredictor.record(prompt, compositeScore, promptType)` called after Stage 5 with the mean Stage 1 composite score
- [x] `GET /api/debug/quality` — sampleSize, recentAvg, trend

---

## SPECIAL TRACK — Autonomous Model Hunter

- [x] Fetch full OpenRouter free model list — filters for `pricing.prompt === 0 && pricing.completion === 0`, text-only modality, IDs not already in registry (`src/CrucibleEngine/modelHunter.ts`)
- [x] Probe-call each candidate — POST to `/chat/completions` with "Reply with exactly: ok", 8s timeout, pass = non-empty non-error response
- [x] Add passing models to registry automatically — persisted to `.crucible/discovered-models.json`, live-injected into `MODEL_REGISTRY` on discovery and on every server start
- [x] Runs once at startup (30s delay) then every 24h; up to 8 candidates per run; `POST /api/hunter/run` for manual trigger; `GET /api/hunter/status` for discovered list
- [ ] Scrape HuggingFace leaderboards and research papers for candidates beyond OpenRouter
- [ ] Use Crucible's own pipeline to evaluate new models (dog-fooding quality gate) before adding

> Note: the lighter `refreshFreeModels()` still runs every 6h to update `free` flag on already-registered OpenRouter models.

## SPECIAL TRACK — Speed (free-models-only)

- [x] Pre-warm — keypress `/api/prewarm` + continuous rolling keepalive every 4 min (`runKeepaliveRound`, `server.ts`). All registry models pinged with staggered 3 s delay; tripped circuit breakers skipped.
- [x] Rate-limit handling — reactive circuit breakers PLUS *predictive* rate management: `predictProviderLoad()` in `modelRegistry.ts` measures per-provider request velocity (15 s window → per-min rate), projects load 10 s ahead, and the selection penalty now reacts to *projected* fill, not just current count — load shifts off a provider before it hits its soft cap. Exposed via `GET /api/debug/ratelimit` + `providerLoad` in topology; keepalive emits `ratelimit_warning` to the debug bus for at-risk providers.
- [x] Speculative stage execution — `maybeSpeculate()` in `server.ts` Stage 1: when a leader finishes with a dominant score (≥0.85, forcing early-exit) or any simple-path leader lands (both skip Stage 3+4), synthesis starts *immediately* on the responses gathered so far, overlapping the synth call with the dead wait for stragglers. At Stage 5 the speculative result is COMMITTED iff its input id-set exactly matches the final synthesis input set (stragglers dropped/rolled back) — else DISCARDED and synthesised normally. Free-tier so a wasted call costs nothing; the win is hiding synth latency behind Stage 1. Verified live: all three paths fire (`speculative_synthesis_start/hit/miss` on the debug bus) and the final answer is correct on both hit and miss.
- [x] Partial/streaming scoring — `provisionalScore()` in `server.ts` Stage 1 runs a cheap, deterministic heuristic (length-completeness · structure (code-fence/sentences) · prompt-keyword relevance · stub/refusal penalty) on the *partial* text as it streams, re-scored every ~200 chars. Emitted on the `layer1` event as `{ score, provisional: true }`, which the existing client handler already applies — so the score bar fills live (verified: 0.31→0.52→0.73→0.80 as a response builds) instead of snapping to a value only when the model finishes. The authoritative `evaluateIteration` score still overrides on `done`.
- [x] Explicit KV-cache optimization — `withStaticPrefix()` in `server.ts` prepends ONE byte-for-byte identical `STATIC_PREAMBLE` (global rules, marker `[[crucible-core-v1]]`) to the system message of *every* call (both `callModel` and `callModelStreaming`), same text and position every time, so providers' prefix KV caches hit across requests. Variable per-call content (contract/aspect/codebase/question) follows the shared prefix. Idempotent via the marker. The rolling keepalive pings carry the same preamble, so they actively keep this prefix warm. Verified: prose + directive-constrained queries return correctly with the prefix in force.

## SPECIAL TRACK — Fluidity / Perceived Speed

- [x] Predictive stage labels — top bar shows active stage + "then {next}" hint. Pure client-side inference from round state.
- [x] Stream everything — synthesis streams token-by-token (`synthesis_token` events) with a blinking cursor; Stage 3+4 critique-and-revise streams per chunk (`critique` events); polish replaces streamed draft with `replace: true` flag. True token streaming wired for all providers: Groq (per-chunk), Mistral (per-chunk), OpenRouter (SSE), HuggingFace (SSE), Gemini (`sendMessageStream`); Cloudflare stays batched (fast small models).
- [x] Instant first token — `{ type: 'thinking' }` emitted immediately on request before any async work.

## SPECIAL TRACK — AGI-adjacent gaps

The working definition driving this: *a system that takes an arbitrary goal, decomposes it,
acquires the tools it needs, executes autonomously, verifies its own output, and improves from
the experience.* Crucible is bottom-up (agency layer first), which is the differentiator.

- [x] **Gap 1 — Goal autonomy:** `src/CrucibleEngine/goalEngine.ts` — six analyzers (quality by prompt type, error recovery rates, model underperformance, weight drift, triumvirate calibration, coverage gaps) scan all `.crucible/` data and produce a ranked `ImprovementGoal[]`. `autoImprove.ts` runs this after each pass and logs the top goal; `saveGoalReport()` persists to `.crucible/goals.json`. `GET /api/autonomous/goals` serves it. Verified: 7 distinct goals generated from synthetic data covering all 6 categories.
- [x] **Gap 2 — Tool acquisition:** `src/CrucibleEngine/tools/dynamicTools.ts` — agent calls `create_tool` with a name, description, params schema, and JS body; body compiled via `vm.Script` (syntax error caught immediately), then `AsyncFunction` with `require` injected; registered live in current session + persisted to `.crucible/dynamic-tools/<name>.json`; loaded back at every server start via `loadDynamicToolsInto()`. `list_dynamic_tools` lets the agent inspect its earned toolkit. `tool_created` event surfaced in agent UI. Agent preamble tells it when and how to use it.
- [x] **Gap 3 — Persistent world model:** `src/CrucibleEngine/state/codebaseIndex.ts` — walks project on first agent run, extracts symbols + imports deterministically (no model calls), persists to `.crucible/codebase-index.json`. Incremental on subsequent runs (mtime-gated). Top-K relevant files retrieved by cosine similarity and injected into every agent system preamble. `reindexFiles()` called from `write_file`/`edit_file`/`apply_patch` via `onFileMutated` hook so the index stays live as the agent mutates files. `GET /api/debug/codebase?q=<query>` for inspection. 58 files indexed on Crucible itself in <50ms.
- [x] **Gap 4 — Meta-learning:** `triumvirate.ts` extended with `recordTriumvirateOutcome()`, `runMetaLearning()`, `effectiveThresholds()`. After each `autoImprove` pass, quality snapshots + approval/rejection counts are recorded; `runMetaLearning()` correlates outcomes with decisions: approvals preceding quality drops → tighten weight_change multiplier; near-total rejection with flat quality → relax knowledge_pattern multiplier; quality trending up → restore toward baseline. 3h cooldown prevents thrashing. `GET /api/autonomous/meta` exposes full state + effective thresholds. Verified: tighten and relax scenarios both fire correctly.
- [ ] **"Goal, not prompt" demo:** e.g. "Make my API 3x faster" → index, find bottlenecks, plan, execute, benchmark, verify, commit, write PR, post — zero prompts after the first. Missing pieces: autonomous goal decomposition + codebase-indexing trigger.

---

## THE REAL GAP — What separates this from AGI, and how to close it

> This section is the long game. It is not a feature list — it is a theory of what genuine
> machine intelligence requires, mapped onto concrete Crucible implementations. Read before
> coding anything in this space.
>
> The core diagnosis: every model in the pipeline operates on *text about the world*, not
> the world itself. The models cannot be wrong in a useful way — when they fail, we route
> around the failure. We do not yet extract signal from it. That is the gap.

---

### TRACK A — Grounding: closing the verify loop against reality

The pipeline currently verifies code (sandbox) and scores text (heuristics). Most questions
don't admit code execution. The breakthrough is making verification as wide as the question.

**A1 — Domain-specific verifiers [x]**
Each prompt type gets a verification strategy beyond "does it look correct":
- *math/reasoning*: extract all numeric claims and equations from the synthesis, run them through a symbolic solver (mathjs / python sympy via sandbox) — if the solver disagrees with the synthesis, flag and trigger a re-roll. A model that says "3x + 5 = 14 so x = 4" can be checked mechanically.
- *factual*: after synthesis, extract entity + claim pairs (structured via a fast model), then search each claim against DuckDuckGo and cross-reference. Flag syntheses that contradict search results above a confidence threshold.
- *code*: already done — sandbox + multi-model fix tournament. Extend to linting (eslint/pylint scores), type-checking, and test coverage as secondary signals.
- *creative*: no ground truth — verifier checks internal consistency (character names, timeline, described physics) rather than external truth.
Implementation: `src/CrucibleEngine/verifiers/` — one file per domain, all called from a `domainVerify(promptType, synthesis, original)` function in Stage 5b before polish.

**A2 — Counterfactual branching [x]**
When the synthesiser produces a confident answer on a factual or reasoning question, spawn a
second "adversarial synthesiser" with the same inputs but a system prompt that says "assume
the top answer is wrong — build the strongest possible alternative." If the adversarial answer
is equally plausible, the original was overconfident. Flag it, lower the synthesis score, and
surface "uncertain" to the user instead of a false definitive.
The signal this generates is more valuable than the verification: *a pair of plausible
conflicting answers is training data that identifies exactly where the models are unreliable.*

**A3 — Live world-state injection [x]**
Certain question classes have answers that change with time (prices, weather, current events,
library versions, who holds an office). The pipeline should detect these via a classifier
(`isTimeDependent(message)`), inject a live web search result as a grounding block before
Stage 1, and tag the synthesis as "grounded [date]" vs "from training data."
This prevents confident stale answers — one of the most common failure modes in production.

**A4 — Execution traces as evidence [x]**
For code responses, after the sandbox runs the code, capture stdout/stderr, any test output,
and the final exit code. These execution traces are injected into the synthesis context so
the synthesiser is writing about *what actually happened*, not what it predicts will happen.
"Here is the code and its output" produces dramatically better explanations than "here is
the code" because the model can reason about the actual runtime behaviour.

---

### TRACK B — Recursive self-modeling: the pipeline reads itself

The pipeline logs everything. Nothing currently reads those logs and changes the pipeline.

**B1 — Pipeline self-patcher [x]**
The agent has tools. Give it a specific mode: "read the last 100 debug events, identify the
stage that most frequently precedes a low-score synthesis, and propose a prompt change for
that stage." The proposal goes through the triumvirate. If approved, the patch is applied
to a config file that overrides stage prompts at runtime — no code deploy needed.
This is the first level of genuine self-improvement: the system patches its own prompts
based on evidence from its own operation, not from our guesses about what's wrong.
Implementation: `src/CrucibleEngine/selfPatcher.ts` — reads `debugBus.history()`, groups by
`requestId`, correlates pipeline stages with final scores from `quality-history.json`,
identifies the weakest stage, drafts a prompt patch, routes to triumvirate, applies on approval.

**B2 — Failure taxonomy builder [x]**
Today: `debugAnalyzer.ts` accumulates `(language, errorType)` stats. Extend to all prompt
types and all pipeline stages. After 500+ queries, cluster the failure modes automatically
(cosine similarity on error descriptions → k-means into ~10 clusters). Each cluster becomes
a named failure mode: "confident but unverifiable", "code runs but doesn't match intent",
"synthesis contradicts one model that was actually right", etc.
Once named, the system can *track whether each failure mode is declining over time*. That is
the metric that tells you whether self-improvement is real or illusory.

**B3 — Stage weight learner [x]**
The scoring engine weights (similarity, functional, novelty) are updated by `autoImprove`.
The stage weights — how much time/compute to spend on each stage — are static. The self-model
version: track which stages produce measurable score lifts per query type. If Stage 3+4
critique-and-revise consistently produces <0.02 score improvement on factual queries but
>0.12 on reasoning queries, the system should learn to skip Stage 3+4 on factual queries
and spend the saved latency on a second Stage 1 model call instead. Each pipeline
configuration is a hypothesis; the system tests it against the quality predictor.

**B4 — The meta-pipeline: Crucible improves Crucible's code [x]**
The agent can already read and edit files. The self-improvement version: a background job
runs weekly, reads the debug bus failure patterns, identifies the top-3 recurring failure
modes, spawns an agent session targeting each one with the goal "reduce the rate of this
failure mode by modifying the pipeline code", runs the full test suite (via the sandbox),
and only commits if tests pass and the quality predictor shows a positive trend. The commit
message cites the failure mode it's addressing.
This is not science fiction — it is exactly what `runAgentLoop` already does, pointed at
`server.ts` instead of a user's project. The infrastructure is built. The missing piece is
the scheduling and the automated quality gate.

---

### TRACK C — The ensemble as a learning organism

**C1 — Automatic roster rotation [x]**
After every 200 queries, compute each model's *net contribution rate* from the genealogy
data (`contributionRates` in `history.json`). Models whose contribution rate has been below
5% for 3 consecutive windows are "benched" — removed from the active ensemble and replaced
by the next available discovered model from the hunter. Benched models are not deleted —
they are re-probed after 7 days. If their probe score improves (model was updated upstream),
they re-enter the rotation.
Result: the ensemble composition self-optimises toward the models that actually survive into
final answers, not the ones we pre-rated highest at registration time.

**C2 — Specialization forcing [x]**
Today: specialization memory biases selection ±4.5%. The forcing version: once a model's
EMA exceeds 0.85 in a category for 50+ queries, it becomes the *mandatory first call* for
that category — not a biased candidate, but the definitive lead. Other models critique and
revise its output instead of generating from scratch. This is architecturally closer to
how expert panels work: the domain expert answers first, generalists challenge it.
Implementation: `selectModels` gains a `forceLeader` path that returns the specialist as
`models[0]` with a flag; Stage 1 runs it first and streams its response before launching
the parallel generalist calls.

**C3 — Cross-model knowledge distillation [x]**
When model A scores 0.95 on a question and model B scores 0.40, the delta is information.
Extract the structural difference between A's response and B's response — what did A do
that B didn't? Token overlap, sentence structure, reasoning steps present in A but absent
in B. Log these deltas to a `distillation.json` file. Over time, this file becomes a
description of "what good answers look like" derived entirely from empirical comparison,
with no human labelling. Inject the top-10 distilled patterns into the synthesis system
prompt as implicit quality guidelines. The synthesis model learns what "good" means from
the ensemble's own performance history, not from our intuitions.

**C4 — Ensemble size as a function of question difficulty [x]**
Today the ensemble size is fixed by `PIPELINE_CONFIG.parallelCount`. The adaptive version:
the quality predictor estimates confidence before Stage 1. High confidence (>0.8) → 2
models, fast path. Medium confidence (0.5–0.8) → default 4 models. Low confidence (<0.5) →
6–8 models, all stages active. The ensemble expands exactly where it's needed and contracts
where it's wasted. This both reduces latency on easy questions and improves quality on hard
ones — the two goals currently in tension.

---

### TRACK D — Memory as a world model

**D1 — Structured entity graph (replacing bullet-list memory) [x]**
Today: `world.md` and `memory.md` are flat lists of facts. Replace with a JSON graph:
nodes are entities (user, projects, files, people, tools, patterns, decisions), edges are
typed relationships (uses, prefers, built, fixed, owns, knows). After each agent session,
a "memory extractor" model reads the conversation and writes new nodes/edges as structured
diffs to `.crucible/world-graph.json`.
At session start, a "graph query" step finds the subgraph relevant to the current goal
(breadth-first from the "current project" node) and injects it as structured context.
The emergent behavior: the system starts noticing connections the user didn't ask for.
"This looks like the same architectural pattern you used in project X, which you later
refactored because of Y" — that is not in a bullet list. It requires traversing a graph.

**D2 — Decision memory with outcome tracking [x]**
Every time the agent makes a significant decision (chose library X, used pattern Y, fixed
bug Z by doing W), log it to `.crucible/decisions.json` with the rationale and the context.
After each session, revisit open decisions: did the choice work out? Read the debug bus,
the test results, the user's reactions. Mark decisions as "validated", "regretted", or
"superseded." Over time the system builds a private knowledge base of *what works in this
codebase specifically*, not generic best-practices. A decision marked "regretted" triggers
a proactive note the next time a similar context arises.

**D3 — Compressed episodic memory [x]**
Global memory (`world.md`) stores facts. What's missing is *episodic* memory — "I remember
when we did X" — which is different from knowing a fact. After each session, run a
summarisation pass: reduce the full session to 3–5 sentences capturing the goal, the
approach taken, the surprising thing that happened, and the outcome. Store these summaries
in `.crucible/episodes.json` (capped at 100, evict oldest). Inject the 3 most semantically
similar episodes at the start of each new session. This gives the system a sense of history
and continuity that bullet-list facts can't provide.

**D4 — Preference learning from implicit signals [x]**
Don't ask the user what they prefer. Infer it. Signals: which synthesis the user accepted
without follow-up (strong positive), which they immediately rephrased (weak negative), which
triggered "no, what I meant was" (strong negative), how long they spent reading before
responding. Map these signals to prompt features (length, code vs prose, step-by-step vs
summary, formal vs conversational). Train a lightweight preference model (logistic regression
over these features, no LLM needed) that biases the polish pass toward the user's inferred
style. The user never fills out a preferences form — the system just gradually starts
sounding more like what they want.

---

### TRACK E — The scientific method: hypothesis, experiment, update

**E1 — A/B infrastructure for pipeline changes [x]**
Before shipping any pipeline change (new prompt, new stage, new model), run it in shadow
mode: a random 10% of queries get the new pipeline, 90% get the current one. Track quality
predictor scores for both cohorts. After 50 queries, test for statistical significance
(Welch's t-test on score distributions). Auto-promote if p<0.05 and effect size >0.03.
Auto-revert if the new pipeline is worse at p<0.1. This is the missing scientific rigour:
no change ships because it seemed like a good idea — changes ship because they demonstrably
work on real queries. This infrastructure also makes every item in this roadmap testable
rather than aspirational.

**E2 — Prompt hardening A/B (partially built) [x]**
The adversarial prompt hardening pass (`PROMPT_HARDENING=true`) is built but unvalidated.
Wire it into the A/B infrastructure: randomly enable hardening per query, record `hardened`
flag in quality history, compute mean composite score for hardened vs raw prompts over the
last 200 queries, expose via `GET /api/debug/hardening-ab`. If lift is negative, auto-disable.

**E3 — Benchmark suite that runs continuously [x]**
A set of 50 canonical questions with known correct answers (across all prompt types) stored
in `.crucible/benchmarks.json`. After each pipeline change, run the full benchmark suite
in the background and record pass rates per category. This is the regression test for
quality — equivalent to a unit test suite but for answer quality. Any change that drops
benchmark scores by >5% in any category triggers an alert to the debug bus.
The benchmarks themselves should evolve: every time the system gets a question wrong that
it has never seen before, add a minimal version of that question to the benchmark suite.
The suite grows to cover the system's actual blind spots.

---

### TRACK F — Fine-tuning: closing the real learning loop

Everything above improves routing and prompting. The real loop is: the models themselves
learn from Crucible's accumulated gold-standard data. This is the moat that compounds.

**F1 — Gold-standard dataset curation [x]**
Define "gold standard": a query where the top synthesis score was >0.85, the verify pass
was clean, and the user did not immediately rephrase. From `history.json`, filter these
entries. Strip to `(prompt, response)` pairs. This dataset already exists in embryonic form
after a few hundred queries — it just isn't labeled and exported yet.
Implementation: `GET /api/export/gold-standard` — returns JSONL in OpenAI fine-tuning
format, filtered by quality threshold. The data exists; the endpoint is a one-hour build.

**F2 — RLHF signal collection [x]**
Add a minimal feedback mechanism to the UI: a thumbs-up / thumbs-down on each synthesis
(no other UI — just two buttons, barely visible). Store `(query, synthesis, vote)` to
`.crucible/feedback.json`. This is the most valuable 10 lines of UI ever written because
it converts user corrections into a training signal that isn't available anywhere else.
Do not show scores, do not gamify — the signal degrades if users optimise for it.

**F3 — Continuous fine-tuning pipeline [x]**
Connect the gold-standard dataset to a free fine-tuning pipeline:
- HuggingFace AutoTrain (free tier, Llama 3 8B) — runs on their hardware, costs nothing
- Output: a fine-tuned model hosted on a HuggingFace Space
- This model becomes the new "synthesis specialist" — highest weight on synthesis, not
  just another ensemble member. It's literally trained on what Crucible users consider
  good answers.
After 1000 gold-standard pairs, the first fine-tune run produces a model that is
demonstrably better than any base model on the exact query distribution it sees. That is
the point where Crucible becomes categorically different from any other AI tool: it has
a model that learned from *your usage*, not from the internet in general.

**F4 — Synthetic data generation from failure modes [x]**
The failure taxonomy (Track B2) identifies clusters of questions the system gets wrong.
For each cluster, generate synthetic training examples: take the wrong answer, generate
the correct answer via the highest-quality available model (or human correction), create
a `(question, wrong_answer, correct_answer)` triple. Use this for DPO (Direct Preference
Optimisation) fine-tuning — the model learns to avoid the specific failure modes documented
in the taxonomy. This is the feedback loop that makes failures valuable rather than just
embarrassing.

---

### TRACK G — The organism: continuous background operation

**G1 — 24/7 improvement daemon [x]**
A persistent background process (separate from the server) that runs the full improvement
cycle continuously: read quality history → identify top goals → spawn agent session targeting
top goal → run pipeline on benchmark suite → commit if better → sleep 1h → repeat.
The server stays responsive; the daemon runs in the background and improves the system
while nobody is watching. The first time a user opens Crucible after a week away and it
is noticeably smarter, they will understand what the system is.

**G2 — Emergent specialisation detection [x]**
After 2000+ queries, run k-means clustering on the query embedding space (using the existing
`vectorize` function). The clusters that emerge are the *actual* query categories for this
user — not the pre-defined `coding/reasoning/creative/factual/math/general` taxonomy we
assumed. If a user mostly asks about React performance, distributed systems, and Italian
recipes, the system should develop three specialised sub-pipelines for those categories,
not treat them as generic "coding" or "factual." Specialisation at the category level rather
than the model level.

**G3 — Session quality arc [x]**
Track quality not per-query but per-session: does the quality improve as the session goes
on (the system is warming up to the problem domain) or degrade (context window filling,
model fatigue)? If quality consistently degrades after query 8 in a session, implement
a "context refresh" — summarise the session so far, start a fresh context window, re-inject
the summary. The session continues seamlessly for the user but the underlying context is
renewed.

**G4 — The collaboration gradient [x]**
Today Crucible is fully autonomous or waiting for input — binary. The AGI version has a
collaboration gradient: it estimates its own confidence per answer and sets its autonomy
level accordingly. High confidence → just answers. Medium confidence → answers with a
brief "I'm less certain about X" flag. Low confidence → asks one targeted clarifying
question before answering. The clarifying question is not random — it is the question that
would most reduce uncertainty (information gain maximisation). This is what a thoughtful
expert does. It is not a feature. It is a personality.

---

### TRACK H — Epistemic Integrity: The System Knows What It Doesn't Know

The single biggest failure mode in every AI system: confident wrongness. The models have no
reliable self-knowledge about the boundary between what they know well and what they're
pattern-matching their way through. Epistemic integrity is the infrastructure that makes
Crucible's uncertainty *legible* — to the user, and to itself.

**H1 — Per-claim confidence annotation [x]**
Wired end-to-end in session 31. `confidenceCalibrator.ts` scores each declarative sentence
by ensemble agreement, web grounding hit rate, and domain verifier outcome. Maps to
`HIGH | MEDIUM | LOW | UNVERIFIED`. Emits `confidence` SSE event and `confidence_calibrated`
debug bus event after polish. UI: compact `<details>` strip below every synthesis — colored
dot, tier, score, flagged claim count. Expands to per-tier counts and each flagged claim
with its tier badge. No emojis, letterSpacing consistent with rest of UI.

**H2 — Uncertainty surface [x]**
`src/CrucibleEngine/uncertaintySurface.ts`. After each pipeline round, records the calibration
score against the closest query cluster (cosine similarity, 20-dim hash projection matching
specializationDetector). Stored in `.crucible/uncertainty-surface.json` as per-cluster EMA
(α=0.25). Pre-Stage 1 lookup: if cluster mean < 0.55 → force full pipeline, raise early-exit
threshold to 0.92, inject uncertainty flag into polish system prompt. Min 3 samples before
routing decisions activate. `GET /api/debug/uncertainty-surface`. `uncertainty_routing` and
`uncertainty_surface_updated` events in debug bus.

**H2 cold-start default [x]**
H2 is only as good as accumulated pattern history. On a fresh install there is no history —
H2 is a no-op until clusters accumulate. Needs a hardcoded cold-start list of known
overconfidence domains (politics, future predictions, specific statistics, medical claims,
legal conclusions) that force full-pipeline routing until at least 3 real samples exist for
the matched cluster. Without this H2 provides no protection on early queries where the
risk of confident wrongness is highest.

**H3 — Multi-source triangulation for world model facts [x]**
Facts pulled from world model must be confirmed by ≥2 independent sources before asserting
with HIGH confidence. Sources: different Stage 1 models producing the same claim, model claim
+ web grounding result, model claim + execution trace output. Single-source facts held at
`PROVISIONAL`. `PROVISIONAL` facts re-evaluated every 10 queries touching the relevant
entity. The world model becomes a vetted knowledge base, not an accumulation of everything
any model ever said. Implementation: triangulation gate in `entityGraph.ts` `upsertEntity`
— facts written with `sourceCount: 1` default to `PROVISIONAL`; a second independent
observation upgrades to `HIGH`.

**H4 — Causal sensitivity analysis [x]**
Wired in session 32. `getFragilityAssumption()` in `confidenceCalibrator.ts` — fast model
call (4s cap, non-blocking) identifies the single named assumption the answer breaks without.
Specificity gate (`isSpecificEnough()`) rejects generic hedges: requires a capitalized proper
noun, version string, number, year, or quoted term; rejects >1 modal verb; rejects <20 or
>300 chars. Runs in `Promise.all` with H1 calibration — zero extra wall-clock cost. Fires
only for `factual | reasoning | math | general` prompt types. Emits `fragility_found` or
`fragility_rejected` to debug bus. UI: italic text under "fragile assumption" label in amber,
above flagged claims. Confirmed live: GR weak-field example produces a named mathematical
condition (`|h_μν| ≪ 1`) with a precise named consequence — no modals, `fragility_found`
in debug bus, specificity gate passed.

**H5 — Frontier epistemic awareness [x]**
Extension of H4. Beyond "which assumption breaks this answer" — surface "is this question
even answerable with current human knowledge?" Crucible identifies when it is at the frontier
of what anyone knows: surfaces the open research questions in the field, identifies what would
need to be established for a definitive answer to exist. Epistemic integrity at the frontier,
not just within known domains. Implementation: a second fast-model pass on `factual | reasoning`
prompts that checks whether the synthesis contains hedges like "ongoing research", "not yet
established", "debated among experts" — if so, extract the specific open question and surface
it as a "frontier" badge alongside the fragility assumption.

---

### TRACK I — True Multi-Agent Specialization

The current ensemble is models debating the same prompt. The next architecture is genuinely
distinct agents — different toolsets, different knowledge domains, different reasoning styles
— coordinated by a meta-agent that knows which specialist to trust for which subtask.
This is architecturally different from specialization memory (Track C2), which biases
selection weights. This is hard routing: the meta-agent decides who is *responsible* for
what, and the specialists work in parallel on their assigned domain.

**I1 — Specialist agent archetypes [x]**
Define four specialist archetypes, each with a distinct system prompt, tool access set, and
knowledge injection:
- **Researcher** — web search + PDF/URL reading + world model query. No write tools.
  System prompt: maximize source diversity, flag contradictions, cite everything.
- **Coder** — file read/write + sandbox execution + codebase index. No web access.
  System prompt: verify by running, never claim something works without executing it.
- **Critic** — read-only access to all other agents' outputs. No write tools, no web.
  System prompt: find flaws, contradictions, missing cases, overconfident claims. Cannot
  agree with the agent it is reviewing — its job is adversarial by design.
- **Strategist** — world model read + episodic memory + decision memory. No execution tools.
  System prompt: situational awareness, tradeoffs, long-term consequences, what the user
  is actually trying to accomplish vs what they asked.

Each archetype is a configuration (system prompt + tool subset) layered on top of the
existing agent loop infrastructure — no new loop code required.

**I2 — Meta-agent task router [x]**
A thin orchestration layer that sits above the agent loop. Given a goal, the meta-agent
decomposes it into subtasks (using the existing `goalDecomposer.ts` heuristic) and
assigns each subtask to the best specialist archetype. The meta-agent then:
1. Dispatches subtasks to specialists in parallel where possible (no data dependency)
2. Sequences subtasks where output of one is input to another
3. Sends every proposed final answer through the Critic before returning to the user
4. Resolves conflicts between specialist outputs (Researcher says X, Coder found Y ≠ X)
Implementation: `src/CrucibleEngine/agent/metaRouter.ts` — takes a goal string, returns a
`SubtaskPlan[]` with assigned archetype, then drives the loop. The existing `runAgentLoop`
becomes the worker; metaRouter is the dispatcher. Wired into `/api/chat` when goal
complexity score exceeds threshold or user explicitly invokes agent mode.

**I3 — Shared task scratchpad [x]**
During a multi-agent task, all specialist agents read and write to a shared in-memory
scratchpad scoped to the task. Format: structured key-value with provenance (which agent
wrote it, when, what confidence). The Researcher writes findings; the Coder reads them to
inform what to build; the Critic reads both to challenge; the Strategist reads all three to
form the synthesized recommendation. No agent is blind to what the others have found.
Implementation: `src/CrucibleEngine/agent/taskScratchpad.ts` — a `Map<string, ScratchEntry>`
keyed by task ID, with `read_scratchpad(key?)` and `write_scratchpad(key, value, confidence)`
tools registered to all specialist loops. Cleared on task completion, persisted to
`.crucible/scratchpad-<taskId>.json` for replay/debug.

**I4 — Agent-to-agent consultation [x]**
A specialist can formally ask another specialist a question mid-task and block until it gets
a structured answer. This enables: Coder asks Researcher "what is the correct API endpoint
for X?" and gets a cited answer before generating code. Strategist asks Critic "what is the
weakest assumption in this plan?" and injects the answer into its next reasoning step.
Implementation: `consult_specialist(archetype, question)` tool — spawns a focused mini-loop
of the target archetype with the question as the goal, returns its `finalText`. Max depth 1
(no recursion). Emits `agent_consultation` to debug bus. The consultation is visible in the
agent UI as a nested step.

**I5 — Adversarial audit pass (always-on Critic) [x]**
Every response from every agent mode — not just multi-agent tasks — passes through an
adversarial Critic loop before reaching the user. The Critic gets the question, the proposed
answer, and the instruction: "Find the three most significant problems with this answer.
Do not find minor stylistic issues. Find things that are *wrong*, *incomplete*, or
*overconfident*." If the Critic finds nothing significant (all issues minor), the answer
ships. If it finds real problems, it either triggers a targeted revision (if fixable) or
appends a flagged caveat. This is the single highest-leverage addition for answer quality:
a dedicated adversarial pass on every output, not just on code.

**I6 — Tool graduation pipeline [x]**
When an agent creates a dynamic tool (Track Gap 2) and it is invoked successfully ≥5 times
without error, it becomes a candidate for specialist-level promotion: the Coder archetype's
tool registry gets it permanently. When a specialist-level tool is invoked successfully
≥20 times across different tasks, it becomes a candidate for the global tool registry
(available to all archetypes). Promotion requires triumvirate approval (same gate as
autonomous weight changes). The ensemble's capabilities compound over time from use, not
just from explicit engineering.

---

### TRACK J — World Model as Active Infrastructure

The world model (`entityGraph`, `causalMemory`, `decisionMemory`, `world.md`) exists but
is passive — written after sessions, injected at the start of sessions. The active version
is queried *during* reasoning, updated *during* responses, and proactively filled *between*
sessions. The distinction matters: a passive world model is context. An active world model
is memory that thinks.

**J1 — World model as a callable tool [x]**
Agents currently receive world model context injected into their system prompt at session
start. Replace (or augment) with a `query_world_model(topic, depth?)` tool — agents call
it explicitly when they need to know something about the world, entities, or prior decisions.
The tool runs a semantic search over the entity graph + episodic memory + causal memory and
returns the most relevant subgraph as structured text. This changes the dynamic: instead of
loading all context upfront (expensive, imprecise), agents pull exactly the context they
need at the moment they need it. Implements the "working memory" model — broad context
available on demand, not stuffed into every prompt.

**J2 — Temporal fact expiry [x]**
Facts in the world model that are inherently time-sensitive (version numbers, prices, who
holds a role, current events, API availability) get a TTL at write time, inferred from the
fact's category. `"React 18 is the current version"` → 90-day TTL. `"Justin prefers
TypeScript"` → no TTL (stable preference). On every session start, run a 50ms sweep over
the entity graph: expired facts are downgraded from `VERIFIED` to `STALE`, triggering a
re-fetch from web grounding the next time an agent queries that entity. The world model
stays current without manual maintenance.

**J3 — World model diff per response [x]**
After every pipeline round and every agent session, run a structured extraction pass:
"What facts, relationships, or decisions in this conversation are new or contradict the
existing world model?" The diff is a structured list of `(entity, attribute, old_value,
new_value, confidence, source)`. High-confidence diffs auto-apply; medium-confidence go
through triangulation (Track H3); contradictions are flagged and logged to
`.crucible/contradiction-log.json` for explicit resolution. The world model evolves
continuously from usage, not just from periodic summarization.

**J4 — Active knowledge gap filling [x]**
After each session, the system identifies what it *didn't* know that it needed to know.
Signals: low-confidence claims that couldn't be grounded, topics where all models disagreed,
queries where the quality predictor was most surprised (predicted high, got low). These
become a `KnowledgeGapQueue` stored in `.crucible/knowledge-gaps.json`. The improvement
daemon (G1) picks up the top-3 gaps each cycle, runs a focused research agent (Researcher
archetype, Track I1) on each, and writes the results into the world model. The next time a
similar query arrives, the system already did its homework.

**J5 — Cross-session knowledge synthesis [x]**
After every 20 sessions on the same emergent topic cluster (Track G2), run a synthesis pass:
a Researcher agent reads all episodic memory summaries in that cluster, the relevant world
model subgraph, and the contradiction log, and produces a "state of knowledge" document
on that topic. Stored in `.crucible/knowledge-synthesis/<cluster-id>.md`. Injected in full
(rather than the general world model excerpt) when a new query matches that cluster.
The system gradually develops deep, structured knowledge in the domains it is actually used in.

---

### TRACK K — The Training Data Moat

The data exists. Most of the collection pipeline exists. What's missing is the part that
makes it a *compounding advantage* rather than an archive: the feedback loops that turn
accumulated data into a system that improves faster than competitors can copy.

**K1 — Hard negative mining [x]**
Gold-standard data (Track F1) captures what worked. The more valuable training signal is
*confident failures*: responses where the composite score was high (>0.75) but the user
immediately rephrased (implicit RLHF negative, Track D4) or where counterfactual branching
(Track A2) found an equally plausible alternative, or where the Critic (Track I5) found
real problems. These cases — high confidence, wrong output — are where models learn the
most. Flag them automatically in `history.json` with `hardNegative: true`. Export as DPO
triples: `(prompt, rejected=synthesis, chosen=corrected_by_critic_or_user)`. The hard
negative dataset is worth 10× the gold-standard dataset of equal size.

**K2 — Ensemble disagreement as training signal [x]**
When Stage 1 produces high score variance (max − min > 0.35), the ensemble is telling you
something important: this is a question where different reasoning approaches produce
genuinely different answers. These high-disagreement cases are the most information-dense
examples in the training set — the model that got it right on a contested question learned
something the others didn't. Export high-disagreement examples with per-model responses
and final synthesis as a multi-turn dataset. Fine-tuning on this set specifically teaches
the model to reason through contested territory rather than defaulting to the consensus.

**K3 — Fine-tuned model re-integration [x]**
The HuggingFace AutoTrain pipeline (Track F3) produces a fine-tuned model after 1000
gold-standard pairs. That model should enter the ensemble as a registered worker — not
just a "synthesis specialist" but a full ensemble member that goes through the same
specialization memory, genealogy attribution, and roster rotation as every other model.
It will outperform base models on the exact query distribution it was trained on.
As it accumulates more specialization data, it gets selected more for its strong categories
— which means it generates more training data for those categories — which means the next
fine-tune is even better. This is the actual compounding loop.

**K4 — Synthetic adversarial pair generation [x]**
Every Stage 3 critique pass already produces a `(worse_draft, critique, better_revision)`
triple. Every counterfactual branch (Track A2) produces a `(question, plausible_wrong,
correct)` pair. Every Critic (Track I5) rejection produces a `(question, rejected_answer,
critic_objection)`. These are DPO training pairs. Wire a background job that extracts them
from `history.json` and `counterfactuals.json` automatically and appends them to the DPO
dataset in `fineTuning.ts`. The fine-tuning pipeline never needs human labeling — the
adversarial architecture generates its own training pairs as a byproduct of operation.

**K5 — Calibration training: penalize confident wrongness [x]**
Track D4 (preference model) infers when users were dissatisfied. Cross-reference with
`confidenceCalibrator.ts` scores: find cases where the system expressed HIGH confidence
and the user was dissatisfied (the worst failure mode). Export these specifically as
"calibration training" examples — the training signal is not just "wrong answer" but
"confidently wrong answer." A model trained on calibration examples learns to express
genuine uncertainty rather than learned hedging. This is qualitatively different from
standard RLHF and produces a system that is trustworthy, not just sometimes correct.

---

### THE DEMO — Public Proof of Differentiation

The bar-setting move is not a blog post or a benchmark leaderboard. It is a *public,
replayable demonstration* where Crucible visibly outperforms the best available models on
a task that matters — shows its work, flags its uncertainty, catches a contradiction, and
produces a more epistemically honest answer than anything else available. The demo *is*
the marketing.

**The reference hard prompt [x]**
Design a canonical multi-agent, multi-source stress test that exercises every differentiating
capability simultaneously. The prompt structure:
1. Synthesize findings from 3+ recent research papers on a contested scientific question
2. Identify claims where the papers contradict each other
3. Identify which claims in each paper are supported vs unsupported by their own cited evidence
4. Produce a summary that accurately represents the state of the field *including open questions*
5. Flag your own uncertainty explicitly where it exists

This prompt is specifically designed to fail GPT-4 and Gemini in characteristic ways: they
will present a confident synthesis that smooths over contradictions and presents contested
findings as settled. Crucible's answer should be messier, more honest, and more useful.
Store the canonical version in `.crucible/benchmarks/reference-hard-prompt.md`.

**Replayable comparison export [ ]**
Every run of the reference prompt produces a structured export: `(question, model_responses,
disagreements, counterfactuals_flagged, critic_objections, uncertainty_annotations,
final_synthesis)` — the full visible process, not just the output. This export can be
rendered as a side-by-side comparison with GPT-4/Gemini outputs on the same question.
The comparison is compelling precisely because it shows Crucible catching things the others
miss, not because it claims to be smarter.

**Public meta-benchmark dashboard [ ]**
A static page (no auth, no login) that runs the canonical benchmark suite (Track E3) against
Crucible weekly and displays rolling scores per category. The categories where Crucible wins
are the categories it was built for. The categories where it lags are roadmap priorities.
The dashboard *is* the product story: a system that measures itself honestly and publishes
the results. Host on Cloudflare Pages (free). Update via the improvement daemon (G1) posting
results to a public JSON endpoint. The meta-benchmark dashboard is the only honest marketing
in AI.

**"Shows its work" response mode [ ]**
A toggle in the UI (off by default) that expands the synthesis to show: which models agreed
vs disagreed at Stage 1, what the Critic flagged, which claims have HIGH vs LOW confidence,
what the adversarial alternative was (Track A2), and what the system doesn't know. This is
the demo mode. Activate it for the reference prompt run. The visible process is the
differentiator — showing that Crucible *reasons* rather than pattern-matches is more
convincing than any benchmark number.

---

### GAME-CHANGING WILDCARDS

These are the implementations with no direct analogue anywhere. Each one is either
technically novel, strategically asymmetric, or produces a capability that cannot be
replicated by adding more parameters to a single model.

**Multimodal grounding via free vision [ ]**
Gemini Flash supports vision at no cost. Wire a `read_image(path_or_url)` and
`read_pdf(path_or_url)` tool using Gemini Flash as the backend — free, fast, available
now. The Researcher archetype (Track I1) gets this tool by default. This means: agents can
read papers, analyze charts, extract data from screenshots, and ground claims against actual
documents rather than just web text. The free-tier philosophy doesn't preclude multimodal —
it just requires picking the right free provider for each modality.

**Persistent multi-session task graph [ ]**
Today every session is independent. The persistent task graph treats long-running goals
(build a trading system, write a thesis, refactor a codebase) as first-class objects that
span sessions. A goal is a directed acyclic graph of subtasks with explicit dependencies
and completion states. Stored in `.crucible/task-graph/<goal-id>.json`. At the start of
each session, the agent checks for open task graphs, reports progress, and picks up where
it left off — without the user re-explaining context. The episodic memory (Track D3)
provides the "what happened last time" context; the task graph provides the "what's next"
structure. Together they give Crucible genuine project memory.

**Autonomous research mode [ ]**
A dedicated mode (distinct from the agent loop) where the user gives a research question
and Crucible runs for as long as it takes — minutes to hours — to produce a cited,
structured research report. The Researcher archetype drives: web search → read sources →
extract claims → triangulate → build world model subgraph → identify gaps → search again →
synthesize. The Critic audits the draft. The result is a document with explicit confidence
levels, cited sources, identified contradictions, and open questions. Free-tier throughout:
DDG for search, Gemini Flash for PDF reading, free models for synthesis. The output quality
on a hard research question should match a junior analyst working for a day.

**Ensemble self-play for reasoning improvement [ ]**
Between sessions, the improvement daemon (G1) runs the ensemble against itself on the
benchmark suite (Track E3) — but with a twist: the models are given each other's *wrong*
answers and asked to identify the error. This generates a second dataset of "error
identification" examples that is distinct from "correct answer" examples. A model fine-tuned
on error identification learns to be a better Critic (Track I5). The training pipeline
becomes self-feeding: correct answers train the synthesis specialist; error identifications
train the Critic; the Critic makes synthesis better; better synthesis generates better
training data. This is the actual learning flywheel, not a metaphor.

**Confidence-gated response commitment [x]**
When the system's calibrated confidence (Track H1) on the final synthesis falls below a
threshold (e.g., aggregate claim confidence < 0.65), it does not commit to an answer.
Instead it presents the best available synthesis alongside an explicit statement of what
additional information would resolve the uncertainty, and a concrete next step (search query,
clarifying question, code to run). This is the collaboration gradient (Track G4) extended
to its logical conclusion: the system knows when it should not be the one to decide.
A system that sometimes says "I don't know, but here is exactly what would tell us" is
categorically more trustworthy than one that always produces a confident answer.

**The adversarial red team as a product [ ]**
The Critic archetype (Track I5) operating on an external target — not Crucible's own
output but user-provided code, documents, proposals, or arguments — is a standalone product.
"Adversarially critique this" is a use case with no good current solution: GPT-4 will find
surface issues; a dedicated adversarial agent with a system prompt specifically designed to
find deep problems, trained on failure patterns, running through a multi-model tournament
that rewards finding flaws the others missed — that is qualitatively different. This is
the Code Review mode generalized to any artifact. It is also the clearest demonstration
of what a multi-agent architecture can do that a single model cannot.

The real loop is: system produces answer → answer is evaluated against ground truth or user
preference → evaluation signal updates the model weights → model produces better answers.

Crucible has all the infrastructure for this except the last mile: the fine-tuning pipeline
(Track F). Every session that runs before Track F is implemented generates gold-standard
data that could be training signal. The cost of not building Track F is paid in wasted
signal — data that exists but isn't used.

Build the gold-standard export endpoint first. It is one hour of work and it starts
accumulating the most valuable asset in this system: labelled, scored, verified answers
from real usage, on real questions, with provenance back to every pipeline stage that
produced them. No amount of clever architecture substitutes for that.

---

### TRACK L — Pipeline Performance

The neuromorphic computing benchmark (7-part comprehensive analysis) timed out at 8-9 minutes
completing only 2/7 sections on June 13. Root cause: waterfall execution, reactive (not
predictive) load balancing, and OpenRouter's ~510-second cap at moderate velocity. These three
items are the fix.

**L1 — Parallel stage execution [x]**
Current pipeline is a waterfall — each stage waits for the previous. Most stages have no true
sequential dependency. Refactor to fire stages concurrently where possible:
- Prompt classifier, memory loading, and web grounding check fire simultaneously at intake
- Model ensemble and web grounding run in parallel (grounding block injected when ready)
- Synthesis fires on first quorum of model responses, not full completion
- H1 confidence calibration and H4 fragility pass already run in `Promise.all` — extend this
  pattern to all post-synthesis passes
Target: 60–70% reduction in response time on complex prompts. This is the single highest-
leverage latency change available without changing the model roster.

**L2 — Prompt decomposition and parallel workstream execution [x]**
Multi-part prompts (like the neuromorphic computing example) should be decomposed into a
dependency graph at intake. Sections with no interdependency fire simultaneously. Only the
final synthesis across sections is a true sequential dependency. Implementation: extend
`goalDecomposer.ts` to detect numbered/section prompts and build a parallel workstream plan;
each workstream runs its own mini Stage 1+2; results join at a final synthesis step.
Expected to bring complex multi-part prompts from 8-9 minutes into sub-10-second range when
combined with L1. This is the specific fix for the neuromorphic timeout.

**L3 — Predictive load balancing [x]**
Current provider routing is reactive — reroutes after a failed call. The topology endpoint
already tracks `secondsToCap` and `velocityPerMin`. Load balancer should read these values
and do the math before dispatching: if a prompt is estimated to take longer than
`secondsToCap`, preemptively route away from that provider before firing. OpenRouter caps at
approximately 510 seconds at moderate velocity — the neuromorphic prompt died at minute 7-8
because the system waited for failure instead of predicting it. Implementation: add a
`estimatedDuration(promptType, complexity)` heuristic to `modelRegistry.ts`; compare against
`predictProviderLoad()` projected fill; deprioritize providers projected to cap mid-request.
Cloudflare and HuggingFace showed zero cap pressure on June 13 and should be preferred for
long-running tasks until L3 is implemented.

---

### TRACK M — Conversational Intelligence

The seam between casual conversation and deep expertise is the single biggest UX problem.
The system currently fires the full synthesis pipeline on "test" and returns a formal
dictionary definition. That is the opposite of the Rick Astley moment.

**M1 — Low-content prompt detection and conversational fallback mode [x]**
Classifier detects low-token, low-domain-signal inputs and routes to a lightweight
conversational mode — no ensemble synthesis, no web grounding, no calibration. A fast single
model call returns a natural response. Detection signals: token count < 8, no domain
vocabulary, no question structure, no imperative verb. Examples: "test" → "Ready when you
are — what's up?". "Hey" → natural greeting. "ok" → natural acknowledgment.
This is the single biggest change to how the system feels in casual use. It is also the
gateway to M2 — you cannot have a seamless transition between modes if one of the modes
is broken.

**M2 — Seamless mode transition [x]**
The visible gear-change between conversational mode and agent execution mode needs to
disappear. One voice, one thread, fluid transitions. The user should not feel a context
switch when Crucible moves from chatting to executing a task. Implementation: a single
response voice layer that wraps both modes — the conversational fallback (M1) and the full
pipeline — with consistent tone, consistent pacing, consistent personality. When the pipeline
fires on a hard question after a casual exchange, the answer should feel like a continuation
of the same voice, not a mode switch. This is the Rick Astley moment made reliable.

**M3 — Proactive contextual engagement [x]**
Crucible notices relevant context from the environment and surfaces it naturally without being
asked. Foundation exists via accessibility tree. Missing piece: a lightweight ambient
watchfulness layer — a background process that monitors for contextually relevant signals
and decides when it is appropriate to speak up vs stay silent. Needs a strong relevance gate
(cosine similarity between ambient context and recent session topics > threshold) to avoid
being annoying. This is the feature that makes Crucible feel like presence rather than a
tool waiting to be used.

---

### TRACK N — Autonomous Infrastructure

**N1 — Admin governance UI [x]**
Conversational backend management interface. Crucible surfaces infrastructure requests with
full reasoning — what it needs, why, how it will execute, projected impact. User reviews and
signs off before anything executes. Not forms or dashboards — conversational cards with
approve/reject. Covers: new server provisioning, memory store management, model registry
additions, self-patches to its own engine, deletion of stale data. This is the trust
escalation system: Crucible operates freely within current boundaries, crosses boundaries
only with explicit sign-off. Keeps the human as governor, not bottleneck.

**N2 — Autonomous server provisioning (gated) [x]**
Crucible can provision its own infrastructure on free-tier providers (Cloudflare Workers,
Supabase, Railway, Render) via their APIs. All provisioning requests go through the N1
governance UI before execution — never autonomous without sign-off. Enables the domain-routed
knowledge store architecture: calculus lives here, linguistics lives here, the router knows
which store to hit.

**N3 — Domain-aware knowledge store routing [x]**
Semantic, persistent domain routing. Not just "this is a coding prompt" but "this requires
the knowledge store that has accumulated pattern libraries around differential equations."
Chunked typed knowledge stores organized by domain; router selects before answering;
retrieval fast enough to feel like memory, not lookup. This is RAG with self-organized domain
awareness — the system decides how to categorize its own knowledge. Extends Track J world
model infrastructure. Cold-start problem: needs either manual domain seeding or a
self-organization pass to bootstrap. N2 provisions the stores; N3 routes to them.

---

### TRACK O — AGI Extensions

**Behavioral adaptation layer [x]**
Persistent cross-session learning that actually updates behavior, not just stores notes.
Structured logs of what worked, what failed, what the user corrected — compressed into
decision priors injected early in the pipeline. Not "here are your memories" but "here is
how you have learned to approach this class of problem." This is the delta between a very
good tool and something that feels different over time. Free-tier implementation: no weight
updates, behavioral priors in prompt context updated per session using the existing
`episodicMemory.ts` + `preferenceModel.ts` infrastructure.

**Long-horizon cross-session planning [x]**
Crucible notices structural dependencies the user hasn't mentioned. Not "complete this task"
but "to achieve what you're building this week, three things need to exist first that you
haven't asked for yet." Requires the behavioral adaptation layer above plus the task graph
(Track L2 decomposition) extended across sessions, not just within a single prompt.

---

### STRESS TEST — Neuromorphic Computing Benchmark

The canonical hard prompt for pipeline performance benchmarking. Previously timed out at
8-9 minutes completing 2/7 sections. Rerun after L1, L2, and L3 are implemented to validate
parallel execution gains.

**The prompt:**
> "Give me a comprehensive analysis of neuromorphic computing: (1) fundamental principles and
> how it differs from von Neumann architecture, (2) current hardware implementations (Intel
> Loihi, IBM TrueNorth, BrainScaleS), (3) programming models and frameworks, (4) performance
> benchmarks vs. GPU/CPU for specific workloads, (5) current limitations and open research
> problems, (6) commercial applications and timeline to practical deployment, (7) comparison
> of leading research groups and their architectural approaches."

**Pass criteria:** All 7 sections complete, total wall-clock < 60 seconds, no provider cap
failures. Save results to `.crucible/benchmarks/neuromorphic-<date>.json`.

---

### ARCHITECTURAL NOTES — June 13 2026

- **Provider reliability is the foundation.** When the pool is healthy (15/18 active June 13)
  the pipeline performs. When Groq daily limits trip, the system degrades gracefully but loses
  its strongest fast models. Provider pool expansion remains critical.
- **Circuit breaker and load tracking are working correctly.** The gap is predictive vs
  reactive routing — see L3.
- **OpenRouter caps at approximately 510 seconds at moderate velocity.** Long-running complex
  prompts race this cap and lose. Do not rely on OpenRouter as primary provider for
  multi-minute tasks until L3 is implemented.
- **Cloudflare and HuggingFace showed zero cap pressure on June 13** and should be preferred
  for long-running tasks in the interim.
- **The Rick Astley moment** (cross-device agent execution with personality) happened on day 5
  before most current implementations. First proof-of-concept of seamless agent presence.
  Target: make that moment reliable across all task types via M1+M2.

---

## CHANGE LOG  *(newest first — append a dated entry per working session)*  *(newest first — append a dated entry per working session)*

### 2026-07-07e — Dynamic tool versioning + rollback (design-spec item 1)

First build item from `docs/DESIGN_SPEC_TOOL_BUILDER_REMOTE_BRAIN.md`: every dynamic tool is
now versioned with one-call rollback, making tool changes reversible (design principle 4).

- **`dynamicTools.ts`** — `DynamicToolRecord` gains `version`, `changeNote`, `provenance`,
  `verification` (all optional; legacy records read as v1). New: `updateDynamicTool()` archives
  the outgoing record to `.crucible/dynamic-tools/history/<name>/v<N>.json` and bumps the
  version; `rollbackDynamicTool()` restores any archived version *as a new version* (history is
  append-only — a rollback can itself be rolled back, nothing is ever destroyed); usage-counter
  writes (`recordToolSuccess`) deliberately never bump the version. `listToolVersions()` /
  `loadToolVersion()` for inspection.
- **`registry.ts`** — new agent tools `update_tool` (compiles + smoke-tests the new body
  *before* committing; a failing body leaves the tool untouched) and `rollback_tool`.
  `create_tool` now stamps v1 with provenance + a passed verification record.
  `list_dynamic_tools` shows versions.
- **`server.ts`** — `GET /api/debug/dynamic-tools/:name/versions` and
  `POST /api/tools/rollback` (restores + re-registers live in the running registry).
- **Verified, not assumed:** 14-assertion tsx smoke test (create → invoke → update → invoke →
  broken-update rejected → rollback → invoke shows old output → rollback-the-rollback →
  counter writes don't bump), all passing; plus live HTTP verification of both endpoints
  against a running server (versions listing, rollback v2→v3-restoring-v1, auth wall intact).
  `tsc -p tsconfig.server.json` shows no new errors in changed regions (pre-existing errors
  unchanged — server runs via tsx).

Next per the build order: user-facing builder dialogue with mandatory pre-install dry run.

### 2026-07-07d — Design spec + gap analysis: Tool Builder, GitHub import, Refinement, Remote Brain

Added `docs/DESIGN_SPEC_TOOL_BUILDER_REMOTE_BRAIN.md` — the full design spec for four
systems (natural-language tool/agent builder, GitHub tool subscriptions/import, adaptive
tool refinement, Remote Brain mobile command center) plus a code-verified gap analysis
mapping each spec piece to what actually exists (`tools/registry.ts`, `tools/dynamicTools.ts`,
`sandbox.ts`, `macTools.ts`, `agent/localIntentRouter.ts`, server.ts Step 9). Key findings:
registry + dynamic tools + Remote Brain eyes/hands/stream exist; the user-facing builder
dialogue, ToolSpec versioning/rollback, refinement smoke-test gate, device pairing/tiers,
and all of GitHub import are not built. Doc ends with a recommended build order. No code
changes this session.

### 2026-07-07c — Extended the verification baseline to every raw exit point in server.ts

Audited every `type: 'synthesis'` send site in `server.ts` (there are 14) instead of waiting for
the next failure report to reveal the next gap. Found four more early-return paths with the
exact same shape as 2026-07-07b's A0/simple-tier gap — a single model's (or a joined multi-model)
answer sent straight to the user, never touching `domainVerify()`:

- **Layer 1 corpus-first gate** (inside the normal/ensemble-on pipeline, not just A0's copy of
  it) — returns before Stage 1–5 even starts.
- **Step 7 offline-mode fallback** (external pool fully tripped, `localInferenceAvailable` true)
  — same raw-single-model shape as A0's on-device path, just reached via a different trigger.
- **L2 Parallel Workstreams join** — each decomposed subtask is answered independently and
  joined/lightly polished, but the combined result never passed through Stage 5b either.
- **MASTERPIECE deep mode** — the most important of the four: it runs *after* Stage 5b and
  **replaces** the already-verified, already-polished synthesis with fresh dialectical content,
  silently discarding the verification that answer already had. Without a check here, deep mode
  could regress a good, verified answer into an unverified one and nobody would know.

All four now route through `verifyAndRepair()` (`baselineVerify.ts`, added in 07b) before
sending, each with its own `baseline_verify_repaired` debug event
(`layer1_corpus_first` / `offline_mode` / `l2_workstreams` / `masterpiece_deep`) so a repair on
any of them is visible via `/api/debug/stream`, same as every other stage.

**Deliberately left alone**, confirmed by reading each site: the Collab-gradient clarify
response (templated system text, not a factual claim), the ANIMA transparency report
(a structured dump of the truth store, not model-generated prose), M1 conversational (still
exempt — no factual claims to check), and the Stage 5b final synthesis sends themselves (that
*is* the already-verified output — verifying it again would be redundant, not another gap).

**The actual invariant this now enforces:** no code path in `server.ts` sends a `synthesis`
event built from freeform model or joined-model text without it having passed through either
Stage 5b's full verify/critique/polish loop, or `verifyAndRepair()`. If a new early-return exit
is ever added to this file, grep for `type: 'synthesis'` and check it against that list before
calling it done — that's the actual hull, not a growing list of individually-patched holes.

### 2026-07-07b — Universal verification baseline for A0 + simple-tier (closes the gap below)

Follow-up to the counting-gate fix below, per direction to reinforce the structural gap rather
than pattern-match each failure shape as it's found. The actual defect wasn't "counting is
wrong" — it's that **two entire exit paths ship a single model's raw output with zero
verification of any kind**: A0 (`ensemble:false`, on-device-only) and the `triageTier ===
'simple'` fast path. Both were built to skip the full pipeline for speed/privacy, and skipping
the pipeline silently meant skipping every check in it too — `domainVerify()`
(math/factual/consistency, `domainVerifiers.ts`) and the Stage 5b critic/polish loop only ever
ran for requests that made it to the full pipeline.

Added `src/CrucibleEngine/baselineVerify.ts` (`verifyAndRepair`): runs the existing
`domainVerify()` against any single-model answer, and — only when it flags a real issue at
`confidence > 0.5` — makes ONE cheap repair call back to the *same* model (never a premium
upgrade) with the specific flagged issues, keeping the repair only if it isn't a degenerate
near-empty collapse. Wired into all three raw exit points: A0's corpus-first branch, A0's
local-FM-synthesis branch, and the simple-triage fast path (`server.ts`) — each now emits a
`baseline_verify_repaired` debug event when a repair actually fires, so it's observable via
`/api/debug/stream` like every other stage. Falls through silently on any verifier/repair error,
matching the existing non-blocking convention everywhere else in the pipeline.

Unit-tested `verifyAndRepair` in isolation (wrong-math → detected + repaired; correct math → no
repair call; a repair that collapses to near-nothing → original kept; prompt types with no
verifier → passthrough, zero extra calls). Could not exercise the A0 on-device branches
end-to-end in this sandbox (no Apple FM bridge / no network egress to any provider here — both
pre-existing environment limits, unrelated to this change) — confirmed instead that the
`triageTier === 'simple'` path's existing try/catch correctly falls through to the full pipeline
when a provider call fails, so the new code doesn't introduce a new failure mode there. The
Layer 0 counting gate below was re-verified live after this change and still short-circuits
before any of this — it's cheaper to just compute the answer than to verify a model's guess at
one.

**Deliberately NOT covered:** M1 conversational mode (`conversationalMode.ts`) is untouched —
"hi" / "thanks" / "test" replies are intentionally casual with no factual claims to verify, so
routing them through `domainVerify()` would be pure overhead. The full pipeline's own Stage
5b/critic loop is also untouched — it's already more sophisticated than this shared baseline, no
need to downgrade it. If a future weak-answer report comes from the full pipeline (not A0/simple
tier), that's a Stage 5b tuning problem, not another missing baseline.

### 2026-07-07 — Deterministic counting gate: fixed hallucinated "how many r's in X" answers

**Bug (user-reported, reproduced end-to-end):** with ensemble off, three chained "how many
X are in word Y" questions (strawberry, then a nonsense pineapple/strawberries follow-up, then a
reversed "how many pineapples are in the word r?") all came back tagged `CRUCIBLE · ON-DEVICE`.
The first ("3 r's in strawberry") happened to be right; every follow-up was pattern-completion
garbage — the on-device model repeated "three r's" regardless of the actual question, then
produced "There are 3 pineapples in the word R," which doesn't parse. Root cause: the A0
ensemble-opt-out path (`server.ts`) sends the raw message straight to `callLocalModel` with zero
verification — no domain verifier, no counting logic, nothing — because that path is designed to
never fan out to external providers. Same gap exists in the `triageTier === 'simple'` fast path
(Stage-5 domain verifiers in `domainVerifiers.ts` only ever ran for the full pipeline).

**Fix, per the free-tier philosophy ("weak output ⇒ more client-side processing, never a premium
model"):** letter/substring/vowel/consonant counting in a word is 100% computable — there's no
reason to ask a model to guess at something arithmetic. Added
`src/CrucibleEngine/countingVerifier.ts` (`answerCountingQuery`), a zero-cost deterministic gate
matching "how many X are/is in (the word/string/name) Y", "how many times does X appear/occur in
Y", and "count X in Y", with special-cased `letter(s)`/`vowel(s)`/`consonant(s)` needles. Wired in
as a new **Layer 0** in `server.ts`, before A0/M1/the full pipeline, so it fires regardless of
ensemble on/off or mode, and costs zero API calls. Deliberately conservative: the "X are/is in Y"
template only fires marker-free (no "the word/string/name") when the needle is unambiguously a
single letter (e.g. `r's`) — otherwise it would hijack real quantity questions like "how many
calories are in a banana." Verified with the server running (`npm install --ignore-scripts` +
`npm rebuild better-sqlite3` to work around the sandboxed sharp download failure) against all
three reported queries (now correct: 3 r's in strawberry; 0 "strawberries" in "pineapple"; 0
"pineapples" in "r") and against a calorie/banana control query (falls through to the normal
pipeline untouched, confirming no false-positive hijack of ordinary questions).

**Still open:** this closes the specific counting-hallucination class, not weak on-device output
in general — the A0/simple-tier paths still have no verification for other prompt types. →
**Resolved in 2026-07-07b below**, which wires `domainVerify()` + a repair pass into both paths
generally instead of adding another one-off pattern gate.

### 2026-07-06 — Resolved v3 UI redesign's canonical-repo question; set up two-agent port plan

A separate repo (`mpd8zyb4yw-hash/Crucible-Code`) held a Claude Design handoff bundle whose
brief targeted this repo's `src/App.tsx`, but the delivered implementation was actually a
from-scratch greenfield app (`crucible-local/crucible-local/`) with a fully stubbed backend
(fake local model, two toy tools, semi-fake ensemble). Verified via `git log` that no redesign
work has landed here — `ModeSwitcher`/`classifyMode`/always-visible pipeline chrome are all
still present and unchanged. Decision: the greenfield app is a validated reference
implementation to port UI/UX from (mode-machine removal, opt-in-ensemble confirm flow,
molten-pour animation, design tokens), not a replacement — this repo's real `server.ts`
pipeline, `CrucibleEngine/tools/`+`agent/`, and self-improvement infra stay. Added
**PRIORITY 0** to `NEXT_SESSION.md` with a two-phase (not fully parallel, due to
`App.tsx` being one 223KB file) plan for two coding agents to execute this port, plus a live
claims table. No `App.tsx` changes made yet — this session was investigation + planning only.

### 2026-06-15 — Track O Layer 1 + Remote Brain fixes (stream size, send button, semantic corpus)

**Remote Brain — black screen / slow connection (root cause: frame size, not delivery):**
Server-side the SSE stream was healthy (first frame 0.8s, verified via curl). The black screen
was raw retina frames (~600KB → ~800KB as base64) saturating phone WiFi and stalling. Re-added a
downscale pass — `sips -Z 1100 … -s formatOptions 40` chained into the capture in ONE shell call
→ ~60KB/frame (13× smaller), streams smoothly. Also send `: connected\n\n` immediately so
EventSource fires `onopen` without waiting for the first capture (kills the perceived 30–60s
connect delay). (`server.ts`)

**Remote Brain — send button didn't work:** the canvas overlay (zIndex 50) sat above the chat
input bar (zIndex 10), intercepting taps. Per the "use the same input element, no second chat bar"
direction: the overlay now stops at `bottom: inputBarHeight` and the input bar is raised to
zIndex 60 with a solid backdrop in Remote Brain mode, so the existing textarea + send button ARE
the command interface. `send()` injects `modeOverride='agent'` whenever Remote Brain is active.
(`src/App.tsx`)

**Note on agent latency:** the local intent fast-path (Layer 0) already makes "open Finder" et al.
instant — the 15s the user saw was the server running pre-fast-path code. Requires a server
restart to pick up `server.ts` changes (tsx does not hot-reload unless run with `tsx watch`).

**Track O Layer 1 — Corpus-First Answer Gate (`src/CrucibleEngine/corpus/corpusFirst.ts`):**
Before the model pipeline runs, `corpusFirstAnswer()` queries the living corpus; on strong
coverage (top similarity ≥ 0.55 + a corroborating passage, or a single ≥ 0.72 hit) it synthesizes
the answer ON-DEVICE (Apple FM daemon) strictly from the retrieved passages — ZERO external API.
High precision: fires only for factual/reasoning/math/general prompts, skips time-sensitive
queries, and falls through to the pipeline whenever coverage is weak or local synth is
unavailable. Wired in `server.ts` right after `classifyPrompt`, gated on `localInferenceAvailable`.
Emits the proven offline-mode event shape (`layer1` + `synthesis` done) so the UI renders it.

**CRITICAL FIX uncovered building Layer 1 — semantic embeddings were never real:**
`@xenova/transformers` was NOT installed, so `embed()` silently used its 256-dim hash fallback.
Corpus retrieval was semantically meaningless ("entropy" and "Roman Empire" both top-ranked
*networking* chunks). Installed `@xenova/transformers@2.17.2` (ONNX all-MiniLM-L6-v2, 384-dim,
runs locally — no API, true to the free-tier ethos) and wrote a one-shot re-embed migration
(`corpus/reembed.ts`) that recomputes all 2253 corpus chunks with real semantic vectors. This is
what makes Layer 1 — and every other corpus retrieval (grounding, gap detection, knowledge
synthesis) — actually work. **Requires server restart** after re-embed so the server process also
uses ONNX for query embeddings (else 384-dim corpus vs 256-dim query → dimension mismatch → no hits).

### 2026-06-15 — Track O: Offline-First agentic execution (Layer 0 — local intent router)

**THE NORTH STAR (user-articulated vision):** A truly offline Crucible. It leans on its own
vast knowledge (the ~20GB living corpus) and on-device capability, reaching for an external LLM
only in genuinely niche cases — *not* out of stubbornness, but because it's powerful enough to
rarely need external assistance. External API calls become the exception, especially in agentic
workflows. This is the direction all agentic work now builds toward.

**The layered architecture (target):**
- **Layer 0 — Deterministic intent → tool resolution (no model at all).** Unambiguous commands
  resolve straight to tool calls. ⟵ *shipped this session.*
- **Layer 1 — Corpus-grounded answer.** Retrieve from the living corpus (`corpus/query.ts`,
  semantic + relationship-graph); when coverage is strong, answer directly. No API.
- **Layer 2 — Local FM reasoning/planning.** Use the Apple Foundation Models daemon (port 11435,
  `local-inference/`) for decomposition, summarization, classification, and corpus synthesis.
  NOTE: the FM daemon is plain chat-completion — no tool-calling — so it can't be the agent
  *driver*, but it can plan and synthesize.
- **Layer 3 — External API.** Only when Layers 0–2 genuinely can't handle the task.

**Layer 0 shipped — `src/CrucibleEngine/agent/localIntentRouter.ts`:**
`resolveLocalIntent(message)` is a pure function mapping unambiguous commands directly to a tool
plan with ZERO model round-trip — this is what eliminates the 5–10s agentic-activation latency
the user reported (the delay was the LLM driver turn just to decide which tool to call). Covers:
open app / URL, play media (YouTube live-search → open top verified result; Spotify search URI),
empty trash, click element, type text. Chained steps (search → open) derive args from the prior
`ToolResult`. **High precision over recall**: anything it can't confidently resolve returns null
and falls through to the existing LLM agent loop. Wired at the top of the `/api/chat` agent block
in `server.ts` (skipped when resuming a persisted task); executes via `registry.exec`, emits the
same `agent_start` / `tool_call` / `tool_result` / `final` SSE events the UI already renders, so
Remote Brain commands now fire instantly. Verified: 18/18 precision test matrix (12 resolve to the
correct tool sequence, 6 prose/coding prompts correctly fall through).

**Next increments (Track O):** Layer 1 corpus-first answer gate before any pipeline/agent model
call; cache the focused-window UI tree in the background and inject it into agent context so even
LLM-routed Mac control skips the `get_ui_tree` round-trip.

### 2026-06-15 — Remote Brain overhaul: SSE stream, persistent auth, mobile load speed

**Screen sharing was completely broken — three compounding bugs:**

1. **Invalid screencapture flag.** `-q 25` is not a valid macOS `screencapture` argument. The OS
   treated it as an output filename, so the real tmpFile was never written. Every frame hit the
   `readErr` branch and retried infinitely with no output. Removed the flag. (`server.ts`)

2. **MJPEG not supported on iOS Safari.** `multipart/x-mixed-replace` in an `<img>` tag has
   never worked on iOS. Replaced the entire stream protocol with Server-Sent Events (SSE):
   backend sends base64-encoded JPEG frames as plain SSE events; frontend receives them via
   `EventSource` and draws to a `<canvas>` — works on every browser including iOS. (`server.ts`,
   `src/App.tsx`)

3. **Frame size.** Raw retina captures are 626KB+ per frame. Added a `sips` resize+compress pass
   (max 1280px, quality 45) immediately after capture → ~110KB per frame, manageable on WiFi.

**Remote Brain overlay redesign:**
- Canvas replaces img, fades in on first frame (no blank flash)
- Connecting spinner while SSE handshake is in flight; error state + retry button
- Live green dot + "LIVE" badge once frames arrive
- Exit button in the same top-right cluster
- Input auto-focuses on open; font size 16px prevents iOS keyboard zoom

**Auth lost on every server restart:**
- `JWT_SECRET` was `crypto.randomBytes()` each boot → all sessions invalidated on every update.
- Now persisted to `.crucible/jwt_secret`; generated once, reused across restarts.
- Both PC and phone were equally affected; phone user notices more because they're less likely
  to sit next to the machine and casually re-auth. (`server.ts`)

**Mobile load speed:**
- Added `compression` middleware to express — all responses including static assets are now
  gzip-compressed.
- Express now serves the production build from `app/` directly on port 3001. Phone loads
  `http://192.168.x.x:3001` — no Vite proxy chain, no dev-server overhead.
- Code-split the build: main app chunk 116KB (was 927KB). React vendor 182KB cached separately.
  markdown/syntax-highlighter chunk lazy-loaded. Critical-path gzipped: 88KB. (`vite.config.ts`)

### 2026-06-15 — Mobile UX + routing fixes: phone stream, autoscroll, card obstruction, creative misroute

Four reported defects fixed:

**1. Remote Brain stream not reaching the phone.** `/api/remote-brain/status` built the
MJPEG URL from `req.hostname`, which is `localhost` behind the Vite proxy — the phone got
`http://localhost:3001/...` and pointed the `<img>` at itself. Client now builds the URL from
`API_BASE` (already resolved in `api.ts` to the exact host the phone loaded from, e.g.
`http://192.168.x.x:3001`) and no longer overwrites it with the backend's value; a cache-bust
`?t=` param forces a fresh multipart socket on each activation. Backend status URL now also
honors `x-forwarded-host` for other callers. (`src/App.tsx`, `server.ts`)

**2. Autoscroll fought the user.** The lock only engaged once you were >80px from the bottom,
so streamed chunks kept yanking you back and freeing it took one big decisive up-scroll. Now
any upward intent — a wheel tick (`onWheel` deltaY<0) or a >6px finger drag (`onTouchMove`) —
engages the lock instantly; `handleScroll` only RE-engages auto-follow once you return within
80px of the bottom. (`src/App.tsx`)

**3. Last message obstructed by model cards.** Scroll `paddingBottom` was `inputBarHeight + 1`,
flush against the cards and ghosted by the fade mask. Bumped to `inputBarHeight + 16` for clean
clearance. (`src/App.tsx`)

**4. "Write me a story" returned a wall of code.** The agent-loop fallback fired in EVERY mode
(`agentMode !== false` is true by default) whenever `detectAgentTask` matched — and ambiguous
tokens like "script"/"story"/"character" tripped its build patterns ("write me a script" →
agent → code). Added `isCreativeProse()` guard (`classifyPrompt === 'creative'` AND no hard
exec signal) to the auto-route condition, and a `STRONG_CREATIVE` regex in `regexClassify` that
wins over coding keywords (so "write a story about a programmer who debugs code" → creative).
"write a python script" still has a hard exec signal → stays coding/agent. Verified with the
classifier + detectAgentTask test matrix. (`server.ts`, `modelRegistry.ts`)

### 2026-06-15 — Steps 3, 4, 7, 9: Specialist Compute Lane + Academic Retrieval + Reasoning Engine + Offline Mode + Remote Brain

**Step 7 — Offline Mode (S4c emergency fallback synthesis):**
After model selection, if `models.length === 0` (all circuit breakers tripped) AND `localInferenceAvailable`:
routes the full query to `callLocalModel()` (Apple Foundation Models bridge, port 11435). Response
labeled `[Offline — on-device only]` so user knows the source. If local inference is also unavailable,
returns a clean error event instead of hanging. Events: `offline_mode_activated` / `pool_empty_no_fallback`.
Verified: status endpoint confirms `localInference.available: true`; offline path confirmed by logic review.

**Step 9 — Remote Brain:**
Backend: `GET /api/screen-stream` — MJPEG stream via `screencapture -x -t jpg` loop at 4fps (250ms
interval, 40% JPEG quality). `GET /api/remote-brain/status` — reports accessibility availability,
frontmost app, stream URL, and tool list. Three new agent tools registered in `tools/registry.ts`:
`get_ui_tree` (dumps focused window's Accessibility tree as structured text, max 100 elements, capped
3000 chars), `click_element` (osascript click by element title, partial match), `type_text` (osascript
keystroke injection). All implemented in `src/CrucibleEngine/macTools.ts`.
UI: Remote Brain button rendered only on `isMobile` (window.innerWidth < 640). On activation:
fullscreen overlay covers entire phone viewport — stream fills top area, Exit button top-right,
caption bar at bottom for agent commands. Desktop shows nothing. Verified: status endpoint returns
`{available: true, frontApp: "firefox", tools: [...]}`.

### 2026-06-15 — Steps 3 & 4: Specialist Compute Lane + Academic Retrieval + Reasoning Engine

**Step 3 — Specialist Compute Lane (`specialistRoles.ts`):**
8 specialist roles (factual-verifier, code-analyst, math-prover, reasoning-critic, domain-expert,
contrarian, simplifier, integrator) with type-aware assignment logic. For `complexity === 'complex'`,
`assignSpecialistRoles()` maps each Stage 1 model to a role based on promptType preference/avoidance.
`buildRoleAddendum()` appends the role addendum to each model's system prompt. Assignment logged as
`specialist_roles_assigned` on debug bus. No simple-query overhead (empty map returned for non-complex).

**Step 3 — Academic Retrieval Lane (`academicRetrieval.ts`):**
Parallel arXiv (Atom API) + Semantic Scholar (free graph API) lookup for `math/reasoning/factual`
queries that contain conceptual signal keywords. Runs concurrently with A3 web grounding in the
pre-Stage-1 block (6s race timeout). Results injected into Stage 1 user message alongside
`groundingBlock`. Events: `academic_grounded` / `academic_retrieval_error` on debug bus.
Verified live: arXiv returned abstract for Fourier transform query and Euclid primes query.

**Step 4 — Reasoning Engine (`reasoningEngine.ts`):**
Pre-Stage-1 scaffold generator for complex reasoning/math queries. Fast model call (4s race timeout)
produces a structured JSON scaffold: scaffoldType, problemRestatement, keyConceptsOrLemmas,
approachSuggestion, commonMistakes, verificationCriteria. Scaffold injected into all Stage 1 system
prompts as `[REASONING SCAFFOLD]` block. Triggers on `math`/`reasoning` promptType OR on keyword
signals (prove, derive, explain why, theorem, algorithm, analyze, etc.) regardless of classifier.
Events: `reasoning_scaffold_built` / `reasoning_scaffold_error` on debug bus.
Verified live: Euclid primes query → `scaffoldType: math-proof`, approach: "Assume finite primes,
construct a new number, derive contradiction"; models GPT-OSS assigned `math-prover` role.

### 2026-06-15 — Step 8: Speed audit — pipeline latency 92s → 34-45s

**Root causes found and fixed:**

**1. Linter remediation was blocking Stage 1 straggler timer** (was: always-on for all prompt
types, 20s timeout, ran BEFORE straggler check fired). Every model that failed the linter gate
would hold the straggler clock for up to 20 extra seconds. Fix: straggler timer now fires on
the first valid response BEFORE linting (score > 0 → clock starts). Linter remediation now
restricted to `coding` queries only (contract violation matters most there); timeout reduced
from 20s to 8s. **Impact: Stage 1 wall-clock 39s → 5-8s for fast-ensemble runs.**

**2. Stage 3+4 timeout was 60s with no straggler gate.** With 5 active models, the slowest
one held the whole stage for up to 60s. Fixes: per-model timeout reduced from 60s to 20s;
added straggler timer (first model finishes → wait 8s, then drop remaining stragglers and use
their Stage 1 responses). Peer context capped at 1500 chars per model (was uncapped — large
Stage 1 responses blew up the Stage 3 prompt). **Impact: Stage 3+4 35s → 7-9s.**

**3. Critic (I5) ran sequentially after calibration.** The adversarial critic (6s timeout)
ran AFTER `await Promise.all([calibration, fragility, frontier])` (4s). Together they added
~10s sequential. Fix: critic promise now starts BEFORE the calibration block and is awaited
after confidence SSE events are sent — runs concurrent with fragility (4s). **Impact: saves
~4s on every run.**

**4. Pre-polish concurrent branches** (counterfactual, A4 trace, hypothesis test) were
sequential: trace ran after cf, hypothesis after trace. All three now start as async IIFEs
immediately after Stage 5 synthesis and are awaited together with `Promise.all`. **Impact:
saves up to 10s on coding/math queries where all three run.**

**5. Post-pipeline metadata blocked [DONE]** — genealogy, world diff, gap detection, causal
recording, history save, cache write all ran synchronously before closing the SSE. This added
~8s after the answer was already delivered. Fix: SSE closes immediately after Stage 5 status
(when `mpGate.mode !== 'deep'`); all post-pipeline ops run in background (send() is
no-op after writableEnded, cacheEvents still accumulates). `res.writableEnded` guard added to
`send()`. Final `res.write([DONE])` guarded with `if (!res.writableEnded)`.

**6. Fragility timeout** now externally capped at 5s via `withTimeout` (fragility already
has internal 4s `Promise.race` — belt-and-suspenders).

**Results:**
- Baseline: 92-95s (median across 3 benchmarks)
- After all fixes: 34-45s (varies by which models respond quickly)
- Cache hit replay: 64ms
- Remaining bottleneck: Stage 5 synthesis on slow openrouter free models (~11s), and
  full-complexity Stage 1 with large ensembles when fast providers hit daily 429 limits.

### 2026-06-15 — Voice layer expansion + silent-catch sweep (P3/P4 + pipeline)

**Voice layer (Step 6):**
`ROBOTIC_OPENERS` expanded from 5 to 18 patterns covering: affirmation openers (Certainly/Absolutely/
Definitely), offering-help openers (happy to help, let me walk you through — now consuming the
full sentence), AI identity disclaimers, announcement/announcement openers (I will now explain,
here is a comprehensive overview), based-on openers (full sentence via `Based on [^.!]{5,120}`).
`ROBOTIC_CLOSERS` expanded from 2 to 10 patterns covering: I-hope, let-me-know, feel-free-to-ask,
please-don't-hesitate, if-you-have-questions, don't-hesitate, I'm-here-to-help, summary/conclusion
paragraph closers. Both opener and closer stripping now loop until stable (handles chained openers
like "Certainly! I'd be happy to help. Here is a comprehensive…" → content directly). Minimum
remaining-text guard lowered from 40 to 10 chars to prevent the guard from blocking legitimate
short content. **Verified:** 6/6 unit tests; live synthesis starts directly with substantive content,
robotic pattern scan negative.

### 2026-06-15 — Stage weight learner activated + silent-catch sweep

**stageWeightLearner fully activated (both directions):**
- Added `getStageMultipliers` to the import and wired it before Stage 3: the early-exit threshold
  now shifts ±0.05 based on whether critique has historically added value for this promptType.
  On a cold store the multiplier is 1.0 (neutral), so the threshold is unchanged until enough
  rounds accumulate confidence > 0.3 (see `CONFIDENCE_SATURATION = 50` in stageWeightLearner.ts).
- Added `recordStageWeightRound` post-synthesis recording with real stage5_synthesis score data.
  **Verified:** `stage_weights_recorded` event fired live; `.crucible/stage-weights.json` written
  (4 weights with sampleSize 163+ indicating prior rounds were already accumulating).

**autonomousProvisioner silent catch fixed:** `.catch(() => {})` on `runApprovedProvisioningRequests`
in governance approval now logs `provisioning_error` to debug bus.

**Silent-catch sweep — pipeline region 2888–3368:**
Fixed 8 more `} catch {}` blocks on engine calls that warranted real error logging:
`counterfactual_error`, `execution_trace_error`, `distill_round_error`, `arc_score_error`,
`ab_record_error`, `roster_eval_error`, `gap_detection_error`, `post_synthesis_block_error`.
All non-SSE, non-file-read catches in the inference path now log to the debug bus.

**goalEngine audit — correctly placed:** `identifyGoals` reports *system* improvement goals for
the background daemon; it's correctly wired to the 15-min improvement tick + governance endpoint.
Not an inference-context injection (that would be noise). No change needed.

**Verification:** Full pipeline query — `done:true ×7`, `cross_session_contradiction ×2`,
`world_diff_applied`, `stage_weights_recorded`, `confidence_calibrated` all present. Zero error events.

### 2026-06-15 — Activated the 3 genuinely-dormant engine modules
Wired the only three priority files that were never imported anywhere (per the audit below).

1. **causalMemory** (`buildCausalDigest` / `enrichAndRecord`) — digest of "why related
   things worked/failed" now injected into the Stage 1 system prompt (server.ts ~2412) and
   the synthesis prompt; `enrichAndRecord` records each round (query→answer, confidence =
   composite score) post-synthesis. **Verified:** node written to `~/.crucible/causal-memory.json`
   (live query "Why does adding a database index…" → node, confidence 0.356, persisted).
2. **crossSessionContradiction** (`scanForContradictions` / `buildContradictionWarning` /
   `recordSessionConclusions`) — scans prior session conclusions for conflicts with the current
   query, injects a warning into Stage 1 context + synthesis; records this session's conclusions
   post-synthesis. **Verified:** `.crucible/session-summaries.json` written with the exact
   synthesis from the live query.
3. **hypothesisTester** (`shouldRunHypothesis` / `runHypothesisTest`) — generate-and-run a
   verification for computational claims (calculate / prove / `O(...)`), complementing the
   existing A4 execution-trace (which only runs code already present in the answer). Added an
   `executeCode → ExecutionTrace` adapter; addendum feeds the polish pass via `extraIssues`
   (server.ts ~2969). **Verified end-to-end via tsx probe:** `987*654+321` → sandbox →
   `{"result":645819}`, `passed:true`, addendum generated.

All three: error paths log to the debug bus (`causal_*_error`, `contradiction_*_error`,
`hypothesis_wire_error`) — no silent catches. Read-side functions only emit events when they
*find* something, so a cold store is correctly silent.

**✅ RESOLVED — classifier self-reinforcement loop (was blocking hypothesis + A4 trace live):**
`classifyPrompt` = `learnedClassify() ?? regexClassify()` was being trained at server.ts:1869 and
:1909 on *its own output* (`learnClassification(message, classifyPrompt(message))`) — a feedback
loop with no ground truth that drifted code/math/complexity prompts to `factual`, silently gating
out `shouldRunHypothesis` AND the pre-existing `shouldRunTrace`. Fixes:
- Exported `regexClassify` from modelRegistry; both training calls now feed
  `regexClassify(message)` (deterministic keyword ground truth) instead of the learned guess.
- Reset the 99-entry self-poisoned `.crucible/classifier-history.json` (backed up to
  `.bak-selfreinforced`). Below `MIN_SAMPLES=20`, `learnedClassify` returns null → pure regex,
  so correct labels resume immediately and re-accumulate cleanly.
**Verified live:** "Describe the binary search algorithm and its time complexity O(log n)" now
classifies `coding` (was `factual`); `hypothesis_generated` + `hypothesis_test_result` both fired
on the live query. The hypothesis tester and A4 execution-trace are now active end-to-end.

### 2026-06-15 — Dormant-brain audit + silent-catch fixes (world model diff)
**Audit (verified, not assumed):** Re-ran the "activate the dormant brain" premise against the
live `/api/chat` handler (server.ts:1505–3315). Finding: that premise is now largely **stale** —
Priority One/Two engine modules are already wired *inline* into the request path, each at exactly
one call site inside `/api/chat`: `episodicMemory`/`buildEpisodeContext` (1575),
`uncertaintySurface`/`lookupUncertainty` (1915), `goalDecomposer`/`extractSubtasks` (2137),
`behavioralAdaptation` (2233), `longHorizonPlanner` (2236), `counterfactualBranch`/`runCounterfactual`
(2844, awaited), `confidenceCalibrator`/`calibrate` (2971, awaited + gated at 3015),
`knowledgeDistillation`/`distillRound` (3201), `worldModelDiff`/`applyWorldDiff` (3247),
`knowledgeGapQueue`/`detectGapsFromRound` (3255). Confirmed live on a real authed query
(`world_diff_applied`, `confidence_calibrated`, `genealogy_computed`, etc. all present in
`/api/debug/history`). **Genuinely never-imported** (the only true dormant priority files):
`causalMemory.ts`, `hypothesisTester.ts`, `crossSessionContradiction.ts` — left for a future session.

**Defects fixed this session (silent catches — the brief explicitly forbids these):**
1. `applyWorldDiff` call site (server.ts:3247) was `try { … } catch {}` — now logs
   `world_diff_error` to the debug bus on failure instead of swallowing.
2. `worldModelDiff.ts` inner `upsertEntity` swallow — now logs `world_diff_upsert_error`.

`calibrate` was suspected of not gating (wrapped in `Promise.resolve`) — investigated and cleared:
it is synchronous, awaited in a `Promise.all`, and its `overallScore` drives the confidence gate at
server.ts:3015. No change needed.

Verified: tsc clean on both touched files (only pre-existing top-level-await errors in
`tools/test-tools.ts` remain, unrelated); real authed `/api/chat` query returned full multi-paragraph
synthesis; `world_diff_applied` fired with zero error events.

### 2026-06-15 — Robust verification + server-owned tasks + nested cutoff
Three comprehensive fixes (replacing the earlier module-skip bandaid):

1. GRADED VERIFICATION (sandbox.ts `verifyCode`/`staticVerify`) — "always verify, never skip".
   The sandbox is network-denied (security model), so code importing third-party libs can't
   fully execute (that was the bogus TS2307 that drove destructive auto-fixes). Now: run fully
   when possible; on a pure module-resolution failure, fall back to REAL static verification —
   TS type-check with module diagnostics (2307/2305/2306/7016) filtered, `node`/TS syntax for
   JS, `ast.parse` for Python, `bash -n` for bash. Always a real verdict; emits `verify_static`
   ("Syntax & types verified — runtime needs external deps"); never skips, never destroys code.
   Verify route now calls `verifyCode` and the module-skip bandaid is removed.

2. UNIFORM NESTED CUTOFF (mobile.css) — every code box caps at 360px desktop / 55vh mobile with
   internal scroll; header (language + copy) stays above the scroll area. One big code output
   can no longer turn the whole pane into a code block. Still fully scrollable + copyable.

3. SERVER-OWNED TASK REGISTRY + REPLAY (server.ts + App.tsx) — the comprehensive fix for
   "response doesn't finish when you switch apps mid-query". Every /api/chat run is a task that
   buffers its full SSE stream keyed by taskId (= roundId), via a one-time res.write/res.end
   hook — captures BOTH the agent and synthesis paths. New `GET /api/task/stream?taskId=&from=`
   replays buffered events then live-tails; `GET /api/task/:id/status` for the load-time check.
   1h TTL after done. Client: `consumeStream` extracted from `send` so the live loop AND
   reconnect share one consumer; taskId saved to localStorage on send; on load + every
   visibilitychange→visible, `reconnectActiveTask` resets the round and replays from index 0
   (rebuild-from-scratch avoids double-applied tokens), else falls back to session restore.
   Replaces the old passive-stream (synthesis-token-only) reconnect.
4. PWA PUSH NOTIFICATIONS (done) — web-push installed; VAPID keys in .env.local
   (VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT). Server: `/api/push/vapid-public`, `/api/push/subscribe`
   (per-user subs in .crucible/push-subscriptions.json), and `notifyUser()` fired from
   `finishTask()` (only for real runs >3s & >4 events). Client: registers `public/sw.js`,
   subscribes on the send gesture (`ensurePushSubscription`). The SW suppresses the notification
   when a window is focused, so you're only pinged if you actually left. `public/manifest.webmanifest`
   + manifest/theme-color added to index.html for installability.

### 2026-06-15 — FATAL fix: verify/fix pass destroying code answers
Symptom: a full code answer got "corrected" to a single line — `// No change needed to fix
TS2307 as the import is removed.` Root chain (server.ts /api/verify surgical path ~3271):
the sandbox ran the code as TypeScript and hit TS2307 (cannot find module — a missing-dep
ENVIRONMENT issue, not a code bug), triggering the fix cascade; the surgical model replied with
a prose comment instead of code; with no fenced block the code took `modelResult.trim()` (the
comment) as the "fix"; a lone comment EXECUTES successfully (empty program) → `verify_fixed`
emitted with the comment → client `applyFixedCode` spliced it OVER the whole code block.
Three-layer fix:
1. Client `applyFixedCode` (src/App.tsx) — CRITICAL backstop covering every fix source: reject
   any replacement that is comment/whitespace-only, or <50% the size of a >120-char original.
   A degenerate "fix" can never overwrite a real code answer again.
2. Server surgical fixer — require an actual fenced code block WITH real (non-comment) code
   lines before accepting a model fix; otherwise discard. "No change needed" can't be a fix.
3. Server verify — skip the fix cascade entirely on module-resolution errors (TS2307 / Cannot
   find module / No module named / ERR_MODULE_NOT_FOUND / Could not resolve): leave the answer
   untouched, emit verify_clean with an honest "imports unavailable in sandbox" status.
Backend restarted (not watch mode). Verified: transpiles + typechecks clean, boots clean.

### 2026-06-15 — Fix: response-pane copy buttons + code-block rendering bugs
Frontend-only (src/App.tsx), HMR — no backend restart:
- `applyFixedCode()`: the end-of-answer correction had two bugs. (1) For a prose answer (no
  code fence) the `else` branch wrapped the ENTIRE answer in a bare fence → "plain text became
  a code/TypeScript block". Now returns prose unchanged. (2) Now strips any self-fence from the
  fixer's output and preserves the ORIGINAL language tag verbatim → fixes "Python code reset to
  TypeScript after the correction".
- CollapsibleCode: code no longer overflows off the right behind the box edge. Switched the
  SyntaxHighlighter to `wrapLongLines` + `whiteSpace: pre-wrap` (and overrode the inner `<code>`
  tag, which oneDark forces to `pre`) so long lines spread downward and wrap cleanly.
- Copy buttons: master "Copy full exchange" now sits in the top corner of every response;
  "Copy answer" moved to the lower action row (the two were swapped). Each code block keeps its
  own corner copy button, now with an always-visible divider line under the header so it reads
  as an independently-copyable nested box.
  NOTE: "nested text box" interpreted as each fenced code block. If the user meant per-section
  prose boxes, that's a larger change — confirm before building.

### 2026-06-15 — Fix: active conversation lost on browser close / refresh
Root cause: `send()` wrote `rounds: []` to `/api/session/save` on every submit ("clear stale
session"), so the persisted copy was EMPTY for the entire deliberation window — only re-saved
once synthesis tokens streamed (the last pipeline stage). Close the tab before then → blank on
return. Also the cross-device session id lived in `sessionStorage`, wiped on tab close.
Fixes (src/App.tsx):
- `sessionId` now persists in `localStorage` (migrates any legacy sessionStorage value).
- `send()` saves the new turn (incl. user message) IMMEDIATELY instead of blanking it.
- Added a continuous debounced persistence effect on `[rounds, mode]` — saves on every
  meaningful change, not just synthesis tokens.
- Added a synchronous keepalive flush on `pagehide` / visibility-hidden so the final ~1s of
  streamed tokens survive the debounce window (mobile tab eviction).
- Removed the now-redundant inline `saveSession` in the synthesis-token handler.
Backend `/api/session/{save,restore}` infra was already correct (per-user files, 24h TTL);
the bug was purely the client defeating it. Verified: typechecks clean, endpoints reachable
(auth-gated 401 without login cookie, as expected).

Follow-up (same session) — the DEEPER bug: "leave during code-gen, return to a dead query."
Generation runs server-side and survives client disconnect, but on completion the server only
wrote the answer to `history-<user>.json` (a summary store) — NEVER back into the active session
the client restores from. So the answer was generated but orphaned; restore showed the query
with no answer. Fix makes the SERVER authoritative over the active session:
- New `patchActiveSessionRound(user, roundId, patch)` in server.ts: read-modify-write that
  merges the finished answer into the matching round by id (preserves the rest of the thread).
- Client now sends `roundId` in the `/api/chat` body.
- Called on completion in BOTH paths: agent loop (`final` text) and synthesis pipeline
  (`pipelineSynthesisText`) → sets `{ synthesis, synthesisDone: true, synthStreaming: false }`.
- Client restore now polls `/api/session/restore` every 3s (≤5 min) while the last round is
  still unfinished, merging answers in by id as the server completes them — so returning
  WHILE generation is in flight fills the answer in live, no manual refresh.
Known tradeoff NOT changed here: the agent/code path aborts 60s after disconnect (checkpoint
resume covers longer absences). If we want long code tasks to keep running after you leave,
that grace window is the knob — flagged for a product decision.

### 2026-06-14 — Remaining item sweep: U10/U11, P12/P14/P15, cache bypass, confidence gate, specialization decay

**Agentic cache bypass (`server.ts`)**
Both exact and semantic cache checks now gate on `isAgenticIntent = detectAgentTask(message)`. Any prompt that routes to the agent loop bypasses cache entirely — cached text can never substitute for live execution. Fixes the case where `mode === 'code'` with agentic intent could hit a stale cache response.

**U10 — Time-of-day valence signal (`anima/valence.ts`)**
`timeOfDayModifier()` returns a signed score nudge and a signal label based on current hour. Late night (11pm–3am): −0.08 nudge. Early morning (4–6am): −0.06. Evening: −0.03. Applied only when `confidence > 0` so neutral sessions receive no false signal. Signal label surfaced in the ANIMA debug stream.

**U11 — ANIMA active indicator (`App.tsx` narrateProcess)**
When a round has `animaTruths`, `narrateProcess()` appends a line noting how many observed patterns shaped the response. Visible in HOW WE GOT HERE on the process trail.

**P12 — Live shard progress (`orchestrator.ts` + `App.tsx`)**
Per-shard triadic pass now emits `masterpiece_shard_progress { completed, total, shardIndex, domain }` as each shard finishes. App.tsx renders a thin progress bar ("N/M shards") while deep mode is running. Bar transitions via CSS ease so it feels smooth.

**P14 — User-provided document ingest (`server.ts`)**
`POST /api/corpus/ingest-document` — accepts `{ text, domain, source?, sourceReliability? }` and runs the full Living Corpus ingest pipeline (chunk/embed/dedup/validate/quarantine/relationship-extract). Returns ingested/deduped/quarantined/bytes counts. Minimum 50 chars, domain required. Emits `corpus_user_ingest` to debug bus.

**P15 — Abductive connection persistence (`corpus/living.ts` + `orchestrator.ts`)**
`persistSurvivedConnections()` in `living.ts` writes dialectic-survived, high-novelty (> 0.65) connections back into the Living Corpus as new chunks after every deep mode run. Format: "Cross-domain insight (A → B):\n{bridgeReasoning}\n\nStructural mirror: ...\n\nFragile assumption: ...". Source reliability scales with novelty score. Fire-and-forget from orchestrator so it never delays the response.

**Specialization memory decay (`modelRegistry.ts`)**
`recordSpecialization` now applies exponential decay (`half-life = 60 days`) before blending the new score. Timestamps stored in `.crucible/specialization-ts.json`. Prevents models that dominated a category early (small sample) from holding that advantage indefinitely. EMA drifts back toward neutral (0.5) as time passes without new signals.

**Confidence-gated response commitment (`server.ts`)**
After H1 calibration: when `overallScore < 0.55` on factual/reasoning/math prompts, a fast model call (5s cap) derives what specific information or verification step would resolve the uncertainty. Result emitted as `uncertain_commitment { overallScore, resolvingStep }`. App.tsx renders it as an amber-bordered block in the process trail: "A definitive answer requires: ..."

**Reference hard prompt (`.crucible/benchmarks/reference-hard-prompt.md`)**
Canonical 5-part stress test on dietary protein + all-cause mortality. Designed to characteristically fail single-model systems (confident consensus smoothing, extrapolation not flagged). Pass criteria: all 5 sections, 2+ named contradictions, 1+ extrapolation flag, specific open questions, confidence MEDIUM or LOW, sub-90s wall clock. Comparison export schema documented for demo use.

**Q7 removed** — standby pre-warm deemed obsolete (keepalive already maintains hot connections; standby hot-swap is correctly gated on mid-flight failures, not warmth).

**Files changed:** `anima/valence.ts`, `App.tsx`, `masterpiece/orchestrator.ts`, `masterpiece/corpus/living.ts`, `server.ts`, `modelRegistry.ts`, `ROADMAP.md`. New file: `.crucible/benchmarks/reference-hard-prompt.md`.

### 2026-06-14 — Model Selection Overhaul: Cold-Start Fix, Probation System, Waitlist Intelligence

**Root cause analysis — why 2-3 models dominated despite 30+ in registry:**

Four compounding bugs prevented fair model competition:

1. **Specialization forcing locked in winners permanently** (`specializationForcing.ts`). Once any model crossed `FORCE_THRESHOLD = 0.78` EMA, it received a guaranteed pipeline slot on every single request. With `MAX_FORCED = 2`, this consumed 2 of 3 deterministic slots before `selectModels` even ran. No hunter model could displace them. Fixed: added `FORCE_RECENCY_WINDOW = 50` — forced slots now require the model to have been called in the last 50 pipeline runs. Stale specialists no longer camp slots. `recordPipelineRun()` and `recordForcedCall()` wired into `server.ts` at `applyForcedSlots`.

2. **Cold-start death spiral for hunter models.** Hunter models entered the registry with zero `modelOutcomes` history. They competed once (wildcard slot), failed on a flaky free tier, received immediate `modelFailurePenalty` (30–90%), and dropped below proven static models permanently. No recovery path existed since viability requires 30 new calls to flush bad history, but low-scoring models rarely got called.

3. **Hunter probe quality scores were all flat `{5,5,5,5,4,5}`** — the `probeQuality()` 4-probe battery was timing out silently on every model because the initial ping already exhausted the model's free-tier budget. 10s per probe × 4 probes = 40s total, but slow models (Nemotron took 32s on a one-word ping) had nothing left. Fixed: added shared 20s budget across all 4 probes (`QUALITY_BUDGET_MS`), 15s latency gate rejecting models too slow to be useful (`MAX_PROBE_LATENCY_MS`), and a blocklist for routers (`openrouter/openrouter/free`).

4. **Keepalive `finally` block never landed** (from prior session handoff). `activePipelineRequests` counter was absent entirely, so keepalive pings fired during live pipeline requests, consuming quota from rate-limited providers mid-request. Fixed: added counter declaration, increment at pipeline entry, and `finally` decrement block on the top-level pipeline catch.

**New infrastructure built:**

- **`src/CrucibleEngine/waitlistManager.ts`** (new, 383 lines) — full pipeline: Hunter Discovery → Waitlist → Probation → Graduate/Reject. Key behaviors:
  - Max 2 concurrent probation slots
  - Hard failures (404/decommissioned) rotate out immediately, pull next from waitlist
  - Soft failures (429/timeout) don't count against probation — free-tier noise distinguished from model death
  - 3 consecutive soft fails treated as hard fail
  - Graduation gate: `viabilityScore < 0.4` after 5 calls → reject; `0.4–0.6` → low-confidence graduate; `> 0.6` → full graduate
  - Tiered rejection cooldowns: 1st failure = 48h, 2nd = 30 days, 3rd+ = 90 days (never permanent — models get updated)
  - Persists to `.crucible/waitlist.json` and `.crucible/probation-history.json`

- **Two-layer waitlist scoring (0–100):**
  - Layer 1 (60% weight, intrinsic): probe quality score normalized, param count sweet-spot bonus (7–70B), probe latency score, probation history penalty
  - Layer 2 (40% weight, external): background scraper runs every 6h — fetches OpenRouter model card → follows HuggingFace link → extracts MMLU/HumanEval/ARC benchmark scores. Graceful degradation: if scraping fails, Layer 1 takes full 100% weight, never blocks queue
  - Age bonus: +2pts per 6h cycle, uncapped — guarantees every model eventually reaches the front regardless of score
  - Fairness gate: no model waits more than 10 cycles

- **Probation injection** wired into main pipeline at `server.ts:1485` — probation models injected as extra slots beyond normal ensemble size, tagged `isWildcard: true`. Doesn't displace proven models.

- **`GET /api/waitlist`** — live waitlist + probation status + rejection history.

- **Waitlist score updater** runs every 6h via `setInterval`, calls `updateWaitlistScores()` then `promoteNextFromWaitlist()`.

- **Hunter integration updated** — `runModelHunter` `onFound` callback now calls `enqueueModel()` instead of direct probation, routing all discoveries through the waitlist pipeline.

- **Bad discovered-models.json data cleaned** — removed Nemotron 550B (32s probe latency), openrouter/openrouter/free (router not a model), Nex-N2-Pro (flat probe scores indicating all quality probes timed out).

**Files changed:** `server.ts`, `modelRegistry.ts` (none — all selection logic correct), `src/CrucibleEngine/specializationForcing.ts`, `src/CrucibleEngine/modelHunter.ts`, `src/CrucibleEngine/waitlistManager.ts` (new).

**Verified:** server boots clean, `/api/waitlist` responds, hunter triggered manually via `POST /api/hunter/run`, specialization forcing patch confirmed in file.

**KEY ENDPOINTS ADDED:**
- `GET /api/waitlist` — waitlist queue, active probation slots, rejection history with cooldowns

### 2026-06-14 (session 5) — Track Q: SUBSTRATE (viability / diversity / hot-swap)

Built the model-selection substrate deferred at the end of session 4. Three components, all in
`modelRegistry.ts` (selection core) + `server.ts` (wiring):

- **Q1 viability fingerprints** — per-model rolling outcome ring → graded `viabilityScore` blending
  success rate and median latency, neutral until 3 samples, multiplied into the `selectModels` score.
  `recordModelOutcome` wired at the Stage 1 success path (streaming bypasses `_emitModelResult`, so
  this was the gap that made the first test show all-failures) and all three failure sites.
- **Q2 diversity-maximised selection** — `pickDiverse()` greedy picker (merit-first, then provider+
  family-repeat penalties) replaces the naive top-N slice; `modelFamily()` derives architecture family.
- **Q3 standby hot-swap** — `pickStandby()` + a `runStage1Model()` refactor so a hard early failure
  dispatches a diverse standby that re-joins the ensemble inline. Code-verified, correctly gated; the
  live swap path has not yet been *observed* firing (no qualifying hard mid-flight failure in tests).
- **Q4** `GET /api/debug/substrate` — fingerprints + live provider/family spread.

**Verified live (3 real quorum queries):** viability diverged exactly as designed — Qwen3 0.667
(fast), GPT OSS 120B 0.533 (same success rate but slow → latency penalty drops it below Qwen),
Gemini 0.1 (0/3, floored). A complex query selected 5 slots across 4 providers / 5 families instead
of clustering on openrouter. Server boots clean (no TDZ/crash), endpoint live.

**Deferred:** Q3 forced-failure live test; Q6 Hunter probe battery; Q7 standby pre-warm + pool-health
gauge; Q8 App.tsx HOW-WE-GOT-HERE additions (land with Track C8 corpus-query integration).

**Also this session — unified diagnostics endpoint `GET /api/diag` + `npm run diag`.** One call returns a
full-system snapshot (pipeline / models / substrate / masterpiece / anima / corpus / errors) so a
diagnosis needs no grep or log-reading. Session-scoped counters (`diag` object in `server.ts`, reset on
restart) wired at the real hook points: request count + cache hits at the cache gate, quality + last-request
at pipeline completion, gate decision + light/deep fires + novelty at `evaluateGate`/light enrichment,
valence + shaping at `runAnimaShaping`, diversity + selection at `model_selection`, hot-swaps in the Q3
swap block. Persistent blocks pull from their own stores (`MODEL_REGISTRY`+circuit states, `viabilitySnapshot()`,
`substrateReport()`, `animaStore.allLiveTruths()`, `corpusStatus()`, `debugBus.history()`). Per-model
`lastCall` added to the viability ring (`lastModelCall()`). Each block independently try/caught — never
500s. **Verified live:** cold snapshot (all blocks render: 31 models, 19 viable / 12 excluded with reasons,
4 anima truths, 2123 corpus chunks) + post-query (requests=1, lastRequest filled, diversity 0.8, gate
decision captured, 5 models with `lastCall` timestamps).

### 2026-06-14 (session 4) — Track C: LIVING CORPUS infrastructure

Built the self-maintaining knowledge-corpus substrate (Track C). Scoping decisions (user-directed): deliberate upfront curation toward the 1GB allocation (not organic growth), Track C infrastructure first (Track Q SUBSTRATE deferred to next session). **Reality flagged & accepted:** a complete 1GB embedded + relationship-graphed corpus cannot finish synchronously in one turn (real network + disk + millions of would-be relationship calls); this session delivers the complete, verified machinery + a deliberate-curation acquisition driver running against real key-free sources, with the corpus filling over time and the lifecycle refining it.

**7 new files (`src/CrucibleEngine/corpus/`):**
- `db.ts` — SQLite (WAL) at `.crucible/corpus/corpus.db`. Tables: `chunks` (content + embedding + source_reliability + staleness_class + retrieval_value + uniqueness + status + superseded_by), `relationships` (7 edge types), `retrieval_log`, `governance_log`, `coverage_gaps`. Indexed on domain/status/staleness/confidence. **Invariant: no public DELETE path — status transitions only (active/archived/quarantined/superseded). Good data never leaves the corpus.**
- `ingest.ts` — full pipeline: sentence-boundary chunking (~512 tokens, 64-token overlap), embedding (shares the MASTERPIECE vector space), cosine dedup (>0.92 → bump confirmation, skip), 4 validation gates (source authority / internal consistency / contradiction / adversarial-style anomaly incl. prompt-injection detection) → **quarantine not reject**, and **budgeted** relationship extraction (model call over top-5 embedding neighbours; the spec's per-chunk call is infeasible at scale, so it's budget-capped per cycle).
- `lifecycle.ts` — staleness decay (`STALENESS_HALF_LIVES`: permanent/scientific 10y/engineering 3y/technology 18mo/current 30d), retention score (0.40 confidence + 0.35 retrieval-value + 0.25 uniqueness), weekly natural shedding (retention < 0.15 after 90d → archive, recoverable), supersession detection (contradiction > 0.7 → archive old as superseded, both stay queryable), weekly gap audit (deficit vs `TARGET_ALLOCATION` × importance + query-miss-rate).
- `acquire.ts` — deliberate-curation driver with **real key-free connectors**: Project Gutenberg (plain-text classics, license-header stripped), RFC editor (TCP/IP/HTTP/TLS standards), arXiv API (cross-domain abstracts: hep-th/quant-ph/math.CO/q-bio/econ.GN/nlin.AO), Stanford Encyclopedia of Philosophy (HTML-stripped, entity-decoded). `CURATION_MANIFEST` maps the priority allocation to concrete fetches; byte + relationship budgeted.
- `query.ts` — retrieval surface: semantic search over active chunks (superseded labelled, on request), relationship-graph one-hop expansion, and `recordRetrievalOutcome` performance feedback that feeds retention + gap detection.
- `index.ts` — `initCorpus` (startup: lifecycle + gap audit + background acquisition), `startAcquisition`, `corpusStatus`.

**server.ts:** `initCorpus` at startup (background, never blocks requests — corpus invariant #5); `GET /api/corpus/status` (chunk counts by status, domain distribution, bytes, gaps, progress %); `POST /api/corpus/acquire` (manual cycle trigger).

**Verified live (real content):** server boot → lifecycle started → gap analysis (empty corpus → philosophy/computer-science/physics top gaps) → background acquisition fetched the SEP "consciousness" entry over HTTP, stripped/chunked/embedded/validated/ingested **79 chunks**; after ~90s: **89 active chunks, 0 quarantined, 34 relationships extracted, 89 governance ingest events**. Retrieval test ("subjective conscious experience and qualia") returned genuinely relevant hits — Nagel's "what it is like" (0.419), conscious mental states (0.349). `/api/corpus/status` live.

**Deferred (noted, not built this session):** Track Q SUBSTRATE (fingerprints/viability/diversity/standby/monitor/Hunter probe battery/new providers/selectModels rewire); MASTERPIECE↔living-corpus query integration; App.tsx HOW-WE-GOT-HERE additions (diversity score / hot-swaps / contributing corpus domains) — these depend on Substrate + the corpus-query integration and land with them.

### 2026-06-14 (session 3) — MASTERPIECE two-mode rewrite + Track U (ANIMA)

Two-track architectural change implemented together (ANIMA depends on the MASTERPIECE rewrite). Verified end-to-end against all three spec scenarios; hardened via a 5-dimension adversarial review workflow (privacy, SSE consistency, two-mode logic, runtime safety, correctness).

**Part 1 — MASTERPIECE: two-mode universal activation.**
- `gate.ts` rewritten: `evaluateGate(prompt) → { mode: 'light' | 'deep' }`. The gate is now a MODE SELECTOR, not on/off. **C4 (ensemble confidence ≥ 0.70) removed entirely** — it meant MASTERPIECE never fired when the ensemble struggled (exactly when it's needed). Deep triggers on complexity alone: tokens ≥ 150 AND subtasks ≥ 2 AND type ≠ factual. `countSubtasks`/`detectPromptType`/`estimateTokens` exported for reuse.
- `orchestrator.ts` split into `runMasterpieceLight` (local corpus enrichment — semantic + abductive query + local structural resonance, NO model calls, 500ms `withTimeout` budget, returns partial on overrun; novelty-scores each connection locally; feeds calibration a weak signal) and `runMasterpieceDeep` (consumes the light `EnrichedContext`, reuses its Ground Truth Anchor by id, does NOT re-query the corpus; runs triadic → abductive+structural → escalation → MoE → assembler; feeds full dialectical calibration).
- New local helpers: `detectLocalStructuralPatterns` (structural.ts, lexical cues + domain `commonIn`, sub-ms), `detectDomain` exported (mosaic.ts), `recordLightSignal` (calibration.ts, ⅓-strength reinforcement, novelty ≥ 0.5 only).
- **Embedding fix (root cause of degenerate novelty):** the fallback embedder hashed individual CHARACTERS into 20 buckets, so any two longer passages scored ~0.95 similar → every novelty pinned to 1.00. Replaced with **256-dim word-level feature hashing** (FNV-1a, signed, stopword-filtered, TF-weighted, L2-normalised) in `embed.ts`. Now unrelated domains score ~0.00 and related ones discriminate. `ensureSeedCorpus` auto-re-seeds when stored-vector byte length ≠ current scheme; added `resetCorpusChunks` + `getSampleChunkEmbedding` (db.ts) and `ensureEmbedderReady` (settles ONNX-availability before the dim check).
- **server.ts:** light mode + ANIMA shaping fire at request arrival in parallel with Stage 1 (zero added latency); light enrichment + shaping injected into the Stage 5 synthesis system/user prompt; deep mode fires after Stage 5 with the flattened emit boundary; `warmCorpus()` seeds the corpus at startup off the request path. Logs: `[MASTERPIECE:light] found N connections, novelty scores: [...]`, `[MASTERPIECE:deep] activating — token estimate X, subtasks Y, type Z`, `[MASTERPIECE:deep] complete — synthesis replaced`.
- **Resilience (free-tier):** `mpDeps.callModel` is now reject-safe (429/400 degrade per-call to `''` instead of aborting the whole deep pipeline, since `withTimeout` only catches timeouts not rejections); the deep assembler guards against an empty result. Verified: deep mode completes through a barrage of HuggingFace 400 + OpenRouter 429 failures.
- **App.tsx:** `masterpiece_light` handler → "cross-domain connection" line in HOW WE GOT HERE (only when novelty > 0.6); fixed the latent `parsed.data.X` vs `parsed.X` mismatch by flattening events server-side so the existing process-trail UI finally populates.

**Part 2 — Track U: ANIMA (9 new files, `src/CrucibleEngine/anima/`).**
- `types.ts`, `valence.ts` (local emotional valence — content lexicons, linguistic stress, topic shift, behavioural signals, small-ask/large-context gap), `observe.ts` (anonymised candidate extraction via a small fast model; only abstracted signal labels + a topic CLASS reach the model — never raw text), `verify.ts` (5 gates: confidence/novelty/fragility/dialectical-challenge/cross-domain-dedup), `store.ts` (SQLite `.crucible/anima/truths.db`, anonymous — no user/session id, day-level dates only; write/confirm/contradict/query/decay/list), `apply.ts` (valence + truths → invisible `ShapingDirectives`), `transparency.ts` (the only explicit surface), `index.ts` (`runAnimaShaping` sync phase-1 + `runAnimaLearning` background phase-2).
- **server.ts:** transparency query short-circuit (build report BEFORE any write so a build error falls through cleanly, never double-writing the SSE stream); ANIMA shaping computed at request arrival and injected into Stage 5; `runAnimaLearning` fire-and-forget after synthesis.
- **App.tsx:** `anima_transparency` handler + `Round.animaTruths`; transparency answer renders via the standard synthesis event.

**Adversarial review fixes (5 confirmed findings):** (1) deep no longer suppressed when light fails — runs with a fallback `EnrichedContext`; (2) transparency early-return restructured to build-before-send so a partial-write error can't corrupt the stream; (3) `observe.ts` no longer sends a raw prompt slice to the model — only an abstracted topic class; (4) light calibration skipped for deep-bound prompts to avoid double-reinforcing the same path in one request; (5) deep anchor reconstruction no longer carries a misleading fresh `storedAt`.

**Scenario verification:** S1 — valence fired (`stressed -0.75, conf 0.65`), shaping set `tone=warmer lead=answer`, 2 falsifiable truths extracted+stored. S2 — `.crucible/anima/truths.db` holds universal (not user-specific) claims with proper fragility and 0.35 starting confidence; privacy check confirms no user/session columns. S3 — transparency query returns the active truth in plain language with "(50% confidence, confirmed 2×)". Deep gate confirmed on the distributed-rate-limiter prompt (tokens 158, subtasks 3, type design).

### 2026-06-14 — Track P: MASTERPIECE full implementation

**14 new files written (`src/CrucibleEngine/masterpiece/`):**
- `types.ts` — all shared types (Shard, TriadicOutput, AbductiveConnection, StructuralResonance, EscalationDecision, RefinedShard, ReasoningPath, GroundTruthAnchor, MasterpieceDeps, MasterpieceResult, GateDecision, CorpusChunk, CalibrationRecord)
- `gate.ts` — 4-condition composite gate: token count ≥ 300, ≥ 2 sub-tasks, synthesis prompt type, ensemble confidence ≥ 0.70
- `mosaic.ts` — Ground Truth Anchor (SQLite-stored, never modified) + model-driven shard decomposition with heuristic fallback
- `triadic.ts` — parallel triadic dialectical pass: thesis/antithesis/middle-ground, 3 models per shard, all shards and all 3 arms run simultaneously
- `abductive.ts` — cross-domain connection finding via corpus query + adversarial dialectical challenge; only survived connections returned
- `structural.ts` — 6 canonical structural patterns with edge topology; model maps shard content onto patterns and identifies resonant domain
- `escalation.ts` — shard-level coherence scoring; LOW/UNVERIFIED shards escalate to independent external model
- `moe.ts` — 4 specialist archetypes (researcher/coder/strategist/critic); specialist receives full context: shard + triad + connections + resonances + escalation
- `calibration.ts` — epistemic path weight tracking with 30-day half-life decay; paths that survive dialectical challenge gain weight
- `orchestrator.ts` — 3 parallel execution blocks + sequential assembler; Ground Truth Anchor invariant enforced throughout; emits all MASTERPIECE SSE events
- `corpus/embed.ts` — ONNX `all-MiniLM-L6-v2` (384-dim quantized) with 20-dim hash projection fallback
- `corpus/db.ts` — SQLite schema v1: documents, chunks, reasoning_paths, calibration_records, anchors; WAL mode
- `corpus/ingest.ts` — 10-document curated seed corpus (information-theory, evolutionary-biology, thermodynamics, cognitive-science, complex-systems, game-theory, philosophy-of-science, network-science, economics, computer-science); auto-seeds on first run
- `corpus/query.ts` — top-k semantic similarity queries; `queryCrossCorpus` excludes shard's own domain for genuine cross-domain search

**`server.ts` changes:**
- Import `runMasterpiece` from orchestrator, `evaluateGate` from gate
- MASTERPIECE block wired after Stage 5 completes: computes ensemble quality from `scores`, evaluates gate, runs MASTERPIECE, emits `{ type: 'synthesis', replace: true }` with enhanced text

**`App.tsx` changes:**
- `masterpiece` field added to `Round` type (display metadata only, never synthesis content)
- SSE handlers for all 8 MASTERPIECE event types: `masterpiece_gate`, `masterpiece_shard`, `masterpiece_triadic`, `masterpiece_abductive`, `masterpiece_escalation`, `masterpiece_moe`, `masterpiece_assemble`, `masterpiece_complete`
- MASTERPIECE display block in process trail: shard count, cross-domain connections, structural resonances, escalation count, elapsed time, domain pairs, structural patterns, high-confidence shard count
- MASTERPIECE chip added to collapsed process trail summary line

**Bug fixes (same session):**
- I5 Adversarial Critic: removed ALL `finalText` mutations and ALL `replace:true` emissions from critic block. Critic now only emits `{ type: 'critic', problems }`. Added `criticProblems` field to Round type + process trail render.
- Intent classification: added research-as-verb bypass (regex for "research ... and/then ... produce/write/analyze") before seeker keyword list
- YouTube URL hallucination: added `search_youtube` tool that fetches real video IDs from `ytInitialData` JSON in YouTube search result pages
- External execution intent: `detectExternalExecIntent()` added to server.ts; `detectAgentTask` guard updated to not block external exec intents; EXECUTION INTENT DETECTED preamble injected into agent system prompt

**Packages installed:** `better-sqlite3`, `@xenova/transformers`, `@types/better-sqlite3`

### 2026-06-14 (session 2) — MASTERPIECE follow-up: gate fix, token overflow fix, output quality fixes

**Problem 1 — MASTERPIECE gate never fired:**
- Root cause: `estimateTokens()` in `gate.ts` used `words × 0.75`. Dense technical text (longer words like "distributed", "stateless", "consensus") had far fewer words than expected: 111 words → 83 estimated tokens, failing C1 ≥ 150.
- Fix: Changed to `Math.round(text.trim().length / 4)` — the industry-standard char/4 approximation. Same 702-char prompt now correctly estimates 175 tokens and passes C1.
- Verified: all four gate conditions (C1 tokens ≥ 150, C2 sub-tasks ≥ 2, C3 prompt type, C4 quality < 0.70 ∥ tokens ≥ 500) pass for the distributed rate limiter test prompt.

**Problem 2 — 413: Request too large (Qwen3 32B, Llama 8B):**
- Root cause: Groq imposes a 6000-token per-request limit. `tpmLimit` was set on Llama 8B but missing from Qwen3 32B in `modelRegistry.ts`. `STATIC_PREAMBLE` adds ~50 tokens, pushing 5950-token requests over the limit.
- Fix in `modelRegistry.ts`: added `tpmLimit: 6000` to the Qwen3 32B entry.
- Fix in `server.ts`: added `STATIC_PREAMBLE_SHORT` (minimal version — just the KV cache prefix marker + one-line tone directive). `withStaticPrefix()` now detects when `estimatedTokens + preambleTokens > tpmLimit × 0.88` and substitutes `STATIC_PREAMBLE_SHORT` for those providers. Applies in both `callModel` and `callModelStreaming`.

**Problem 3 — Output quality 4–5/10 on hard coding prompts:**

*3a. L2 decomposition not firing for paragraph-form prompts:*
- Root cause: `extractSubtasks` in `goalDecomposer.ts` only parsed numbered/bulleted/lettered list markers. "Design the complete system: the data structure each server maintains, the gossip/sync protocol…" returned 0 subtasks.
- Fix: added `colonSpecRe` (colon-delimited design specs: "Design X: a, b, c") and `imperativeRe` (imperative sentences: "Show the core data structures…") extraction paths.
- Fix: lowered L2 minimum subtask threshold from 3 to 2 when prompt is ≥ 100 tokens (char/4 estimate), so complex paragraph-form prompts reliably trigger parallel workstreams.

*3b. Contract generator lacks evaluation criteria:*
- Added `EvaluationCriterion` interface and `evaluationCriteria` field to `InterfaceContract` in `contract-generator.ts`.
- Added `buildEvaluationCriteria()`: maps each extracted prompt requirement to a keyword cluster with domain-specific synonym expansion (e.g. "gossip" → \[gossip, sync, propagat, exchang, peer, broadcast\]), so paraphrases ("peer synchronization" instead of "gossip protocol") still score coverage.
- Contract system prompt now includes an explicit "EVALUATION CRITERIA" section, so models see exactly which concepts must appear.
- `evaluationCriteria` added to the `contract` field in `ScoringInput` (`types.ts`).

*3c. Scoring engine does not use evaluation criteria:*
- Added `computeEvaluationCriteriaScore()` to `scoring-engine.ts`: any keyword match within a criterion's cluster → concept covered (paraphrase-tolerant). Missing `required` concepts → blocking critique.
- Wired into the composite score with `evalCriteriaWeight = 0.16` when ≥ 2 criteria are present.
- Rebalanced composite weights: contract 0.35, functional 0.25, novelty 0.03, similarity 0.06, coverage 0.15, evalCriteria 0.16.

---

### 2026-06-13 (session 33) — ROADMAP update: H1/H2/H4 marked complete, Tracks L/M/N/O added

**Verification pass (H1 + H4)**
Both H1 and H4 confirmed rendering correctly end-to-end before proceeding:
- Server started, GR/weak-field query fired via `/api/chat`
- `confidence_calibrated` and `fragility_found` in debug bus — no `fragility_rejected`
- `fragilityAssumption` present in SSE `confidence` event (175 chars, LaTeX named condition)
- UI strip renders: colored dot + tier + score, expands to fragile assumption + flagged claims
- H2 verified unblocked: the surface H2 routes hard queries to is real and rendering correctly

**H2 built (`src/CrucibleEngine/uncertaintySurface.ts`)**
- `recordCalibrationForQuery()` — called post-calibration; vectorizes query with same 20-dim
  hash projection as specializationDetector; finds closest cluster via cosine sim; EMA
  (α=0.25) updates `.crucible/uncertainty-surface.json`. Min similarity 0.1 to associate.
- `lookupUncertainty()` — called pre-Stage 1; returns `forceFullPipeline`, `injectionFlag`,
  `lowerEarlyExitThreshold`. Requires ≥3 samples before routing decisions activate.
- Low-confidence threshold: cluster mean < 0.55 → force full, raise early-exit to 0.92,
  inject uncertainty note into polish system prompt
- `GET /api/debug/uncertainty-surface`; `uncertainty_routing` + `uncertainty_surface_updated`
  events on debug bus
- Wired into `server.ts`: import, pre-Stage 1 lookup folds into complexity/early-exit logic,
  uncertainty flag folded into polish system prompt, `recordCalibrationForQuery` called inside
  the calibration try/catch after the `confidence` SSE event fires

**ROADMAP additions**
- H2 cold-start default [ ] — hardcoded overconfidence domain list needed before cluster
  history accumulates
- H5 frontier epistemic awareness [ ] — "is this question answerable at all?" extension of H4
- Track L (L1–L3) — Pipeline Performance: parallel stages, prompt decomposition, predictive
  load balancing. Motivated by neuromorphic benchmark timing out at 8-9 min
- Track M (M1–M3) — Conversational Intelligence: low-content fallback, seamless mode
  transition, proactive contextual engagement
- Track N (N1–N3) — Autonomous Infrastructure: governance UI, server provisioning, domain
  knowledge store routing
- Track O — AGI Extensions: behavioral adaptation layer, long-horizon cross-session planning
- Neuromorphic stress test canonical prompt documented with pass criteria
- Architectural notes from June 13 session added (provider caps, Rick Astley moment)

### 2026-06-13 (session 32) — Track H4: fragility assumption (specific, named, no hedges)

**`src/CrucibleEngine/confidenceCalibrator.ts`**
- `buildFragilityPrompt(synthesisText, question)` — the core prompt. Design constraint baked in:
  bad/good contrast in the prompt body forces the model toward named entities over generic
  disclaimers. Bans modal verbs ("may", "might") in the output, requires a named entity
  (specific product, number, policy, version), demands exactly one sentence with no preamble.
- `isSpecificEnough(assumption)` — specificity gate before surfacing. Requires a named entity
  (capitalized proper noun, version string, number, year, or quoted term). Rejects outputs with
  >1 modal verb. Rejects if <20 or >300 chars. Emits `fragility_rejected` to debug bus with
  the rejected text for tuning visibility.
- `getFragilityAssumption(...)` — calls a fast model with a 4s timeout (non-blocking). Strips
  common opener prefixes ("This answer assumes", "Note:", etc.). Returns null on timeout,
  model failure, or specificity rejection. Emits `fragility_found` to debug bus on success.
- Only fires for `factual | reasoning | math | general` prompt types. Skips `coding | creative`.

**`server.ts`**
- `getFragilityAssumption` imported alongside `calibrate`
- Both run in `Promise.all` after polish — calibration is synchronous (deterministic), fragility
  races a model call. Wall-clock cost = max(calibration, fragility) ≈ 4s cap, not sequential.
- Picks `fastModels[0]` from `selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum')`
  — smallest/fastest available model, since specificity comes from the prompt, not capability.
- `fragilityAssumption` added to the `confidence` SSE event (undefined when null).

**`src/App.tsx`**
- `Round.confidence` gains optional `fragilityAssumption?: string`
- UI: when present, renders above the flagged claims under a "fragile assumption" label.
  Italic, slightly brighter than flagged claims (0.55 opacity vs 0.3). Visually distinct
  because it's a different signal — structural fragility vs grounding failure.
- Collapsed summary line shows "1 fragile assumption" in amber when present.

**Verified live:** GR vs Newton question produces:
  "The spacetime metric reduces to the Newtonian potential in the weak-field, low-speed
  limit — if this correspondence fails, the claim that GR reproduces the inverse-square
  law and matches planetary motions breaks."
Named entity, concrete condition, exact consequence. No modals. `fragility_found` in debug bus.

### 2026-06-13 (session 31) — Track H1: confidence calibration wired end-to-end

**`src/CrucibleEngine/confidenceCalibrator.ts` (wired)**
Previously a complete but entirely dead module. Now called at the end of Stage 5b after
polish finalizes, before the `replace: true` synthesis event fires. Receives: all Stage 1
`revised` responses as `modelResponses`, `groundingBlock` as `webGroundingContext`,
`verifierIssues` from the domain verifier, and the mean composite score. Returns
`overallTier`, `overallScore`, and per-claim LOW/UNVERIFIED flags.

**`server.ts`**
- Import `calibrate` from `confidenceCalibrator`
- After polish, call `calibrate()` with full pipeline context (non-blocking, try/catch)
- Emit `{ type: 'confidence', overallTier, overallScore, summary: {high/medium/low/unverified}, flaggedClaims }` as a new SSE event type
- Fixed the uppercase/lowercase key mismatch in `CalibrationResult.summary` — interface now uses `HIGH/MEDIUM/LOW/UNVERIFIED` matching the internal `counts` object
- `confidence_calibrated` event lands in the debug bus with `claimCount`, `overallTier`, `overallScore`, `counts`

**`src/App.tsx`**
- `Round` interface gains optional `confidence` field (overallTier, overallScore, summary, flaggedClaims)
- SSE handler: `parsed.type === 'confidence'` stores result into the round
- UI: compact `<details>` strip renders below synthesis text when `round.confidence` is present
  - Collapsed by default — a colored dot + "confidence MEDIUM (60%)" + flagged count
  - Expanded: per-tier counts + each flagged claim with its tier badge
  - Color-coded: green for HIGH, amber for MEDIUM, red for LOW/UNVERIFIED
  - No emojis, letterSpacing consistent with rest of UI

**Verified live:** `confidence_calibrated` appears in `/api/debug/history`. SSE event
carries correct `summary` counts. On a clean factual response: MEDIUM overall, 2 medium
claims, 0 flagged. Event fires after genealogy, before `stage 5 done`.

### 2026-06-13 (session 30) — Context anchor + intelligence layer (7 modules)

**`src/CrucibleEngine/contextAnchor.ts` (rebuilt)**
Full spec rebuild. Added `DiscrepancyType` union (`SEMANTIC_DRIFT | MISSING_ENTITY | MISSING_REQUIREMENT | CONTRADICTION`). Each discrepancy now has a typed `weight` score (0–1). SEMANTIC_DRIFT below Jaccard 0.65 is ignored; at or above it emits a weighted SEMANTIC_DRIFT discrepancy; very high drift + low cosine → CONTRADICTION. Added `diffAgainstAnchor(anchorId, compressedState): Discrepancy[]` as the canonical API. Replaced pure Jaccard with dual metric (Jaccard + local TF cosine) using the `buildVector`/`cosineSim` pattern consistent with the rest of the codebase. `validateCompression` kept as a backward-compat wrapper that derives the legacy `action` string from the highest-weight discrepancy.

**`src/CrucibleEngine/contextManager.ts` (rebuilt)**
Full spec rebuild. Adds `ModelBudget` tracking per session (`initBudget`, `updateBudget`, `getBudgetState`) with per-model-family token limits. Compression fires at 85% of token budget (or 60k chars, whichever comes first). `transparentModelSwitch` uses `getBenchedIds` from `rosterRotation.ts` to avoid benched models and logs every switch to `debugBus` as `agent/model_switch`. Handoff now uses `buildHandoffPrompt` producing the spec's `{ taskGoal, compressedState, discrepancyPatches, currentPosition, nextExpectedOutput }` format. All events (`context_compression_start`, `context_compressed`, `model_switch`, `model_switch_failed`) emitted to debugBus.

**`src/CrucibleEngine/causalMemory.ts` (new)**
Directed graph of cause-effect relationships. `CausalNode: { event, outcome, confidence, sessionId, timestamp }`. `CausalEdge: { cause, effect, strength, observedCount }`. `addCausalEdge` reinforces existing edges via EMA (α=0.2). `query(context)` returns ranked causal chains with upstream causes and downstream effects. `enrichAndRecord` cross-links new nodes to entityGraph entities and past decisionMemory entries. Persisted to `~/.crucible/causal-memory.json`, capped at 1000 nodes / 3000 edges.

**`src/CrucibleEngine/goalDecomposer.ts` (new)**
Heuristic decomposition (no model call — free-tier safe). Detects numbered/bulleted lists and "then/also/and then" connectors to build a `SubtaskNode[]` dependency tree. Estimates confidence per node from vague-language and complexity signals. `propagateUncertainty(tree, nodeId, newConf)` BFS-flags all downstream dependents when confidence drops below 0.6, injecting caveats. `buildDecompositionContext` produces an injection block for agent preambles.

**`src/CrucibleEngine/crossSessionContradiction.ts` (new)**
Extends counterfactualBranch with a session history index. `scanForContradictions(prompt)` scores each known fact from recent session summaries against the current prompt using topic overlap + polarity detection + numeric divergence. Events above `CONTRADICTION_THRESHOLD` (0.65) are logged to `.crucible/contradiction-log.json`, stored in `decisionMemory`, and emitted to debugBus. `recordSessionConclusions` should be called after each pipeline round to keep the index current.

**`src/CrucibleEngine/hypothesisTester.ts` (new)**
For `coding`/`reasoning`/`math` prompts with computable claims. `generateHypothesis` extracts math expressions, inline code blocks, or assertion patterns without a model call. Runs test via the caller-provided `runCode` function (wraps `sandbox.ts`). On failure, `reviseHypothesis` wraps in try/catch and retries once. Result injected as `[HYPOTHESIS TEST RESULT]` block into synthesis prompt. `buildTraceBlock` from `executionTrace.ts` formats stdout/stderr/exit. All steps emit to debugBus.

**`src/CrucibleEngine/confidenceCalibrator.ts` (new)**
Final-pass claim scorer. `calibrate(synthesisText, opts)` extracts declarative sentences, scores each by: ensemble agreement (proportion of model responses covering the claim, 40% weight), web grounding hit rate (30%), verification pass/fail from domainVerifiers (30%). Maps to `HIGH | MEDIUM | LOW | UNVERIFIED` tiers. Annotates `[LOW]`/`[UNVERIFIED]` inline. Returns `summaryBlock` for response top (`"Confidence: HIGH (82%) | 5 high · 2 medium · 1 low"`). `adjustScoreForConfidence` nudges composite score down proportionally to unverified ratio. Emits `confidence_calibrated` to debugBus.

**`src/CrucibleEngine/improvementDaemon.ts` (updated)**
Added 5 new periodic tasks: `causal_memory_compact` (8h — prunes edges strength < 0.2), `goal_decomp_health` (3h — health signal), `contradiction_sweep` (2h — reports contradiction log stats), `confidence_calibration` (4h — avg composite score trend), `context_budget_report` (1h — model switch count from contextManager). Added `recordModelSwitch(dir, from, to, reason)` — called by contextManager/server.ts wiring to make every transparent model switch visible in the debug bus and daemon log. `DaemonState` extended with `modelSwitches[]`. `loadDaemonState` now merges new tasks into saved state so upgrades are additive. `buildIntelligenceHandlers(projectDir)` returns the handler map for the five new tasks; server.ts should merge it into the daemonTick handler map.

### 2026-06-13 (session 29) — Context continuity under resource constraints

**`src/CrucibleEngine/contextManager.ts` (new)**
`maybeCompressMessages(messages, goal, callModel)` fires when the raw transcript exceeds 60,000 chars (~15k tokens). Two modes: (1) model-assisted — a fast general model summarises old turns into a dense anchor block (7s timeout, falls through silently on failure); (2) structural fallback — deterministic extraction of assistant decisions and recent tool observations into a `[CONTEXT HANDOFF]` block. The system message is always preserved verbatim. The last `KEEP_RECENT_TURNS=6` user/assistant exchanges are kept raw. Everything older is replaced by the single anchor block. The calling loop never knows a handoff happened — the result is a normal messages array.

**`src/CrucibleEngine/contextAnchor.ts` (new)**
In-memory anchor store keyed by agent loop invocation. `createAnchor(anchorId, original)` extracts: named entities (capitalized words, numbers with units, file paths), explicit requirement sentences ("must", "should", "ensure", etc.), and stores the original prompt verbatim. After each compression, `validateCompression(anchorId, compressedSummary)` runs two checks: (1) Jaccard distance — semantic drift signal; (2) entity and requirement coverage — are the specific facts and instructions from the original still present? Weight table: semantic drift alone → `ignore`; missing >2 entities → `inject_entities` (patch block listing lost facts); missing requirements → `re_anchor` (re-inject original requirements); high drift + no entity loss → `flag_contradiction`. The returned `patch` string is injected as a user message before the next model turn — surgical, minimal tokens.

**Agent loop wiring (`src/CrucibleEngine/agent/loop.ts`)**
- `compressCallModel?` added to `AgentLoopOpts` — server injects a fast `selectModels('general')` call
- `createAnchor(anchorId, goal)` at loop start; `deleteAnchor(anchorId)` in `done()`
- After `squashOldObservations`, `maybeCompressMessages` is called; if compressed, `validateCompression` runs and any patch is pushed onto the message array
- `context_compressed` event emitted to debug bus with `tokensReclaimed`, `discrepancyAction`, entity/requirement counts

**`server.ts`**
- `compressCallModel` wired into `runAgentLoop` call — uses `selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum')` for the fastest available free model
- `import { getAnchor }` added
- New `GET /api/debug/context-anchor?id=<anchorId>` endpoint — returns original, entities, requirements for inspection during a live agent session

### 2026-06-13 (session 28) — Remaining tracks: A2, A3, A4, B4, E2

**Counterfactual branching (Track A2 — `counterfactualBranch.ts`)**
After synthesis on `factual`/`reasoning`/`math` prompts, an adversarial model is given the same inputs with "assume the top answer is wrong — build the strongest alternative." Jaccard distance between original and adversarial ≥ 0.65 → `flagged=true` and a caveat is appended before polish. Pairs stored in `.crucible/counterfactuals.json` as training signal. Runs concurrently with domain verifier at zero extra wall-clock cost. Endpoint: `GET /api/counterfactuals`.

**Live web grounding (Track A3 — `webGrounding.ts`)**
`isTimeDependent()` matches patterns like "latest", "current CEO", "price of", etc. On match, DDG Instant Answer API is queried (5s timeout, no key required). Response injected as a `[LIVE CONTEXT — date]` block prepended to the Stage 1 user message. Falls through silently on timeout. Emits `web_grounded` debug event.

**Execution traces (Track A4 — `executionTrace.ts`)**
For `coding` responses containing a JS/TS/Python code block, `shouldRunTrace` fires. `extractFirstCodeBlock` pulls the first fenced block, posts it to the internal `/api/verify` endpoint, and `buildTraceBlock` formats stdout/stderr/exit code. The trace is injected into the Stage 5b polish prompt as a `FLAGGED ISSUES` item alongside domain verifier output.

**Meta-pipeline (Track B4 — `metaPipeline.ts`)**
`scheduleMetaTask` is called by the daemon's `failure_taxonomy` handler. It writes a `.crucible/meta-task.json` with a targeted agent instruction (e.g. "reduce 'thin synthesis on factual' failures by improving `domainVerifiers.ts`"). A 30-min polling interval posts the task goal to the internal `/api/chat` agent endpoint, marks it `done`, and clears the file. Endpoints: `GET /api/meta-pipeline/task`, `POST /api/meta-pipeline/schedule`.

**Prompt hardening A/B (Track E2)**
Hardening now fires randomly on 20% of queries regardless of `PROMPT_HARDENING` env var. The cohort (`hardened`/`raw`) is stored in `history.json` per round. `GET /api/debug/hardening-ab` returns count, avg score, and lift for each cohort over the last 200 rounds.

**Tracks now marked [x]:** A2, A3, A4, B4, E2.

**F3/F4 also built this session:** `fineTuning.ts` — SFT from `history.json` entries scoring ≥ 0.80, DPO triples from counterfactual pairs + high/low score history pairs. HuggingFace AutoTrain submission via HTTPS (token from `HF_TOKEN`/`HF_REPO` env). Endpoints: `GET /api/finetune/preview[?type=dpo]`, `GET /api/finetune/export`, `POST /api/finetune/submit`, `GET /api/finetune/jobs`.

**All 26 Track A–G items now [x]. THE REAL GAP section is fully implemented.**

### 2026-06-13 (session 27) — AGI-track mass implementation sprint (Tracks A–G)

**New files:** `rosterRotation.ts`, `selfPatcher.ts` (wired), `failureTaxonomy.ts` (B2), `stageWeightLearner.ts` (B3), `specializationForcing.ts` (C2), `knowledgeDistillation.ts` (C3), `entityGraph.ts` (D1), `decisionMemory.ts` (D2), `preferenceModel.ts` (D4), `specializationDetector.ts` (G2), `sessionQualityArc.ts` (G3), `improvementDaemon.ts` (G1).

**server.ts wiring:** Roster rotation after every pipeline round. Self-patcher cycle every 6h (triumvirate gate). Specialization forcing applied to model selection (forced slots for EMA ≥ 0.78 models). Knowledge distillation context injected into synthesis prompt. Preference model updated on every `/api/feedback` vote. Session quality arc scored after every round. Entity graph + decision context injected into agent system preamble. Improvement daemon ticking every 15min. `episodicMemory.ts` fixed (removed broken `modelRegistry` import, self-contained `vectorize`/`cosineSim`).

**New endpoints:** `GET /api/roster`, `POST /api/roster/promote`, `GET /api/self-patcher/patches`, `POST /api/self-patcher/approve`, `GET /api/failure-taxonomy`, `POST /api/failure-taxonomy/rebuild`, `GET /api/stage-weights`, `GET /api/query-clusters`, `POST /api/query-clusters/rebuild`, `GET /api/preference-model`, `GET /api/daemon/state`, `GET /api/entity-graph`.

**Tracks marked [x]:** A1, B1, B2, B3, C1, C2, C3, C4, D1, D2, D3, D4, E1, E3, F1, F2, G1, G2, G3, G4.

**Remaining [ ]:** A2 (counterfactual branching), A3 (live web grounding), A4 (execution traces), B4 (meta-pipeline), E2 (hardening A/B), F3 (HuggingFace fine-tune), F4 (DPO from failure modes).

### 2026-06-13 (session 26) — Causal probe (Stage 2.5) + Autonomous Model Hunter + polish

**Stage 2.5 — Causal reasoning probe (`server.ts`)**
Fires concurrently with Stage 3 on `reasoning`/`math`/`factual` prompts (skips on early-exit or simple queries). A fast model probes the top-3 Stage 1 responses: "identify the key assumption and one failure scenario per answer." 4s hard timeout; falls through silently. Output injected into synthesis user message as a `CAUTION` block, forcing the synthesiser to address failure modes before assembling the final answer. Emits `causal_probe_done` to debug bus. `earlyExit` declaration hoisted to Stage 2.5 so Stage 3 references it (removed duplicate `const earlyExit` in Stage 3).

**Autonomous Model Hunter (`src/CrucibleEngine/modelHunter.ts` + `server.ts`)**
New module that discovers free models on OpenRouter not already in the static registry. Flow: fetch `/api/v1/models` → filter for `pricing = 0`, text modality, unknown ID → probe-call with "Reply with exactly: ok" (8s timeout) → if pass, build a `DiscoveredModel` entry with inferred quality/params/speed and persist to `.crucible/discovered-models.json`. Server loads discovered models into `MODEL_REGISTRY` on startup; live-injects new models as they're found. Runs 30s after boot then every 24h. `POST /api/hunter/run` for manual trigger; `GET /api/hunter/status` for discovered list.

**History binder — export md + session restore (session 25, same day)**
- "export md" button in hover-expand of each history row; downloads `crucible-<ts>.md`
- Click any row → restores session as a read-only Round in the main view ("click to restore" hint)
- Agent rounds now persisted to history after loop completion

**Global memory (`session.ts`, `tools/registry.ts`, `loop.ts`) (session 25)**
- `~/.crucible/world.md` persists cross-project user facts; injected into every agent system preamble
- `write_global_memory` tool + loop preamble section

### 2026-06-14 (session 26) — Chat persistence, cross-device SSE, multi-user auth

**Auth layer (`server.ts`, `src/api.ts`, `src/App.tsx`):**
- JWT HS256 with `crypto.createHmac` — no external auth library. `JWT_SECRET` from `.env.local`.
- Google OAuth2 + GitHub OAuth: standard authorization code flow implemented with plain `fetch` — no Passport, no openid-client. Credentials from `.env.local` (`GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`).
- `GET /api/auth/google` → Google consent screen. `GET /api/auth/callback/google` → exchanges code, upserts user, issues cookie, redirects to frontend.
- `GET /api/auth/github` → GitHub consent screen. `GET /api/auth/callback/github` → same flow; fetches `/user/emails` for users with private emails.
- CSRF state param: 16-byte random hex per request, stored in in-memory Map with 10-min TTL.
- `upsertUser(provider, providerId, email)` — creates user on first login, looks up by provider+id on repeat. No passwords stored anywhere.
- `.crucible/users.json` fields: `{ id, email, provider, providerId, createdAt }`.
- `parseCookies` helper — no cookie-parser dependency.
- `POST /api/auth/logout` — clears cookie. `GET /api/auth/me` — returns `{ id, email }`.
- All `/api/*` endpoints protected by auth middleware (excludes `/api/auth/*`).
- `apiFetch` wrapper in `src/api.ts` — automatically sends `credentials: 'include'` on every call.
- `AuthScreen` — CrucibleMark logo, "Continue with Google" + "Continue with GitHub" buttons (no passwords, no forms). Provider SVG logos drawn inline. 0.4s fade-in. Error from `?auth_error=` query param on failed OAuth redirect.
- CORS updated to `credentials: true` with dynamic origin reflection.

**Per-user history (`server.ts`):**
- All history writes now use `.crucible/history-<userId>.json` when authenticated.
- Migration: `.crucible/history.json` renamed to `.crucible/history-default.json` on first startup.
- `GET /api/export/gold-standard` scoped to auth user.
- Background analytics (stage_weight_rebuild, self-patcher) fall back to `history-default.json`.

**Server-side session persistence (`server.ts`, `src/App.tsx`):**
- `POST /api/session/save` — writes `{ rounds, mode, timestamp }` to `.crucible/active-session-<userId>.json`.
- `GET /api/session/restore` — returns last saved session if < 24h old, else `{ session: null }`.
- Client: on `synthesis_token` events, debounced 1s save to server; on new send, clears stale session.
- On mount (after auth confirmed), restores rounds and mode from server before user types anything.

**Cross-device SSE broadcast (`server.ts`, `src/App.tsx`):**
- `broadcastClients: Map<sessionId, Set<Response>>` — passive SSE listener registry.
- Both `send()` functions in `/api/chat` (agent path + pipeline path) now broadcast to all passive listeners sharing the same `sessionId`.
- `GET /api/session/stream?sessionId=xxx` — registers a passive SSE listener; 25s keepalive; auto-cleans on disconnect.
- `sessionId` generated in `sessionStorage` on first page load, sent in every `/api/chat` request body.
- Passive listener in `App.tsx` receives `synthesis_token` events from the driving device and appends to the last round.

**HistoryBinder 30s poll (Task 1, `src/App.tsx`):**
- `setInterval(fetchHistory, 30_000)` while panel is open — new sessions appear without reload.

**Mobile reconnect hardening (Task 5, `src/App.tsx`):**
- `visibilitychange` handler: on `visible`, if mid-response reconnects passive SSE stream with exponential backoff (1s → 30s max).
- If response completed while locked, `GET /api/session/restore` merges completed synthesis into last round.
- "reconnecting…" indicator in topbar (amber, pulsing) during reconnect attempts.
- `wasThinkingRef` tracks whether a response was in-flight before the screen locked.

### 2026-06-13 (session 25) — Mobile Studio fix, history restore, agent history, global memory

**Mobile Studio keyboard fix (`LeftDock.tsx`):**
- `inputBarHeight?: number` prop added (default 88). `App.tsx` now passes live `inputBarHeight` state.
- Mobile panel `bottom: inputBarHeight` — stops at the input bar, never overlaps keyboard.
- Scrim `bottom: inputBarHeight` on all viewports — hardcoded `88px` replaced.

**History binder click-to-restore (`App.tsx`):**
- Each row in `HistoryBinder` is now clickable: pushes a restored `Round` with `synthesis`, model list, and `synthesisDone: true` into the main rounds array.
- "click to restore" hint appears on hover. `HistoryBinder` accepts `onRestore` callback.

**Agent round history persistence (`server.ts`):**
- After a completed agent loop, `result.finalText` written to `.crucible/history.json` with `promptType: 'agent'`. Now all round types appear in the history binder.

**Cross-session global memory (`session.ts`, `tools/registry.ts`, `loop.ts`, `server.ts`):**
- `appendGlobalMemory(fact, when)` / `readGlobalMemoryDigest()` in `session.ts`. Stores to `~/.crucible/world.md`, compressed to last 1500 chars.
- Global digest injected into agent system preamble (before per-project memory and codebase context).
- `write_global_memory` tool registered — agent uses it when it learns durable user facts.
- Loop preamble section explains when to use global vs project memory.
- `GET /api/memory/global` for inspection.

### 2026-06-13 (session 24) — Code Studio inline panel + agent mode in Studio

**Code Studio layout overhaul (`LeftDock.tsx`):**
- Studio is no longer a full-screen overlay. Desktop: left side panel at `min(52vw, 680px)`, chat area shifts right to fill remaining space. Mobile: 95vw full-height overlay sliding in from left, with chat input bar always visible below.
- Scrim `bottom: 88px` creates a dead zone above the input bar so tapping outside the panel closes it without the keyboard intercepting the tap.
- Mobile collab button (`.crucible-studio-collab-btn`) hidden via media query on `<= 640px`.
- Agent toggle in studio input bar uses text-only (no emoji).

**Agent mode in Studio:**
- Toggle in the studio input bar switches between ensemble build mode and agent loop mode.
- Agent loop mode shows a live `StudioAgentPanel` with steps, tool calls, and diffs as the agent works.

**Mobile keyboard fix (session 25):**
- `inputBarHeight` prop added to `LeftDock` (default 88). `App.tsx` passes live `inputBarHeight` state down.
- Mobile panel `bottom: inputBarHeight` — panel stops exactly at the input bar, never overlaps the keyboard.
- Scrim `bottom: inputBarHeight` on all viewports — hardcoded `88px` replaced with live value.

### 2026-06-13 (session 23) — Goal Autonomy (Gap 1) + Triumvirate Meta-Learning (Gap 4)

**`src/CrucibleEngine/goalEngine.ts` (new)**
Six analyzers scan all `.crucible/` data sources and produce a ranked `ImprovementGoal[]`:
1. `analyzeQualityByPromptType` — groups quality-history by promptType; any category > 8 pts below global average becomes a goal
2. `analyzeErrorRecovery` — debug patterns with count ≥ 5 and auto-fix rate < 60% surface as error_recovery goals
3. `analyzeModelUnderperformance` — specialization EMAs < 35% flag model_underperformance with a retrain_model_bias action
4. `analyzeWeightDrift` — scoring weights > 55% (dominant) or < 15% (suppressed) become rebalance goals
5. `analyzeTriumvirateBalance` — proposal types with approve rate < 10% or > 90% over last 50 decisions flag calibrate_triumvirate
6. `analyzeCoverageGaps` — prompt types with < 3% share in pipeline history flag expand_coverage

Goals sorted by priority (1=highest) then by gap magnitude. Top 10 returned. `autoImprove.ts` runs `identifyGoals` + `saveGoalReport` after each pass; logs top goal title + rationale. `GET /api/autonomous/goals?refresh=true` to force recompute.

**`triumvirate.ts` — meta-learning extension (Gap 4)**
`recordTriumvirateOutcome(dir, approved, rejected, qualityBefore, qualityAfter)` — called from `autoImprove` after each pass; stores rolling 100-entry window to `.crucible/triumvirate-meta.json`.
`runMetaLearning(dir)` — runs after recording; three conditions:
- Approvals correlating with quality drops (< −3pts avg) → +0.1 to weight_change multiplier (tightens toward 4/3 unanimous)
- Reject rate > 85% with flat/down quality → −0.1 to knowledge_pattern multiplier (relaxes toward 1/2 majority)  
- Quality trending up with healthy approve/reject balance → +0.05 toward defaults on both multipliers
3h cooldown between adjustments; full adjustment log in `adjustmentLog[]`.
`effectiveThresholds(dir)` returns integer-rounded required-approval counts after multiplier. Exposed via `GET /api/autonomous/meta`.

### 2026-06-13 (session 22) — Tool Acquisition (Gap 2)

**`src/CrucibleEngine/tools/dynamicTools.ts` (new)**
Agent can write and register its own tools at runtime via a `create_tool` meta-tool. The body is a
JS async function that receives `(args, ctx, require)` and must return `{ ok, output }`. Compilation
uses `vm.Script` for syntax checking (error thrown immediately at register time) then `AsyncFunction`
constructor for execution — module-scope `createRequire` provides Node builtins. Five test cases verified:
echo, os.hostname, syntax error, runtime throw, bad return type.

`create_tool` registers the new ToolDef live in the current session (available immediately) and
persists the record to `.crucible/dynamic-tools/<name>.json`. `loadDynamicToolsInto()` called at
server startup loads all persisted tools so every future session inherits them — the agent's toolkit
grows permanently. `list_dynamic_tools` lets the agent introspect its earned kit.

`GET /api/debug/dynamic-tools` returns count + per-tool stats (use count, creation date).
`tool_created` SSE event wired into the agent UI — appears in the tool call log.
Agent preamble gains a TOOL ACQUISITION rule: "if no existing tool covers the need, use create_tool."

### 2026-06-13 (session 21) — Codebase Indexing (Gap 3 — Persistent World Model)

**`src/CrucibleEngine/state/codebaseIndex.ts` (new)**
Walks the project on first agent run — skips `node_modules`, `.git`, `dist`, `.crucible` etc. —
extracts symbols (exported functions/classes/types via regex) and imports from `.ts/.tsx/.js/.py/.go`
and 15 other extensions. No model calls — fully deterministic, free-tier safe. Persists to
`.crucible/codebase-index.json` (capped 400 entries, 200 KB per file). On subsequent runs, only
re-indexes files whose mtime changed (typically < 50ms hot-path).

**Retrieval:** same `vectorize`/`cosineSim` architecture as the semantic cache and quality predictor.
Each file's vector is built from `[rel path, symbols, imports, summary]` text. `searchIndex(idx, query, topK=8)`
returns the most relevant files for the current agent query.

**Injection:** `buildCodebaseContext(projectPath, query)` is called at agent start before Stage 1.
The resulting `CODEBASE (N files indexed): …` block (top-8 relevant files with their symbol lists) is
appended to the agent's `systemPreamble` alongside the existing `memoryDigest`. Both planned and direct
agent paths receive it.

**Live updates:** `ToolCtx` gains `onFileMutated?(absPaths)` hook. `write_file`, `edit_file`, and
`apply_patch` in `tools/registry.ts` each call it after writing. Server wires it to `reindexFiles()`
so the index reflects every file the agent touches within the same session. The `/api/file/write`
REST endpoint also calls `reindexFiles` after writes.

**Debug endpoint:** `GET /api/debug/codebase?project=<path>&q=<query>` — returns total/byLang stats
and, when `q` is provided, the top-10 semantic hits with symbols and summary for each.

### 2026-06-13 (session 20) — Drift Prevention Triumvirate

**`src/CrucibleEngine/triumvirate.ts` (new)**
Three judge models with distinct mandates run in parallel to debate every proposed autonomous
change before it is committed. STABILITY judges destabilization risk (weight drift, narrow
over-indexing). EFFICACY judges evidence quality (sample size, circular reasoning from prior
autonomous commits). DIVERSITY judges ensemble breadth (novelty weight floor, similarity
ceiling, pattern deduplication). All three are prompted with the exact proposal text and respond
with a structured VERDICT: APPROVE/REJECT + REASON. Judges are picked from different providers
(one Groq, one Mistral, one OpenRouter) for architectural independence — same prompt sent to
three different training distributions. 8s timeout per judge; conservative default REJECT on
timeout or error. Full debate log persisted to `.crucible/triumvirate-log.json` (capped 200).

**Voting thresholds:**
- Scoring-weight changes → unanimous (3/3) — high stakes
- Knowledge-base pattern additions → majority (2/3) — lower stakes

**`src/CrucibleEngine/autoImprove.ts` — gated**
Both Pass 1 (pattern extraction) and Pass 2 (weight adjustment) now call `runTriumvirate()`
before committing. Rejected proposals are skipped with a console log — the improvement pass
continues for other proposals. `setCallModel()` lets server.ts inject the live `callModel`
function at startup so autoImprove.ts never imports from server.ts (avoids circular dep).

**`server.ts`**
- Imports `setCallModel` and calls it at server startup with the live `callModel` fn + `MODEL_REGISTRY`
- Imports `loadTriumvirateLog` from triumvirate.ts
- New `GET /api/autonomous/debates?n=N` endpoint returns last N debate entries

### 2026-06-13 (session 19) — Autonomous background improvement + response-time dashboard

**1. Autonomous Background Improvement (`src/CrucibleEngine/autoImprove.ts`)**
Fires non-blocking after every pipeline round (5s debounce). Three passes: (1) Pattern extraction —
reads quality-history, mines top-5% composite-score entries, builds tier-2 KnowledgeEntry objects
from extracted tokens and adds them to the live scoring engine via addApprovedEntry(); persisted
to .crucible/learned-patterns.json and loaded at server startup. (2) Weight tuning — compares
promptType distribution of top vs bottom entries, nudges ScoringConfig.weights ±0.01 toward what
correlates with winning; bounded per-dimension and re-normalized to sum to 1.0. (3) Git audit —
stages .crucible/ changes and commits with [autonomous] prefix + timestamp. Rollback gate: if
qualityPredictor.stats() returns trend='down', reverts last autonomous commit. `GET /api/autonomous/status`.

**2. Live SCORING_CONFIG (`server.ts`)**
`SCORING_CONFIG` wraps DEFAULT_SCORING_CONFIG and merges learned weights at startup and after each
round; all three evaluateIteration call sites updated to use SCORING_CONFIG — weights now drift
automatically as the system learns.

**3. Response-time dashboard (`server.ts`)**
`recordLatency()` in `_emitModelResult` maintains a rolling 50-sample window per model ID.
`getLatencyReport()` computes avg / p50 / p95 from sorted samples. `GET /api/debug/latency`
returns all models sorted by avg latency with provider annotation.

### 2026-06-13 (session 18) — Flywheel: quality predictor + smarter routing

**1. Cross-Session Quality Predictor (`src/CrucibleEngine/qualityPredictor.ts`)**
New module parallel to debugAnalyzer. Extracts a feature vector from each prompt (tf-normalized
tokens + 5 structural scalars) and stores `(features, compositeScore)` to `.crucible/quality-history.json`
after every pipeline round. `predict()` runs k-NN (k=7) weighted by feature cosine similarity,
returning `{ predictedScore, confidence, recentAvg, trend }`. Wired into pipeline before Stage 1:
confidence < 0.3 (uncertain) forces full pipeline even on "simple" queries; confidence ≥ 0.5 +
predicted ≥ 0.8 drops the early-exit threshold from 0.85 → 0.75. The threshold change flows
through all three sites that reference it. `GET /api/debug/quality`.

**2. Smarter Routing (`modelRegistry.ts`)**
`classifyPrompt` now runs learned k-NN classification first, falls back to regex if < 20 samples,
cosine similarity < 0.25, or no majority vote (> 50% weight). `learnClassification()` appends
`(tokenized prompt, promptType)` to `.crucible/classifier-history.json` on every pipeline round —
no manual labeling needed, history accumulates automatically. `GET /api/classifier/stats`.

### 2026-06-13 (session 17) — Flywheel core: specialization memory + response genealogy + prompt hardening

**1. Model Specialization Memory (`modelRegistry.ts`)**
After every Stage 1 score, `recordSpecialization(modelId, promptType, score)` appends an EMA
(α=0.2) entry to `.crucible/specialization.json`. `selectModels` reads these weights at selection
time and multiplies each model's composite score by `1 + (ema - 0.5) * 0.15` — a model averaging
0.8 in factual gets +4.5%, one averaging 0.2 gets -4.5%. Bias grows as data accumulates, starting
at neutral (no file = all 1.0). Surfaces in `/api/debug/topology` as e.g. `"factual +14.0%"`.

**2. Response Genealogy (`server.ts`)**
After Stage 5b finalizes `pipelineSynthesisText`, splits the synthesis into sentences (>20 chars)
and cosine-matches each to the best-fitting model response using the existing `vectorize`/`cosineSim`
functions. Produces `attribution: {sentenceIdx → modelId}` and `contributionRates: {modelId →
fraction}` stored alongside each history entry. Models that survive into synthesis receive a second
`recordSpecialization` call: `0.5 + contributionRate * 0.5` — stronger signal than Stage 1 score
alone (a model scoring 0.9 but contributing 0% to synthesis gets no compounding advantage). Emits
`genealogy_computed` to the debug bus.

**3. Adversarial Prompt Hardening (`server.ts`)**
When `PROMPT_HARDENING=true` in `.env.local`, before Stage 1 the fastest non-tripped Groq model
rewrites the prompt for maximum precision. `workingMessage` (hardened) is what Stage 1 models
receive; original `message` is kept for display, history key, semantic cache, and polish prompts.
2s hard timeout, falls through silently on any failure. Emits `prompt_hardened` to debug bus.
A/B validation (compare composite scores hardened vs raw) remains for a future session.

### 2026-06-13 (session 16) — UI fixes: scroll clearance + verify-fix word wrap

**1. Scroll clearance (bottom of response → 1px above model cards)**
Replaced the spacer div + stale-state approach with `paddingBottom: inputBarHeight + 1` directly on
the scroll container. The browser uses the live inline value at every scroll calculation — no timing
gap between model cards appearing and `inputBarHeight` updating. Added `inputBarHeight` to the
auto-scroll effect deps so when the input bar grows (cards appear/disappear), the scroll re-fires
with the correct `scrollHeight`. Fixed `mobile.css` to override `padding-top/left/right` individually
instead of the shorthand, so the dynamic `paddingBottom` isn't clobbered on mobile.

**2. Verify-fix word wrap**
Root cause: global CSS `pre { white-space: pre !important }` was inherited by `<code>` elements
inside `<pre>` wrappers from ReactMarkdown, killing all word-wrap properties on no-language fenced
blocks. Fix: added `pre` component override in synthesis ReactMarkdown that renders as a fragment
(`<>{children}</>`), removing `<pre>` from the DOM entirely. No-language fenced blocks now route to
a plain styled `<div>` with `white-space: pre-wrap + wordBreak: break-word` (monospace, dark
background, scrollable) instead of `CollapsibleCode` — which the user correctly identified as an
inappropriate "nested box" for base responses. Language-tagged blocks still use `CollapsibleCode`.

**3. Flywheel special track added to ROADMAP**
Five compounding-advantage tracks added: smarter routing (trained classifier replacing regex),
model specialization memory (per-category win tracking → selection bias), response genealogy
(attribution of synthesis sentences back to source models → implicit quality signal), adversarial
prompt hardening (precision rewriter before Stage 1), cross-session quality predictor (same
pattern-learning architecture as debugAnalyzer applied to composite score prediction).

### 2026-06-13 (session 13) — Semantic cache (Tier 1 Performance)

On an exact-cache miss, Crucible now checks for a *paraphrase* of a prior query before running
the full pipeline. `semanticLookup()` (`server.ts`) compares the new query to every live cache
entry by content-word token-cosine: `vectorize()` lowercases, keeps `[a-z0-9]{2,}` tokens, drops
~40 stopwords, and applies a minimal plural/3rd-person `-s` stemmer (deliberately NOT `ing/es/ed`
— those over-stem nouns like "string"→"str"); `cosineSim()` scores them. Best match ≥ 0.82 is
replayed instantly with events tagged `cached + semantic`, plus a `semantic_cache` note event
carrying the similarity and matched query. The vec/cosine pair is isolated so a real embedding
backend can swap in later without touching the call sites — true to the free-tier philosophy
(local, instant, zero model calls). UI: the green cache badge now reads `similar · N%` for a
semantic reuse, with the original question in a hover tooltip.

Tuning was test-driven: a 7-case matrix (paraphrases must HIT, different key nouns must MISS).
0.9 + aggressive stemming failed ("reverse"≠"reverses"); plural-`s`-only stemming at 0.82 gives a
clean gap — paraphrases land 0.87–1.00, distinct intent 0.50–0.67. Verified live end-to-end.

### 2026-06-13 (session 12) — UX fixes: refinement-preserves-code-block, dynamic "How we got here", mobile rule

**1. Refinement no longer destroys the code-block UI (`src/App.tsx`).**
`verify_fixed` / `analysis_fixed` previously did `synthesis: parsed.code` — replacing the entire
markdown answer with RAW code, so the `CollapsibleCode` block (and any surrounding prose) was lost
and it rendered as flat text. New `applyFixedCode(original, fixedCode)` splices the fix INTO the
original answer's first fenced block, preserving the language tag, surrounding prose, and the
collapsible rendering — only the code changes. Falls back to wrapping in a fence if the original had
none. Also: the code-mode synthesis prompt now *requires* a fenced ```lang block (defensive against
the session-11 global preamble).

**2. "How we got here" → dynamic, personality-driven narration (`src/App.tsx`).**
The "Process" line was a single hardcoded sentence every time. New `narrateProcess()` infers a
1–4 sentence story purely from the round's own data — deterministic (same every reopen, different
per prompt, no model call): difficulty opener keyed on top score + score spread + complexity;
an underdog callout when a ≤9B model matches the leaders (parses the size from the label, e.g.
"Llama 3.1 8B (8B) punched above its weight") — suppressed when that small model was itself the
synthesiser; a disagreement note on high spread + multiple critiques; the verify outcome
(fixed/clean); and a resilience note when models dropped mid-run. Verified across easy/hard/underdog
scenarios — output is distinct and sensible each time.

**3. New permanent working rule (top of this doc): mobile + desktop, always.**
Every UI change must hold on BOTH form factors; refinement passes must preserve the rendered UI
shape. Recorded in the UI rules block so all future work honours it.

### 2026-06-12 (session 11) — KV-cache prefix optimization (Speed track closed)

**The idea (roadmap):** identical static preamble (same tokens, same order) across calls so
providers' prefix KV caches hit. Previously the system message led with the *variable*
`contract.systemPrompt`, so almost no prefix was shared between calls.

**What changed — `server.ts`:**
- `STATIC_PREAMBLE` — a byte-for-byte constant block of global rules (plain text, no emojis,
  no prose-in-code, lead with substance), tagged with marker `[[crucible-core-v1]]`.
- `withStaticPrefix(messages)` prepends it to the first system message (or injects one),
  idempotent via the marker, and is applied unconditionally at the top of **both** `callModel`
  and `callModelStreaming`. Every provider call now shares the longest-possible identical prefix;
  the variable contract/aspect/codebase/question content follows it.
- Bonus: the rolling keepalive "Hi" pings now carry the same preamble, so they actively keep the
  shared prefix warm in each provider's cache between user requests.
- The global rules also reinforce the session-11 prose-in-code fix at the source.

With this, the Speed (free-models-only) track is fully closed. Verified live: prose and
length-directive queries return correctly with the prefix in force; no regressions.

### 2026-06-12 (session 11) — Output-quality fix: prose-in-code artifact

**Bug:** asking for prose (e.g. a fox story) sometimes returned the narrative stuffed into code
scaffolding — `const story = \`story.\`;`, a lone ```` ```block ```` , or a `console.log(…)` call —
so it read like "a script-pasting bot" instead of eloquent prose.

**Fix (both ends, per "gold out"):**
- *Backstop — `normalize.ts`:* new `unwrapProseWrapper()` (run first in `normalizeOutput`) detects
  the three wrapper shapes and unwraps to the inner text, gated by a conservative `looksLikeProse()`
  (≥60% letters, <3% code-punctuation density, sentence-shaped). Real code has high symbol density
  so it never trips — verified: 6/6 cases (3 prose wrappers unwrap, real fenced/inline code + plain
  prose untouched). Since `normalizeOutput` runs on both synthesis inputs and the final answer, the
  artifact is scrubbed even if a model emits it.
- *Prevention — prompts:* the `creative` contract format and the non-code synthesis system prompt
  now explicitly forbid wrapping prose in code blocks / quotes / variable assignments.
- Verified live (uncached): fox tale now returns flowing prose, no scaffolding.

### 2026-06-12 (session 10) — Speculative Stage Execution (Speed track closed)

**The idea (roadmap):** start the next stage on the likely winner while Stage 1 is still
streaming; discard if wrong. Built on session 9's provisional scoring.

**What changed — `server.ts`:**
- Factored the synthesis system prompt into `synthSystemContent` and added
  `buildSynthesisMessages(ids)` so the speculative and real synthesis paths share one builder.
- `maybeSpeculate(leaderId)` fires once, from Stage 1, when a model finishes with a dominant
  score (≥0.85 → forces early-exit) **or** any simple-path leader lands (≥0.4) — both cases skip
  Stage 3+4, so synthesis input == Stage 1 responses. It captures the currently-ready response
  set and kicks off a buffered synth call on the leader *while slower models are still streaming*,
  emitting `pipeline/speculative_synthesis_start`.
- At Stage 5, **commit iff** the speculation's input id-set exactly equals the final synthesis
  input set (`models.filter(revised)`) and we're on the early-exit/simple path — meaning the
  stragglers we bet against were dropped or rolled back. On a hit: skip the real synth call,
  emit the buffered text as one `synthesis_token`, then the normal Stage 5b polish + final
  `replace` run unchanged (`speculative_synthesis_hit`). On a miss: discard, synthesise normally
  (`speculative_synthesis_miss`). The wasted speculative call is free-tier; the payoff is the
  synth latency disappearing behind Stage 1's tail.

**Why it's correct:** the commit gate is set-equality on contributing model ids, so a committed
speculation was built from exactly the inputs the real synthesis would have used — identical
output, just earlier. Anything else discards. Verified live across simple queries: all three
events fire, one genuine HIT (straggler dropped), and the final answer is correct on both paths.

### 2026-06-12 (session 9) — Partial/Streaming Scoring (Speed track)

**The problem:** Stage 1 only scored a response *after* it finished streaming
(`evaluateIteration` on the full text). The score bar sat at 0 through the entire stream,
then snapped to a value — no live feedback, and the adaptive early-exit had nothing to read
mid-stream.

**What changed — `server.ts` Stage 1:**
- New `provisionalScore(partial)` — a cheap, deterministic 0–1 heuristic over the *partial*
  text: 0.4·length-completeness + 0.3·structure (code-fence in code mode, terminated sentences
  in prose) + 0.3·prompt-keyword relevance, times a 0.5 penalty for stub/refusal/error markers.
  Prompt keywords are extracted once per request.
- The Stage 1 streaming callback accumulates per-model text in `streamed[]` and re-scores every
  ~200 chars of growth (throttled to stay cheap), emitting the provisional score on the existing
  `layer1` event as `{ score, provisional: true }`.
- No client change needed — `App.tsx`'s `layer1` handler already maps `score` onto
  `r.scores[modelId]`, so the bar now fills live and the authoritative `evaluateIteration` score
  overrides it on `done`.

Verified live: provisional scores climb monotonically as a response builds
(0.31 → 0.52 → 0.73 → 0.80) and reset per model. *Speculative stage execution remains open* —
the provisional signal is the groundwork for it.

### 2026-06-12 (session 8) — Predictive Rate Management (Speed track closed)

**The problem:** the old rate-limit penalty was reactive — it counted calls in the last 60 s
and penalised only once a provider was already ≥70% of its soft cap. By the time a burst was
visible in the counter, the wall was often already hit. The roadmap asked for *predictive*
management: shift load **before** the wall.

**What changed:**

**1. `modelRegistry.ts` — velocity-aware predictor (replaces the flat counter)**
- Per-provider call log is now a pruned array of timestamps (1-min window) instead of a single
  counter, so velocity is measurable.
- `predictProviderLoad(provider)` returns `{ count, cap, fillRatio, velocityPerMin,
  projectedCount, secondsToCap, penalty }`. Velocity is calls in the last 15 s scaled to a
  per-minute rate; `projectedCount` extrapolates load 10 s ahead.
- `loadToPenalty()` blends current fill with *projected* fill and applies the worse of the two:
  ≥0.7 → 0.6, ≥0.9 → 0.3, ≥1.0 → 0.1. A provider being hammered fast gets penalised while it's
  still at 0.8 actual fill, because the projection says it'll overshoot. Verified: 20 rapid groq
  calls (cap 25, fill 0.80) → projected 33 → penalty 0.1, secondsToCap 3.75 s; idle providers
  stay at 1.0. `rateLimitPenalty()` (used in `selectModels`) now delegates to this — no caller
  changes needed.
- `allProviderLoads()` exported for diagnostics.

**2. `server.ts` — visibility**
- `GET /api/debug/ratelimit` — full per-provider load snapshot + `atRisk` list (penalty < 1.0).
- `providerLoad` added to `/api/debug/topology`.
- `runKeepaliveRound` emits `circuit/ratelimit_warning` to the debug bus for any at-risk provider
  (severity `warn` when penalty ≤ 0.3), so the predictive shed is visible in `/api/debug/stream`.

Verified live: server boots clean, `/api/debug/ratelimit` returns real provider velocities.

### 2026-06-12 (session 7) — Analysis Pipeline: Multi-Model Fix Tournament

**What changed and why, in the order it was integrated:**

**1. `src/CrucibleEngine/debug/pipeline.ts` — created (Round 4 of /api/verify)**
When Rounds 1–3 (execute, algorithmic fix × 2, surgical single model) all fail, this pipeline
fires. It is the answer to "what if one model can't solve it?"

Architecture of a single pipeline run:
- **Context assembly**: extracts the function scope containing the error line (walks up through
  the code to find the enclosing `function`/`def`/`class`, then down to the next boundary).
  Extracts the first imperative sentence of the original prompt as the "intent" signal.
- **4-way parallel attack**: all four lenses fire simultaneously against architecturally diverse
  models (Llama 3.3 70B · Qwen3 32B · Mistral Small · Gemma 3 27B). Each model gets a
  fundamentally different angle on the same problem — not the same prompt sent four times:
  - *Root Cause*: trace backwards from the error line to find where the bug was introduced
  - *Minimal Patch*: fewest possible lines changed, no restructuring
  - *Intent Restorer*: forget the broken code, rewrite from the task description
  - *Adversarial*: assume the obvious fix is wrong — find the non-obvious issue
- **Fix tournament**: every candidate that runs successfully gets scored with `quickScore`
  (structural heuristics: logic presence, line count, keyword overlap with the original prompt,
  no stub patterns). Passing candidates ranked by score; the winner is returned.
- **Synthesis**: if zero candidates pass but ≥2 produced *different* errors (partial progress),
  the strongest model gets all partial attempts with their remaining errors and synthesizes a
  composite fix. That composite is re-verified in the sandbox.
- **Iterative deepening**: if round 1 fails entirely, round 2 runs with the failure history
  (what each lens tried and the error it left behind) injected into every prompt. Max 2 rounds
  = up to 8 model attacks + 2 synthesis attempts = 10 total fix attempts before giving up.
- All events emitted to debug bus throughout: `analysis_start` · `attack_start` ·
  `candidate_proposed` · `candidate_tested` · `candidate_scored` · `synthesis_start` ·
  `analysis_fixed` · `analysis_failed` · `analysis_deepening`.

**2. `server.ts` — Round 4 wired into `/api/verify`**
The `runAnalysisPipeline` call replaces the old dead-end after Round 3 fails. It passes the
`callModel` function (already instrumented with debug events), `executeCode` as the sandbox
runner, and `send` as the SSE emitter — so the client gets live progress during the parallel
attack. If `analysis_fixed` fires, the verify endpoint closes with success and streams back the
winning code. The old `verify_failed` + `verify_needs_model` fallback is retained for the case
where all 10 attempts genuinely fail.

**3. `src/App.tsx` — pipeline events wired into `runVerify`**
New event handlers: `analysis_start` / `analysis_status` / `analysis_deepening` → update
`verifyMessage`. `attack_start` → show "Analyzing: [Lens] (N/4)". `candidate_tested` →
show pass/fail per lens. `synthesis_start` → show synthesis message. `analysis_fixed` →
same success path as `verify_fixed` (updates code + status). `analysis_failed` → same failure
path as `verify_failed`. The user sees live progress during the multi-model attack without
any new UI components — just the existing verify status line updating in real time.

**Why this is competitive with Claude Code:**
Claude Code uses a single strong model with repeated retries. This pipeline uses multiple
models with *different reasoning architectures* in parallel, picks the best result by a
scoring function, and synthesizes from failures. A bug that stumps a 70B model reasoning one
way may be trivial to a 32B model with a different training distribution. The adversarial lens
specifically targets the class of bugs where the "obvious fix" makes things worse.

### 2026-06-12 (session 6) — Debug Infrastructure + Real-Time Error Correction

**What changed and why, in the order it was integrated:**

**1. Debug Bus (`src/CrucibleEngine/debug/bus.ts`) — created**
A singleton event bus that every part of the system emits into. Backed by a 500-event in-memory
ring buffer and a Set of SSE subscribers. This is the foundation everything else in this session
builds on — without it, errors are only visible in server logs, scattered and uncorrelated.
*Why it's not UI:* It's infrastructure. End users never touch it. Models and developers use the
HTTP endpoints to diagnose problems without grep-searching source files.

**2. Debug Analyzer (`src/CrucibleEngine/debug/analyzer.ts`) — created**
Subscribes to the bus on startup. Accumulates `(language, errorType)` statistics with exponential
moving-average auto-fix rates. Builds per-request causal chains (all events with the same
`requestId` in order). Persists patterns to `.crucible/patterns.json` so learning carries across
server restarts. `predict(language)` returns a ranked list of likely error types — the hook for
proactive warnings before code even runs.

**3. `sandbox.ts` TypeScript type-check upgrade**
`executeTS` previously used `ts.transpileModule` (syntax-only, `transpileOnly: true`). Replaced
with a `ts.createProgram` pass that catches full type errors (TS2xxx diagnostics) with line and
column. Only file-scoped diagnostics are surfaced (stdlib errors are suppressed via `skipLibCheck`).
Transpile-and-run still happens after a clean type-check. *Impact:* type errors that were silently
passing through and causing confusing runtime failures are now caught and classified before execution.

**4. `sandbox.ts` real-time stderr streaming (`executeCodeStreaming`) — new export**
Python and Bash processes previously batched all stderr until `proc.on('close')`. New
`executeCodeStreaming` function flushes each `\n`-terminated stderr/stdout line immediately via
`proc.stderr.on('data')`. Non-process languages (JS, TS) go through the existing batch path then
fake-stream for a uniform interface. Used by `/api/sandbox/run` for live output in the Code tab.

**5. `/api/verify` auto-heal loop — closed on the server**
Previously Round 3 emitted `verify_needs_model` and the client had to fire a full `/api/chat`
call (5-stage ensemble, 15–30s). Now the server handles it directly: tries Groq Llama 3.3 70B →
Mistral Small → OpenRouter Mistral 7B in sequence, extracts the code block from the response,
re-executes it, and streams `verify_fixed` if it passes. The client `verify_needs_model` handler
is kept as a last-resort fallback only if all three models fail. *Impact:* surgical fixes go from
15–30s to ~2–3s and return working code rather than prose.

**6. `server.ts` — debug bus instrumentation**
`callModel` now emits `model_call` (with provider, model id, estimated prompt tokens) on entry.
`callModelInstrumented` wrapper emits `model_result` (latency ms, estimated output tokens) or an
error event on throw. `/api/verify` emits the full event sequence per request:
`verify_start → execution_result → error_detected → fix_applied → verify_result`.
`debugAnalyzer.init(process.cwd())` called on server start to load persisted patterns.

**7. Debug HTTP endpoints — added to `server.ts`**
Five new routes added just before the keepalive block:
- `GET /api/debug/stream` — SSE, sends history on connect then live events
- `GET /api/debug/history?n=N` — last N events as JSON
- `GET /api/debug/chain/:requestId` — causal chain for one request
- `GET /api/debug/patterns?lang=X` — patterns + prediction
- `GET /api/debug/topology` — model registry with circuit states + uptime

**8. Pre-existing keepalive bugs fixed (same session)**
`runKeepaliveRound` used `state !== 'open'` (wrong — `CircuitState` values are `active/tripped/probing`)
and `maxTokens: 32` on `SelectedModel` (field doesn't exist). Both corrected.

**`src/DebugPanel.tsx`** — renamed from a UI overlay to a pure server-side re-export shim.
Exports `debugBus`, `debugAnalyzer`, and their types for any future module that wants to tap in
without importing from deep paths. Not imported by any UI component.

### 2026-06-12 (session 5)
- **Reliability: Timeout + Checkpoint/Resume (closed):**
  - Removed 5-min `WALL_CLOCK_MS` wall-clock kill from `loop.ts`. Raised `maxIters`
    default 16→32 (direct) and 10→20 (per planned step in `planner.ts`). Token budget
    raised 60k→120k.
  - New `src/CrucibleEngine/state/checkpoint.ts` — iteration-level checkpoint
    (`checkpoint-active.json` in `.crucible/`) written after every tool-call round.
    Auto-deleted on clean completion; survives drops/kills/quota hits.
  - `GET /api/checkpoint` — scans `~/Desktop/Crucible/` for live checkpoints.
    `DELETE /api/checkpoint` — clears one by projectPath.
  - Server emits `{ type: 'keepalive', elapsed }` every 25s during agent runs so
    HTTP/proxy connections never idle-close.
  - `{ type: 'iter_progress', iter, maxIters, stepIndex, stepTotal, stepIntent, elapsed }`
    emitted on every loop iteration — drives the live UI timer.
  - UI: live `mm:ss · iter N/M · step N/M · intent…` timer in top bar during agent
    mode; simpler elapsed clock for pipeline mode. Both start/reset with each send.
  - Resume banner: on mount, client polls `/api/checkpoint`; if a saved checkpoint
    exists, a "Paused at step X/Y, iter N/M — Continue" banner appears fixed above
    the input bar. Continue resumes from the exact saved conversation state;
    Dismiss clears the checkpoint.

### 2026-06-12 (session 4)
- **Complete Fluidity track (all 3 items closed):**
  - *True token streaming for all providers:* `callModelStreaming` in `server.ts` now emits
    per-chunk tokens for Groq, Mistral, OpenRouter (SSE `stream: true`), HuggingFace (SSE),
    and Gemini (`sendMessageStream`). Cloudflare stays batched (fast small models).
  - *Stage 3+4 critique-and-revise streaming:* switched from `callModel` to
    `callModelStreaming`; client receives `critique` events with partial text as each model's
    improved response builds. The `done: true` critique event + `revision` event still fire at
    end. CritiqueGrid dot keeps pulsing until `done` arrives — no UI change needed.
  - *Stage 5 synthesis streaming:* `callModelStreaming` emits `synthesis_token` events; client
    appends them to `r.synthesis` in real time with a blinking `|` cursor. Stage 5b polish
    runs silently after synthesis completes; final polished text arrives as
    `{ type: 'synthesis', replace: true, done: true }` which replaces the streamed draft.
  - *Instant first token:* `{ type: 'thinking' }` emitted right after SSE headers are set,
    before model selection or any async work.
  - *Predictive stage labels:* top bar now shows "then {next}" hint alongside the active stage
    label. Pure client-side — no new server events needed.

### 2026-06-12 (session 3)
- **Continuous rolling keepalive (Speed track — closed):** `runKeepaliveRound()` in `server.ts`
  pings every `MODEL_REGISTRY` entry with a trivial prompt on startup and every 4 minutes.
  Calls are staggered 3 s apart to avoid simultaneous rate-limit hits; models with a tripped
  circuit breaker are skipped. Keeps provider connections and KV caches hot with zero user
  interaction required.

### 2026-06-12 (session 2)
- **Polish-concision lever (Stage 5b):** the polish pass now enforces ruthless concision and
  obeys explicit length/format directives. New `extractLengthDirective()` in `normalize.ts`
  detects "in one sentence / N words / bullet points / briefly / one-liner" etc. (8/8 tests),
  and the polish floor relaxes when brevity was requested. Verified live: "What is 2+2? Answer
  in one sentence." now returns "2+2 equals 4." (was a bloated run-on).
- **Section 8 — destructive op confirmation (closed):** `destructiveReason()` in
  `tools/registry.ts` blocks destructive shell commands by default in the `run` tool
  (rm -rf, force-push, reset --hard, git clean -f, sudo, dd/mkfs, recursive chmod/chown,
  power control, fork bombs). Opt in via new `ctx.allowDestructive`. 20/20 detector tests pass.

### 2026-06-12 (session 1)
- Removed all emojis from UI chrome AND at prompt sources so model outputs/code are emoji-free
  (`App.tsx`, `LeftDock.tsx`, `contract-generator.ts`, `server.ts`, `scoring-engine.ts`).
- Fixed text overflow: long unbroken code/strings now wordBreak inside their boxes
  (user bubble, model response, inline code, synthesis body, critique).
- Code Studio (`LeftDock.tsx`) no longer pulls stock/external images — `POWER` prompt rewritten
  to author all visuals in code (SVG/canvas/WebGL/CSS, procedural). De-"image-generator"-ified.
- Animations softened — removed bouncy overshoot easing; fixed whip-away studio close to ease-in-out.
- **"Gold out" pipeline polish (client-side, per philosophy):**
  - New `src/CrucibleEngine/normalize.ts` — deterministic scrub of model output (strips preamble,
    trailing filler, emoji backstop, whitespace). 5/5 unit tests pass. Wired into synthesis inputs.
  - New Stage 5b in `server.ts` — post-synthesis model polish pass (tightens against the question,
    length-guarded so a bad polish can't nuke a good draft). Verified end-to-end.
  - *Known tuning gap:* polish is currently too gentle — doesn't enforce concision or honor explicit
    length/format asks (e.g. "in one sentence"). Next lever to pull.
- Fixed copy button: the `execCommand('copy')` fallback (Electron `file://` path) created a temp
  `<textarea>` that inherited the root's `user-select:none`, so selection was empty and nothing copied.
  Now forces `userSelect:text` + `setSelectionRange`. Also made answer/code/critique/input content
  selectable (`App.tsx`, `LeftDock.tsx`).

---

> **One line:** "We don't need better models. We need better systems. And ours gets better by itself."

### 2026-06-13 (session 15) — Code Studio auto-fix loop, chat history, model fixes, history binder

**Code Studio (`LeftDock.tsx`):**
- `injectErrorReporter()` wraps iframe HTML with `window.onerror` + `unhandledrejection` listeners that `postMessage` errors to parent
- `attemptFix()` — on receiving an iframe error, feeds broken HTML + error message back to the ensemble and swaps in fixed doc; retries up to 3× with amber animated progress bar; send button disabled during fix
- Download button: `↓ export` at bottom bar + `download` button inside code view — creates Blob and triggers browser download
- `key` prop on iframe tied to first 120 chars of `srcDoc` so React remounts on new build (avoids stale cached render)
- Fix state distinct from build state: amber gradient bar vs. indigo gradient bar

**Chat history:**
- Server: after `stage 5 done`, completed pipeline rounds appended to `.crucible/history.json` (ts, query, promptType, models[], synthesis). Capped at 200. `pipelineSynthesisText` hoisted to outer scope to survive the stage-5 try/catch.
- `GET /api/history` endpoint — reads file, returns sessions newest-first
- `HistoryBinder` component — clock icon in topbar button cluster, opens floating frosted-glass card (`blur(40px) saturate(1.5)`, 16px radius, prismatic 2px top stripe). Entries: type-color left stripe, truncated query (wraps on hover), promptType badge, relative time. CSS grid row transition expands model list + synthesis snippet on hover. Closes on outside click. Lazy-loads on first open.

**Model fixes:**
- `llama-3.1-8b-instruct` (Cloudflare) deprecated May 30 — replaced with `llama-3.2-3b-instruct` in both `modelData.ts` (client) and `modelRegistry.ts` (server)
- `parseRetryDelay` in `modelRegistry.ts` now parses Groq's `5m13.632s` format (`in\s+(?:Xh)?(?:Xm)?Xs`) and detects "tokens per day / TPD / daily limit" → 24h cooldown
- `MAX_COOLDOWN_MS` raised from 6h to 25h so daily-reset cooldowns aren't capped short
- Circuit state manually corrected: `llama-3.3-70b-versatile` tripped 24h, deprecated models tripped 30 days

**UI fixes:**
- Removed stale `console.log('[DEBUG] model_selection complexity:…')` from `App.tsx`
- Mobile theater cards: `max-height: 320px` + `overflow-y: auto` in `mobile.css` — card text now scrolls within the card instead of blowing up the horizontal row height on "show more"

### 2026-06-13 (session 14) — Agentic capability fixes: routing, tools, confirmation loop

**Problems fixed:**
- Code mode routed to pipeline (no tools) instead of agent loop for action requests
- Agent asked for specific confirmation phrases then looped when blocked by destructive guard
- `rm -rf` blocked by destructive guard with no fallback, causing infinite confirmation loop

**What changed:**
- `detectAgentTask` in `server.ts` expanded to catch: delete/move/download file ops, confirmation words (yes/proceed/go ahead etc)
- Routing condition: `code` mode now routes to agent loop when `detectAgentTask` fires
- Agent system prompt (`loop.ts`): RULE 1/2/3 at top; EXECUTION OVER SCRIPTING and CONFIRMATION POLICY sections added; explicit instruction to use `delete_folder` not `rm -rf`
- New `delete_folder` tool in `registry.ts` — recursive folder delete scoped to whitelisted paths, bypasses destructive guard safely
- New `empty_trash` tool in `registry.ts` — empties macOS Trash via osascript

### 2026-06-13 (session 14 cont.) — Reconnect grace period + auto-resume

- `server.ts`: 60s grace period before aborting agent on SSE disconnect (screen lock, network drop, page reload). `graceTimer` cleared on clean finish.
- `App.tsx`: `continueFromCheckpointData(offer)` extracted so auto-resume and manual resume share one code path. On mount, if checkpoint age < 90s, auto-resumes silently instead of showing the banner.

### 2026-06-13 (session 14 cont.) — Agentic routing, tool fixes, launch app

**Agentic routing expanded:**
- `detectAgentTask` now catches: folder create/open, file write, multi-step search-then-save, Finder open, confirmation words (yes/proceed/go ahead etc)
- `code` mode routes to agent loop when `detectAgentTask` fires
- `write_file` now has `allowOutside: true` so agent can write to Desktop/Downloads/Documents

**New tools:**
- `delete_folder` — recursive folder delete scoped to whitelisted paths, bypasses destructive guard
- `empty_trash` — empties macOS Trash via osascript

**Agent system prompt hardened:**
- RULE 1/2/3 at top of preamble: never ask for confirmation phrases, never output scripts, use tools
- EXECUTION OVER SCRIPTING: explicit list of tools to use instead of rm -rf
- CONFIRMATION POLICY: yes/proceed/go ahead = execute immediately

**Web search improved:**
- Three-strategy DDG scraper: standard classes → data-result blocks → h2/h3 fallback
- No longer returns zero results when DDG changes markup

**Reconnect grace period:**
- 60s grace before aborting agent on SSE disconnect (screen lock, tab switch)
- Auto-resume if checkpoint age < 90s on page load

**Crucible.app:**
- Double-clickable macOS app on Desktop
- Checks if already running — opens browser directly if so
- Launches Terminal + backend + frontend if not running


### 2026-06-13 (session 16) — Debug bus wiring, agent routing, TS scaffolding, AGI groundwork

**Debug bus wired into agent loop (`src/CrucibleEngine/agent/loop.ts`):**
- Agent loop was completely dark — no events emitted to debug bus
- Added `debugBus` import and emissions at: loop_start, tool calls (name/args/result), agent errors
- Debug history now shows `agent` and `tool` categories alongside `model` and `system`
- Full causal chain now traceable via `curl http://localhost:3001/api/debug/history`

**Agent routing fix (`server.ts` — `detectAgentTask`):**
- Prompts like "write a TypeScript function" were routing to pipeline (display mode) instead of agent loop
- Added patterns: `write/implement/create/build/make` + `function/class/algorithm/solution/program`
- Added patterns: `with a test`, `and verify`, `that works`, `make it run`
- Verified: palindrome prompt now routes to agent, creates files, runs tests, self-verifies

**TypeScript scaffolding fix (`agent/loop.ts` system prompt + `agent/verify.ts`):**
- Agent was generating `"type": "module"` in package.json causing ESM/CommonJS conflicts
- `ts-node` was being used instead of `tsx` — caused module resolution failures
- System prompt now enforces: never set `"type": "module"`, always use `tsx`, CommonJS imports, always run entry point after scaffolding
- `detectCheck` in `verify.ts` now finds TypeScript entry points (index.ts, main.ts, testHarness.ts) and runs them with `npx tsx` instead of just `tsc --noEmit`
- Verified: TypeScript projects now run cleanly on first attempt, no manual fixes needed

**Stress test — distributed job queue:**
- Crucible generated a complete TypeScript distributed job queue from scratch in ~6 minutes
- Components: priority queue (binary heap), exponential backoff retry, dead letter queue, worker pool, 1000-job test harness with 20% random failure rate
- Self-healed a patch error mid-generation without user intervention
- All 1000 jobs processed, dead letter count: 0
- No external dependencies — pure Node.js

---

## AGI TRACK — World Model & Richer Understanding [ ] not built

> The goal: Crucible should understand the world, not just code. A system so capable the
> distinction between "brilliant tool" and "general intelligence" stops mattering in practice.
> Free-tier throughout. No premium models. Emergent capability through layered systems.

### What exists today that points toward this
- Per-project persistent memory (`memory.md` — facts, preferences, patterns per codebase)
- Multi-model debate + synthesis (catches mistakes single models miss)
- Self-healing execution loop
- Debug bus with pattern learning (`analyzer.ts` — accumulates error patterns across sessions)
- Agent eyes via accessibility tree (reads Mac UI without vision models)

### What's missing for a richer world model

**Cross-session global memory [x]**
- `~/.crucible/world.md` — `appendGlobalMemory()` / `readGlobalMemoryDigest()` in `session.ts`. Injected into every agent system preamble before per-project memory and codebase context.
- `write_global_memory` tool available to the agent — agent uses it when it learns durable user facts (preferences, timezone, recurring tools). Loop preamble instructs when to use it vs project memory.
- `GET /api/memory/global` for inspection.
- Compressed: last 1500 chars / 50 bullets; append-only with exact-duplicate dedup.

**Domain knowledge beyond code [ ]**
- Today: RAG context is code-focused (knowledge-base.ts).
- Goal: pluggable domain packs — science, finance, law, medicine, history — injected by topic classifier.
- Implementation: extend `getAspectContext` to pull from domain-specific knowledge files, auto-selected by `classifyPrompt`.

**Causal reasoning layer [x]**
- Stage 2.5 "causal probe" fires concurrently with Stage 3 for `reasoning`/`math`/`factual` prompts (skipped on early-exit/simple).
- A fast model audits the top-3 Stage 1 responses: "identify the key assumption and one failure scenario per answer."
- 4s hard timeout; falls through silently on failure. Output injected into synthesis user message as a `CAUTION` block so the synthesiser addresses failure modes.
- Emits `causal_probe_done` to debug bus.

**Autonomous model hunter [ ]**
- Today: model list is static, manually updated.
- Goal: scheduled scraper that checks HuggingFace leaderboards, OpenRouter trending, research paper releases — discovers new free models, probes them, adds passing ones to the registry automatically.
- Key: uses Crucible's own pipeline to evaluate new models before adding them (dog-fooding).

**Provider diversity (resilience) [ ]**
- Today: Groq (daily limits), OpenRouter (slow), Mistral (1 model), Gemini (quota issues).
- Goal: add Together AI, Cloudflare Workers AI, HuggingFace Inference API — providers with no daily token caps.
- Circuit breaker already handles individual failures — just need more providers in the pool.

**Self-improvement loop [ ]**
- Goal: Crucible uses its own pipeline to improve its own code.
- Inputs: debug bus error patterns, user feedback, failed verifications.
- Output: proposed patches to its own engine, git-checkpointed before applying, rolled back on regression.
- This closes the loop: Crucible becomes a system that gets better by using itself.

## Chat History / Session Browser — [x] done

- [x] Persist completed pipeline rounds to `.crucible/history-<userId>.json` (per-user) — ts, query, promptType, models[], synthesis. Capped at 200 entries.
- [x] `GET /api/history` endpoint — returns sessions newest-first, scoped to authenticated user
- [x] History binder UI — floating clock-icon button in topbar, opens frosted-glass card anchored top-right. Entries show query, promptType badge, relative timestamp. Hover-expands to show model list + synthesis snippet (CSS grid row transition). Closes on outside click.
- [x] Click a session to restore it in the main view (read-only replay) — clicking a history row pushes a restored `Round` with the synthesis and model list visible; "click to restore" hint appears on hover
- [x] Export a session as markdown — "export md" button in hover-expand of each history row; downloads `crucible-<ts>.md` with query, metadata, and synthesis
- [x] Agent-mode rounds persisted — `result.finalText` written to history with `promptType: 'agent'` after every completed agent loop
- [x] HistoryBinder polls every 30s while open — new sessions appear without reload
- [x] Server-side session persistence — `POST /api/session/save`, `GET /api/session/restore` (24h TTL, per-user)
- [x] Cross-device SSE broadcast — `broadcastClients` Map keyed by sessionId; `GET /api/session/stream?sessionId=xxx` for passive listeners; mobile auto-reconnect with exponential backoff
- [x] Multi-user auth — email/password, JWT in httpOnly cookie (30-day), scrypt hashing; `POST /api/auth/register|login|logout`, `GET /api/auth/me`; all `/api/*` endpoints require auth
- [x] Splash screen + login/register forms — dark glass aesthetic, fade-in animation, inline validation errors, uses existing CrucibleMark
- [x] visibilitychange reconnect — on screen unlock, merges server session state into local rounds; "reconnecting…" topbar indicator

## Code Studio — [~] partial

- [x] Full-screen frosted overlay with prismatic glow render stage (`LeftDock.tsx`)
- [x] Iterative prompting — each message refines the last render, not a fresh start
- [x] Two-pass build: ensemble draft → power-pass refinement
- [x] Auto fix loop — `injectErrorReporter()` wraps iframe output with `window.onerror`; on JS error, `attemptFix()` feeds broken HTML + error to ensemble and swaps in fixed doc; retries up to 3×; amber progress bar during fix
- [x] Download as HTML — `↓ export` button (also in code view)
- [x] Peek at code / copy
- [~] Inline panel beside chat (no tab switch) — Desktop: `min(52vw, 680px)` left panel, chat shifts right. Mobile: 95vw overlay with input bar visible. **Remaining:** mobile panel bottom clips behind keyboard (needs dynamic `inputBarHeight` prop from App.tsx).
- [~] Mobile-first canvas layout — panel slides in from left on mobile, scrim above input bar. Collab button hidden on mobile. **Remaining:** dynamic `inputBarHeight` for panel/scrim bottom edge.
- [~] Agent-powered mode — agent toggle in studio input bar routes to agent loop with live `StudioAgentPanel`. **Remaining:** agent-mode session not yet persisted to history.

## Track P — MASTERPIECE
**Mosaic Abductive Synthesis Terminal Engine for Recursive Inference, Expert Consultation, and Epistemic Emergence**

The culminating architecture of Crucible. **Runs on EVERY prompt** in one of two modes — the gate is a mode SELECTOR, not an on/off switch (rewritten 2026-06-14 session 3). Light mode enriches every query locally; deep mode adds the full dialectical pipeline on complex prompts.

### Two-Mode Gate (`evaluateGate(prompt) → { mode: 'light' | 'deep' }`)
**Light mode — ALWAYS runs, every prompt, no exceptions.** Local corpus enrichment only (semantic + abductive query + structural resonance), no model calls, target < 500ms. Fires in parallel with model selection + Stage 1, so it adds **zero latency** to the critical path. Generates a calibration learning signal even when it finds nothing novel.

**Deep mode — adds the full pipeline, triggered by prompt COMPLEXITY ALONE** (no ensemble-confidence condition — the old C4 ≥ 0.70 meant MASTERPIECE never fired when the ensemble struggled, i.e. exactly when it was most needed):
- **D1** Token estimate ≥ 150 (`estimateTokens`, char/4)
- **D2** ≥ 2 detectable subtasks (`countSubtasks`)
- **D3** Prompt type is not `factual` (`detectPromptType`)
All three must hold. Fires after Stage 5 completes, consuming the light `EnrichedContext` so corpus queries are not repeated.

### Architecture
**Mosaic Sharding** — prompt decomposed into 2–6 semantically complete shards via a fast model. Ground Truth Anchor stored immutably in SQLite; never modified, referenced by all stages for coherence. Heuristic fallback (paragraph/sentence splits) if model decomposition fails.

**Triadic Dialectical Pass** — per shard, 3 models run simultaneously:
- Thesis: strongest case FOR the shard's claims
- Antithesis: strongest case AGAINST or complicating the shard's framing
- Middle-Ground: genuine uncertainty map — what is actually unknown or contested
All shards run in parallel; each shard's 3 models also run in parallel.

**Abductive Synthesis Engine** — for each shard, queries the cross-domain corpus (excludes shard's own domain), asks a model to find defensible non-obvious structural connections, then challenges each candidate with the antithesis arm of the triadic pass. Only connections that survive adversarial challenge are retained. Each connection records: bridgeReasoning, structuralMirror, fragileAssumption, noveltyScore.

**Structural Resonance Engine** — detects edge-graph isomorphisms between shard content and 6 canonical structural patterns (feedback-stabilisation, exploration-exploitation, phase-transition, adversarial-coevolution, compression-redundancy-tradeoff, hub-and-spoke-cascade). Maps abstract pattern nodes to concrete entities in the shard.

**Escalation Confidence Gate (H1 at shard level)** — scores each shard's triadic coherence (how much thesis/antithesis agree on underlying facts). Shards scoring LOW (0.35–0.54) or UNVERIFIED (<0.35) escalate to an independent external model call for verification.

**Ensemble MoE Refinement** — specialist archetype routing per shard:
- `researcher` → information-theory, philosophy-of-science, network-science, evolutionary-biology, thermodynamics, cognitive-science
- `coder` → computer-science
- `strategist` → economics, game-theory, complex-systems
- `critic` → any LOW/UNVERIFIED escalation tier (forced, regardless of domain)
Each specialist receives: shard + triadic outputs + abductive connections + structural resonances + escalation result.

**Final Assembler** — reads all refined shards in index order, weaves a coherent narrative synthesis that integrates the most defensible cross-domain insights, names bridges explicitly, addresses genuine uncertainties, and takes the ensemble base synthesis as its starting point to transcend.

**Epistemic Reinforcement Weight System** — cross-domain reasoning paths tracked in SQLite with 30-day half-life decay. Paths surviving dialectical challenge gain weight; paths failing lose weight. Future runs biased toward well-evidenced connections. Weights persist across sessions.

### Corpus
Curated 10-document seed corpus covering: information-theory, evolutionary-biology, thermodynamics, cognitive-science, complex-systems, game-theory, philosophy-of-science, network-science, economics, computer-science. Each document is ~200 words of information-dense content (not summaries). Chunks embedded with ONNX `all-MiniLM-L6-v2` (384-dim, quantized, runs locally). Fallback when ONNX unavailable: **256-dim word-level feature hashing** (signed, TF-weighted, L2-normalised) — replaced the original 20-dim CHARACTER hash whose buckets saturated so badly that every pair of passages scored ~0.95 similar (making cross-domain novelty meaningless). The corpus auto-re-seeds when the embedding scheme/dimension changes (`ensureSeedCorpus` detects a stored-vector byte-length mismatch and wipes+re-ingests).

### Files
- `src/CrucibleEngine/masterpiece/types.ts` — all shared types (Shard, TriadicOutput, AbductiveConnection, StructuralResonance, EscalationDecision, RefinedShard, ReasoningPath, MasterpieceDeps, etc.)
- `src/CrucibleEngine/masterpiece/gate.ts` — 4-condition composite gate evaluation
- `src/CrucibleEngine/masterpiece/mosaic.ts` — Ground Truth Anchor + shard decomposition
- `src/CrucibleEngine/masterpiece/triadic.ts` — parallel triadic dialectical pass
- `src/CrucibleEngine/masterpiece/abductive.ts` — cross-domain connection finding + adversarial challenge
- `src/CrucibleEngine/masterpiece/structural.ts` — edge-graph isomorphism detection
- `src/CrucibleEngine/masterpiece/escalation.ts` — shard-level H1 coherence scoring + external escalation
- `src/CrucibleEngine/masterpiece/moe.ts` — specialist archetype routing + shard refinement
- `src/CrucibleEngine/masterpiece/calibration.ts` — epistemic weight tracking with decay
- `src/CrucibleEngine/masterpiece/orchestrator.ts` — full pipeline coordination + assembler
- `src/CrucibleEngine/masterpiece/corpus/embed.ts` — ONNX embedding wrapper + hash fallback
- `src/CrucibleEngine/masterpiece/corpus/db.ts` — SQLite schema + prepared statements
- `src/CrucibleEngine/masterpiece/corpus/ingest.ts` — document ingestion + seed corpus
- `src/CrucibleEngine/masterpiece/corpus/query.ts` — semantic similarity queries

### SSE Events
- `masterpiece_light` — light-mode cross-domain connection, emitted ONLY when a connection scores novelty > 0.6 (surfaced as one sentence in HOW WE GOT HERE)
- `masterpiece_gate` — deep-mode activation decision
> **Note (2026-06-14 s3):** orchestrator emits `{type, data}`; the server FLATTENS to `{type, ...data}` at the emit boundary so App.tsx's flat readers (`parsed.shardCount`, not `parsed.data.shardCount`) populate. This fixed a latent bug where the MASTERPIECE process-trail UI never showed data.
- `masterpiece_shard` — shard manifest (count + domain list)
- `masterpiece_triadic` — resonances found, structural patterns
- `masterpiece_abductive` — connections found vs. survived, domain pairs
- `masterpiece_escalation` — per-shard tiers and calibration scores
- `masterpiece_moe` — specialist assignments and confidence scores
- `masterpiece_assemble` — final assembly started
- `masterpiece_complete` — completion metadata (replaces nothing — synthesis already delivered via standard `replace:true` event)

### Implementation invariants
- Ground Truth Anchor never modified. `originalPrompt` is the canonical reference used at every stage.
- MASTERPIECE emits its own `{ type: 'synthesis', replace: true }` event — this is valid because it IS the final answer, replacing the ensemble synthesis.
- `callModel` and `selectModels` injected via `MasterpieceDeps` to avoid circular imports with server.ts.
- SQLite WAL mode. All schema migrations versioned. `data/masterpiece-corpus.db` auto-created on first run.
- Packages: `better-sqlite3`, `@xenova/transformers` (both installed).

### Status
- [x] P1 — Mosaic Sharding + Ground Truth Anchor
- [x] P2 — Triadic Dialectical Pass (parallel per-shard)
- [x] P3 — Abductive Synthesis Engine (cross-domain corpus query + adversarial challenge)
- [x] P4 — Structural Resonance Engine (6 canonical patterns, edge-graph isomorphism)
- [x] P5 — Escalation Confidence Gate (shard-level H1)
- [x] P6 — Ensemble MoE Refinement (4 specialist archetypes)
- [x] P7 — Epistemic Reinforcement Weight System (SQLite, 30-day decay)
- [x] P8 — Final Assembler + Corpus
- [x] P9 — ONNX embedding pipeline + SQLite schema
- [x] P10 — Gate wired into server.ts
- [x] P11 — SSE events wired into App.tsx (process trail display) — flattened emit boundary
- [x] P16 — **Two-mode rewrite**: gate is a `light`/`deep` mode selector; light runs on every prompt
- [x] P17 — `runMasterpieceLight` (local corpus enrichment, < 500ms budget, fires parallel to Stage 1) + `runMasterpieceDeep` (consumes light context, no re-query)
- [x] P18 — 256-dim word-level feature-hash fallback embedder + auto re-seed on scheme change
- [x] P19 — Reject-safe `mpDeps.callModel` (free-tier 429/400 degrade per-call instead of aborting the whole deep pipeline) + assembler empty-guard
- [x] P12 — Live shard progress indicator while pipeline runs (`masterpiece_shard_progress` event + progress bar in App.tsx)
- [ ] P13 — User-tunable gate threshold (confidence slider in settings)
- [x] P14 — Corpus expansion: `POST /api/corpus/ingest-document` — user-provided text ingest through full validation/dedup/quarantine pipeline
- [x] P15 — Abductive connection persistence: survived connections (novelty > 0.65, dialectic-passed) written back to Living Corpus after deep mode

---

## Track U — ANIMA
**Autonomous Naturalistic Inference about the Machine-Agnostic Anthropology**

Crucible's evolving understanding of the human condition. **Not** user profiles. **Not** session logs. Universal, falsifiable observations about human experience — discovered from behavioural signal, verified through epistemic integrity, stored anonymously, applied invisibly to make responses more human. Runs in parallel with MASTERPIECE light mode on every request; the only place it is ever made explicit to the user is the transparency layer.

### Flow
```
REQUEST ARRIVES
   ├── MASTERPIECE light (corpus enrichment)   ─┐
   ├── ANIMA valence detection + store query    ─┤ parallel, zero added latency
   └── Model selection + Stage 1                ─┘
        │
        ▼  Stage 5 synthesis receives: ensemble responses + light enrichment + ANIMA shaping directives
        ▼  (deep mode, if triggered, replaces synthesis)
        ▼  (background, non-blocking) ANIMA observe → verify (5 gates) → store
```

### Components
**Emotional valence detector** (`valence.ts`) — pure-local heuristic (no model call, zero latency). Reads conversation history + current prompt; scores `EmotionalValence {score -1..+1, dominant, signals[], confidence}`. Detects: content emotional weight (grief/longing/betrayal/anger/stress/anxiety lexicons), linguistic stress (terse messages, repetition via Jaccard, urgency), topic shift (technical→personal), behavioural signals (music/rest/distraction/grounding), and the **gap** between a small ask and a large emotional context. Low confidence ⇒ caller does not act.

**Candidate observation extractor** (`observe.ts`) — runs after the response. Sends an ANONYMISED summary (valence reading + abstracted signal labels + a coarse topic CLASS — never raw conversation text) to a small fast model, which proposes ≤ 2 falsifiable, generalisable, non-obvious observations with a stated fragility. `sanitiseCandidate` rewrites/discards anything that personalises ("you"/"the user") rather than generalises.

**Epistemic integrity pipeline** (`verify.ts`) — five gates, ALL must pass: (1) confidence < 0.35 → discard; (2) novelty < 0.4 → discard; (3) empty/"nothing" fragility → discard (unfalsifiable); (4) dialectical challenge — an antithesis model argues against it, discard if the antithesis wins; (5) cross-domain dedup — a near-duplicate already in the store gets CONFIRMED instead of duplicated.

**Universal Truth Store** (`store.ts`) — SQLite at `.crucible/anima/truths.db`. Operations: `write` (status `candidate`, confidence 0.35), `confirm` (recompute, promote to `active` at ≥ 0.5), `contradict` (recompute, archive below 0.2), `query(domain, valence)` (active truths ranked by confidence × relevance), `decay` (entries silent 90 days drift toward neutral), `list`. Confidence formula: `confirming / (confirming + contradicting + 2)`.

**Response shaping** (`apply.ts`) — maps the valence + relevant active truths to invisible `ShapingDirectives {toneShift, leadWith, omit[], add[]}`, rendered into the synthesis system prompt as a "RESPONSE SHAPING (invisible to user)" block. The user never sees the directive — only experiences the warmer/briefer/softer response.

**Transparency layer** (`transparency.ts`) — the ONLY explicit surface. Detects "what have you learned about humans?" style queries (routed in server.ts before the pipeline), returns the active store in plain language grouped by domain with confidence % and fragility.

### Privacy invariants (enforced in code, not just docs)
- Every ANIMA file opens with `// ANIMA processes signal to extract universal observations. No user data is stored at any layer.`
- `valence.ts` READS history, NEVER writes any part of it; the returned valence carries only derived signal labels.
- `observe.ts` generalises before anything leaves the function — only abstracted signal labels + a topic CLASS reach the model, never raw text (tightened in the s3 review).
- `store.ts` schema has NO user-id, NO session-id, NO sub-day timestamp — only day-level ISO dates. Verified at runtime: the `truths` table columns are `id, observation, domain, confidence, novelty_score, confirming_instances, contradicting_instances, fragility, first_observed, last_updated, status`.
- `transparency.ts` shows only the universal observations + confidence, never the producing signal.

### Files
- `src/CrucibleEngine/anima/types.ts` — `UniversalTruth`, `EmotionalValence`, `CandidateObservation`, `ShapingDirectives`, `AnimaDeps`
- `src/CrucibleEngine/anima/valence.ts` — local emotional valence detector
- `src/CrucibleEngine/anima/observe.ts` — candidate observation extractor (anonymised)
- `src/CrucibleEngine/anima/verify.ts` — 5-gate epistemic integrity pipeline
- `src/CrucibleEngine/anima/store.ts` — Universal Truth Store (SQLite, anonymous)
- `src/CrucibleEngine/anima/apply.ts` — valence → shaping directives
- `src/CrucibleEngine/anima/transparency.ts` — user-facing transparency layer
- `src/CrucibleEngine/anima/index.ts` — `runAnimaShaping` (phase 1, sync) + `runAnimaLearning` (phase 2, background) + `runAnima`

### SSE Events
- `anima_transparency` — `{ count, entries[] }` for the transparency query (paired with a normal `synthesis` event carrying the plain-language report)

### Implementation note — two-phase wiring
The spec's conceptual `runAnima(history, prompt, pendingSynthesis)` is wired as two temporal phases because shaping is needed BEFORE the response exists while observation needs the response ITSELF: **Phase 1** `runAnimaShaping` (synchronous valence + store query) runs at request arrival and shapes Stage 5; **Phase 2** `runAnimaLearning` (observe → verify → store) runs fire-and-forget AFTER synthesis and never blocks the user.

### Status
- [x] U1 — `types.ts` shared types
- [x] U2 — Emotional valence detector (local, 6+ signal classes incl. behavioural gap)
- [x] U3 — Candidate observation extractor (anonymised, generalised, sanitised)
- [x] U4 — 5-gate epistemic integrity pipeline
- [x] U5 — Universal Truth Store (SQLite, anonymous, confirm/contradict/decay)
- [x] U6 — Response shaping (valence + truths → invisible directives, injected into synthesis)
- [x] U7 — Transparency layer (routed in server.ts, plain-language report with confidence)
- [x] U8 — Server wiring (parallel with light mode; background learning) + App.tsx handlers
- [x] U9 — Privacy invariants enforced in code + verified at runtime (no user/session columns)
- [x] U10 — Time-of-day context signal: `timeOfDayModifier()` in valence.ts — late night/early morning amplify negative readings when content signals already exist; applied only when confidence > 0 to avoid false signal on neutral sessions
- [x] U11 — ANIMA active indicator in HOW WE GOT HERE: when shaped truths exist, narrateProcess() appends a note about how many observed patterns shaped the response

---

## Track C — LIVING CORPUS
**A self-maintaining, dynamically evolving knowledge base that grows toward what matters, sheds what doesn't, governs itself against corruption, and never permanently destroys anything.**

Target: deliberately-curated cross-domain content (toward 1GB), fully chunked, embedded, relationship-graphed, and governed. Distinct from the small MASTERPIECE seed corpus but shares its embedding vector space, so the two are interoperable. SQLite (WAL) at `.crucible/corpus/corpus.db`.

### Pipeline (every document, every step, in order)
`chunk → embed → dedup → validate → relationship-extract (budgeted) → write`
- **Chunking** — sentence-boundary, ~512 tokens, 64-token overlap, never mid-sentence.
- **Embedding** — shared MASTERPIECE embedder (256-dim feature-hash fallback / 384-dim ONNX), unified vector space.
- **Dedup** — cosine > 0.92 to any active chunk → skip + bump the existing chunk's confirmation count.
- **Validation gates → quarantine (never reject):** source authority, internal consistency, contradiction-with-high-confidence, adversarial/stylistic anomaly (incl. prompt-injection detection). Corpus is a trust boundary.
- **Relationship extraction** — model call over the top-5 embedding neighbours, 7 edge types (depends-on/enables/constrains/contradicts/analogizes/scales-with/emerges-from). **Budgeted** per cycle (the spec's per-chunk call is infeasible at corpus scale).

### Dynamic management (`lifecycle.ts`)
- **Staleness decay** — `STALENESS_HALF_LIVES` {permanent: ∞, scientific: 10y, engineering: 3y, technology: 18mo, current: 30d}; `effectiveConfidence = confidence × 0.5^(age/halfLife)`.
- **Retention score** — `0.40·effectiveConfidence + 0.35·retrievalValue + 0.25·uniqueness`.
- **Natural shedding (weekly)** — retention < 0.15 after 90 days → **archive** (recoverable, never deleted).
- **Supersession** — new chunk contradicts an established (>0.7) chunk → archive old as `superseded`; both stay queryable, superseded labelled in results.
- **Gap detection (weekly)** — per-domain deficit vs `TARGET_ALLOCATION` × importance + observed query-miss-rate → top-3 gaps flagged for the next acquisition cycle.

### Acquisition (`acquire.ts`) — deliberate curation, real key-free sources
Project Gutenberg (classics), RFC editor (distributed-systems standards), arXiv API (cross-domain abstracts), Stanford Encyclopedia of Philosophy (peer-reviewed reasoning). `CURATION_MANIFEST` maps the priority allocation to concrete fetches; byte + relationship budgeted; runs in the background. Sources needing bulk archives / API keys (SO dump, NASA NTRS, PubMed bulk, GitHub top-500) are out of scope for the key-free driver and noted in the manifest.

### Storage invariant
**Good data never leaves the corpus.** No public DELETE path — only status transitions (active → archived/quarantined/superseded). Everything is recoverable. Every lifecycle/ingestion decision is written to `governance_log`.

### Endpoints
- `GET /api/corpus/status` — chunk counts by status, domain distribution, bytes, gaps, progress toward 1GB.
- `POST /api/corpus/acquire` — manually trigger a background acquisition cycle (`{ byteBudgetMB }`).

### Files
`src/CrucibleEngine/corpus/`: `db.ts` (schema + status-only mutations), `ingest.ts` (pipeline), `lifecycle.ts` (decay/retention/shedding/supersession/gaps), `acquire.ts` (connectors + driver), `query.ts` (retrieval + relationship expansion + feedback), `index.ts` (startup orchestration).

### Status
- [x] C1 — Storage schema (chunks/relationships/retrieval_log/governance_log/coverage_gaps), WAL, indexes
- [x] C2 — Ingestion pipeline (chunk/embed/dedup/validate→quarantine/relationship-extract)
- [x] C3 — Lifecycle (staleness decay, retention, weekly shedding, supersession, gap detection)
- [x] C4 — Deliberate-curation acquisition driver (Gutenberg/RFC/arXiv/SEP connectors, real HTTP)
- [x] C5 — Retrieval surface (semantic + relationship expansion + performance feedback)
- [x] C6 — Governance audit log (every decision recorded)
- [x] C7 — Server wiring (startup init, `/api/corpus/status`, `/api/corpus/acquire`) — verified live
- [ ] C8 — MASTERPIECE↔living-corpus query integration (route deep-mode abductive queries here)
- [ ] C9 — Bulk/keyed sources (SO dump, NASA NTRS, PubMed, GitHub top-500) + reach 1GB
- [ ] C10 — App.tsx HOW-WE-GOT-HERE: contributing corpus domains (lands with Substrate)
- [ ] C11 — ONNX embeddings (install `@xenova/transformers`) for 384-dim semantic quality

## SPECIAL TRACK — Q: SUBSTRATE (model viability / diversity / hot-swap)

> The selection layer that pairs with Track C's corpus. Where circuit breakers are
> binary and reactive (a model is up or tripped), Substrate adds a *graded, predictive*
> signal so a model that is technically up but slow or flaky sinks in the ranking before
> it ever trips — and the ensemble never concentrates on one provider/family, the
> correlated-failure risk free tiers are most exposed to. All in `modelRegistry.ts`
> (selection core) + `server.ts` (wiring + debug surface). Free-tier philosophy intact:
> nothing paid is ever selected; viability only re-ranks within the existing free pool.

- [x] Q1 — **Predictive viability fingerprints.** Per-model rolling ring (last 30) of
  `{ ok, latencyMs }` outcomes → `viabilityScore(id)` ∈ [0.1, 1.0] = successRate × latency
  factor (1.0 at/under 12s reference, floored 0.8 so slow-but-reliable beats fast-but-failing).
  Unseen / <3 samples → **neutral 1.0** so freshly discovered models get a fair first shot.
  Folded multiplicatively into the `selectModels` score. `recordModelOutcome()` fires on every
  Stage 1 outcome (success path added explicitly — Stage 1 streams, bypassing `_emitModelResult`)
  and at all three failure sites. **Verified live:** after 3 rounds — Qwen3 32B 0.667 (67% succ,
  fast 4.6s, no latency penalty), GPT OSS 120B 0.533 (same 67% succ but slow 15.5s → latency
  factor drops it *below* Qwen), Gemini 2.0 Flash 0.1 (0/3, floored). The slow-model penalty and
  the failing-model floor both demonstrably fire.
- [x] Q2 — **Diversity-maximised selection.** `pickDiverse()` replaces the naive top-N slice:
  greedy, single highest scorer first (merit-preserving), then each subsequent slot re-ranked by
  `score × 0.82^providerRepeats × 0.90^familyRepeats` so providers/families spread. `modelFamily()`
  derives architecture family from the id (llama/qwen/glm/gemma/mistral/gpt-oss/nemotron/phi/
  command/deepseek/owl). **Verified live:** a complex query selected 5 slots across 4 providers
  (openrouter×2, gemini, groq, huggingface) and 5 families instead of clustering on openrouter
  (which holds 8 of the active pool — the exact concentration this defends against).
- [~] Q3 — **Standby hot-swap.** `pickStandby(promptType, complexity, excludeIds)` returns the best
  eligible replacement not in flight, preferring a provider+family not already used. Wired into
  Stage 1: on a **hard** failure (not quota/decommission — those trip the breaker and are excluded
  by pickStandby) **before the ensemble has a leader** (`!firstDone`), a standby is dispatched,
  appended to `models` (so downstream rollback/critique/synthesis include it), and re-enters the
  same `runStage1Model()` — awaited inline so the stage barrier waits for it. Budget: max 2 swaps/
  request; a standby that itself fails is not re-swapped. Emits `hot_swap` to the debug bus + a
  `model_selection` update to the UI. **Code-verified & correctly gated; not yet observed firing
  live** — no qualifying hard mid-flight failure occurred in test runs (failures were quota trips /
  post-leader timeouts). Needs a forced-failure test to confirm the live swap path end-to-end.
- [x] Q4 — **Substrate debug surface.** `GET /api/debug/substrate` → per-model viability/samples/
  successRate/medianLatency (sorted by viability) + live provider & family spread of the healthy
  pool. Verified live.
- [x] Q5 — **New providers (carried over from the June-13 audit target).** Registry now spans 11
  providers (groq/openrouter/cloudflare/huggingface/gemini/mistral + together/cerebras/cohere/
  fireworks/deepinfra) via a generic OpenAI-compatible transport; `free:false` entries (deepinfra)
  excluded from the active pool by the `m.free===true` filter. Provider-spread target (≥6 providers,
  ≤25% single share) documented in the registry header.
- [x] Q6 — **Hunter probe battery.** `modelHunter.ts` runs 4 quality probes on every discovered model (coding: JS reduce one-liner, reasoning: bat+ball problem, factual: gold symbol, general: French translation). Shared 20s budget across all probes. Latency gate (>15s → reject). Results stored as real `quality`/`fit` values. Flat-score entries in discovered-models.json cleaned.
- [ ] Q8 — **App.tsx HOW-WE-GOT-HERE additions** (diversity score / hot-swaps this session /
  contributing corpus domains) — lands with the corpus-query integration (Track C8).

---

## SPECIAL TRACK — Remote Brain (Phone as Window, Mac as Body)

> The vision: open Crucible on your phone, see your Mac screen live, talk or type naturally,
> watch the agent act in real time. Not a panel, not a tab — a full mode shift. The entire UI
> transforms. Chat becomes a caption bar at the bottom. The screen stream fills the view.
> It feels like holding a window into your Mac, not using a remote control tool.

### Core experience
- One button in Crucible triggers Remote Brain mode
- Full UI transforms — stream fills screen, chat drops to bottom as caption bar
- Speak or type — agent acts on Mac in real time, you watch it happen
- Agent speaks back via TTS when it needs input or finishes
- Feels native, not bolted on

### Connection modes (automatic, degrades gracefully)
- **Local WiFi** (primary) — screen stream at full quality, sub-100ms latency, never leaves network
- **Bluetooth** — fallback for voice/command signals only if WiFi drops, not enough bandwidth for stream
- **Cellular** (away mode) — Cloudflare Tunnel exposes local backend to public URL, stream drops to low framerate compressed, voice+text control still fully functional

### Screen streaming
- Mac-side: `screencapture` loop or lightweight native Swift helper streaming MJPEG
- Served directly from local backend (port 3001) over WiFi
- Phone receives and renders stream fullscreen
- No cloud round-trip on local WiFi — latency is physical distance only

### Agent eyes — accessibility tree (no vision model needed)
- `get_ui_tree` tool: dumps macOS accessibility tree of focused app as structured text
 (every button, field, menu, window with label and role — osascript/AXUIElement)
- Agent reads tree, understands UI in natural language, decides action
- `click_element` tool: clicks by element label/role — no pixel coordinates needed
- `type_text` tool: types into focused field
- Loop: read tree → decide → act → read tree → verify → continue
- Faster and more reliable than vision models, fully free-tier compatible

### Voice pipeline (all free, all cloud)
- **STT**: Whisper on HuggingFace Space — ~300ms transcription, no API key
- **Command routing**: Cloudflare Workers AI classifier — simple vs complex task, near zero latency

### Agentic execution fixes
- **search_youtube tool** `[x]` — scrapes `ytInitialData` JSON from YouTube search results page to retrieve real, verified video IDs. Replaces hallucinated URL generation. Verifies availability via oembed endpoint before opening. Registered in agent tool registry. Agent must never construct YouTube URLs from model knowledge — live search only.
- **Agentic cache bypass** `[x]` — `isAgenticIntent` flag derived from `detectAgentTask(message)` bypasses both exact and semantic cache; wired in server.ts at both cache check sites.
- **Intent classifier: natural language action detection** `[ ]` — detect executable intent directed at external systems (YouTube, files, browser, calendar). Verbs like "put on", "open", "play", "search and find" directed at external systems dispatch to agent execution, not text response.
- **Simple commands**: small fast model (already in registry) handles "open Spotify", "close window" etc
- **Complex tasks**: full agent loop, same as today
- **TTS**: Edge-TTS (Microsoft free, no key) speaks confirmation/status back to user

### Design principles
- Not a feature inside Crucible — a MODE Crucible enters
- No clunky panels or tabs — full UI transformation on mode entry
- Graceful degradation: loses screen stream on cellular, never loses control
- Local-first: fastest path is always direct WiFi, cloud is fallback not default
- Free-tier throughout: no premium models, no paid streaming infrastructure

### Build order
1. Screen stream endpoint on backend (MJPEG over HTTP)
2. Fullscreen stream view in mobile UI with caption bar
3. `get_ui_tree` + `click_element` + `type_text` tools
4. Whisper STT integration (HuggingFace Space)
5. Edge-TTS response playback
6. Cloudflare Tunnel for cellular/away mode
7. Mode-shift UI animation and polish
