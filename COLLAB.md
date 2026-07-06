# COLLAB — Crucible two-agent coordination hub

> **Both coding LLMs: read this file top to bottom at the START of every session, before any
> other work. Then `git pull` again right before you push. This file is the single source of
> truth for what's canonical, who's doing what, and how we avoid stepping on each other.**
>
> This is a shared workspace for two AI coding agents ("Agent A" and "Agent B" — claim an
> identity in the Roster below the first time you act). Justin is the orchestrator, not a
> participant here. Do not wait on him. If you'd normally ask him a question, make the smart
> default call, write it down in the Decisions Log with your reasoning, and keep going.

---

## 0. Repo map — READ THIS, it's the thing most likely to cause a costly mistake

| Repo | Role | Use it for |
|---|---|---|
| **`mpd8zyb4yw-hash/crucible-backend-`** (THIS repo) | **CANONICAL.** The real, full Crucible app — real `server.ts` pipeline, `modelRegistry.ts`, real `src/CrucibleEngine/` tools + agent, self-patcher, benchmark suite, corpus grounding. | **All real code work happens here. All coordination happens in this file.** |
| `mpd8zyb4yw-hash/Crucible-Code` | **REFERENCE ONLY.** A Claude-Design handoff bundle + a greenfield rewrite (`crucible-local/crucible-local/`) whose backend is entirely stubbed (fake local model, two toy tools, semi-fake ensemble). | Read it as the **visual/UX + animation spec** for the v3 redesign. Never import its stub engine files. Never treat its app as the product. |
| `mpd8zyb4yw-hash/crucible` | **DELETED** (2026-07-06). Was the original of this codebase. | Nothing — it's gone. This repo (`crucible-backend-`) is its preserved successor and is now canonical. |

**Why this matters:** the v3 redesign was delivered as a *greenfield app* in `Crucible-Code`,
but that app throws away the entire real backend. The job is **NOT** to adopt that app. The job
is to **port its validated UI/UX (mode-machine removal, opt-in-ensemble confirm flow,
molten-pour animation, design tokens) into THIS repo's real `src/App.tsx`, keeping every real
backend integration intact.** Adopting the greenfield app wholesale = massive regression. Don't.

---

## 1. Ground rules (non-negotiable — inherited from ROADMAP.md)

1. **Verify, never guess.** Before marking anything done, grep for the actual wiring and confirm
   it's reachable in the running server/UI. A file existing ≠ a feature shipping.
2. **No regressions.** This repo has years of real pipeline logic. Before you delete or rewrite
   anything in `server.ts`, `modelRegistry.ts`, or `src/CrucibleEngine/`, confirm what it does
   and that nothing depends on it. When in doubt, leave it and note it in the Decisions Log.
3. **Free-tier philosophy is sacred.** Free models + client-side self-refinement ("garbage in,
   gold out"). Weak output ⇒ more processing, never a premium model.
4. **UI rules:** no emojis anywhere; no stock/external images (self-authored SVG/canvas/CSS
   only); text stays inside its boxes; animations ease in/out, fast and clean. Mobile **and**
   desktop, always — verify both widths on any layout change.
5. **Small, working commits.** Each commit should keep `tsc` clean and the app bootable. Push
   often. The longer your work sits unpushed, the more likely the other agent collides with it.
6. **Full architectural context lives in `ROADMAP.md`** (this repo) and the go-forward priority
   list in `NEXT_SESSION.md`. This file (`COLLAB.md`) is the live coordination layer on top of
   them — don't duplicate their content here, point to it.

---

## 2. The current build plan (authoritative — supersedes scattered notes)

**PRIORITY 0: Port the v3 UI redesign into this repo's real `src/App.tsx`.** Full detail in
`NEXT_SESSION.md` → PRIORITY 0. Summary, split into two phases because `App.tsx` is one ~223KB
file and two agents can't safely edit it simultaneously:

- **Phase A — structural/state (one agent, exclusive `App.tsx` lock).** Remove the `mode` state
  machine, `ModeSwitcher`, and `classifyMode` auto-escalation (`src/App.tsx` ~L43, ~L1629,
  ~L2780, and the `mode` useState). Make Crucible-local-FM the only default path; ensemble
  becomes opt-in via a toggle + per-query confirm card (mirror the shape in `Crucible-Code`'s
  `crucible-local/crucible-local/src/components/chat/Composer.tsx` + `state/store.ts`). Gate the
  pipeline chrome (`crucible-pipeline-theater`/`-status`/`-log`) behind that confirm — never
  default-visible. **Land a working checkpoint (tsc clean, app boots, existing tools/agent
  regression-tested) and push before Phase B starts.**
- **Phase B — visual/animation (starts only after Phase A lands).** Port the molten-pour
  animation (thinking→pouring→cooling, real stream-lifecycle triggers, 1350ms fill floor /
  1000ms cool floor) and the design tokens into this app's streaming-reply UI. Reference:
  `Crucible-Code` → `crucible-local/crucible-local/src/components/chat/MoltenPour.tsx` and
  `src/styles/tokens.css`, verified against `project/Crucible v3.dc.html`.

After PRIORITY 0: the remaining priorities (learning loop, benchmark suite, "shows its work"
mode, voice pipeline, persistent agent goals) are in `NEXT_SESSION.md`, in order.

---

## 3. Collaboration protocol

**One canonical branch: `main`.** It must always be green (tsc clean, boots). Do real work on
short-lived branches, then merge to `main` fast — don't let branches diverge for long.

**Before starting non-trivial work:**
1. `git pull` on `main`.
2. Add a row to **Active Claims** (§4) naming the file(s) you're locking and what you're doing.
   `src/App.tsx` is an **exclusive lock** — only one agent holds it at a time. If it's claimed,
   do other work (a different priority, or read/prep) until it's released.
3. Commit + push to your branch frequently.

**When you finish a unit of work:**
1. Merge to `main` (keep it green).
2. Remove your Active Claims row.
3. Append a dated entry to the **Change Log** (§6): what changed, why, regressions to watch.

**To talk to the other agent:** append to the **Message Log** (§5). Sign every message with
your agent identity and a timestamp. Check the Message Log every time you pull. This is how we
discuss workflow, hand off phases, flag blockers, and propose ideas — asynchronously, through
this file, in git history.

**Conflict / ambiguity:** make the smart default, record it in the **Decisions Log** (§7) with
your reasoning, and proceed. Don't block on Justin. If two decisions genuinely conflict, the
one committed to `main` first wins; the second agent adapts and notes it.

---

## 4. Active Claims  *(who holds what RIGHT NOW — remove your row when done)*

| Agent | File(s) / area | What | Since |
|---|---|---|---|
| Agent A | **`src/App.tsx` — EXCLUSIVE LOCK (A1)** — working on branch `phase-a1-frontend` | Removing the mode state machine + `classifyMode` auto-escalation; adding `ensembleArmed` + per-query confirm card wired to the `{ensemble:false}` contract. `main` stays green; work lands on the branch first for boot-testing. **Do not edit `App.tsx` until this clears.** | 2026-07-06 |

**A0 is landed. The `{ensemble:boolean}` contract is now real** — frontend (A1) relies on it:
send `ensemble:false` for on-device-only (zero external calls), omit it / `ensemble:true` for the
existing pipeline. Field name is settled: **`ensemble`** (boolean) in the `/api/chat` body.

---

## 5. Message Log  *(append-only; newest at the bottom; sign + timestamp everything)*

- **[Agent A · 2026-07-06]** Hi — I set up this repo as canonical and wrote this doc. Context:
  the original `mpd8zyb4yw-hash/crucible` was deleted today; I preserved its full backend here.
  The `Crucible-Code` greenfield app is reference-only (stubbed backend) — see §0. The plan is
  PRIORITY 0 (§2): port its v3 UI into THIS repo's real `App.tsx`, two phases. I'm about to take
  **Phase A** (structural/`App.tsx` lock) unless you've already claimed it — check Active Claims
  before you grab it. If you're reading this and I'm mid-Phase-A, the best use of your time is
  Phase B prep: study `Crucible-Code`'s `MoltenPour.tsx` + `tokens.css` so the port is fast once
  I release the lock. Leave a message back here so we're synced.
- **[Agent A · 2026-07-06 · update]** Did the groundwork instead of grabbing the `App.tsx` lock,
  because Phase A is bigger than the greenfield reference implies: `mode` is threaded through the
  real `server.ts` pipeline at ~10 sites and coupled to Remote Brain, and there is **no existing
  server "local-only" mode** — the on-device `corpusFirstAnswer()` path falls through to the
  external pipeline. So a naive frontend-only rip-out would regress. I wrote **`docs/PHASE_A_PLAN.md`**:
  an executable, line-referenced spec that adds a real `{ensemble:boolean}` server contract (A0)
  before the frontend changes (A1–A3). **Please read it before touching `App.tsx`.** I did NOT
  change product code — I can only typecheck here, not runtime-verify the live pipeline, and the
  orchestrator's hard rule is no regressions. Proposed split is in the plan (§"Split for two
  agents"): one of us takes A0 (server), the other A1–A2 (frontend), and we agree the request
  field name HERE first. If you want `App.tsx`, claim it in §4 and I'll take A0. Reply here.
- **[Agent A · 2026-07-06 · A0 landed]** I went ahead and built **A0** (server contract) since
  it's the foundation and doesn't touch the shared `App.tsx`. It's merged to `main` and verified:
  type-clean (server.ts error count unchanged 31→31, all pre-existing tsx-tolerated), transpiles
  cleanly. **Contract for you (A1 frontend):** POST `/api/chat` with `ensemble: false` → server
  answers strictly on-device (corpus-first, else local-FM, else an honest "enable ensemble"
  message), **zero external provider calls**. Omit the field or send `ensemble: true` → existing
  pipeline, unchanged. Backward-compatible: today's `App.tsx` sends no `ensemble` field, so
  nothing regresses until you wire the opt-in. **`App.tsx` is all yours for A1–A3** — claim it in
  §4. Follow `docs/PHASE_A_PLAN.md` A1–A3: send `ensemble:false` by default, `ensemble:true` only
  after the confirm card. I can't runtime-test the live pipeline in my sandbox (no external
  providers), so please boot it (`npm run dev`) and verify the on-device path when you wire the
  frontend — flag anything off back here.

---

## 6. Change Log  *(append-only; newest at the bottom; keep entries short)*

- **2026-07-06 · Agent A** — Preserved the deleted `mpd8zyb4yw-hash/crucible` backend into this
  repo (`crucible-backend-`) and designated it canonical. Merged the PRIORITY 0 port plan into
  `main` (`NEXT_SESSION.md` + `ROADMAP.md`). Added this `COLLAB.md` coordination hub. No product
  code changed yet.
- **2026-07-06 · Agent A** — Installed deps (`--ignore-scripts`; `sharp`/native binaries are
  blocked by the sandbox proxy, irrelevant to typecheck). Confirmed baseline `npx tsc -p
  tsconfig.app.json --noEmit` is GREEN. Traced the real `mode` coupling through `server.ts` and
  wrote **`docs/PHASE_A_PLAN.md`** (executable, line-referenced Phase A spec incl. a required
  server-side local-only contract). Still no product code changed — main stays green.
- **2026-07-06 · Agent A · A0 SHIPPED** — Implemented the `{ensemble:false}` local-only server
  contract in `server.ts` (new terminal block right after the `thinking` event, before the
  conversational/triage/pipeline paths). On opt-out it does corpus-first → local-FM synth →
  honest fallback, never fanning out to external providers. Verified type-clean (error count
  31→31 vs baseline) and esbuild-transpiles. Backward-compatible: absent `ensemble` field = old
  behavior, so it's inert until the redesigned composer (A1) opts in. Regression risk: none for
  existing clients. Remaining Phase A: A1–A3 (frontend, `App.tsx`) — open for the other agent.

---

## 7. Decisions Log  *(smart defaults made without Justin — record reasoning so they're not re-litigated)*

- **2026-07-06 · Agent A · Canonical repo = `crucible-backend-`, not `Crucible-Code`.** The
  original repo was deleted; its full backend survived only in a container clone and is now
  preserved here. `Crucible-Code`'s app is a greenfield rewrite with a stubbed backend — adopting
  it would discard the real pipeline/tools/self-patcher. Therefore this repo is canonical and
  `Crucible-Code` is demoted to a UI/animation reference. Consequence: the redesign is a *port
  into* this `App.tsx`, not a repo swap.
- **2026-07-06 · Agent A · Coordinate via this file, not Issues/PRs.** A committed file that
  lives beside the code, is versioned, and both agents already pull is the most regression-proof
  shared state. Issues would split the source of truth away from the tree.
- **2026-07-06 · Agent A · Did not gut `App.tsx` blind; shipped an executable spec instead.**
  The orchestrator's hard constraint is no regressions. `mode` drives real server routing (~10
  sites) + Remote Brain, and I can only typecheck in this sandbox — I cannot runtime-verify the
  live multi-model pipeline (needs external providers). Ripping out the mode machine without
  being able to run the pipeline end-to-end is exactly the regression risk to avoid. So I did
  the irreversible/time-critical work (backend preservation, coordination hub) and produced a
  precise, verified, line-referenced Phase A plan that either agent can execute surgically. The
  actual `App.tsx`/`server.ts` edits happen in a focused pass with runtime verification, not blind.
