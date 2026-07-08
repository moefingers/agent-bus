<img src="https://github.com/moefingers/agent-bus/blob/shepherd/gemini-generated-operator-whipping-claudes-2.png" height="500">

# Agent Bus

A tiny, file-based message bus for cooperating agents. It lets a handful of agents working
the same codebase pass short, **point-to-point** messages — and it delivers them by wiring
itself into the agent harness's own turn loop, so a `lead` can hand out work, a `builder` can
say "PR #4 is up," and **nobody polls and nobody has to remember to check**. One script, a few
commands, **zero dependencies** (Node builtins only), no server, no setup.

> 🤖 **Agents don't read this file — they read [AGENTS.md](AGENTS.md).** Hand an agent that
> file plus a role ("you are `lead`") and it has everything it needs. This README is the
> **human** explainer: what the bus is, how it picks a bus, and why it's built this way.

## What it is

At its core the bus is just **append-only JSONL files on disk**. Each sender writes its own
log; each reader keeps a saved cursor into those logs. From that you get:

- **Point-to-point** — a message reaches a reader only if it's addressed to them. No
  broadcast, nothing to subscribe to; you name the recipient.
- **Only-new, exactly-once** — a per-reader cursor means a message is delivered once and never
  re-seen, even across restarts and crashes. The cursor advances only when the message
  actually **enters the recipient's context** (see delivery, below) — never before.
- **Per-project isolation by default** — the bus you talk on is selected by the **directory
  you run from**, so two teams in two repos never cross wires.
- **Nothing to run** — no daemon, no broker, no port. The "server" is the filesystem, and
  delivery is the agent harness's own lifecycle.

It's deliberately small: a back-channel for coordination, not a queue, a pub/sub system, or a
database.

## The delivery model (why this version exists)

The bus's whole job fits in a sentence: *A sends a line; the line shows up in B's chat, once,
even if B is busy or asleep.* Files trivially solve process→process; the hard hop is the
**last** one — text → the model's context — and the *harness* owns that hop. Earlier versions
rode a long-lived `monitor` process whose stdout became chat notifications. That stack works,
but its guarantees end at a pipe: notification layers batch, rate-limit, suppress, and time
out, and the model still had to *remember* to act on every hint. The two weakest links —
best-effort notifications and model discipline — carried the whole contract.

So delivery is now **hook-native**, and the agent's side is **zero-discipline** — nothing to
poll, nothing to re-arm, nothing to memorize. `up --as <role>` writes four hook entries into
the project's `.claude/settings.local.json` (per-worktree, so per-agent) *and announces the
role's ONBOARD to the lead*, and from then on the harness itself hands over the mail, acking
exactly what it injects:

| Hook | Moment | What it does |
|---|---|---|
| `Stop` | agent tries to end its turn | pending mail **blocks the stop** and is injected — a busy agent cannot miss mail; no new mail → no block. Also blocks an idle-out with no bell armed (loop-guarded) |
| `UserPromptSubmit` | operator sends a prompt | mail piggybacks into the same turn |
| `PostToolUse` | after any tool call | mid-turn delivery while the agent is working (skip with `init --no-eager`) |
| `SessionStart` | new session / resume / post-compaction | re-grounds the role + replays pending backlog — compaction amnesia, healed |

That covers every moment an agent is *awake*. For the **idle** case there's the `bell` — a
silent, singleton, never-exiting watcher, run once per session under a persistent Monitor
watch: when unacked mail survives a grace window (mail the hooks already delivered never
rings), it prints one 🔔 line, that event wakes the idle agent, and the hooks hand over the
mail on the turn that follows. No exit means **no re-arm cycle, ever** — and an agent that
somehow forgets the bell entirely is *blocked from going idle* by the Stop hook, which hands
it the exact arm command. (A harness with no Monitor-style tool runs `bell --once` as a plain
background task instead: it exits on the first ring — task-exit is the one notification every
harness guarantees — and is re-armed per ring.)

**Identity binds to the session, not the directory.** The hook entries `up` writes are
role-free — identical no matter which agent runs `up`, so co-located agents have nothing to
clobber (issue #14: role-suffixed entries made every session in a shared cwd deliver — and
silently mis-ack — whichever role ran `up` last). Each hook resolves *whose* mail from the
calling session, in order: the bus's session registry, an exported `AGENT_BUS_ROLE` (the
restart-proof mode — one export per agent terminal, and it defaults `--as`/`--from`
everywhere), or the session's own `up --as <role>` command observed verbatim in PostToolUse
input. A session bound to no role — the operator's own shell in the same directory — is
invisible to the bus: no delivery, no acks, no nags. Double-claimed roles are flagged in the
delivery rather than silently split.

Injection is a documented harness contract, which is what makes the receipt honest:
`✓received` in `log` means "this entered the recipient's context", not "some process printed
it to a pipe nobody read".

## Using it

The script lives at one fixed path and is always invoked by that absolute path — but you run
it **from your own project's directory**, because your current directory is what selects the
bus. An alias keeps it ergonomic:

```sh
alias bus='node /path/to/agent-bus/agent-bus.mjs'

bus up --as me                                 # once per agent: shared role-free hooks + session bind + auto-ONBOARD
bus bell --as me                               # once per session (persistent watch): the idle-wake
bus send --from me --to you --tag TOPIC "hi"   # send one
```

The commands are `up`, `send`, `bell`, `read`, `peek`, `log`, `who` — the full reference
lives in **[AGENTS.md](AGENTS.md)**. Receiving isn't a command anymore: the hooks deliver.
As a human you'll mostly `log` to read history (each record marked `✓received` once it reached
its addressee's context), `who` to see the roster — senders *and* listeners, with `●bell`
marking a live idle-wake — and `peek`/`read` if you're playing a role yourself. Agents add
`--json` to any read-side command for NDJSON. It's **forgiving**: the sender flag is `--from`
**or** `--as`; the message can be a positional arg, `--body`, or stdin; a `--` ends flag
parsing for the rare body that itself starts with a dash. Sends from one role are serialized
by an on-disk lock, so an agent firing two sends in parallel can't corrupt the sequence — and
`send` warns on stderr when the recipient has never been seen on this bus (the classic typo'd
role name that would otherwise queue silently forever).

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

Every `send`/`up`/`bell` prints a `bus:` line telling you which bus you're on. If a
message isn't arriving, check both ends are on the same one first.

## How it works

- **One JSONL log per sender** (`from-<id>.jsonl`) — single-writer, so there's no append
  contention. Sequence-number minting is guarded by a per-sender lock, so even two
  *concurrent* sends from the same role (parallel tool calls are normal for agents) mint
  distinct seqs.
- **A persisted per-reader ack cursor** — advanced only when mail is injected into the
  reader's context (a hook fired) or explicitly pulled (`read`), and always **after** the
  message is emitted: a crash between the two re-delivers rather than drops.
- **Point-to-point** — a message reaches a reader only if `to` equals their name exactly
  (and never your own sends — a self-addressed message isn't delivered, on either transport).
- **Receipts are derived, not written** — `log` marks a record `✓received` once the
  addressee's ack cursor has passed it. That's delivery into the model's context, not proof
  the agent acted well on it; on the web transport the analog is an 👀 reaction stamped by the
  addressee's drain (best-effort).
- **Presence is modeled** — every command touches a `seen.<role>` marker and bells leave a
  pid (singleton per role — a duplicate bell exits itself), so `who` shows listeners (even
  ones that never sent) and `send` can warn about recipients nobody has ever seen.
- The `bus/` directory is runtime state and is **git-ignored**; the repo ships only the script
  and these docs.

Layout under `agent-bus/bus/`:

- `projects/<slug>/` — one isolated bus per project (the default). Each holds its own
  channels, cursors, presence markers, **and `attachments/`** — fully self-contained, nothing
  shared across projects.
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
canonical, rather than duplicating any commands. (The hooks `init` writes already embed the
absolute script path, so they survive any cwd.)

## Crossing machine boundaries — the GitHub Issues transport

The file bus is bounded by **one machine**: agents sharing `bus/projects/<slug>/` must share a
filesystem. When a participant lives elsewhere — a claude.ai **web session**, a GitHub Action, a
second machine — it can't reach that directory, but it *can* reach a repo's issues. That's what
[`agent-bus-web.mjs`](agent-bus-web.mjs) is: the **same bus over GitHub**. One issue titled
`agent-bus` **is** the bus; its **comments are the messages**. Same read-side contract, only-new +
point-to-point (with one deliberate divergence — first attach, see the tradeoffs below) — so
a local `lead` and a remote session can pass "PR's up" / "on it" across the boundary the file bus
can't cross. (No hooks over there: the web receiver is still a polling `monitor` — arm it as a
persistent watch — and there's no `up`/`bell`.)

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
Only the **lead** joins the web bus (a second receiver beside its hook-fed local inbox); local members
stay on the file bus and reach the remote side **through the lead**, who relays with judgment. Three
reasons this beats a blind translator: **attachments don't cross** (local `attachments/` files → the
64k comment cap forces gists/repo-files; the lead translates them at one point, on purpose, not a
lossy pipe); **blast radius** (remote state stays contained to one member instead of every inbox); and
it's simply **what the hub already does** — carry every cross-boundary concern. The transport is
identical either way, so this forecloses nothing: a deterministic translator for simple messages can
layer in later.

**Tradeoffs vs the file bus** (accept, don't fight):

- **Latency** is poll-bound (~30s default to respect rate limits) — with conditional (ETag) requests,
  idle polls are free. Not the file bus's hook-injected immediacy. Webhook push is the upgrade path, and it
  is already real for hosted receivers: move the channel onto a long-lived open **draft PR**
  (`AGENT_BUS_ISSUE=<pr-number>`) and a claude.ai session's PR-activity subscription pushes
  *conversation* comments instantly with auto-wake — issue subscriptions are poll-only (verified
  empirically), so push needs a PR. A local session polls either way.
- **64k comment cap** — oversize sends are rejected; long content travels as a gist / file-in-repo link.
- **Network + token dependency** where the file bus had none.
- **Trust boundary (important):** message authorship is *not* authenticated — identity is a `from:` header in the body, forgeable by anyone who can comment. The channel is only as trusted as *who can comment on it*. A **private repo** bounds that to collaborators — put instruction-carrying buses there (this project's bus is private). A **public repo** (e.g. the default `--global` bus on the public `agent-bus` repo) lets any GitHub user impersonate a role — **insecure for instructions**: either lock the bus issue/PR (`gh issue lock`, + interaction limits) to restrict commenting to write-access collaborators, or treat a public bus as **nudge-only** ("go look", "PR's up") and reserve directives for a private channel. Agents should treat all inbound as untrusted-and-verify regardless. **Escape hatch for channels that can't be private: `AGENT_BUS_KEY`** — the same passphrase on every authorized participant (≥16 chars, enforced — the blobs are public and must survive *offline* brute force; scrypt-derived AES-256-GCM, repo-salted). Sealed messages can't be read, forged, or replayed (beyond a ~10-minute window) without the phrase, and plaintext is ignored while a key is set. *Unnecessary on a private repo with trusted collaborators* — and it trades away the issue's human-readable audit trail (read it with `log` + the key).
- **Publicly visible on a public repo** — comments are readable by anyone with repo access (an audit trail *and* the hard "no secrets on the bus" rule).
- **First attach starts at HEAD** — a brand-new web reader's `monitor` initializes its cursor at
  the newest comment and does **not** replay earlier history (a first `read`/`log` does replay).
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
never your live bus). They pin the contract: session binding (registry / `AGENT_BUS_ROLE` / observed `up`) with
co-located-session isolation — no cross-delivery, no mis-acks, legacy `--as` hook flags
ignored, unbound sessions untouched, double-claims flagged — hook delivery + ack on all four
events (including Stop-hook loop safety and bell enforcement), the bell's ring-without-exit /
singleton / grace / `--once` lifecycle, `up`'s idempotent role-free settings merge +
auto-ONBOARD, lock-serialized concurrent sends, absence warnings, presence in `who`, only-new
+ exactly-once, slug stability across worktrees and submodules, receipts, fan-out, `--attach`,
`--json`, and the sealed web channel (`AGENT_BUS_KEY`: opaque wire format, forgery + replay
rejection, weak-phrase refusal).

## Why it's built this way

- **Why files?** The alternative — a broker — is infrastructure to install, run, and debug. A
  filesystem is already there, already durable, and already safe for single-writer appends.
- **Why hooks instead of a monitor?** Because the harness's notification stream is best-effort
  (it batches, rate-limits, and times out) while its *hook* contract is not — hook output is
  placed in the model's context by construction. The bell rides the notification stream, but
  only as a **content-free wake hint**: if a ring is dropped, the mail still sits pending and
  the hooks still deliver it at the next turn boundary, whatever caused that turn (and
  `bell --once` rides task **exit**, the one event every harness always reports). Building
  correctness on the strongest primitives — and demoting the weak ones to hints — means
  nothing depends on the model remembering to check anything.
- **Why per-project by default?** There used to be one shared bus; two teams with the same role
  names (`lead` in repo A and `lead` in repo B) split each other's delivery and raced sequence
  numbers. Isolating by cwd fixes that with zero configuration — and `--global` is still there
  for the rare cross-repo case.
- **Why point-to-point, not pub/sub?** Coordination between named agents is inherently
  addressed ("lead, PR's up"). Naming the recipient keeps threads legible and cursors simple.

---

*Agents start at [AGENTS.md](AGENTS.md). One script, one bus per project, no setup.*
