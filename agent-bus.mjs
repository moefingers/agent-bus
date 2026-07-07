#!/usr/bin/env node
// agent-bus — dead-simple append-only message bus for cooperating agents.
//
// SEVEN commands. Forgiving on purpose:
//   • sender flag is --from OR --as (either works)
//   • the message body is a positional arg, --body, OR stdin (any works)
//   • `--` ends flag parsing — use it (or stdin) when the body starts with "--"
//   • --json on any read-side command (monitor/read/peek/log/who) emits NDJSON
//     records instead of the human format — agents should prefer it
//
//   send    --from me --to you[,them] [--tag X] [--attach FILE] "msg"  (alias: post)
//           --to a,b,c fans out one point-to-point message per recipient;
//           --attach copies FILE into this bus's attachments/ + appends the pointer
//   monitor --as me [--interval 2]   ← the ONE command to RECEIVE: polls, SURFACES only NEW.
//                                       NEVER advances your cursor — so an orphaned monitor
//                                       (agent session died) can't silently eat your queue;
//                                       you `ack` what you've acted on.
//   read    --as me [--from who]        one-shot: print new + advance your cursor (a manual ack)
//   ack     --as me [--upto N]          mark "processed up to here" — advance your cursor WITHOUT
//                                       printing. Run it after acting on what your monitor surfaced.
//   peek    --as me                     look without advancing
//   log     [--from who] [--to who]     full history, cursor-free — debug AND recovery:
//                                       `log --to me` replays everything ever sent to me.
//                                       Each record carries a receipt: ✓received once the
//                                       addressee has ACKED past it (via ack/read) — the monitor
//                                       only surfaces, so this now reflects agent progress.
//   who                                 roster: every sender ever seen + last activity
//
// BUS RESOLUTION (v2 — per-project by default):
//   1. $AGENT_BUS_DIR set        → use it verbatim (ultimate manual override)
//   2. --global / $AGENT_BUS_GLOBAL → the shared cross-project bus  (bus/global/)
//   3. default                   → THIS project's isolated bus      (bus/projects/<slug>/)
//   4. cwd not in a git repo     → fall back to global + warn on stderr
// The project <slug> is worktree-STABLE: a repo's main tree and all its
// worktrees resolve to the same bus (keyed off the git common dir), so
// `lead` in project A never collides with `lead` in project B.
// Run the script from YOUR project dir — cwd selects the bus.
//
// How it works: one JSONL log per SENDER (from-<id>.jsonl) = single-writer, no append
// contention. (Single-writer = one send AT A TIME per role: two concurrent sends from the
// same role can mint duplicate seqs, and a drain landing between them can drop the second.
// Sequential sends — the normal case — are always safe.) A PERSISTED per-reader cursor is
// your ACK FLOOR — advanced by `ack`/`read`, NOT by the monitor (which only surfaces), so a
// dead session's orphaned monitor can't advance it and silently drop your queue; survives
// restarts. Point-to-point: a message
// reaches a reader only if to === their name (no broadcast, and never your own sends — a
// self-addressed message is not delivered). No deps; node builtins only.

import { mkdirSync, readFileSync, appendFileSync, existsSync, writeFileSync, readdirSync, statSync, realpathSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
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
      // --global and --json are pure boolean flags: they must never swallow a
      // following token (e.g. `send --to you --global "hi"` keeps the body).
      if (k === "global" || k === "json") { o[k] = true; continue; }
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
// Only `from-*.jsonl` files are channels — this bus's `attachments/` subdir
// never matches the `from-*.jsonl` filter, so it's safely ignored here.
const channels = () => readdirSync(BUS).filter((f) => f.startsWith("from-") && f.endsWith(".jsonl")).map((f) => f.slice(5, -6));
const fmt = (r, mark = "") => `#${r.seq} ${r.ts} ${r.from}→${r.to}${r.tag ? " [" + r.tag + "]" : ""}${mark}\n${r.body}\n`;
// One record per stdout line-group: NDJSON with --json (what agents should
// parse), the human format otherwise. `mark` is a human-only status suffix.
const emit = (r, mark = "") => process.stdout.write(JSON_OUT ? JSON.stringify(r) + "\n" : fmt(r, mark) + "\n");

// Print which bus we resolved (stderr — never pollutes stdout parsing) so a
// misrouted command is visible, not silent.
const announceBus = () => process.stderr.write(`bus: ${bus.label}\n`);

// DRAIN (read-path): print messages new to `reader` AND advance the persistent
// cursor — a one-shot manual consume/ack. Used by `read`, NOT by the monitor.
function drain(reader, only) {
  const froms = only ? [only] : channels().filter((c) => c !== reader);
  const out = [];
  for (const from of froms) {
    const cur = getCursor(reader, from);
    const unread = readLog(from).filter((r) => r.to === reader && r.seq > cur);
    out.push(...unread);
    if (unread.length) setCursor(reader, from, unread[unread.length - 1].seq);
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  for (const r of out) emit(r);
  return out.length;
}

// SURFACE (monitor-path): print messages new to `reader` using an IN-MEMORY
// high-water-mark, WITHOUT ever touching the persistent cursor. THE fix for the
// orphaned-monitor silent-drain: a monitor whose agent session has died keeps
// polling but can no longer CONSUME the queue — it can't advance the cursor, so
// it can't swallow work into a void that `peek` then reports as "no new". The
// cursor moves only on an explicit `ack`/`read`, so a revived agent's fresh
// monitor re-surfaces everything since the last ack (at-worst REPLAY, never the
// silent LOSS we hit). `mem` is this process's per-channel HWM; the effective
// position is max(what I've surfaced, the ack floor) so an external ack can't
// cause a re-surface. Returns count.
function surface(reader, only, mem) {
  const froms = only ? [only] : channels().filter((c) => c !== reader);
  const out = [];
  for (const from of froms) {
    const log = readLog(from);
    const maxSeq = log.length ? log[log.length - 1].seq : 0;
    // Seqs only climb in normal operation. If our in-memory HWM is AHEAD of the
    // channel's current max, the channel was wiped/reset out from under us (the
    // transient bus-dir sweep case) — our HWM survived the wipe but is now
    // stale, so drop it and re-surface from the ack floor. Never strand a
    // post-wipe message behind a phantom HWM.
    if (mem[from] != null && mem[from] > maxSeq) delete mem[from];
    const pos = Math.max(mem[from] ?? 0, getCursor(reader, from));
    const fresh = log.filter((r) => r.to === reader && r.seq > pos);
    if (fresh.length) {
      out.push(...fresh);
      mem[from] = fresh[fresh.length - 1].seq;
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  for (const r of out) emit(r);
  return out.length;
}

// Liveness probe for a pid: signal 0 sends nothing but throws if the process is
// gone (ESRCH). EPERM = alive but not ours. Used by the single-monitor lock.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

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
  for (const to of recipients) {
    const rec = { seq: nextSeq(sender), ts: new Date().toISOString(), from: sender, to, tag: val(o.tag), body };
    appendFileSync(chanFile(sender), JSON.stringify(rec) + "\n");
    console.log(JSON_OUT ? JSON.stringify({ sent: rec.seq, from: sender, to }) : `sent #${rec.seq}  ${sender}→${to}`);
  }
} else if (cmd === "monitor") {
  if (!reader) { console.error("monitor: need --as <your-name>"); process.exit(1); }
  announceBus();
  // SINGLE-MONITOR LOCK — one live monitor per role. A relaunch REPLACES a stale
  // monitor (kills it) instead of stacking an orphan that zombie-drains the bus
  // (the exact failure this targets). Best-effort + self-cleaning on exit.
  const pidPath = join(BUS, `monitor.${reader}.pid`);
  if (existsSync(pidPath)) {
    const oldPid = Number(readFileSync(pidPath, "utf8").trim());
    if (oldPid && oldPid !== process.pid && pidAlive(oldPid)) {
      try { process.kill(oldPid); process.stderr.write(`agent-bus: replaced a stale ${reader} monitor (pid ${oldPid})\n`); }
      catch { /* already gone between the check and the kill */ }
    }
  }
  writeFileSync(pidPath, String(process.pid));
  const releasePid = () => { try { if (existsSync(pidPath) && Number(readFileSync(pidPath, "utf8").trim()) === process.pid) unlinkSync(pidPath); } catch { /* best-effort */ } };
  process.on("exit", releasePid);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { releasePid(); process.exit(0); });

  const ms = (Number(o.interval) > 0 ? Number(o.interval) : 2) * 1000;
  const only = val(o.from);
  const mem = {};                               // per-channel HWM — in-memory ONLY, never persisted
  surface(reader, only, mem);                   // instant catch-up = everything since your last ack
  setInterval(() => {                           // then poll; SURFACES only new, silent otherwise
    // The monitor is the ONE persistent receiver — a transient error (bus dir
    // swept mid-session, a permissions blip) must not kill it. Same
    // catch-and-continue as the web transport's poll.
    try { surface(reader, only, mem); }
    catch (e) { process.stderr.write(`agent-bus: poll error (continuing): ${e.message}\n`); }
  }, ms);
} else if (cmd === "read") {
  if (!reader) { console.error("read: need --as <your-name>"); process.exit(1); }
  if (drain(reader, val(o.from)) === 0 && !JSON_OUT) console.log("(no new messages)");
} else if (cmd === "ack") {
  // Advance your persistent cursor = "I have PROCESSED everything up to here."
  // Because the monitor now only SURFACES (never advances the cursor), THIS is
  // what makes `✓received` mean acknowledged, bounds re-surfacing on a monitor
  // restart, and records real progress. `--upto N` acks a specific seq; the
  // default acks to the latest message addressed to you on each channel. Run it
  // after you've acted on what your monitor surfaced.
  if (!reader) { console.error("ack: need --as <your-name>"); process.exit(1); }
  const only = val(o.from);
  const upto = val(o.upto) != null ? Number(val(o.upto)) : null;
  const froms = only ? [only] : channels().filter((c) => c !== reader);
  let acked = 0;
  for (const from of froms) {
    const mine = readLog(from).filter((r) => r.to === reader);
    if (!mine.length) continue;
    const latest = mine[mine.length - 1].seq;
    const target = upto != null ? Math.min(upto, latest) : latest;
    const cur = getCursor(reader, from);
    if (target > cur) { acked += mine.filter((r) => r.seq > cur && r.seq <= target).length; setCursor(reader, from, target); }
  }
  if (!JSON_OUT) console.log(`acked ${acked} message(s) for ${reader}`);
  else console.log(JSON.stringify({ acked, reader }));
} else if (cmd === "peek") {
  if (!reader) { console.error("peek: need --as <your-name>"); process.exit(1); }
  const froms = val(o.from) ? [val(o.from)] : channels().filter((c) => c !== reader);
  const out = [];
  for (const from of froms) { const cur = getCursor(reader, from); out.push(...readLog(from).filter((r) => r.to === reader && r.seq > cur)); }
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  if (!out.length) { if (!JSON_OUT) console.log("(no new messages)"); } else out.forEach((r) => emit(r));
} else if (cmd === "log") {
  // Cursor-free audit view — debug AND recovery (`log --to me` = everything
  // ever addressed to me, e.g. to re-ground after context loss). Receipts are
  // DERIVED live from the addressee's cursor: ✓received now means the agent
  // ACKNOWLEDGED past this record (via ack/read) — the monitor only SURFACES,
  // it no longer advances the cursor, so this reflects agent progress, not
  // merely that a poller drained. No state is written; single-writer intact.
  const fromF = val(o.from), toF = val(o.to);
  const recs = (fromF ? [fromF] : channels()).flatMap((c) => readLog(c))
    .filter((r) => !toF || r.to === toF)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  for (const r of recs) {
    const received = getCursor(r.to, r.from) >= r.seq;
    emit({ ...r, received }, received ? " ✓received" : " ·pending");
  }
} else if (cmd === "who") {
  // Roster: everyone who has ever SENT on this bus + last activity. Because
  // every role announces ONBOARD on arrival, presence here ≈ membership; a
  // stale lastTs is the lead's staleness/liveness glance.
  announceBus();
  const rows = channels().map((name) => {
    const l = readLog(name);
    const last = l[l.length - 1];
    return { name, sent: l.length, lastSeq: last ? last.seq : 0, lastTs: last ? last.ts : null };
  }).sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
  if (!rows.length) { if (!JSON_OUT) console.log("(no senders yet)"); }
  else rows.forEach((r) => console.log(JSON_OUT ? JSON.stringify(r) : `${r.name}  ×${r.sent}  last #${r.lastSeq} ${r.lastTs}`));
} else {
  console.error('usage: send --from me --to you[,them] [--attach FILE] "msg" | monitor --as me | read --as me | ack --as me [--upto N] | peek --as me | log [--from who] [--to me] | who   [--global] [--json]');
  process.exit(1);
}
