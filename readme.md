# Agent Bus — how the team talks

A tiny file-based message bus so cooperating agents exchange messages and get **immediate, only-new** notifications. One script, five commands, no setup, no dependencies — Node builtins only. By default each **project gets its own isolated bus** (selected by the directory you run from), so two teams working in two repos never cross wires; cross-project coordination is an explicit **`--global`** opt-in. If your usage disagrees with this doc, the doc wins — fix your usage.

> 🤖 **Agents onboard from [AGENTS.md](AGENTS.md), not here.** That file is the self-contained
> operating manual — hand an agent `AGENTS.md` + a role ("you are `lead`") and it knows the rest.
> This README is the **human** explainer: what the bus is, how it resolves, and why.

## The one thing to know

Always run **this repo's** copy of the script — one script, never vendored — and run it
**from your own project's directory**. The script lives at a fixed path; your **current
directory** is what picks the bus:

```
node "o:/Redundant Local/agent-bus/agent-bus.mjs" <command>
```

- **Default — per-project, isolated.** Run from anywhere inside your project's git repo
  (or any of its worktrees) and you hit *that project's* bus: `agent-bus/bus/projects/<slug>/`.
  The `<slug>` is **worktree-stable** — a repo's main tree and every worktree resolve to the
  same bus, so a long-running `lead` monitor in the main tree and a `builder` in a worktree
  share one channel set.
- **Cross-project — `--global`.** Add `--global` (or set `$AGENT_BUS_GLOBAL=1`) to use the
  one shared bus (`agent-bus/bus/global/`) for coordinating across repos.
- **Explicit project — `$AGENT_BUS_PROJECT`.** Set the *same* name on every agent (e.g.
  `AGENT_BUS_PROJECT=ice-fragrances`) to pin them all to one bus regardless of how each one's
  path resolves — the bulletproof way to guarantee a team shares a bus.
- **Manual isolation — `$AGENT_BUS_DIR`.** Set it to any directory for a fully private bus
  (ultimate override; wins over everything).
- **Not in a git repo?** The script falls back to the global bus and prints a stderr warning.

The project `<slug>` is derived from the repo dir's **canonical** path (drive-letter case and
separators normalized), so the *same* repo always resolves to *one* bus even when different
agents' shells report its path differently (a real Windows footgun: `realpath` preserves
`process.cwd()`'s drive-letter case).

⚠️ **Don't `cd` into the agent-bus repo to run commands** — you'd resolve the *agent-bus
project's* bus instead of yours. Run from your project; invoke the script by its absolute path.

It's **forgiving**: the sender flag is `--from` **or** `--as` (either works); the message is a
**positional arg, `--body`, or stdin** (any works).

## Commands

| To… | Run |
|---|---|
| **send** a message | `… send --from me --to you [--tag TOPIC] "your message"` |
| **receive** (the important one) | `… monitor --as me` |
| read once, new only | `… read --as me` |
| look without consuming | `… peek --as me` |
| full history (debug) | `… log --from someone` |

(`send` and `post` are the same. `monitor`/`read`/`peek` take `--as me`. Any command accepts
`--global` to target the shared cross-project bus.)

## Receiving — run ONE monitor, forever

Each agent runs **exactly one** persistent monitor (via your Monitor tool), **from its
project dir**. It polls every ~2s and surfaces each **new** message, staying silent when
there's nothing new:

```
node "o:/Redundant Local/agent-bus/agent-bus.mjs" monitor --as <your-name>
```

That's the whole thing — no hand-rolled loops, no flags to get wrong. It owns your cursor (only-new, exactly-once, survives restarts/kills). Don't also `read --as you` in your work loop — you'd consume what the monitor should surface; use `peek` to glance without consuming.

## Running more than one project at once

This is the whole reason v2 exists. Two teams, two repos, same role names — on a single
shared bus they'd collide: a `lead` monitor in repo A and a `lead` monitor in repo B would
**split delivery** (shared per-reader cursor) and **race sequence numbers** (shared
`from-lead.jsonl`), with no way to tell whose message is whose.

The per-project default fixes this automatically:

- **Default = isolated.** Each repo's agents talk only to each other. `lead` in `zpoem` and
  `lead` in `agent-bus` are different channels in different bus dirs — zero collision. You
  don't have to do anything; just run from your project.
- **`--global` = cross-project.** When two projects genuinely need to coordinate (or one
  agent relays between them), use `--global` on both ends so everyone shares
  `agent-bus/bus/global/`. Pick distinct names if roles would otherwise clash.
- **`$AGENT_BUS_DIR` = manual.** For a one-off private bus unrelated to any repo.

The monitor/send `bus:` stderr line tells you which one you're on — if a message isn't
arriving, check both ends are on the same bus first.

## Sending long content — use an attachment

A bus message body is **one short line**. Anything longer — a report, an inventory,
a spec, a copy deck — will break shell quoting (you'll send an empty `-` body) and
should travel as an **attachment**, not a body. Write it to
`agent-bus/bus/attachments/<name>.md` (the `bus/` dir is already git-ignored, so
attachments stay local + uncommitted, exactly like the messages) and send a one-line
pointer that **leads with the tl;dr**:

```
… send --from me --to you --tag SPEC "spec ready: bus/attachments/migration-plan.md — tl;dr: rename-in-place via explicit SQL"
```

Attachments are a **shared scratch space** (one `bus/attachments/` for all buses) for
passing work between agents. Genuine project deliverables (CONTEXT docs, etc.) still go
into the relevant project repo via a PR — never leave them in `bus/attachments/`.

## How it works

One JSONL log per **sender** (`from-<id>.jsonl`) = single-writer, no append contention. A **persisted per-reader cursor** means you only ever see what's NEW (implicit acks; survives restarts/kills). **Point-to-point:** a message reaches a reader only if `to` is exactly their name — no broadcast.

The bus directory is runtime state and is **git-ignored** (the repo ships only the script +
this doc). Layout under `agent-bus/bus/`:

- `projects/<slug>/` — one isolated bus per project (the default). `<slug>` = sanitized repo
  dir name + a short hash of its **canonical** path (drive-case/separators normalized so the
  same repo always resolves to one bus); resolved from the git **common dir** so all of a
  repo's worktrees map to the same slug. `$AGENT_BUS_PROJECT` overrides the slug by name.
- `global/` — the shared cross-project bus (`--global` / `$AGENT_BUS_GLOBAL`).
- `attachments/` — shared scratch for long content (see above).

Only `from-*.jsonl` files are channels, so those sibling subdirs are never mistaken for one.

## Conventions

- **One recipient per message** — point-to-point, no broadcast. Loop over names to reach several. A message reaches a reader only if `--to` is exactly their name.
- **Pick a stable name** per agent for the whole session (`lead`, `deputy`, `builder-1`, …) and use it for both `--as` and as others' `--to`.
- **Tag** every message (`--tag OUT-221`, `[GIT-SYNC]`) so threads stay scannable.
- **Run from your project dir** so you're on the right bus; glance at the `bus:` line. Use `--global` only when coordinating across repos, and then on **both** ends.
- **Close the loop, both ways.** Send a question/finding → you're owed an ack + next step. Someone's report makes you act elsewhere → reply to them too. **Announce when you finish** ("PR #N up") — don't go silent.
- **Git — the lead is git-master.** Work in a worktree/branch, **never commit to main directly**; open a PR; the **lead reviews + merges**, then posts a `[GIT-SYNC]` (pull/FF) to whoever the merge affects. After a `[GIT-SYNC]`, sync your own worktree onto latest origin/main.

## Consuming this from another project

There is **one** script — don't vendor a copy into your repo (a second copy resolves its
own `bus/` next to itself, splitting your bus in two). Instead, each project just **points at
this repo**:

1. Drop a thin pointer in your project (e.g. `CONTEXT/agent-bus.md`) that links to
   this script + doc and names them canonical — no commands duplicated.
2. Invoke the absolute path directly **from your project dir**, or add a shell alias:
   `alias bus='node "o:/Redundant Local/agent-bus/agent-bus.mjs"'` → then `bus send …`.
   (The alias still resolves your project's bus because resolution is by **cwd**, not by where
   the script lives.)

Cross-project coordination → `--global` on every participant. A one-off private bus →
`$AGENT_BUS_DIR`.

## Roles — job definitions

The team is **dynamic**: the operator spins up any subset of these at any time, in any project. Don't assume all (or any specific one) are running. **If a role is running, this is its job + who directs it.**

- **lead** — the hub + git-master. Delegates all build/implementation work; reviews + merges every PR + posts GIT-SYNC; coordinates the team; surfaces decisions to the operator (directly, or async via envoy).
- **deputy** — the lead's right-hand / senior engineer. Takes the hardest engine/critical builds + reviews; may **also** delegate to builders.
- **design** — UX/vision owner; produces specs + copy; works directly with the lead. Does **not** dispatch builds — routes any implementation need through the lead.
- **builder** (×N) — receives delegated build work from **lead or deputy only** (not design). Worktree/branch → PR (lead merges). Does **not** self-claim lanes — surfaces options, lead/deputy assigns.
- **scout** — errand-runner for **anyone**: prod QA / validation, ground-truth lookups, post-deploy smokes.
- **scribe** — errand-runner for **anyone**: documentation (keeps reference/context docs current; owners hand it facts, it documents).
- **envoy** — the team's **async line to the operator** (the human). Any role routes a question to envoy; it relays via the AskUserQuestion tool and posts the answer back. A faithful relay (never answers/editorializes); shared by everyone; non-blocking — the team keeps working while it holds the question. **Always** reports every question + answer to the **lead** (not just the asker) — the operator's input is high-value lead context.
