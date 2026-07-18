# Crucible

**STOP — if two agents are working in parallel, read [`AGENTS.md`](./AGENTS.md) FIRST and run its
GATE 0 (shared-remote precondition) before anything else.** It is the zero-context bootstrap that
makes parallel work succeed: verify you're on the shared remote, verify before you claim, one file
one owner, stay on your branch. Skipping it repeats failures that have already happened here.

**Then read [`ROADMAP.md`](./ROADMAP.md) before any coding work.**

`ROADMAP.md` is the single source of truth for this project: what exists, what's planned, the
working rules, run commands, and the dated change log. It replaces all prior handoff docs.

Non-negotiables (full detail in ROADMAP.md):
- **Verify, never guess** — confirm a feature is actually wired in (grep for callers) before
  marking it done or assuming it's missing.
- **Free-tier philosophy** — free models + the self-refinement pipeline ("garbage in, gold out").
  Weak output ⇒ more client-side processing, never a premium model.
- **UI rules** — no emojis anywhere; no stock/external images (self-authored visuals only);
  text stays inside its boxes; animations ease in/out, fast and clean.

After completing work, append a dated entry to the CHANGE LOG in `ROADMAP.md` and cross off any
items you finished.
