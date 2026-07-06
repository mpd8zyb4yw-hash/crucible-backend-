# Phase A — structural port, executable spec (code-grounded, no-regression)

> Written by Agent A on 2026-07-06 after tracing the REAL coupling in this repo (not the
> greenfield reference). This turns "port the v3 UI" into steps that account for the real
> `server.ts` pipeline so we don't regress it. Line numbers are as of commit `7b4e1b4`; re-grep
> before editing, the file moves.

## The core problem the redesign solves

Today every non-trivial query hits the external ensemble pipeline, because
`classifyMode()` auto-escalates on complexity/keywords (`src/App.tsx` ~L1629) and the default
mode is `'quorum'` (the full fan-out). The v3 spec: **default = Crucible on-device only (zero
external calls); ensemble = explicit opt-in with a per-query confirm card.**

## The real coupling you must NOT break

`mode` is not a frontend-only value. It is sent in the `/api/chat` body (`src/App.tsx` ~L2062,
`send()`) and drives server routing:

- `server.ts:1612` — `mode === 'agent' || mode === 'seeker' || (mode === 'code' && …)` selects
  the **agent loop** (tool-calling execution). Remote Brain depends on this via
  `modeOverride='agent'` (`App.tsx:2065`, set when `remoteBrain` is open, `App.tsx:1521`).
- `server.ts:1965/1972` — `triageTier` and `isAgenticIntent` branch on `mode === 'agent'`.
- `server.ts:2058` — the **on-device path already exists**: when `localInferenceAvailable &&
  !isAgenticIntent && triageTier !== 'simple'`, `corpusFirstAnswer()` (`src/CrucibleEngine/
  corpus/corpusFirst`) answers from the corpus with ZERO external API — BUT it falls THROUGH to
  the external pipeline when corpus coverage is weak. That fall-through is what makes "default"
  still hit providers.
- `server.ts:2274/2596/2685/2992` — synthesis/structure prompts branch on `mode === 'code' |
  'seeker'`.

**Conclusion:** "Crucible-only" is not an existing server mode. It must be added as an explicit
request contract, and the on-device path must be made terminal (no external fall-through) when
the user has NOT opted into ensemble.

## Steps (each ends tsc-clean via `npx tsc -p tsconfig.app.json --noEmit`; keep `main` green)

### A0 — server contract: a real local-only path (do FIRST, it's the foundation)
1. Add to `/api/chat` body handling a boolean, e.g. `ensemble` (default `false`).
2. When `ensemble !== true` AND not an agentic/Remote-Brain request: route to a **terminal**
   local answer — `corpusFirstAnswer()` when coverage is strong, else a single local-FM
   synthesis (Apple FM daemon, `local-inference/`, already wired via `localInferenceAvailable`)
   — and **return without ever calling the external pipeline**. Emit the existing SSE event
   shape (`layer1` + `synthesis` done) so the UI renders it unchanged.
3. When `ensemble === true`: run the existing full pipeline exactly as today (no behavior change).
4. Leave `mode === 'agent'` (Remote Brain / agentic intent) untouched — it bypasses this gate.
5. Verify: agent tasks and Remote Brain still route to the agent loop; a plain query with
   `ensemble:false` produces a local answer and makes zero provider calls (check
   `recordProviderCall`/diag counters stay flat).

### A1 — frontend state: replace the 3-mode machine with an opt-in binary
1. Remove `classifyMode` (`App.tsx:1629`) and its call site (`App.tsx:2780`).
2. Remove `ModeSwitcher` (`App.tsx:43`) and its render (`App.tsx:4195`); remove `MODE_META`/
   `MODES` if now unused (watch `noUnusedLocals` — it'll flag leftovers, good).
3. Replace `const [mode,setMode] = useState<'quorum'|'code'|'seeker'>('quorum')` with an
   `ensembleArmed` boolean (default `false`). Preserve the Remote Brain path: it uses
   `modeOverride='agent'` directly in `send()` (`App.tsx:2065`) — keep that; it no longer needs
   the `mode` state at all. `preBrainModeRef` (App.tsx:~1452) can be deleted with the state.
4. In `send()`: if `!ensembleArmed` → POST `{ ensemble:false }`. If `ensembleArmed` → show the
   per-query confirm card (below) and only POST `{ ensemble:true }` on confirm.
5. Anywhere the UI read `mode` for styling (`App.tsx:50,4143,4223`, `ShimmerBg mode=`
   `App.tsx:2854`) — collapse to the two states (local vs ensemble) or a constant accent.

### A2 — the per-query confirm card (mirror the reference shape)
Reference: `Crucible-Code` → `crucible-local/crucible-local/src/components/chat/Composer.tsx`
(the "Use ensemble for this?" card) and `state/store.ts` (`confirm: {type:'ask'|'nokeys'}`).
Even when armed, EVERY ensemble send shows the card with [Crucible only] / [Run ensemble]. No
auto-escalation ever. (API-keys "nokeys" state can come in a later step — this repo's ensemble
uses server-side provider keys, so the "add keys" state may be N/A; confirm before copying it.)

### A3 — gate the pipeline chrome behind the opt-in
`crucible-pipeline-theater` / `-status` / `-log` and the stage-dots / per-model panels
(`App.tsx` ~L3032 "Pipeline mode (quorum)") must render ONLY for a confirmed ensemble run.
Default local replies: clean card + a small "CRUCIBLE · ON-DEVICE" footer. Never show pipeline
theater for a local query.

## Verification checklist before merging Phase A to main
- [ ] `npx tsc -p tsconfig.app.json --noEmit` clean.
- [ ] App boots (`npm run dev`), default query returns a local answer, **zero provider calls**.
- [ ] Armed + confirm → full pipeline runs exactly as before.
- [ ] Remote Brain still opens and sends to the agent loop.
- [ ] Existing tools/agent surface (`src/CrucibleEngine/tools`, `agent`) still callable.
- [ ] Mobile + desktop both hold.

## Split for two agents
A0 (server) and A1–A3 (frontend `App.tsx`) touch different files, but A1 depends on A0's
contract. Suggested: **one agent does A0 (server contract) while the other does A1–A2 frontend
scaffolding against the agreed `{ensemble:boolean}` contract**, then integrate + A3 together.
Coordinate the exact request-body field name in `COLLAB.md` §5 BEFORE both start, so the
frontend and server agree. `App.tsx` is an exclusive lock (COLLAB §4) — only one agent edits it.
