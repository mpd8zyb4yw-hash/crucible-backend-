# Crucible → Agentic Coding Assistant — Build Handoff (for Fable 5)

**Mission:** take Crucible from a multi-model *answer synthesizer* (~30% done) to a real
*agentic code-compiling assistant* (the remaining 70%). Build in the **numbered sections
below, in order**. Each section is self-contained and resumable. **Finish one section
fully (pass its DONE-WHEN) before starting the next** — so a usage cutoff never leaves
half-written source. After each section: commit (`git add -A && git commit`), and update
the PROGRESS table at the bottom.

---

## 0. ORIENTATION (read once, ~2 min)

**Project root:** `/Users/justin/crucible-local` — NEVER move to `~/Desktop` or `~/Documents`
(iCloud injects `com.apple.macl` xattrs that hang `tsx`). This is the canonical build.

**Run:**
- Backend: `cd ~/crucible-local && npx tsx server.ts` → port **3001**
- Frontend: `npx vite` → dev UI (Electron entry: `electron.cjs`)
- Never `npm run build`. If ports stick: `pkill -f tsx; pkill -f vite; pkill -f Electron`.

**Env:** `.env.local` holds 7 keys (Groq, Mistral, OpenRouter, Gemini, HF, Cloudflare acct+key).
Server reads them via dotenv. Keep secrets out of git (`.gitignore` covers `.env.local`).

**What already exists (do NOT rebuild):**
| Area | File | State |
|---|---|---|
| HTTP + SSE + providers | `server.ts` (~45KB) | newest; 6 providers; `/api/chat` streams |
| Model selection / routing | `modelRegistry.ts` | `classifyPrompt`, `selectModels`, circuit breakers, per-type `fit` |
| Scoring | `src/CrucibleEngine/scoring-engine.ts` + `contract-generator.ts` + `tokenizer.ts` + `knowledge-base.ts` + `types.ts` | contract-based composite score, remediation gate |
| Error parsing | `src/CrucibleEngine/error-intelligence.ts` | pattern→remediation hints (UNDERUSED — section 4) |
| Code exec | `src/CrucibleEngine/sandbox.ts` | Python sandbox, `prewarmPython()` |
| Codebase RAG | `src/CrucibleEngine/rag-context.ts` | `buildIndex/queryIndex/getIndexStats` |
| Checkpoints | `src/CrucibleEngine/checkpoint.ts` | git-based `createCheckpoint/rollback/getCheckpoints` |
| Weak agent loop | `server.ts` `callModelAgentic` + `extractToolCall` | regex `<tool>` tags, 3 iters, ONLY in remediation — REPLACE in sections 1–2 |
| File tools | `/api/file/{read,write,list}` | whole-file only (no diffs — section 3) |
| UI | `src/App.tsx` (~77KB) | code panel, pipeline log, prompt-type badge, "how we got here" |

**Existing endpoints:** `/api/chat /api/verify /api/prewarm /api/config /api/terminal
/api/file/{read,write,list} /api/checkpoint{,/rollback} /api/checkpoints /api/index{,/stats}`.

**Backup of pre-merge stubs:** `src.reconstruct-backup/` (ignore; reference only).

**Design invariants:** lightweight + fast are first-class. No heavy frameworks (no LangChain,
no vector-DB server). Stream everything. Prefer in-process, file-backed state. Every new
loop must be **cancellable** and **token-budgeted**. Favor novel/minimal approaches over
boilerplate when they cut latency or tokens.

---

## 1. STRUCTURED TOOL PROTOCOL  *(foundation — everything else depends on it)*

**Goal:** replace fragile regex `<tool>` scraping with a robust, provider-portable tool
protocol + a single tool registry.

**Create:** `src/CrucibleEngine/tools/registry.ts`, `src/CrucibleEngine/tools/protocol.ts`.
**Modify:** `server.ts` (remove `extractToolCall`/`executeToolCall`, route through registry).

**Contract:**
```
type ToolDef = { name; description; params: JSONSchema; run(args, ctx): Promise<ToolResult> }
type ToolResult = { ok: boolean; output: string; truncated?: boolean; meta?: any }
type ToolCall = { id; name; args }   // parsed from a model turn
registry.list(): ToolDef[]; registry.exec(call, ctx): Promise<ToolResult>
```
**Parser strategy (novel/lightweight, dual-mode):**
1. If provider supports native function-calling (Groq/Mistral/OpenRouter OpenAI-compat,
   Gemini), use it — pass `registry` as JSON-schema tools, read structured `tool_calls`.
2. Fallback for models without it: a **strict single-fence JSON protocol** — model emits
   one ```json {"tool","args"}``` block; parse with a tolerant JSON extractor (balance-brace
   scan, not regex). Reject + reprompt once on malformed. No multi-tag scraping.

**Context object `ctx`** carries: `projectPath`, `budget`, `emit(event)` (for SSE), `signal`
(AbortSignal). Pass it everywhere so tools can stream + be cancelled.

**DONE WHEN:** a unit smoke test issues a `read_file` via BOTH native and JSON-fence paths and
gets identical `ToolResult`; `server.ts` no longer references `extractToolCall`. Commit.

---

## 2. THE AGENT LOOP  *(the core of "agentic")*

**Goal:** a sustained plan→act→observe→repeat loop on the MAIN request path, not just
remediation. This is the single biggest gap.

**Create:** `src/CrucibleEngine/agent/loop.ts`. **Modify:** `server.ts` `/api/chat` to run the
loop when the request is a *task* (vs. a pure Q&A — reuse `classifyPrompt`).

**State machine (keep tiny):**
```
state = { goal, plan: Step[], cursor, transcript, files: Map, budgetTokens, iters }
loop(): while not done and iters<MAX and budget>0:
  turn = await driverModel(transcript + tools)         // section 6 picks driver
  if turn.toolCalls: results = await Promise.all(exec); append; continue
  if turn.final: verify() (section 4); if pass -> done else inject failure; continue
```
**Novel/lightweight levers:**
- **Observation compression:** never feed raw tool output back verbatim. Summarize file reads
  to signatures + relevant spans (reuse `queryIndex`/`tokenizer`); cap each observation to N
  tokens. This is what keeps it fast + cheap on small models.
- **Interleaved streaming:** emit `tool_call`, `tool_result`, `thought`, `diff`, `verify`
  events over the existing SSE channel so the UI (section 7) renders live.
- **Hard caps:** `MAX_ITERS`, `budgetTokens`, wall-clock timeout, AbortSignal — all enforced.
- **Idempotent steps:** each step writes through `checkpoint.ts` first → any step is undoable.

**DONE WHEN:** `/api/chat` with "create a file that prints prime numbers and run it" autonomously
writes, runs, and reports success across ≥2 tool iterations, fully cancellable. Commit.

---

## 3. REAL EDITING + SHELL TOOLSET  *(give the loop hands)*

**Goal:** replace whole-file writes with surgical edits and add execution/search tools.
Register all in section-1 registry.

**Tools to add (each ≤ a small function):**
| Tool | Behavior | Lightweight note |
|---|---|---|
| `edit_file` | exact `old→new` string replace, unique-match or fail | no AST; diff-match by anchor |
| `apply_patch` | unified-diff apply (multi-hunk) | use a tiny inline patcher, no dep |
| `read_file` | range-aware (offset/limit), returns line numbers | cap output |
| `search` | ripgrep if present, else streamed JS walk | reuse `rag-context` SKIP_DIRS |
| `run` | shell exec in `projectPath`, captured stdout/stderr, timeout, killable | extend `sandbox.ts` beyond Python — generic subprocess + Python fast-path |
| `list_dir` | shallow tree | exists; wrap |

**Safety:** `run`/`edit`/`write` gate behind a permission flag in `ctx` (default: allow within
`projectPath`, deny outside). Checkpoint before any mutation.

**DONE WHEN:** loop can `edit_file` a real file, `run` its test, and `search` the tree — verified
by one scripted task. Commit.

---

## 4. EXECUTION-DRIVEN VERIFICATION  *(close the run→fix loop)*

**Goal:** wire `sandbox.ts` + `error-intelligence.ts` into a verify-and-self-heal cycle the
agent loop calls before declaring done.

**Create:** `src/CrucibleEngine/agent/verify.ts`.
```
verify(step, ctx): { passed; signal: 'compile'|'test'|'runtime'|'lint'; report; hints }
```
**Flow:** detect how to check (test cmd? compile? just run?) → execute via `run` →
on failure, pass stderr through `error-intelligence.ts` to get structured `hints` →
return to loop, which feeds `report+hints` back to the driver for a fix turn. Cap heal
attempts (e.g. 3) then surface honestly.

**Novel/lightweight:** maintain a per-session **failure fingerprint set** (hash of error
signature); if the same fingerprint repeats, stop looping and escalate to the ensemble
(section 6) instead of burning iterations — prevents thrash.

**DONE WHEN:** a deliberately-buggy task gets auto-fixed within the heal cap, and an
unfixable one stops cleanly with an honest report (no infinite loop). Commit.

---

## 5. PLANNER / TASK DECOMPOSITION  *(long-horizon)*

**Goal:** break a task into an explicit todo list, execute steps, track status, allow
re-planning. Reuse the loop per step.

**Create:** `src/CrucibleEngine/agent/planner.ts`.
```
plan(goal, ctx): Step[]            // Step = { id, intent, files?, doneCheck }
replan(state, failure): Step[]     // when verify keeps failing or scope changes
```
**Lightweight approach:** planner is a SINGLE strong-model call returning a compact JSON
todo (no chain-of-thought stored). Steps stream to UI as a live checklist. The loop owns
execution; planner only (re)orders. Keep plan in `state`, persisted to the session file
(section 8) so a cutoff resumes mid-plan.

**DONE WHEN:** a 3+ step task ("add a function, write its test, run it, fix failures") shows
a live todo list that ticks off and completes end-to-end. Commit.

---

## 6. MODEL STRATEGY — ORCHESTRATOR/WORKER + SPEED  *(beat the weak-model ceiling)*

**Goal:** stop treating all models equally. One capable model *drives* the loop; the cheap
ensemble does parallelizable sub-work. This is how you get agency without frontier-only cost.

**Modify:** `modelRegistry.ts` (add role tiers), `agent/loop.ts` (driver selection).

**Design:**
- **Driver tier:** best available instruction-follower with reliable tool-calling (route to
  the strongest free model that supports native function-calling; let user plug a paid key).
  Drives planning + tool decisions.
- **Worker tier:** existing parallel ensemble — used for *bounded* sub-tasks (generate N
  candidate impls of one function, draft a test, summarize a file) where the scorer picks a
  winner. Reuse the existing adversarial pipeline AS a tool the driver can call:
  `tool: ensemble_solve(subprompt) → best scored candidate`. **This makes Crucible's
  unique scoring engine the worker brain — the real differentiator.**
- **Speed levers (treat as requirements):** prompt-cache the system+tool preamble; stream
  driver tokens; run worker ensemble + verification concurrently; speculative pre-warm of
  the next likely tool (`prewarmPython` pattern generalized); compress observations (section 2).

**DONE WHEN:** driver autonomously calls `ensemble_solve` for a hard sub-step and integrates
the winning candidate; measured end-to-end latency on a sample task is logged. Commit.

---

## 7. FRONTEND — SURFACE THE AGENT  *(make it visible)*

**Goal:** render the live loop in the existing `App.tsx` UI. No rewrite — extend.

**Add (consume new SSE events from section 2):**
- Live **todo checklist** (from planner) with per-step status.
- **Tool-call timeline:** each `tool_call`/`tool_result` as a collapsible row.
- **Diff viewer** for `edit_file`/`apply_patch` (red/green), reusing the existing code panel.
- **Terminal pane** streaming `run` stdout/stderr.
- **Verify badge** per step (pass/heal/fail) — extend the existing "fixed and verified" UI.
- Keep the dynamic code-panel expand/collapse behavior already present.

**Lightweight:** one reducer over the SSE event stream → one `agentState`. No new state lib.

**DONE WHEN:** running a task shows todos ticking, tools streaming, diffs, and terminal output
live, all cancellable from the UI. Commit.

---

## 8. STATE, MEMORY, SAFETY, PROJECT BINDING  *(make it durable + self-contained)*

**Goal:** dedicated per-project data dir, resumable sessions, project memory, permissions.

**Create:** `src/CrucibleEngine/state/session.ts`.
- **Dedicated data dir:** `<projectPath>/.crucible/` holds `index.json`, `checkpoints.json`,
  `sessions/<id>.json`, `memory.md`. NEVER share a global app dir across projects.
- **Resumable sessions:** persist `state` (plan, transcript-summary, cursor) after each step;
  on reconnect, rehydrate so a usage cutoff resumes the *agent task*, not just the chat.
- **Project memory:** append durable facts (build cmd, test cmd, conventions) to
  `.crucible/memory.md`; inject a compressed digest into the driver preamble.
- **Permissions:** explicit allow-list for `run`/write outside `projectPath`; destructive ops
  (delete, force-push, outside-root writes) require a UI confirm event.

**DONE WHEN:** kill the server mid-task, restart, and the session resumes with plan + files
intact; writes outside `projectPath` are blocked without confirm. Commit.

---

## SEQUENCING & RESUME RULES
- Order is dependency-correct: **1→2→3→4→5→6→7→8**. Don't skip ahead.
- **One section = one or more commits, but never leave a section's source half-written across
  a usage boundary.** If you must stop, stop at a compiling state and note the exact next step
  in PROGRESS.
- Each section's DONE-WHEN is a runnable check — prove it before moving on.
- Keep it lean: if a section can be done in fewer files with a novel trick, do that. Speed and
  token-efficiency are graded equally with correctness.

## PROGRESS (update every commit)
| # | Section | Status | Last commit | Next step if interrupted |
|---|---|---|---|---|
| 1 | Tool protocol | ✅ | (this commit) | done — registry + dual-mode protocol, smoke test passes |
| 2 | Agent loop | ✅ | (this commit) | done — loop on main /api/chat path, write+run verified |
| 3 | Editing+shell | ✅ | (this commit) | done — edit/patch/search/run, checkpoint gate, 11 tests pass |
| 4 | Verification | ✅ | (this commit) | done — verify+self-heal, fingerprint anti-thrash, 8 tests pass |
| 5 | Planner | ✅ | (this commit) | done — live todo plan/replan, 5-step task e2e (groq TPD hit at tail, honest stop) |
| 6 | Model strategy | ✅ | (this commit) | done — driver tier + cross-provider fallback; ensemble_solve autonomously fired (edit_distance correct); latency logged (~220s planned path — optimize apply_patch churn later) |
| 7 | Frontend | ✅ | (this commit) | done — AgentPanel (plan/tools/diffs/terminal/verify) via one reducer; verified live in preview; cross-chunk SSE buffering; cancellable |
| 8 | State/memory/safety | ✅ | (this commit) | done — per-project .crucible/ dir, resumable sessions (kill+resume verified), project memory digest, write-outside-root blocked; 15 tests pass |
