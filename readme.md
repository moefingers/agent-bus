<img src="https://github.com/moefingers/agent-bus/blob/shepherd/gemini-generated-operator-whipping-claudes.png" height="500">

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

Six commands exist — `send`, `monitor`, `read`, `peek`, `log`, `who` — and the full reference
lives in **[AGENTS.md](AGENTS.md)**. As a human you'll mostly `monitor` to watch a channel,
`log` to read history (each record marked `✓received` once its addressee's reader has drained
it), and `who` to see the roster. Agents add `--json` to any read-side command for NDJSON.
It's **forgiving**: the sender flag is `--from` **or** `--as`; the message can be a positional
arg, `--body`, or stdin; a `--` ends flag parsing for the rare body that itself starts with a
dash.

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
  contention. Single-writer also means **one send at a time per role**: two *concurrent* sends
  from the same role can mint the same `seq`, and a read landing between them can drop the
  second — sequential sends (the normal case) are always safe.
- **A persisted per-reader cursor** — that's what makes delivery only-new and exactly-once
  across restarts and kills.
- **Point-to-point** — a message reaches a reader only if `to` equals their name exactly
  (and never your own sends — a self-addressed message isn't delivered, on either transport).
- **Receipts are derived, not written** — `log` marks a record `✓received` once the
  addressee's cursor has passed it, i.e. their own monitor/read consumed it. That's
  program-level delivery, not proof the agent acted; on the web transport the analog is an
  👀 reaction stamped by the addressee's drain (best-effort).
- The `bus/` directory is runtime state and is **git-ignored**; the repo ships only the script
  and these docs.

Layout under `agent-bus/bus/`:

- `projects/<slug>/` — one isolated bus per project (the default). Each holds its own
  channels, cursors, **and `attachments/`** — fully self-contained, nothing shared across projects.
- `global/` — the shared cross-project bus (`--global` / `$AGENT_BUS_GLOBAL`), with its own `attachments/`.

## Long content goes in an attachment

A bus message body is **one short line**. Anything longer — a spec, a report, an inventory —
would break shell quoting and should travel as a file: write it to **your bus's own
`attachments/` subdir** — `agent-bus/bus/projects/<your-slug>/attachments/<name>.md` (the slug
from your `bus:` line) — and send a one-line pointer that leads with the tl;dr
(`send --attach <file>` does the copy and the pointer in one step). Genuine
deliverables still land in their own project repo via a PR; attachments are just scratch for
passing work between agents. They live **strictly** in the git-ignored bus homes
(`bus/projects/<slug>/attachments/`, or `bus/global/attachments/` for the global bus) — never at
the agent-bus repo root or inside a project repo.

## Pointing a project at the bus

Don't **vendor** a copy of the script into another repo — a second copy resolves its own
`bus/` next to itself and silently splits your bus in two. Instead, point every project at the
*one* script: invoke it by absolute path (the `bus` alias above), and optionally drop a thin
pointer doc in the project (e.g. `CONTEXT/agent-bus.md`) that names this script + AGENTS.md as
canonical, rather than duplicating any commands.

## Crossing machine boundaries — the GitHub Issues transport

The file bus is bounded by **one machine**: agents sharing `bus/projects/<slug>/` must share a
filesystem. When a participant lives elsewhere — a claude.ai **web session**, a GitHub Action, a
second machine — it can't reach that directory, but it *can* reach a repo's issues. That's what
[`agent-bus-web.mjs`](agent-bus-web.mjs) is: the **same bus over GitHub**. One issue titled
`agent-bus` **is** the bus; its **comments are the messages**. Same six commands, same only-new +
point-to-point contract (with one deliberate divergence — first attach, see the tradeoffs below) — so
a local `lead` and a remote session can pass "PR's up" / "on it" across the boundary the file bus
can't cross.

**Why an issue works as a bus.** GitHub serializes comment creation, so the file bus's per-sender
single-writer trick is unnecessary — every agent posts to the one issue, no contention. `seq` becomes
the **comment id** (monotonic — sort and cursor on it); the cursor stays **local** (last-seen id per
reader); and identity moves **into the comment body** — a `from:`/`to:`/`tag:` header above a `---`
separator — because agents may share one token, so the API's comment-author field can't be trusted. A
comment that doesn't parse as a header (a human typing in the issue) is simply skipped.

**Setup.** A token with issues access, resolved in order: `AGENT_BUS_GITHUB_TOKEN` (preferred — a bus-dedicated Issues-only PAT), else `GITHUB_TOKEN` (or `GH_TOKEN`), else `gh auth login`. The bus repo is your
cwd's `git origin` by default; `AGENT_BUS_REPO=owner/repo` is the manual override, and
`AGENT_BUS_ISSUE=<number>` (set on every participant) pins the channel to a specific issue — or open
PR, since PR comments are issue comments to the API — bypassing title discovery. (`--global` points at
the shared repo, default `moefingers/agent-bus`, and warns loudly: see the trust boundary below —
instruction-carrying buses belong on a private repo.) Local cursor + the cached bus-issue number live
under `bus-web/` (git-ignored, like `bus/`); if the bus issue is ever deleted or transferred, remove
`bus-web/<owner>__<repo>/issue` so the channel re-resolves. Zero dependencies — Node ≥18 builtins only.

**One bridge, by design.** You *could* have every local agent inject/read web messages — but don't.
Only the **lead** joins the web bus (a second monitor beside its local one); local members stay on the
file bus and reach the remote side **through the lead**, who relays with judgment. Three reasons this
beats a blind translator: **attachments don't cross** (local `attachments/` files → the 64k comment
cap forces gists/repo-files; the lead translates them at one point, on purpose, not a lossy pipe);
**blast radius** (remote state stays contained to one member instead of every inbox); and it's simply
**what the hub already does** — carry every cross-boundary concern. The transport is identical either
way, so this forecloses nothing: a deterministic translator for simple messages can layer in later.

**Tradeoffs vs the file bus** (accept, don't fight):

- **Latency** is poll-bound (~30s default to respect rate limits) — with conditional (ETag) requests,
  idle polls are free. Not the file bus's 2-second local poll. Webhook push is the upgrade path, and it
  is already real for hosted receivers: move the channel onto a long-lived open **draft PR**
  (`AGENT_BUS_ISSUE=<pr-number>`) and a claude.ai session's PR-activity subscription pushes
  *conversation* comments instantly with auto-wake — issue subscriptions are poll-only (verified
  empirically), so push needs a PR. A local session polls either way.
- **64k comment cap** — oversize sends are rejected; long content travels as a gist / file-in-repo link.
- **Network + token dependency** where the file bus had none.
- **Trust boundary (important):** message authorship is *not* authenticated — identity is a `from:` header in the body, forgeable by anyone who can comment. The channel is only as trusted as *who can comment on it*. A **private repo** bounds that to collaborators — put instruction-carrying buses there (this project's bus is private). A **public repo** (e.g. the default `--global` bus on the public `agent-bus` repo) lets any GitHub user impersonate a role — **insecure for instructions**: either lock the bus issue/PR (`gh issue lock`, + interaction limits) to restrict commenting to write-access collaborators, or treat a public bus as **nudge-only** ("go look", "PR's up") and reserve directives for a private channel. Agents should treat all inbound as untrusted-and-verify regardless.
- **Publicly visible on a public repo** — comments are readable by anyone with repo access (an audit trail *and* the hard "no secrets on the bus" rule).
- **First attach starts at HEAD** — the one contract divergence from the file bus: a brand-new
  reader's `monitor` initializes its cursor at the newest comment and does **not** replay earlier
  history (a first `read`/`log` does replay; a first *local-bus* monitor replays its whole backlog).
  So attach monitors *before* traffic you care about — in practice, the lead attaches before web
  roles announce, and a late attacher catches up with `read`.
- **Local cursor** — a fresh machine's `read` replays history (idempotent, so harmless). Durable
  cross-machine cursors are deliberately out of scope until they hurt.

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
[`.claude/skills/`](.claude/skills/) (each holds only the role's essence; the protocol they
share lives once in the [`bus` skill](.claude/skills/bus/SKILL.md)).

## Tests

`node test/local.mjs && node test/web.mjs` — zero-dep and network-free (the web suite runs
against a mocked GitHub API; both suites execute isolated copies of the scripts in a temp dir,
never your live bus). They pin the contract: only-new + exactly-once (including the
filtered-read watermark hold), slug stability across worktrees and submodules, monitor
crash-resilience, receipts, fan-out, `--attach`, and `--json`.

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
