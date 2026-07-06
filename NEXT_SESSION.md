# Crucible — Open Problems & Next Build Priorities

> This document is a handoff for the next engineering session.
> Read ROADMAP.md first for full architectural context.
> These are the gaps that matter most, in priority order.

---

## PRIORITY 0 — Port the v3 UI Redesign Into `src/App.tsx` (two-agent parallel effort)

**Decision (2026-07-06), resolved without going back to Justin — see reasoning below.**

A separate GitHub repo, `mpd8zyb4yw-hash/Crucible-Code`, holds a Claude-Design handoff bundle
for a UI redesign (`project/Crucible v3.dc.html` spec + `project/HANDOFF - Claude Code
implementation brief.md`). The brief's stated target was this repo's `src/App.tsx` — but what
actually got built there is a **from-scratch greenfield app**
(`crucible-local/crucible-local/`, plain Vite + React + zustand, ~1,500 lines across all
files) rather than an edit of this monolith. It was verified against the brief and is
functionally correct: mode picker and `classifyMode` auto-escalation gone, ensemble is
opt-in with a per-query confirm card, API keys are a blank-slate name+value list, and the
molten-pour animation is ported and wired to real stream lifecycle events (not timers).

**Why it's a reference implementation, not a replacement.** Its `CrucibleEngine/` is entirely
stubbed — `localModel.ts` is a templated zero-network responder, `tools/index.ts` has two toy
tools, `ensemble.ts` only makes a real HTTP call when a key's value happens to contain a URL.
None of that is real next to what this repo already has: an actual pipeline (`server.ts`,
`modelRegistry.ts` `PIPELINE_CONFIG`), the real tool/agent surface, self-patcher, benchmark
suite, corpus grounding — years of production logic this repo's own ROADMAP.md documents.
Throwing that away to adopt the greenfield app wholesale would be a regression, not a redesign.
Confirmed via `git log` here that no redesign work has landed in this repo — `ModeSwitcher`,
`classifyMode`, and the always-visible pipeline chrome are all still present and unchanged
(`src/App.tsx` lines ~43, ~1444, ~1629, ~2780, ~4195).

**The plan: port the validated UI/UX pieces into this repo's real `App.tsx`, keep every real
backend integration.** Treat `Crucible-Code`'s `crucible-local/crucible-local/` as the spec —
read it for exact behavior/shape — but reimplement against this repo's real state, real
`CrucibleEngine/tools/` + `agent/`, real `modelRegistry.ts`. Do not import its stub engine
files. Do not delete this repo's real tool implementations while porting UI.

**This file is monolithic (`App.tsx`, ~223KB) — high collision risk for two agents working at
once.** Split into sequential phases with a hard handoff, not free-for-all parallel file
ownership like a normal multi-file project would allow:

- **Phase A (Agent 1 — structural/state):** Remove the `mode` state machine, `ModeSwitcher`,
  and `classifyMode` auto-escalation (`src/App.tsx` ~L1444, ~L1629, ~L2780, ~L4195). Replace
  with: Crucible-local-FM is the only default path; ensemble is opt-in via a toggle +
  per-query confirm card (mirror `crucible-local/crucible-local/src/components/chat/
  Composer.tsx` + `state/store.ts`'s `confirm`/`ensembleArmed` shape). Gate
  `crucible-pipeline-theater`/`-status`/`-log` (~L504/L4060/L4688 per the original brief) behind
  that confirm — never default-visible. **Commit + push a working checkpoint (`tsc` clean, app
  boots, existing tools/agent regression-tested) before Phase B starts.**
- **Phase B (Agent 2 — visual/animation, starts only after Phase A lands):** Port
  `MoltenPour.tsx`'s animation (thinking → pouring → cooling, real stream-lifecycle triggers,
  1350ms fill floor / 1000ms cool floor) and `styles/tokens.css`'s design tokens into this
  app's streaming-reply UI. Reference implementation:
  `Crucible-Code` repo, `crucible-local/crucible-local/src/components/chat/MoltenPour.tsx` and
  `src/styles/tokens.css`. Verify against `project/Crucible v3.dc.html` in the Crucible-Code
  repo for exact easing/color values.

**Whichever agent is not doing Phase A right now:** don't start Phase B against the
pre-Phase-A structure — you'll be porting animation logic into DOM/JSX that Phase A is about
to delete. Use the time to read the reference implementation and this repo's real
`App.tsx` streaming-render code so Phase B is fast once Phase A lands, or pick up other
priorities below.

**Active claim:**

| Agent | Phase | Status | Started |
|---|---|---|---|
| _(none yet)_ | | | |

Update the row above when you start; append a dated entry to ROADMAP.md's CHANGE LOG when a
phase lands (per this repo's standing rule — verify wiring with `grep` before marking done,
same as everywhere else in this file).

---

## PRIORITY 1 — Close the Learning Loop (The Compounding Gap)

**The problem:**
Crucible has all the pieces of a self-improving system — genealogy attribution, specialization
memory, quality predictor, triumvirate governance, ANIMA truth store, uncertainty surface — but
they feed into each other weakly. The system learns within a session and across sessions via EMA
weights, but it does not yet systematically identify what is working, extract the pattern, and
harden it into the pipeline configuration itself.

**What's missing:**
The self-patcher (`selfPatcher.ts`) exists and is documented as [x] but needs verification that
it is actually wired and firing. The specific missing behavior:

- After every N pipeline rounds (suggest 20), read the last 100 debug events
- Identify which pipeline stage most frequently precedes a low synthesis score
- Cross-reference with `quality-history.json` and `specialization.json`
- Propose a concrete config change (stage prompt tweak, model weight adjustment, early-exit
  threshold change) — not code, just config that the existing infrastructure can apply
- Route proposal through triumvirate (already built)
- Apply on approval, log to `.crucible/self-patches.json`
- Roll back automatically if quality predictor trend goes negative within 10 rounds

**Key distinction from fine-tuning:**
Crucible does NOT train model weights. It refines ITSELF — its routing logic, its stage prompts,
its scoring thresholds, its model selection weights. The models stay external and free. The
intelligence that compounds is in the pipeline configuration and the accumulated signal in
`.crucible/`. This is the correct framing of "self-improvement" for Crucible's architecture.

**Files to verify/fix:**
- `src/CrucibleEngine/selfPatcher.ts` — confirm it is actually called from server.ts on a schedule
- `src/CrucibleEngine/autoImprove.ts` — confirm `triggerImprovementPass()` is firing after rounds
- `GET /api/self-patcher/patches` — check this endpoint returns real data, not empty

---

## PRIORITY 2 — Regression Safety Net (Benchmark Suite)

**The problem:**
Architectural decisions — which models to favor, which pipeline stages to keep, which weights to
tune — are currently made based on feel and spot-checking. A bad patch could degrade answer
quality and would only be caught through user observation, not measurement.

**What's missing:**
Track E3 (benchmark suite) is marked [x] in the roadmap but needs verification it is actually
running continuously. Specifically:

- `.crucible/benchmarks.json` should exist with 50+ canonical questions and known correct answers
  across all prompt types (coding, reasoning, factual, math, creative, general)
- After every significant pipeline change, the suite should run in the background and record
  pass rates per category
- `GET /api/debug/benchmarks` should return rolling pass rates and flag any category that dropped
  more than 5% from its baseline
- The neuromorphic stress test (documented in ROADMAP.md) should be one of the benchmark entries
  with its 7-section pass criteria

**Implementation note:**
The benchmark runner should use the SIMPLE_PIPELINE_CONFIG (not full ensemble) to avoid burning
quota on self-testing. Results go to `.crucible/benchmark-results.json`. The signal is trend,
not absolute score — is the system getting better or worse over time on a fixed question set.

---

## PRIORITY 3 — "Shows Its Work" Mode (The Demo Mode)

**The problem:**
Crucible performs extraordinary reasoning — triadic dialectics, abductive synthesis, epistemic
calibration, ANIMA shaping, confidence annotation — and the user sees almost none of it. The
process trail exists but is collapsed by default and doesn't tell a coherent story.

**What's missing:**
A toggle in the UI (off by default, labeled something like "thinking visible") that expands the
synthesis to show:

- Which models agreed vs disagreed at Stage 1 (score variance visualization)
- What the Critic flagged (already stored in `criticProblems`)
- Which claims are HIGH vs LOW confidence (already stored in `round.confidence`)
- The fragile assumption (already stored in `fragilityAssumption`)
- What ANIMA detected and how it shaped the response (transparency layer already built)
- Cross-domain connections MASTERPIECE found (already stored in `masterpiece` field)
- Which model actually contributed most to the final synthesis (genealogy attribution)

**Why this matters:**
This is simultaneously the strongest marketing asset (visible reasoning beats any benchmark
number) and the best debugging tool (when something goes wrong, you can see exactly which stage
failed and why). It is not a new system — it is a UI layer over data that already exists in
every `Round` object. Estimated build: 2-4 hours in `App.tsx`.

**Design constraint:**
No emojis. No clutter. A single toggle that reveals/hides a structured breakdown panel below
the synthesis. Mobile-first — must work at phone width. Should feel like turning on subtitles,
not opening a dashboard.

**Status (June 14 2026):**
Genealogy contribution rates are now sent over SSE (`genealogy` event type) and displayed in
the process trail — showing which model contributed what fraction of the final synthesis.
`recordPipelineRun()` and `recordProbationOutcome()` wired. Probation status shown in topology.
The "toggle all open by default" version of Shows Its Work is still not built — the process
trail is still collapsed by default. A `showWork` boolean in state that auto-opens the
`<details>` elements and adds a toolbar toggle is the remaining work.

---

## PRIORITY 4 — Voice Pipeline (Mobile Transformation)

**The problem:**
Crucible on mobile requires typing. The Remote Brain track is documented but not built. Even
without the full screen-stream vision, a voice input → pipeline → spoken response loop would
transform how the system feels and dramatically expand its use cases.

**What to build (minimal viable version):**
1. Microphone button in the mobile input bar
2. On press: record audio, send to Whisper on HuggingFace Inference API (free, no key needed
   for public models, ~300ms transcription)
3. Transcribed text enters the normal pipeline
4. After synthesis, pass response text through Edge-TTS (Microsoft, free, no API key) for
   spoken playback
5. The response plays through the phone speaker while text is visible

**What NOT to build yet:**
The full Remote Brain (screen stream, Mac control, Bluetooth fallback) is a larger project.
Build the voice I/O loop first — it is self-contained and validates the audio pipeline
before adding the complexity of screen streaming.

**Key files to create:**
- `src/CrucibleEngine/voice/stt.ts` — Whisper HuggingFace wrapper
- `src/CrucibleEngine/voice/tts.ts` — Edge-TTS wrapper
- `App.tsx` — microphone button + audio playback (mobile only, hidden on desktop)

**Free-tier note:**
HuggingFace `openai/whisper-large-v3` is available on the Inference API free tier.
Edge-TTS is accessed via the `edge-tts` npm package, no API key, Microsoft's free
neural voices. Both fit the free-tier-only philosophy exactly.

---

## PRIORITY 5 — Persistent Agent Goals (Long-Horizon Continuity)

**The problem:**
Every agent session starts from zero context about multi-session goals. The checkpoint system
saves iteration state within a session, and episodic memory summarizes what happened. But if
you tell Crucible "refactor this codebase over the next week," it has no structure for tracking
progress across sessions, knowing what's done vs pending, or picking up intelligently where it
left off.

**What's missing:**
A task graph that persists across sessions:

```json
// .crucible/task-graph/<goal-id>.json
{
  "goal": "Refactor authentication system",
  "created": "2026-06-14T…",
  "status": "in_progress",
  "nodes": [
    { "id": "n1", "task": "Audit current auth flow", "status": "done", "completedAt": "…" },
    { "id": "n2", "task": "Replace JWT library", "status": "in_progress", "startedAt": "…" },
    { "id": "n3", "task": "Update tests", "status": "pending", "dependsOn": ["n2"] }
  ]
}
```

At session start, agent checks for open task graphs matching the current project, reports
progress naturally ("Last session I finished the auth audit — continuing with the JWT
replacement"), and resumes from the correct node.

**Integration points:**
- `goalDecomposer.ts` already exists — extend to write decomposition output to task graph file
- `episodicMemory.ts` already summarizes sessions — link summaries to task graph nodes
- Agent loop preamble already reads `memoryDigest` — add task graph injection here
- New `GET /api/task-graph` endpoint for inspection
- New `POST /api/task-graph/create` to initialize a multi-session goal

---

## PRIORITY 6 — Actionable Uncertainty (Closing the Epistemic Loop)

**The problem:**
H1 confidence calibration flags LOW and UNVERIFIED claims. H4 surfaces the fragile assumption.
H2 routes uncertain topics to the full pipeline. But none of this tells the user what to DO
about the uncertainty. A flagged claim with no suggested action is decorative, not useful.

**What's missing:**
When the confidence calibrator produces LOW or UNVERIFIED claims, generate a specific
suggested action alongside each flag:

- For UNVERIFIED factual claims: auto-generate a web search query the user can run to verify
  (use the existing DDG grounding infrastructure — `webGrounding.ts` — to attempt verification
  first, surface the query if grounding fails or conflicts)
- For LOW confidence reasoning claims: surface the specific assumption that if wrong would
  break the claim (this is already computed by H4 `getFragilityAssumption` — just link it
  to the specific flagged sentence rather than the synthesis as a whole)
- For PROVISIONAL world model facts: surface when the fact was last verified and what would
  update it

**Implementation:**
Extend `confidenceCalibrator.ts` `calibrate()` return type to include `suggestedAction?` per
flagged claim. Extend the `confidence` SSE event to carry these. Extend the UI confidence
strip to show the action inline with each flagged claim — a small "verify →" link or suggested
search query. No new model calls needed — this is recombination of existing signals.

---

## ARCHITECTURAL REMINDER — What Self-Improvement Means in Crucible

Crucible does NOT fine-tune or retrain models. The models are external, free-tier, and fixed.

What Crucible refines is ITSELF:
- **Routing logic** — which model gets which query (specialization memory, viability scores)
- **Stage configuration** — which pipeline stages fire, in what order, with what prompts
- **Scoring thresholds** — when to early-exit, when to force full pipeline, when to escalate
- **Model selection weights** — EMA-based bias toward models that actually survive into synthesis
- **World model** — accumulated facts, decisions, episodic memory that inform future responses
- **Pipeline prompts** — the system prompts driving each stage, tunable via self-patcher

The compounding advantage is not in model weights. It is in the accumulated signal in
`.crucible/` and the pipeline configuration that has been tuned on real usage. Six months of
real queries produces routing intelligence, uncertainty surface calibration, and specialization
memory that cannot be replicated by spinning up the same stack on a fresh install.

This is the correct framing. Build everything with this in mind.

---

## QUICK WINS (< 2 hours each)

These are not priorities but are high-value and low-effort:

**A. Wire `recordPipelineRun()` verification** — DONE (June 14 2026)
`recordPipelineRun()` is now called after every Stage 5 completion so the specialization
forcing recency counter advances correctly. `pipelineRunCount` was stuck at 0 — forcing decay
never fired. Fixed in server.ts.

**B. `/api/waitlist` auto-promotion on boot** — DONE (was already wired)
`promoteNextFromWaitlist()` is already called at server boot (line 336 in server.ts).

**C. Probation outcome recording** — DONE (June 14 2026)
`recordProbationOutcome()` now called alongside `recordModelOutcome()` at Stage 1 outcome
sites. Probation models now accumulate outcome data and can graduate or be rejected.

**D. Debug topology shows probation status** — DONE (June 14 2026)
`GET /api/debug/topology` now includes `probation` array with id, label, callsRemaining for
each model in a probation slot.

**E. Genealogy contribution rates in UI** — DONE (June 14 2026)
`genealogy` SSE event now emitted after attribution pass. Process trail in App.tsx now shows
per-model contribution rates as percentage bars under the ensemble section.
