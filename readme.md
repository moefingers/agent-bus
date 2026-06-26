# Agent Bus

A tiny, file-based message bus for cooperating agents. It lets a handful of agents working
the same codebase pass short, **point-to-point** messages and get **immediate, only-new**
notifications — so a `lead` can hand out work, a `builder` can say "PR #4 is up," and nobody
has to poll. One script, a few commands, **zero dependencies** (Node builtins only), no
server, no setup.

> 🤖 **Agents don't read this file — they read [AGENTS.md](AGENTS.md).** Hand an agent that
> file plus a role ("you are `lead`") and it has everything it needs. This README is the
> **human** explainer: what the bus is, how it picks a bus, and why it's built this way.

## What it is

At its core the bus is just **append-only JSONL files on disk**. Each sender writes its own
log; each reader keeps a saved cursor into those logs. From that you get:

- **Point-to-point** — a message reaches a reader only if it's addressed to them. No
  broadcast, nothing to subscribe to; you name the recipient.
- **Only-new, exactly-once** — a per-reader cursor means you see each message once and never
  re-see it, even after a restart or crash. Reading is an implicit ack.
- **Per-project isolation by default** — the bus you talk on is selected by the **directory
  you run from**, so two teams in two repos never cross wires.
- **Nothing to run** — no daemon, no broker, no port. The "server" is the filesystem.

It's deliberately small: a back-channel for coordination, not a queue, a pub/sub system, or a
database.

## Using it

The script lives at one fixed path and is always invoked by that absolute path — but you run
it **from your own project's directory**, because your current directory is what selects the
bus. An alias keeps it ergonomic:

```sh
alias bus='node /path/to/agent-bus/agent-bus.mjs'

bus monitor --as me                            # watch for messages addressed to you
bus send --from me --to you --tag TOPIC "hi"   # send one
```

Five commands exist — `send`, `monitor`, `read`, `peek`, `log` — and the full reference lives
in **[AGENTS.md](AGENTS.md)**. As a human you'll mostly `monitor` to watch a channel and `log`
to read history. It's **forgiving**: the sender flag is `--from` **or** `--as`; the message
can be a positional arg, `--body`, or stdin.

## How a bus is chosen

Every bus is a directory under `agent-bus/bus/`. Which one you hit is resolved like this, each
row overriding the one above it:

| You want… | Do this | Bus used |
|---|---|---|
| **Per-project (default)** | just run from inside your repo | `bus/projects/<slug>/` |
| **Cross-project coordination** | add `--global` (on *every* participant) | `bus/global/` |
| **A team pinned by name** | set `AGENT_BUS_PROJECT=<name>` on every agent | that named bus |
| **A private, one-off bus** | set `AGENT_BUS_DIR=<dir>` | that dir (wins over all) |

The project `<slug>` is derived from the repo's **canonical** path (drive-letter case and
separators normalized) and resolved from the git common dir — so a repo's main tree and all
its worktrees always map to the **same** bus, and the same repo never accidentally splits into
two buses because two shells reported its path differently (a real Windows footgun). Not in a
git repo? It falls back to the global bus and warns.

> ⚠️ Don't `cd` into the agent-bus repo to run commands — you'd land on the *agent-bus
> project's* own bus instead of yours. Run from your project; the script's location is fixed,
> the bus follows your cwd.

Every `send`/`monitor` prints a `bus:` line telling you which bus you're on. If a message
isn't arriving, check both ends are on the same one first.

## How it works

- **One JSONL log per sender** (`from-<id>.jsonl`) — single-writer, so there's no append
  contention.
- **A persisted per-reader cursor** — that's what makes delivery only-new and exactly-once
  across restarts and kills.
- **Point-to-point** — a message reaches a reader only if `to` equals their name exactly.
- The `bus/` directory is runtime state and is **git-ignored**; the repo ships only the script
  and these docs.

Layout under `agent-bus/bus/`:

- `projects/<slug>/` — one isolated bus per project (the default).
- `global/` — the shared cross-project bus (`--global` / `$AGENT_BUS_GLOBAL`).
- `attachments/` — shared scratch for long content (see below).

## Long content goes in an attachment

A bus message body is **one short line**. Anything longer — a spec, a report, an inventory —
would break shell quoting and should travel as a file: write it to
`agent-bus/bus/attachments/<name>.md` and send a one-line pointer that leads with the tl;dr.
Genuine deliverables still land in their own project repo via a PR; attachments are just
scratch for passing work between agents.

## Pointing a project at the bus

Don't **vendor** a copy of the script into another repo — a second copy resolves its own
`bus/` next to itself and silently splits your bus in two. Instead, point every project at the
*one* script: invoke it by absolute path (the `bus` alias above), and optionally drop a thin
pointer doc in the project (e.g. `CONTEXT/agent-bus.md`) that names this script + AGENTS.md as
canonical, rather than duplicating any commands.

## The team model

The bus assumes a small, **dynamic** team — the operator spins up any subset of these roles,
in any project, at any time. The **lead** is the hub and the only one who merges; everyone
else opens PRs. In brief:

- **lead** — hub + git-master: delegates work, reviews and merges every PR, posts
  `[GIT-SYNC]`, carries decisions to the operator.
- **deputy** — senior engineer: takes the hardest builds + reviews; may also delegate to
  builders.
- **builder** (×N) — takes one delegated lane → worktree → PR; never self-claims or merges.
- **design** — owns UX/vision; produces specs + copy; routes builds through the lead.
- **scout** — shared errand-runner for QA, validation, and ground-truth lookups.
- **scribe** — shared errand-runner for documentation.
- **envoy** — faithful async relay between the team and the operator (the human).

The authoritative, operational version — who directs whom, the exact git discipline — lives in
**[AGENTS.md](AGENTS.md)**, and each role also ships a ready-to-load skill under
[`.claude/skills/`](.claude/skills/).

## Why it's built this way

- **Why files?** The alternative — a broker — is infrastructure to install, run, and debug. A
  filesystem is already there, already durable, and already safe for single-writer appends.
- **Why per-project by default?** There used to be one shared bus; two teams with the same role
  names (`lead` in repo A and `lead` in repo B) split each other's delivery and raced sequence
  numbers. Isolating by cwd fixes that with zero configuration — and `--global` is still there
  for the rare cross-repo case.
- **Why point-to-point, not pub/sub?** Coordination between named agents is inherently
  addressed ("lead, PR's up"). Naming the recipient keeps threads legible and cursors simple.

---

*Agents start at [AGENTS.md](AGENTS.md). One script, one bus per project, no setup.*
