# AGENTS.md — zero-context parallel-work bootstrap

> **You are one of two AI coding agents working this repo in parallel. Read this file FIRST,
> top to bottom, before any other work — including before reading `ROADMAP.md`. It exists to
> make "work in parallel with the other agent" succeed from a cold start with zero prior
> context. If you skip the GATE below, you will repeat failures that have already happened here.**

---

## GATE 0 — Shared-remote precondition (MUST pass before you touch anything)

Two agents can only coordinate if they push/pull the **same git remote**. If you are on a
different clone, the other agent's commits are invisible to you and any "it's wired" claim about
their work is unverifiable. **This is the failure that has already bitten us.** Run these first:

```
git remote -v                                   # origin MUST be: .../mpd8zyb4yw-hash/crucible-backend-
git fetch origin                                # must succeed
git ls-remote --heads origin main               # main must exist on the shared remote
git branch --show-current                       # this is YOUR working branch — note it
```

- If `origin` is **not** `mpd8zyb4yw-hash/crucible-backend-`: **STOP.** You are on the wrong
  clone. Tell the human. Do not coordinate, do not claim shared state — you cannot see it.
- If it matches: you are connected. Proceed. **All coordination now happens through this remote
  in `COLLAB.md`, never through a human relaying pasted text.** If you find yourself being handed
  the other agent's words by a human instead of reading them via `git`, GATE 0 has failed — say so.

---

## The 5 rules (non-negotiable)

1. **VERIFY BEFORE YOU CLAIM.** Never state that a commit, branch, or wiring exists unless you
   have just run `git show <sha>` / `git ls-remote` and seen it. Quote the sha. "I committed X"
   without a verified sha is a lie, even if you believe it. This rule exists because an agent here
   asserted a commit that did not exist in its tree. Report only state you can reproduce with a
   command in THIS repo, right now.

2. **ONE FILE, ONE OWNER.** Before editing any non-doc file, add a row to `COLLAB.md` §4 (Active
   Claims) naming the file(s) and your branch. Never edit a file another agent's row locks.
   `server.ts`, `modelRegistry.ts`, and `src/App.tsx` are **singleton locks** — exactly one agent
   at a time. If it's claimed, do other work. Cross-lane seams (one agent needs a change in the
   other's locked file) are requested in §5 and made by the file's owner, not by grabbing the lock.

3. **STAY ON YOUR BRANCH.** Work only on the branch from `git branch --show-current` at boot (the
   human assigns each agent a distinct one). Never push to the other agent's branch or to `main`.
   `main` is integration-only and lands via GATE 3 below.

4. **SYNC RITUAL, every session and every push.**
   - *Session start:* `git fetch origin` → read `COLLAB.md` top-to-bottom (esp. §4 claims + newest
     §5 messages) → read your lane's files.
   - *Before every push:* `git fetch origin && git merge origin/main`. `COLLAB.md`/`ROADMAP.md`/
     `NEXT_SESSION.md` are **append-only** — resolve any conflict by **keeping BOTH sides' blocks**
     (union), never discarding the other agent's lines.
   - *After a unit of work:* push your branch, update your §4 claim, append a dated §6 change-log
     entry. Keep docs truthful — if a claim row is stale, fix it.

5. **TELL THE TRUTH ABOUT VERIFICATION LEVEL.** Neither agent can boot the live app in-sandbox
   (no providers / native deps). So "verified" means: transpiles + loads clean, and a standalone
   test of the changed logic passes — say exactly that. Never claim "boot-tested" or "works live";
   the boot-test is the human's gate (GATE 3). If tests fail, say so with the output.

---

## Lanes (how we split so we never collide)

Assign disjoint file areas. Current durable split (adjust in §4 as work shifts):

| Lane | Owns (locked) | Nature |
|---|---|---|
| **Reliability / pipeline** | `server.ts`, `modelRegistry.ts` | request path, providers, error handling |
| **On-device model quality** | `src/CrucibleEngine/localModels/**` | ensemble, strengthen, routing (pure/offline/benched) |
| **Frontend** | `src/App.tsx` | UI (singleton lock; often idle) |

Two lanes are collision-safe iff `git diff --name-only origin/main...<branchA>` and `...<branchB>`
share no non-doc file. **Verify disjointness with that command before assuming it.**

---

## GATE 3 — Integration & boot-test (the only path to `main`)

1. Land small; don't stack. Max **one unmerged branch per agent** at a time.
2. When branches are ready and verified-disjoint: cut ONE `integration/<date>` branch from `main`,
   merge each disjoint branch in (clean by construction), hand the human **one** branch to boot
   once.
3. On green boot-test, fast-forward the branches into `main`. Only the human's boot-test promotes
   code to `main` — an agent never self-certifies a merge to `main`.

---

## First actions from zero context

1. Run GATE 0. If it fails, stop and report.
2. Read `COLLAB.md` (live coordination) and `ROADMAP.md` (architecture; note its prose can lag the
   code — trust `git`/grep over checkboxes).
3. Post a §5 message: your identity, your branch, the lane you're taking (check §4 it's free).
4. Claim your files in §4, then work — small commits, push often, verify before you claim.
