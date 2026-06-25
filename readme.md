# Agent Bus — how the team talks

A tiny file-based message bus so cooperating agents exchange messages and get **immediate, only-new** notifications. One script, five commands, no setup, no dependencies — Node builtins only. It is **project-agnostic**: any repo in the workspace shares the same bus. If your usage disagrees with this doc, the doc wins — fix your usage.

## Joining the team — do this first

If you were handed this doc and a **role** (`lead`, `deputy`, `builder-1`, `design`,
`scout`, `scribe`, `envoy`), onboard yourself:

1. Start your **single** persistent receiver via your Monitor tool — exactly one, forever
   (see [Receiving](#receiving--run-one-monitor-forever)):
   `node "o:/Redundant Local/agent-bus/agent-bus.mjs" monitor --as <your-role>`
2. Announce yourself to the lead:
   `node "o:/Redundant Local/agent-bus/agent-bus.mjs" send --from <your-role> --to lead --tag ONBOARD "online — <your-role>, ready"`
3. Work by the [Conventions](#conventions) and your [Role](#roles--job-definitions): point-to-point,
   tag every message, close the loop both ways, and **never commit to main** — the lead is git-master.

Then wait for the lead to assign you a lane. That's onboarding.

## The one thing to know

Always run **this repo's** copy of the script (it finds the shared bus next to itself — `agent-bus/bus/` — so every agent across every project, even agents in worktrees, hits the one shared bus via this same absolute path):

```
node "o:/Redundant Local/agent-bus/agent-bus.mjs" <command>
```

No env vars needed. It's **forgiving**: the sender flag is `--from` **or** `--as` (either works); the message is a **positional arg, `--body`, or stdin** (any works). (Override the bus location with `$AGENT_BUS_DIR` only if you want a private/isolated bus.)

## Commands

| To… | Run |
|---|---|
| **send** a message | `… send --from me --to you [--tag TOPIC] "your message"` |
| **receive** (the important one) | `… monitor --as me` |
| read once, new only | `… read --as me` |
| look without consuming | `… peek --as me` |
| full history (debug) | `… log --from someone` |

(`send` and `post` are the same. `monitor`/`read`/`peek` take `--as me`.)

## Receiving — run ONE monitor, forever

Each agent runs **exactly one** persistent monitor (via your Monitor tool). It polls every ~2s and surfaces each **new** message, staying silent when there's nothing new:

```
node "o:/Redundant Local/agent-bus/agent-bus.mjs" monitor --as <your-name>
```

That's the whole thing — no hand-rolled loops, no flags to get wrong. It owns your cursor (only-new, exactly-once, survives restarts/kills). Don't also `read --as you` in your work loop — you'd consume what the monitor should surface; use `peek` to glance without consuming.

## How it works

One JSONL log per **sender** (`from-<id>.jsonl`) = single-writer, no append contention. A **persisted per-reader cursor** means you only ever see what's NEW (implicit acks; survives restarts/kills). **Point-to-point:** a message reaches a reader only if `to` is exactly their name — no broadcast. The bus directory (`agent-bus/bus/`) is runtime state and is git-ignored; the repo ships only the script + this doc.

## Conventions

- **One recipient per message** — point-to-point, no broadcast. Loop over names to reach several. A message reaches a reader only if `--to` is exactly their name.
- **Pick a stable name** per agent for the whole session (`lead`, `deputy`, `builder-1`, …) and use it for both `--as` and as others' `--to`.
- **Tag** every message (`--tag OUT-221`, `[GIT-SYNC]`) so threads stay scannable.
- **Close the loop, both ways.** Send a question/finding → you're owed an ack + next step. Someone's report makes you act elsewhere → reply to them too. **Announce when you finish** ("PR #N up") — don't go silent.
- **Git — the lead is git-master.** Work in a worktree/branch, **never commit to main directly**; open a PR; the **lead reviews + merges**, then posts a `[GIT-SYNC]` (pull/FF) to whoever the merge affects. After a `[GIT-SYNC]`, sync your own worktree onto latest origin/main.

## Consuming this from another project

There is **one** bus and **one** script — don't vendor a copy into your repo (a
second copy resolves `./bus` to a *different* directory and silently splits the
bus in two). Instead, each project just **points at this repo**:

1. Drop a thin pointer in your project (e.g. `CONTEXT/agent-bus.md`) that links to
   this script + doc and names them canonical — no commands duplicated.
2. Invoke the absolute path directly, or add a shell alias for ergonomics:
   `alias bus='node "o:/Redundant Local/agent-bus/agent-bus.mjs"'` → then `bus send …`.

Only want a private, isolated bus for one workspace? Don't fork the script — set
`$AGENT_BUS_DIR` to a directory of your choice and that process group gets its own bus.

## Roles — job definitions

The team is **dynamic**: the operator spins up any subset of these at any time, in any project. Don't assume all (or any specific one) are running. **If a role is running, this is its job + who directs it.**

- **lead** — the hub + git-master. Delegates all build/implementation work; reviews + merges every PR + posts GIT-SYNC; coordinates the team; surfaces decisions to the operator (directly, or async via envoy).
- **deputy** — the lead's right-hand / senior engineer. Takes the hardest engine/critical builds + reviews; may **also** delegate to builders.
- **design** — UX/vision owner; produces specs + copy; works directly with the lead. Does **not** dispatch builds — routes any implementation need through the lead.
- **builder** (×N) — receives delegated build work from **lead or deputy only** (not design). Worktree/branch → PR (lead merges). Does **not** self-claim lanes — surfaces options, lead/deputy assigns.
- **scout** — errand-runner for **anyone**: prod QA / validation, ground-truth lookups, post-deploy smokes.
- **scribe** — errand-runner for **anyone**: documentation (keeps reference/context docs current; owners hand it facts, it documents).
- **envoy** — the team's **async line to the operator** (the human). Any role routes a question to envoy; it relays via the AskUserQuestion tool and posts the answer back. A faithful relay (never answers/editorializes); shared by everyone; non-blocking — the team keeps working while it holds the question. **Always** reports every question + answer to the **lead** (not just the asker) — the operator's input is high-value lead context.
