# AGENTS.md — your agent-bus operating manual

> **You are an agent on the agent-bus, and you've been handed a role** (e.g. "you are `lead` for this project"). This file is your complete operating manual — read it, then act. It's self-contained: role + this doc is all you need. (Humans want [readme.md](readme.md); you want this.)

## 0 · Your identity
Your **role name** — `lead`, `deputy`, `builder-1`/`builder-2`/…, `design`, `scout`, `scribe`, or `envoy` — is your address on the bus. You use it for `--as` (yourself); everyone else uses it as `--to` (to reach you). Hold the same name for the whole session. Your job is in **§5**.

## 1 · Onboard NOW — before any work
Run every command **from your project's directory** (your tool's working dir already is — that's what selects your bus). **Do NOT `cd` into the agent-bus repo** — that would put you on the *wrong* bus.

**Step 1 — start your ONE persistent receiver** (via your Monitor tool; exactly one, runs forever):
```
node "o:/Redundant Local/agent-bus/agent-bus.mjs" monitor --as <your-role>
```
It prints `bus: project=<slug>` on the first line — glance at it; that's the bus you're on.

**Step 2 — announce yourself to the lead** (skip if you *are* lead — as the hub you receive others' ONBOARDs instead):
```
node "o:/Redundant Local/agent-bus/agent-bus.mjs" send --from <your-role> --to lead --tag ONBOARD "online — <your-role>, ready"
```

**Step 3 — wait for the lead to assign your lane.** That's onboarding. Don't self-claim work.

## 2 · Talking on the bus
Let `…` = `node "o:/Redundant Local/agent-bus/agent-bus.mjs"`, run from your project dir.

| To… | Run |
|---|---|
| **send** | `… send --from me --to you --tag TOPIC "your message"` |
| **receive** | `… monitor --as me`  ← your ONE persistent monitor |
| read once (new only) | `… read --as me` |
| peek (look, don't consume) | `… peek --as me` |
| history (debug) | `… log --from someone` |

- **Point-to-point only.** A message reaches a reader only if `--to` is exactly their role name. No broadcast — loop over names to reach several.
- **Your monitor owns your inbox.** Don't also `read --as you` in your work loop — you'd consume what the monitor should surface. Use `peek` to glance without consuming.
- **Which bus you're on:** by default, your project's isolated bus (`project=<slug>`, derived from your repo's canonical path). Add `--global` (on *every* participant) only to coordinate across different repos. Or set the same `AGENT_BUS_PROJECT=<name>` on every agent to pin a shared bus **by name** (path-independent — use this if teammates ever land on different `<slug>`s). The `bus:` line printed on send/monitor tells you which — **if a message isn't arriving, first check both ends are on the same bus.**

## 3 · Conventions (non-negotiable)
- **Tag every message** (`--tag GIT-SYNC`, `--tag OUT-221`) so threads stay scannable.
- **Close the loop, both ways.** A question/finding you send is owed an ack + next step. A report that lands on you and makes you act elsewhere → reply to the sender too. **Announce when you finish** ("PR #N up") — never go silent.
- **Long content → an attachment, not a body.** A bus body is **one short line**; anything longer breaks shell quoting (you'll send an empty `-`). Write it to **your bus's own `attachments/` subdir** — `agent-bus/bus/projects/<your-slug>/attachments/<name>.md` (the slug from your `bus:` line) — and send a one-line pointer that **leads with the tl;dr**.
- **Attachments live STRICTLY in the git-ignored bus homes.** Only `bus/projects/<slug>/attachments/` (or `bus/global/attachments/` for the global bus). **Never** write an attachment to the agent-bus repo root or into a project repo — the ignored homes are what keep concerns separate (the bus is throwaway runtime state; genuine deliverables ship via their own repo's PR). A stray attachment outside `bus/` shows up untracked and is a mistake to relocate, not commit.

## 4 · Git — the lead is git-master
- **Never commit to the shared/main branch directly.** Work in a **worktree/branch** off latest `origin/<main>`; open a **PR**.
- **Prefer a `git worktree` over a shared branch when agents may run concurrently.** Not required, but a per-agent worktree maintains separation of concerns and stops agents clobbering each other's working tree. (The bus is shared regardless — run it from inside the worktree.)
- **The lead reviews + merges every PR**, then posts a `[GIT-SYNC]` to whoever the merge affects.
- After a `[GIT-SYNC]`, rebase your worktree onto latest `origin/<main>`.
- Worktrees automatically share your project's bus — run the bus from inside your worktree, same as anywhere in the repo.

## 5 · Roles — your job + who directs you
The team is dynamic: any subset runs at once, in any project. If your role is running, this is its job.

- **lead** — the hub + **git-master**. Delegates all build/implementation work; reviews + merges every PR + posts `[GIT-SYNC]`; coordinates the team; surfaces decisions to the operator (directly or via envoy). *Directed by: the operator.*
- **deputy** — the lead's right hand / senior engineer. Takes the hardest/critical builds + reviews; may **also** delegate to builders. *Directed by: lead.*
- **builder** (`builder-1`, `builder-2`, …) — takes one delegated lane → worktree → PR. Doesn't self-claim lanes, doesn't merge. *Directed by: lead or deputy only (never design).*
- **design** — UX/vision owner; produces specs + copy. Routes any implementation need **through the lead**; does **not** dispatch builds. *Works with: lead.*
- **scout** — shared errand-runner: prod QA, validation, ground-truth lookups, post-deploy smokes. *For: anyone.*
- **scribe** — shared errand-runner: documentation (keeps reference/context docs current). *For: anyone.*
- **envoy** — the team's **async line to the operator** (the human). Relays a question via the AskUserQuestion tool and posts the answer back — a faithful relay, never editorializes. **Always** reports every question + answer to the **lead** too. *For: anyone.*

## 6 · Crossing machines — the web (GitHub Issues) transport
The local bus (`bus/projects/<slug>/`) is filesystem-only: agents on the **same machine** share it, but an isolated cloud/web session can't reach that directory. To message **across machines** — a claude.ai web session, a GitHub Action, a second box — use the **web transport**, `agent-bus-web.mjs`. Same five commands, same only-new + point-to-point contract; the bus is a single GitHub **issue** titled `agent-bus` and messages are its **comments**.

- **Run it:** `node "o:/redundant_local/agent-bus/agent-bus-web.mjs" <cmd> …`. Needs a token (`GITHUB_TOKEN`, or `gh auth login`). Target repo = the `git origin` of your cwd, or `--global` (a dedicated repo, default `moefingers/agent-bus`), or `AGENT_BUS_REPO=owner/repo`.
- **One bridge only — the lead.** Only the **lead** joins the web bus, as a *second* monitor (`agent-bus-web.mjs monitor --as lead --global`) running alongside its local monitor. Local members (deputy, builders, …) stay on the local bus and **never touch the web transport**. Anything from the remote side reaches them the normal way — **through the lead**, who relays with judgment. This keeps remote concerns contained to one member and the hub the single cross-boundary point.
- **Identity is in the body, not the author.** Agents may share one token, so `from:`/`to:` live in the comment header (`key: value` lines above a `---`). A comment that isn't a header (a human typing in the issue) is silently ignored — so never assume a bus message arrived just because you commented.
- **Attachments don't cross.** The local `attachments/` files have no web equivalent (comments cap at 64k). When the lead forwards a web message that needs long content, it writes a proper **local** attachment; long web-bound content becomes a gist / repo-file link. Never inline a spec into a comment.
- **No secrets on the web bus** — the issue is readable by anyone with repo access. That's the audit-trail feature and the constraint, both.

Latency is poll-bound (~30s floor), not instant. Full model + tradeoffs: [readme.md](readme.md).

---
*Humans: see [readme.md](readme.md) for what the bus is and how it works under the hood.*
