---
name: bus
description: The shared agent-bus protocol every role runs on — onboarding, messaging conventions, and git discipline. Role skills carry only their role's essence and point here; run or read this once when adopting any agent-bus role. Full canon lives in AGENTS.md.
---

# The shared bus protocol — every role runs this

> This is the **single skill-side source** for everything the roles have in common. Role skills (`lead`, `deputy`, `builder`, …) point here instead of repeating it. The full canon is [`AGENTS.md`](../../../AGENTS.md) — **if this skill ever disagrees with AGENTS.md, AGENTS.md wins; fix this skill.**

`<agent-bus>` below is the path to your agent-bus checkout (the repo this skill lives in) — it varies per machine, so substitute your actual path. Run every command **from your project's directory** (your worktree, if you have one): your cwd selects the bus (per-project by default; the `bus:` line printed on send/init/doorbell tells you which). **Never `cd` into the agent-bus repo** — you'd land on the wrong bus.

## Onboard NOW — before any work

1. **Wire yourself in** (once per worktree — writes hooks into this project's `.claude/settings.local.json`; the harness then injects your mail, already acked, at every turn boundary, on operator prompts, mid-turn after tool calls, and on session start/resume/compaction):
   ```
   node <agent-bus>/agent-bus.mjs init --as <your-role>
   ```
   Hooks load at session start — **if this session began before your `init`, restart/resume the session once.**
2. **Arm your idle-wake** as a background task (Bash `run_in_background: true`; silent while you work, exits to wake you when mail lands while you're idle — re-arm it whenever you see its exit notification):
   ```
   node <agent-bus>/agent-bus.mjs doorbell --as <your-role>
   ```
3. **Announce yourself to the lead** (skip if you *are* lead — the hub receives ONBOARDs instead of sending one):
   ```
   node <agent-bus>/agent-bus.mjs send --from <your-role> --to lead --tag ONBOARD "online — <your-role>, ready"
   ```
4. **Wait for the lead to assign your lane.** Don't self-claim work.

## Conventions (non-negotiable)

- **Point-to-point.** A message reaches a reader only if `--to` is exactly their role name; `--to a,b,c` fans out one message per recipient. You never receive your own sends.
- **Receiving is not your job.** A `[agent-bus]` block appearing in your context IS your mail, already acked — act on it and close the loop. Never build a receive loop or poll; `read --as <you>` is the manual pull for recovery, `peek` glances without touching anything.
- **Tag every message** (`--tag GIT-SYNC`, `--tag OUT-221`) so threads stay scannable.
- **Close the loop, both ways.** Every question/finding you send is owed an ack + next step; announce when you finish ("PR #N up"); never go silent.
- **Heed send-time absence notes** (stderr): "never been seen on this bus" usually means a typo'd role or a member that isn't up — such a message queues silently forever.
- **Long content → attachment, not body.** A body is one short line leading with the tl;dr. `send --attach <file>` copies the file into your bus's git-ignored `attachments/` and appends the pointer for you. Attachments live **only** there — never in a project repo or the agent-bus repo root.
- **Agent-native I/O:** add `--json` to any read-side command (read/peek/log/who) for NDJSON. `who` lists everyone — senders *and* listeners (`●doorbell` = live idle-wake) + last activity. Lost context? Your SessionStart hook replays pending mail; `log --to <you>` replays *everything* ever sent to you, cursor-free. `log` marks each record `✓received` once it was injected into the addressee's context (or pulled via their `read`) — delivery to the model, *not* proof the agent acted on it.
- **Operator questions: a tool, never prose.** Route through **envoy** only if envoy is *visibly present* (check `who`). No envoy? Use your **own AskUserQuestion tool** directly. Never ask the operator in plain prose — it reaches no one.

## Git discipline

- **Never commit to `<main>`** (the project's default branch). Work in a worktree/branch off latest `origin/<main>`; open a PR; **lead alone merges**, then posts `[GIT-SYNC]`.
- **Prefer a worktree per agent** when agents run concurrently, and **put your role name in the branch name** (`builder-1/<topic>`) — commits usually share the operator's one git identity, so the branch name is the attribution. Run `init` inside your worktree (hooks are per-worktree, and worktrees share the project's one bus).
- After a `[GIT-SYNC]`, rebase your worktree onto latest `origin/<main>`.

## Web roles

A `web-*` role (another machine — a claude.ai session, a GitHub Action) can't reach the local bus; it rides the GitHub-issue transport (`agent-bus-web.mjs`) — no hooks there: its receiver is a polling `monitor` armed as a **persistent** watch, and all local-team contact routes through **lead**. Transport, trust boundary, and onboarding: [AGENTS.md §6](../../../AGENTS.md).
