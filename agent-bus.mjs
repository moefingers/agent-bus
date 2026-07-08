#!/usr/bin/env node
// agent-bus — dead-simple append-only message bus for cooperating agents.
//
// THE SENTENCE: A sends a line; the line shows up in B's chat, once, even if
// B is busy or asleep.
//
// The hard hop was never process→process (files solve that); it's the LAST
// hop, text→model-context — and the agent harness owns that hop. So delivery
// is HOOK-NATIVE, and the agent's side is ZERO-DISCIPLINE: nothing to poll,
// nothing to re-arm, nothing to remember. Every requirement is automated,
// injected, or enforced at a turn boundary:
//
//   Stop hook             agent finishes a turn → pending mail blocks the stop
//                         and is injected + acked. A busy agent CANNOT miss mail.
//                         (Self-terminating: injected mail is acked, so the next
//                         stop passes.) Also enforces the bell: an agent can't
//                         go idle unarmed — the block carries the exact command.
//   UserPromptSubmit hook operator talks to the agent → mail piggybacks in.
//   PostToolUse hook      mid-turn delivery after any tool call (near-realtime
//                         while the agent is working).
//   SessionStart hook     new session / resume / post-compaction → role banner +
//                         backlog re-injected. Compaction amnesia, healed.
//   bell (command)        the idle case: a silent, singleton, never-exiting
//                         watcher. Run it under a persistent Monitor-style
//                         watch: when unacked mail survives a grace window it
//                         prints ONE 🔔 line — that event wakes the idle agent,
//                         and the hooks hand over the mail. No exit → no
//                         re-arm cycle, ever. (Harness without a Monitor tool?
//                         `bell --once` as a plain background task exits on the
//                         first ring — task-exit is the wake; re-arm after.)
//
// One durable watermark per (reader, sender): cursor.<as>.from-<sender>, the
// ACK cursor. It advances only when mail is actually injected into context
// (hooks) or explicitly pulled (`read`) — always AFTER emitting, so a crash
// re-delivers rather than drops. Receipts (`log` ✓received) therefore mean
// "entered the addressee's context", not "some process printed it". The bell
// never acks and never delivers — it only wakes.
//
// COMMANDS (forgiving: sender is --from OR --as; body is positional, --body,
// or stdin; `--` ends flag parsing; --json on read-side commands → NDJSON):
//   up       --as me [--no-eager]      onboard THIS agent in THIS project, one
//                                      shot: writes the four hooks into
//                                      .claude/settings.local.json AND announces
//                                      your ONBOARD to lead (lead skips the
//                                      announce — the hub receives them).
//                                      (`init` is an alias.)
//   send     --from me --to you[,them] [--tag X] [--attach FILE] "msg"
//                                      fan-out via commas; sends from one role
//                                      are lock-serialized (parallel-safe seqs);
//                                      warns when the recipient looks absent
//   bell     --as me [--once] [--interval 2] [--grace 15]
//                                      the idle-wake (see above). Singleton per
//                                      role — a duplicate exits itself.
//   read     --as me [--from who]      manual pull: print pending + ack. The
//                                      recovery path — hooks make it optional.
//   peek     --as me                   look, touch nothing
//   log      [--from who] [--to who]   full history, cursor-free; ✓received =
//                                      acked into the addressee's context
//   who                                roster: senders + listeners (●bell =
//                                      live idle-wake), last activity
//   hook-stop|hook-prompt|hook-posttool|hook-session --as me
//                                      internal: invoked by the harness hooks
//                                      that `up` writes. Not for humans.
//
// BUS RESOLUTION (per-project by default):
//   1. $AGENT_BUS_DIR set        → use it verbatim (ultimate manual override)
//   2. --global / $AGENT_BUS_GLOBAL → the shared cross-project bus  (bus/global/)
//   3. $AGENT_BUS_PROJECT=<name> → that named bus (path-independent pin)
//   4. default                   → THIS project's isolated bus (bus/projects/<slug>/)
//   5. cwd not in a git repo     → fall back to global + warn on stderr
// The project <slug> is worktree-STABLE (keyed off the git common dir), so a
// repo's main tree and all its worktrees share ONE bus. Run every command from
// YOUR project dir — cwd selects the bus.
//
// How it works: one JSONL log per SENDER (from-<id>.jsonl) = single-writer, no
// append contention; a per-sender on-disk lock serializes seq minting, so even
// concurrent sends from one role (parallel tool calls) can't mint duplicates.
// Point-to-point: a message reaches a reader only if to === their name (no
// broadcast; never your own sends). Presence: every command touches
// seen.<role>, and bells leave a pid — `who` and send-time warnings read
// them. No deps; node builtins only.

import { mkdirSync, readFileSync, appendFileSync, existsSync, writeFileSync, readdirSync, statSync, realpathSync, copyFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const BUS_ROOT = join(SCRIPT_DIR, "bus");

const val = (x) => (x && x !== true ? x : null);
const truthy = (v) => v != null && v !== "" && v !== "0" && String(v).toLowerCase() !== "false";

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // A bare `--` ends flag parsing: everything after it is positional, so a
    // body that itself starts with "--" can still be sent.
    if (a === "--") { o._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      // Pure boolean flags must never swallow a following token
      // (e.g. `send --to you --global "hi"` keeps the body).
      if (k === "global" || k === "json" || k === "no-eager" || k === "once") { o[k] = true; continue; }
      o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else o._.push(a);
  }
  return o;
}

// realpath that degrades to the raw path if the target can't be resolved
// (keeps slugs deterministic even on odd filesystems).
function safeRealpath(p) {
  try { return realpathSync(p); } catch { return p; }
}

// Find the MAIN repo root for `startDir`, resolving linked worktrees back to
// their common repo so the slug is identical across a repo's main tree and
// every worktree. Pure-Node (no `git` spawn) for speed + portability.
function findRepoRoot(startDir) {
  let dir = safeRealpath(startDir);
  for (;;) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      let st;
      try { st = statSync(gitPath); } catch { st = null; }
      if (st && st.isDirectory()) {
        // Normal checkout: the working tree containing .git IS the root.
        return dir;
      }
      if (st && st.isFile()) {
        // A .git FILE = a working tree whose real git dir lives elsewhere.
        //   Linked worktree ("gitdir: <main>/.git/worktrees/<name>"): resolve back
        //   to the MAIN repo root so every worktree shares that repo's one bus.
        //   Anything else (a submodule's ".git/modules/<name>", --separate-git-dir):
        //   THIS dir is its own working tree — its own repo, its own bus.
        // gitdir may be RELATIVE (submodules are written that way), so resolve it
        // against the directory holding the .git file — NEVER the process cwd,
        // which would mint a different slug per cwd and split the bus.
        const content = readFileSync(gitPath, "utf8");
        const m = content.match(/gitdir:\s*(.+)/);
        if (m) {
          const gitdir = resolve(dir, m[1].trim()).replace(/\\/g, "/");
          const wt = gitdir.indexOf("/worktrees/");
          if (wt !== -1) return safeRealpath(dirname(gitdir.slice(0, wt)));
        }
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // hit filesystem root, no repo
    dir = parent;
  }
}

// CANONICAL key for a path. realpathSync on Windows preserves the drive-letter
// CASE of process.cwd() (and separator direction can vary), so the SAME repo
// produced different strings — and thus different slugs/buses — for different
// agents, silently splitting a team. Normalize before hashing: unify
// separators, drop the \\?\ long-path prefix, strip trailing slashes, and
// lowercase on Windows (its filesystem is case-insensitive). This is THE fix
// for "same repo, two buses".
function canonicalKey(p) {
  let s = safeRealpath(p).replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/+$/, "");
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

// slug = sanitized basename + short hash of the CANONICAL path, so two repos
// with the same directory name still get distinct buses, while the SAME repo
// always resolves to one bus no matter how its path was expressed.
function projectSlug(repoRoot) {
  const key = canonicalKey(repoRoot);
  const base = basename(key).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 6);
  return `${base}-${hash}`;
}

// Resolve which bus dir to use + a short human label for the stderr notice.
function resolveBus(args) {
  if (process.env.AGENT_BUS_DIR) {
    return { dir: process.env.AGENT_BUS_DIR, label: `dir=${process.env.AGENT_BUS_DIR}` };
  }
  if (args.global === true || truthy(process.env.AGENT_BUS_GLOBAL)) {
    return { dir: join(BUS_ROOT, "global"), label: "global" };
  }
  // Explicit, path-independent pin. Every agent that sets the SAME
  // AGENT_BUS_PROJECT shares a bus no matter where/how the repo is mounted —
  // the bulletproof override when path resolution can't be trusted.
  if (truthy(process.env.AGENT_BUS_PROJECT)) {
    const name = String(process.env.AGENT_BUS_PROJECT).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
    return { dir: join(BUS_ROOT, "projects", name), label: `project=${name}` };
  }
  const root = findRepoRoot(process.cwd());
  if (!root) {
    process.stderr.write(`agent-bus: no git project at ${process.cwd()}, using global bus\n`);
    return { dir: join(BUS_ROOT, "global"), label: "global" };
  }
  const slug = projectSlug(root);
  return { dir: join(BUS_ROOT, "projects", slug), label: `project=${slug}` };
}

const [cmd, ...rest] = process.argv.slice(2);
const o = parseArgs(rest);
const sender = val(o.from) || val(o.as);
const reader = val(o.as) || val(o.from);
const JSON_OUT = o.json === true;

const bus = resolveBus(o);
const BUS = bus.dir;
mkdirSync(BUS, { recursive: true });
// Long-content scratch lives in THIS bus's own subdir, so every project's bus
// is fully self-contained: channels + cursors + attachments under one folder.
mkdirSync(join(BUS, "attachments"), { recursive: true });

const chanFile = (from) => join(BUS, `from-${from}.jsonl`);
const cursorFile = (as, from) => join(BUS, `cursor.${as}.from-${from}`);

function readLog(from) {
  const f = chanFile(from);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const nextSeq = (from) => { const l = readLog(from); return l.length ? l[l.length - 1].seq + 1 : 1; };
const getCursor = (as, from) => (existsSync(cursorFile(as, from)) ? Number(readFileSync(cursorFile(as, from), "utf8").trim()) || 0 : 0);
const setCursor = (as, from, seq) => writeFileSync(cursorFile(as, from), String(seq));
// Only `from-*.jsonl` files are channels — cursors, seen-markers, bell pids,
// locks, and this bus's `attachments/` subdir never match the filter.
const channels = () => readdirSync(BUS).filter((f) => f.startsWith("from-") && f.endsWith(".jsonl")).map((f) => f.slice(5, -6));
const fmt = (r, mark = "") => `#${r.seq} ${r.ts} ${r.from}→${r.to}${r.tag ? " [" + r.tag + "]" : ""}${mark}\n${r.body}\n`;
// One record per stdout line-group: NDJSON with --json (what agents should
// parse), the human format otherwise. `mark` is a human-only status suffix.
const emit = (r, mark = "") => process.stdout.write(JSON_OUT ? JSON.stringify(r) + "\n" : fmt(r, mark) + "\n");

// Print which bus we resolved (stderr — never pollutes stdout parsing) so a
// misrouted command is visible, not silent. Hooks skip it: their stdout/stderr
// is a delivery channel, and they must stay fast and quiet.
const announceBus = () => process.stderr.write(`bus: ${bus.label}\n`);

// ── presence ──────────────────────────────────────────────────────────────────
// Every command touches seen.<role>; bells additionally leave a pid.
// `who` and send-time absence warnings read these. Heuristic freshness — a
// signal for judgment, not a lease.
const seenFile = (who) => join(BUS, `seen.${who}`);
const touchSeen = (who) => { if (who) try { writeFileSync(seenFile(who), new Date().toISOString()); } catch { /* bus dir mid-sweep */ } };
const lastSeenIso = (who) => { try { return statSync(seenFile(who)).mtime.toISOString(); } catch { return null; } };
const pidFile = (who) => join(BUS, `bell.${who}.pid`);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const bellPid = (who) => { try { return Number(readFileSync(pidFile(who), "utf8").trim()) || 0; } catch { return 0; } };
// pid 0 would signal the whole process GROUP (always "alive") — guard it.
const bellAlive = (who) => { const p = bellPid(who); return p > 0 && pidAlive(p); };
const STALE_NOTE_MS = 300_000; // absence note when no bell + quiet this long

// ── send serialization ────────────────────────────────────────────────────────
// nextSeq is read-modify-write; two CONCURRENT sends from one role (parallel
// tool calls are normal for agents) could mint the same seq and a drain could
// then drop one. A per-sender mkdir lock (atomic everywhere) closes it.
function withSendLock(name, fn) {
  const lock = join(BUS, `.lock-send-${name}`);
  const deadline = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { rmdirSync(lock); continue; } } catch { /* raced the owner */ }
      if (Date.now() > deadline) { console.error(`send: gave up waiting for ${lock}`); process.exit(1); }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch { /* already gone */ } }
}

// ── delivery core ─────────────────────────────────────────────────────────────
// Everything addressed to `reader` beyond its ack cursor. Pure read.
function pending(reader, only) {
  const froms = only ? [only] : channels().filter((c) => c !== reader);
  const out = [];
  for (const from of froms) {
    const cur = getCursor(reader, from);
    out.push(...readLog(from).filter((r) => r.to === reader && r.seq > cur));
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  return out;
}
// Ack AFTER emitting (deliver-then-ack): a crash between the two re-delivers
// next time instead of losing mail. At-least-once, never at-most-once.
function ack(reader, msgs) {
  const tops = new Map();
  for (const r of msgs) tops.set(r.from, Math.max(tops.get(r.from) ?? 0, r.seq));
  for (const [f, s] of tops) if (s > getCursor(reader, f)) setCursor(reader, f, s);
}
// Mint + append one record under the sender's lock. Shared by `send` and the
// auto-ONBOARD in `up`.
function postMessage(from, to, tag, body) {
  return withSendLock(from, () => {
    const rec = { seq: nextSeq(from), ts: new Date().toISOString(), from, to, tag: tag || null, body };
    appendFileSync(chanFile(from), JSON.stringify(rec) + "\n");
    return rec;
  });
}

// ── hook plumbing ─────────────────────────────────────────────────────────────
const MAX_INJECT = 25; // per injection; the rest stays pending → next hook fires again
function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const t = readFileSync(0, "utf8");
    return t.trim() ? JSON.parse(t) : {};
  } catch { return {}; }
}
const armBell = (role) => `node "${SCRIPT_PATH}" bell --as ${role}`;
const armHint = (role) => `Arm it via your Monitor tool (persistent: true, session-length): ${armBell(role)}   — no Monitor tool? plain background task: ${armBell(role)} --once (exits on the first ring; re-arm after).`;
function deliveryText(role, msgs, left) {
  const lines = msgs.map((r) => fmt(r).trimEnd()).join("\n");
  const senders = [...new Set(msgs.map((r) => r.from))];
  const reply = senders.length === 1
    ? `node "${SCRIPT_PATH}" send --from ${role} --to ${senders[0]} --tag ${msgs[msgs.length - 1].tag || "RE"} "<one line>"`
    : `node "${SCRIPT_PATH}" send --from ${role} --to <sender> --tag <TAG> "<one line>"`;
  const more = left > 0 ? `\n[agent-bus] +${left} more still pending — they arrive on your next turn boundary (or pull now: node "${SCRIPT_PATH}" read --as ${role}).` : "";
  return `[agent-bus] ${msgs.length} new message(s) for '${role}':\n${lines}${more}\n[agent-bus] Delivered + acked. Close the loop per AGENTS.md: ${reply}`;
}
// Deliver-and-ack for a hook. Injection is a harness contract (block-reason /
// added context ARE placed in the model's context), so acking here is honest.
function hookDrain(role) {
  const all = pending(role, null);
  const msgs = all.slice(0, MAX_INJECT);
  if (msgs.length) { ack(role, msgs); }
  touchSeen(role);
  return { msgs, left: all.length - msgs.length };
}

const HOOK_EVENTS = { "hook-stop": "Stop", "hook-prompt": "UserPromptSubmit", "hook-posttool": "PostToolUse", "hook-session": "SessionStart" };

if (cmd === "send" || cmd === "post") {
  // --to a,b,c fans out one point-to-point record per recipient — there is
  // still no broadcast, just less typing for the GIT-SYNC-style multicasts.
  const recipients = [...new Set(String(val(o.to) || "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!sender || !recipients.length) { console.error("send: need a sender (--from or --as) and --to"); process.exit(1); }
  let body = val(o.body) || (o._.length ? o._.join(" ") : "");
  if (!body) { try { body = readFileSync(0, "utf8").trim(); } catch { /* no stdin */ } }
  // --attach FILE: copy into THIS bus's own attachments/ and append the
  // pointer, so long content rides the documented convention with zero manual
  // path work (and never lands outside the git-ignored bus home).
  if (val(o.attach)) {
    const src = val(o.attach);
    if (!existsSync(src)) { console.error(`send: --attach ${src}: no such file`); process.exit(1); }
    const base = basename(src);
    let dest = join(BUS, "attachments", base);
    for (let n = 2; existsSync(dest); n++) dest = join(BUS, "attachments", base.replace(/(\.[^.]*)?$/, `-${n}$1`));
    copyFileSync(src, dest);
    process.stderr.write(`attached: ${dest}\n`);
    body = body ? `${body} — attachment: ${dest}` : `attachment: ${dest}`;
  }
  if (!body) { console.error("send: need a message (positional, --body, stdin, or --attach)"); process.exit(1); }
  announceBus();
  touchSeen(sender);
  // Absence warnings: a message to a role nobody has ever seen queues silently
  // forever — the #1 team coordination failure. Say so at send time.
  for (const to of recipients) {
    const seen = lastSeenIso(to);
    if (!seen && !existsSync(chanFile(to))) {
      process.stderr.write(`send: note — '${to}' has never been seen on this bus. Queued; if you expected them online, run \`who\` and check both ends show the same bus: line.\n`);
    } else if (!bellAlive(to) && (!seen || Date.now() - Date.parse(seen) > STALE_NOTE_MS)) {
      process.stderr.write(`send: note — '${to}' has no live bell and was last seen ${seen || "never"}. They'll get this on their next turn; if they should wake NOW, ask the operator to nudge them.\n`);
    }
  }
  for (const to of recipients) {
    const rec = postMessage(sender, to, val(o.tag), body);
    console.log(JSON_OUT ? JSON.stringify({ sent: rec.seq, from: sender, to }) : `sent #${rec.seq}  ${sender}→${to}`);
  }
} else if (cmd === "up" || cmd === "init") {
  // Onboard THIS agent in THIS project, one shot: bake role + script path into
  // .claude/settings.local.json hooks (per-worktree = per-agent, git-ignored
  // by Claude Code convention) AND announce the ONBOARD. Idempotent: re-running
  // replaces our entries, never touches anyone else's.
  const role = reader;
  if (!role || !/^[a-z0-9][a-z0-9_-]*$/i.test(role)) { console.error("up: need --as <role> ([a-z0-9-_] only)"); process.exit(1); }
  const root = findRepoRoot(process.cwd()) || process.cwd();
  if (root === process.cwd() && !existsSync(join(root, ".git"))) {
    process.stderr.write("up: warning — not in a git repo; hooks land in ./.claude and the bus is global\n");
  }
  const settingsPath = join(root, ".claude", "settings.local.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* absent or invalid → start fresh */ }
  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const ours = (c) => typeof c === "string" && c.includes(basename(SCRIPT_PATH)) && c.includes(" hook-");
  const events = Object.entries(HOOK_EVENTS).filter(([k]) => k !== "hook-posttool" || o["no-eager"] !== true);
  for (const evt of new Set(Object.values(HOOK_EVENTS))) {
    // strip any previous agent-bus entries (old role, old path) from every event
    settings.hooks[evt] = (settings.hooks[evt] || [])
      .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !ours(h.command)) }))
      .filter((m) => (m.hooks || []).length);
  }
  for (const [hookCmd, evt] of events) {
    (settings.hooks[evt] = settings.hooks[evt] || []).push({ hooks: [{ type: "command", command: `node "${SCRIPT_PATH}" ${hookCmd} --as ${role}` }] });
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  announceBus();
  touchSeen(role);
  console.log(`up: '${role}' wired into ${settingsPath}`);
  console.log(`  hooks: ${events.map(([, e]) => e).join(", ")} — mail is injected + acked at your turn boundaries; you never poll.`);
  console.log(`  NOTE: hooks load at session start — if this session predates this command, restart/resume once.`);
  if (role !== "lead") {
    const rec = postMessage(role, "lead", "ONBOARD", `online — ${role}, ready`);
    console.log(`  announced: ONBOARD #${rec.seq} → lead. Wait for your lane; don't self-claim work.`);
  } else {
    console.log(`  you are the hub: others' ONBOARDs arrive hook-injected; assign each a lane.`);
  }
  console.log(`  ONE step left — arm your idle-wake bell via your Monitor tool (persistent: true):`);
  console.log(`      ${armBell(role)}`);
  console.log(`  (no Monitor tool? background task fallback: ${armBell(role)} --once — re-arm after each ring. Forgot entirely? The Stop hook won't let you idle out unarmed.)`);
} else if (cmd === "bell") {
  // The idle-wake, zero-maintenance: singleton per role, never exits. Run it
  // under a persistent Monitor watch — when unacked mail SURVIVES the grace
  // window (mail the hooks deliver mid-turn never rings), it prints ONE 🔔
  // line per mail-batch: that event wakes an idle agent; the hooks deliver.
  // It never acks. --once exits after the first ring instead (task-exit wake
  // for harnesses without a Monitor tool; re-arm after each ring).
  if (!reader) { console.error("bell: need --as <your-name>"); process.exit(1); }
  const other = bellPid(reader);
  if (other && other !== process.pid && pidAlive(other)) {
    process.stderr.write(`bell: already ringing for '${reader}' (pid ${other}) — duplicate exits\n`);
    process.exit(0);
  }
  announceBus();
  const intervalMs = (Number(o.interval) > 0 ? Number(o.interval) : 2) * 1000;
  const graceMs = (Number(o.grace) >= 0 ? Number(o.grace) : 15) * 1000;
  const REMIND_MS = 10 * 60_000; // re-ring long-ignored pending mail, gently
  writeFileSync(pidFile(reader), String(process.pid));
  process.on("exit", () => { try { unlinkSync(pidFile(reader)); } catch { /* gone with the bus */ } });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rung = new Map(); // from → highest seq already rung for
  let lastRing = 0;
  const unrung = (msgs) => msgs.some((r) => r.seq > (rung.get(r.from) ?? 0));
  for (;;) {
    let msgs = [];
    try { touchSeen(reader); msgs = pending(reader, null); }
    catch (e) { process.stderr.write(`agent-bus: poll error (continuing): ${e.message}\n`); }
    if (msgs.length && (unrung(msgs) || Date.now() - lastRing > REMIND_MS)) {
      await sleep(graceMs); // hooks may deliver mid-turn mail before we wake anyone
      let still = [];
      try { still = pending(reader, null); } catch { /* transient */ }
      if (still.length && (unrung(still) || Date.now() - lastRing > REMIND_MS)) {
        console.log(`🔔 agent-bus: ${still.length} message(s) pending for '${reader}' — delivered at your next turn boundary. Idle? Pull now: node "${SCRIPT_PATH}" read --as ${reader}`);
        lastRing = Date.now();
        for (const r of still) rung.set(r.from, Math.max(rung.get(r.from) ?? 0, r.seq));
        if (o.once === true) process.exit(0);
      }
    }
    await sleep(intervalMs);
  }
} else if (cmd in HOOK_EVENTS) {
  // Internal: the harness invokes these (up wired them). Fast, quiet, and
  // every byte of stdout is a delivery channel — no banners here.
  if (!reader) { console.error(`${cmd}: missing --as <role> (re-run up)`); process.exit(1); }
  const input = readStdinJson();
  const { msgs, left } = hookDrain(reader);
  if (cmd === "hook-stop") {
    const nag = bellAlive(reader) ? "" : `\n[agent-bus] Your bell is not armed — while idle you will not wake for new mail. ${armHint(reader)}`;
    if (msgs.length) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: deliveryText(reader, msgs, left) + nag }));
    } else if (nag && input.stop_hook_active !== true) {
      // Enforce, don't trust: an agent can't idle out receiverless by
      // accident. Nag exactly once per stop cycle (stop_hook_active guards
      // the loop, so a blocked harness can still come to rest).
      process.stdout.write(JSON.stringify({ decision: "block", reason: nag.trim() }));
    }
  } else if (cmd === "hook-prompt" || cmd === "hook-session") {
    // stdout on exit 0 is added to context for both events.
    if (cmd === "hook-session") {
      const bell = bellAlive(reader) ? "bell armed" : `bell NOT armed — ${armHint(reader)}`;
      process.stdout.write(`[agent-bus] You are '${reader}' on this project's bus (${bus.label}); ${bell} Mail is hook-delivered — you never poll.\n`);
    }
    if (msgs.length) process.stdout.write(deliveryText(reader, msgs, left) + "\n");
  } else if (cmd === "hook-posttool") {
    if (msgs.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: deliveryText(reader, msgs, left) } }));
  }
} else if (cmd === "read") {
  if (!reader) { console.error("read: need --as <your-name>"); process.exit(1); }
  touchSeen(reader);
  const msgs = pending(reader, val(o.from));
  for (const r of msgs) emit(r);
  ack(reader, msgs);
  if (!msgs.length && !JSON_OUT) console.log("(no new messages)");
} else if (cmd === "peek") {
  if (!reader) { console.error("peek: need --as <your-name>"); process.exit(1); }
  touchSeen(reader);
  const out = pending(reader, val(o.from));
  if (!out.length) { if (!JSON_OUT) console.log("(no new messages)"); } else out.forEach((r) => emit(r));
} else if (cmd === "log") {
  // Cursor-free audit view — debug AND recovery (`log --to me` = everything
  // ever addressed to me, e.g. to re-ground after context loss). Receipts are
  // DERIVED live from the addressee's ack cursor: ✓received means the record
  // was injected into their context (hook) or pulled (`read`) — delivery to
  // the MODEL, still not proof it acted well. No state is written here.
  const fromF = val(o.from), toF = val(o.to);
  const recs = (fromF ? [fromF] : channels()).flatMap((c) => readLog(c))
    .filter((r) => !toF || r.to === toF)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  for (const r of recs) {
    const received = getCursor(r.to, r.from) >= r.seq;
    emit({ ...r, received }, received ? " ✓received" : " ·pending");
  }
} else if (cmd === "who") {
  // Roster: everyone who ever SENT (channel files) ∪ everyone ever SEEN
  // (presence markers — so listeners who haven't spoken are visible too).
  // ●bell = live idle-wake right now; lastSeen = last bus activity.
  announceBus();
  const seenRoles = readdirSync(BUS).filter((f) => f.startsWith("seen.")).map((f) => f.slice(5));
  const rows = [...new Set([...channels(), ...seenRoles])].map((name) => {
    const l = readLog(name);
    const last = l[l.length - 1];
    return {
      name, sent: l.length, lastSeq: last ? last.seq : 0, lastTs: last ? last.ts : null,
      lastSeen: lastSeenIso(name), bell: bellAlive(name),
    };
  }).sort((a, b) => String(b.lastSeen || b.lastTs).localeCompare(String(a.lastSeen || a.lastTs)));
  if (!rows.length) { if (!JSON_OUT) console.log("(nobody here yet)"); }
  else rows.forEach((r) => console.log(JSON_OUT ? JSON.stringify(r)
    : `${r.name}  ×${r.sent}  last #${r.lastSeq} ${r.lastTs || "—"}${r.bell ? "  ●bell" : r.lastSeen ? `  seen ${r.lastSeen}` : ""}`));
} else if (cmd === "monitor") {
  console.error([
    "monitor was retired: delivery is hook-native now — mail is injected at your turn boundaries, nothing to watch.",
    `onboard:   node "${SCRIPT_PATH}" up --as <your-role>      (hooks + ONBOARD; restart/resume session once)`,
    `idle-wake: ${armBell("<your-role>")}    (persistent Monitor watch; or --once as a background task)`,
    `manual:    node "${SCRIPT_PATH}" read --as <your-role>    (pull + ack, for recovery)`,
    "(the web transport, agent-bus-web.mjs, keeps its monitor — different machine, different rules)",
  ].join("\n"));
  process.exit(1);
} else if (cmd === "doorbell") {
  console.error([
    "doorbell grew into bell — same idea, zero re-arm cycles:",
    `  persistent Monitor watch:  ${armBell("<your-role>")}          (never exits; rings a line per wake)`,
    `  background-task fallback:  ${armBell("<your-role>")} --once   (exits on the first ring; re-arm after)`,
  ].join("\n"));
  process.exit(1);
} else {
  console.error('usage: up --as me [--no-eager] | send --from me --to you[,them] [--attach FILE] "msg" | bell --as me [--once] | read --as me | peek --as me | log [--from who] [--to me] | who   [--global] [--json]');
  process.exit(1);
}
