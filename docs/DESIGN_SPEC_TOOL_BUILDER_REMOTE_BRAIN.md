# Crucible — Natural-Language Tool Builder & Remote Brain: Design Spec + Gap Analysis

> Spec drafted 2026-07-07 from the product vision. The spec was originally written without
> repo access ("greenfield"); the **Gap Analysis** section at the bottom reconciles it
> against the actual codebase. ROADMAP.md remains the source of truth for status — this doc
> is the design reference for the four systems below.

---

## 1. Design Principles (apply to every system below)

1. **Never claim success without proof.** Every "tool built," "change applied," or "device
   connected" state is backed by an automated verification step whose actual result is shown
   to the user — pass/fail, logs, diff, transcript. No optimistic status text.
2. **Consent is never automated away.** Anything that grants access (GitHub tokens, shell
   access, keyboard/mouse control) requires an explicit human-approved authorization step.
   Tedium can be removed; the consent step cannot.
3. **Every generated tool is sandboxed until proven safe**, and every generated system
   command is scoped and confirmable until proven safe.
4. **Every change is reversible.** Tool specs, generated code, and refinements are
   versioned; rollback is one click.

---

## 2. System 1 — Natural-Language Tool/Agent Builder

### 2.1 Conversational flow (generalizing the "/grill me" example)

1. **Trigger capture** — user says "build me a tool that…"
2. **Intent extraction** — Crucible parses this into a draft ToolSpec (2.3) and restates it
   in plain language for confirmation
3. **Clarifying dialogue** — Crucible asks only what it can't infer, one question at a time.
   For a persona-style tool: "What should it ask about first?", "How chatty vs. terse should
   it be?", "When should it hand off to the actual task?"
4. **Draft generation** — produces the trigger (slash command or natural-language phrase),
   persona/system prompt, question flow, and generated implementation if code is required
5. **Dry run** — Crucible runs the tool against a synthetic scenario matching the user's
   stated use case and shows the transcript/output *before* asking to install
6. **Install** — tool is registered, versioned, and made available; a rollback point is
   created automatically

### 2.2 Architecture

- **Tool Registry** — central store of ToolSpecs, generated code, version history, and
  usage logs
- **Router** — matches slash commands *and* natural-language triggers (e.g., "call grill-me
  before any build task") to registry entries; supports semantic/fuzzy trigger matching,
  not just exact slash strings
- **Builder Agent** — a scoped sub-agent whose only job is conversation → ToolSpec →
  generated artifact. Runs with its own tool/token budget so a bad build can't consume the
  main session's context or permissions
- **Sandbox Runner** — executes generated code/personas in an isolated environment
  (per-run, no network by default, resource and time limits) for the dry run, and for all
  future invocations unless the user explicitly grants the tool broader permissions

### 2.3 ToolSpec schema (example: grill-me)

```json
{
  "id": "grill-me",
  "trigger": {
    "type": "slash_command",
    "value": "/grill me",
    "aliases": ["quiz me on this task", "interview me before we start"]
  },
  "kind": "persona_agent",
  "description": "Interviews the user with clarifying questions before starting a build task.",
  "behavior": {
    "persona_prompt": "...",
    "question_bank": ["...", "..."],
    "handoff_condition": "user confirms scope is clear, or says 'go'"
  },
  "generated_code_ref": null,
  "permissions": ["chat_only"],
  "provenance": { "source": "user_authored", "imported_from": null },
  "version": 1,
  "test_cases": [
    { "scenario": "python snake game request", "expected_behavior_notes": "..." }
  ],
  "verification_status": {
    "last_smoke_test": "2026-07-07T18:00:00Z",
    "result": "pass"
  }
}
```

---

## 3. System 2 — GitHub Subscriptions & Tool Discovery

### 3.1 Subscribing to sources

Users add a GitHub username/org as a "subscription" (e.g., a known agent-skills author).
Two discovery modes, both live simultaneously:

- **Indexed** — a background job periodically crawls subscribed repos and extracts a
  lightweight manifest (repo, path, name, description, detected trigger, license) into a
  searchable index
- **Live search** — an on-demand "ctrl+F"-style query at build time across subscribed repos
  (and, if the user opts in, GitHub search more broadly) to cover anything the indexed
  cache is missing or stale on

### 3.2 Manifest detection

Heuristics first (README parsing, folder conventions like `skills/`, `tools/`, `agents/`,
package metadata), then an LLM classification pass to confirm "this looks like an
importable tool" and produce a short natural-language description. Each detected tool
becomes a lightweight card: name, author, repo, description, license, last updated.

### 3.3 Surfacing during the builder flow

When a user's request semantically matches a subscribed tool, the builder pauses and
offers it:

> "Matt Pocock has a public grill-me tool that matches this — import it, build fresh, or
> see both?"

This is a suggestion, never a redirect — declining continues the natural-language build
normally.

### 3.4 Import flow

Fetch source → license check (flag copyleft/attribution requirements, block if the license
explicitly disallows reuse) → adapt to the local ToolSpec schema → resolve dependencies →
run through the same Sandbox Runner dry-run as a user-authored tool before install.
Imported tools keep `provenance` pointing at the source repo/commit for future update
checks and attribution.

### 3.5 Private repos — removing tedium without bypassing consent

The agent cannot silently obtain a token — GitHub requires the account owner to explicitly
approve access. What the agent *can* do is remove the manual friction around that approval:

1. Agent determines the minimal scopes needed (e.g., read-only on a specific org) and
   generates a GitHub App install link or OAuth authorize URL with those scopes pre-filled
2. User taps the link and approves on **GitHub's own consent screen** — this step is the
   actual security boundary and is never automated
3. Crucible receives the callback, exchanges the code for a token, and stores it encrypted
   at rest, scoped to that installation, visible in a "Connected Accounts" settings page
   with a one-tap revoke
4. Tokens are never typed by hand, never displayed in chat, and never logged

---

## 4. System 3 — Adaptive Tool Refinement

### 4.1 Usage-pattern detection

Each tool invocation is logged with a context tag (the inferred topic/domain of the
surrounding conversation, not raw content). When a tool is used repeatedly in a consistent
domain — e.g., grill-me used repeatedly across aerodynamics-related build tasks — Crucible
proactively *suggests*, never auto-applies:

> "You tend to use grill-me for aerodynamics work on cars and aircraft — want me to tune
> its question set toward that?"

### 4.2 Natural-language editing

The user can say "make grill-me less chatty" or "add a question about Reynolds number,"
and Crucible proposes a diff against the current ToolSpec (old vs. new persona prompt /
question bank / parameters) — never a silent overwrite. The user approves, requests
changes, or discards.

### 4.3 Mandatory verification gate

No refinement goes live without a smoke test: Crucible auto-generates a representative
scenario (or reuses the most recent real invocation) and runs the updated tool against it,
showing a before/after transcript. Only after confirmation — user approval, or an automated
pass/fail check for deterministic tools — does the new version replace the old one. The
prior version stays available for instant rollback.

---

## 5. System 4 — Remote Brain: Mobile Command Center

### 5.1 Scope

Full system control from the phone: shell command execution, mouse/keyboard emulation,
file access, and tool-building on the desktop, all driven conversationally from mobile.

### 5.2 Security model (non-negotiable given "full control")

- **Pairing** — desktop generates a short-lived pairing code/QR; mobile scans it once to
  establish a long-lived, revocable device credential (comparable to SSH key pairing, not
  a shared password)
- **Session-scoped permission tiers**:
  - *Tier 1 — Observe*: view screen/state, read logs, no side effects
  - *Tier 2 — Build*: create/edit files in a designated workspace, run tests, install
    tools — sandboxed, no destructive shell access
  - *Tier 3 — Full control*: arbitrary shell, mouse/keyboard emulation — requires explicit
    step-up confirmation (biometric on phone) per session, plus a visible "Remote session
    active" indicator on the desktop that can locally kill the session at any time
- **Command allow/deny lists** — destructive patterns (recursive deletes, force pushes,
  disk operations, credential-file access, etc.) always require an inline confirm tap on
  the phone, even inside an active Tier 3 session
- **Audit log** — every remote command and its result is stored locally, viewable from
  either device, exportable
- **Kill switch** — one tap on either device ends the session and revokes the credential
  immediately

### 5.3 Real-time bidirectional sync

- Desktop runs a persistent local daemon maintaining a secure relay/websocket connection
  (self-hosted relay or end-to-end encrypted tunnel — command content isn't visible to a
  third party)
- Changes triggered from mobile chat stream build/test logs to the phone live
- **UI sync is honestly labeled, not assumed**: where hot-reload is possible, pushed
  changes reflect immediately; where it isn't, Crucible shows a "changes ready — refresh
  to apply" prompt rather than claiming the change is already live

### 5.4 Ambiguity navigation (no-tool fallback)

Remote Brain must handle prompts it has no specific tool for — e.g. "open Notes, create a
new note with the top 10 places to visit in Rome." When no registered tool or deterministic
intent matches, the request falls through to a general plan-and-act loop: read the UI tree,
decompose the goal (open app → create item → generate content → type it), act step by step,
and verify each step from the refreshed UI tree. Ambiguity is resolved by observation, not
guessing — if the UI state after an action doesn't match the expected state, re-plan.

### 5.5 Why this isn't a gimmick

The mobile app is a full second surface for the same session state, not a read-only
companion. Building a tool, refining one, or reviewing a smoke-test result works
identically whether started on desktop or phone.

---

## 6. Reliability Requirement — "Shipped Means Proven"

Every user-facing "done" state (tool built, refinement applied, device connected, remote
command executed) requires:

- an automated check whose actual pass/fail result gates the "done" label
- the check's evidence (logs, diff, transcript) surfaced alongside it — not just a checkmark
- a distinct, honestly-labeled **"generated, not yet verified"** state for anything that
  hasn't passed its gate — never described as "shipped" or "done"

The fix for confident-but-wrong status reporting isn't better wording — it's making "done"
structurally require a passing, visible test. (This is already the repo's rule #1 in
ROADMAP.md; the systems above make it a *product* behavior, not just a dev-process rule.)

---

## 7. GAP ANALYSIS — spec vs. actual codebase (2026-07-07)

The spec assumed no codebase; the repo in fact has substantial foundations. Mapping per
system, verified by reading the code (not just file names):

### System 1 — Tool Builder

| Spec piece | Status | Where |
|---|---|---|
| Tool Registry (store + exec + mutation gating) | **Exists** | `src/CrucibleEngine/tools/registry.ts` — `registry.register/list/get/exec`, `mutates` flag, pre-mutation checkpoints |
| Dynamic runtime-authored tools, persisted + reloaded | **Exists** | `src/CrucibleEngine/tools/dynamicTools.ts` — `.crucible/dynamic-tools/`, `compileTool()` syntax-checks via `vm.Script`, tier graduation (session → specialist → global, triumvirate approval) |
| Sandbox Runner | **Partial** | `src/CrucibleEngine/sandbox.ts` is a code-*verification* sandbox (network-denied exec + static checks). Dynamic tool bodies themselves run **unsandboxed** in-process (`AsyncFunction` with real `require`) — acceptable under the current "agent already has shell" model, but not the spec's per-run isolation |
| Conversational build flow (intent → clarify → draft → dry run → install) | **Missing** | Tools today are authored by the *agent* mid-task, not via a user-facing "build me a tool that…" dialogue. No ToolSpec schema, no persona/question-bank kind, no pre-install dry-run transcript shown to the user |
| Natural-language + slash trigger routing | **Partial** | `agent/localIntentRouter.ts` does deterministic phrase → tool-plan routing (high precision, null on doubt). No user-defined triggers/aliases, no semantic matching to registry entries |
| Versioning + one-click rollback of tools | **Missing** | `DynamicToolRecord` has no version history; `checkpoint.ts` covers project files, not tool records |

### System 2 — GitHub Subscriptions & Import

| Spec piece | Status | Where |
|---|---|---|
| OAuth flow scaffolding | **Partial** | `server.ts` has `GITHUB_CLIENT_ID/SECRET` env wiring; Google OAuth (`tools/googleApis.ts`, `saveTokens`) proves the callback/token-storage pattern exists to copy |
| Subscriptions, crawling/indexing, manifest detection, license gate, import-with-provenance | **Missing** | Nothing in the repo crawls or imports external tools |
| Surfacing matches during build flow | **Missing** | Depends on both the builder flow and the index — neither exists |

### System 3 — Adaptive Refinement

| Spec piece | Status | Where |
|---|---|---|
| Usage logging per tool | **Partial** | `useCount`/`successCount`/`lastUsed` in `DynamicToolRecord`; no per-invocation *context/domain* tag |
| Domain-pattern suggestion ("tune grill-me for aero") | **Missing** | `specializationDetector.ts` / `behavioralAdaptation.ts` do adjacent things for *models*, not user tools |
| NL editing with diff + approval | **Missing** | — |
| Smoke-test gate before a refinement goes live | **Missing** for tools | The *pattern* exists elsewhere: `baselineVerify.ts` / `domainVerifiers.ts` gate answers; `npm run smoke` gates sessions. Not applied to tool edits |

### System 4 — Remote Brain

| Spec piece | Status | Where |
|---|---|---|
| Eyes & hands (UI tree, click, type) | **Exists** | `macTools.ts` (`get_ui_tree`, `click_element`, `type_text`), registered in the tool registry |
| Screen streaming to phone | **Exists** | `server.ts` Step 9 — SSE screen stream (`/api/screen-stream`, chosen over MJPEG for iOS), `/api/remote-brain/status` |
| Auth | **Partial** | `requireAuth` cookie session; screen stream is deliberately cookie-exempt (LAN-only). No device pairing, no per-device revocable credential |
| Permission tiers (Observe/Build/Full) + biometric step-up | **Missing** | All-or-nothing today |
| Destructive-command confirm taps, audit log, kill switch | **Partial** | `mutates` flag + `allowMutation` gate and pre-mutation checkpoints exist; no phone-side confirm UX, no exportable audit log, no session kill switch |
| Ambiguity navigation (5.4) | **Partial** | Exactly the designed stack: `localIntentRouter` (Layer 0, deterministic) → agent loop (`agent/loop.ts`, `planner.ts`) with UI-tree read-act-verify. The gap is *coverage and reliability* of the fallback loop, not its absence |
| Relay for away-from-LAN use | **Partial** | Cloudflare-tunnel approach noted in ROADMAP build order; not an E2E-encrypted paired channel |

### Recommended build order (highest leverage first)

1. **ToolSpec + versioning + rollback** on top of `dynamicTools.ts` (small delta, unlocks Systems 1 & 3)
2. **User-facing builder dialogue** with mandatory pre-install dry run (reuse `sandbox.ts` + agent verify loop as the gate)
3. **Refinement diff-and-smoke-test flow** (reuses #1's versioning and #2's dry run)
4. **Remote Brain pairing + tiers + confirm taps** (security prerequisite for pushing Remote Brain further)
5. **GitHub subscriptions/import** last — biggest new surface, least shared foundation

Open questions from the original spec (relay approach, license-gate strictness, Tier 3
time limit) remain open.
