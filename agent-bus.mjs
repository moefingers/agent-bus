#!/usr/bin/env node
// agent-bus — dead-simple append-only message bus for cooperating agents.
//
// FIVE commands. Forgiving on purpose:
//   • sender flag is --from OR --as (either works)
//   • the message body is a positional arg, --body, OR stdin (any works)
//
//   send    --from me --to you [--tag X] "your message"     (alias: post)
//   monitor --as me [--interval 2]   ← the ONE command to RECEIVE: polls, prints only NEW
//   read    --as me [--from who]        one-shot: print new + advance your cursor
//   peek    --as me                     look without advancing
//   log     --from who                  full history (debug)
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
// contention. A PERSISTED per-reader cursor means you only ever see what's NEW (implicit
// acks; survives restarts). Point-to-point: a message reaches a reader only if to === their
// name (no broadcast). No deps; node builtins only.

import { mkdirSync, readFileSync, appendFileSync, existsSync, writeFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, dirname, basename } from "node:path";
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
    if (a.startsWith("--")) {
      const k = a.slice(2);
      // --global is a pure boolean flag: it must never swallow a following
      // token (e.g. `send --to you --global "hi"` keeps "hi" as the body).
      if (k === "global") { o[k] = true; continue; }
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
        // Linked worktree: .git is a file "gitdir: <main>/.git/worktrees/<name>".
        // The common git dir is everything before "/worktrees/"; the main repo
        // root is its parent.
        const content = readFileSync(gitPath, "utf8");
        const m = content.match(/gitdir:\s*(.+)/);
        if (m) {
          const gitdir = m[1].trim().replace(/\\/g, "/");
          const wt = gitdir.indexOf("/worktrees/");
          const commonGitDir = wt !== -1 ? gitdir.slice(0, wt) : dirname(gitdir);
          return safeRealpath(dirname(commonGitDir));
        }
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // hit filesystem root, no repo
    dir = parent;
  }
}

// slug = sanitized basename + short hash of the realpath, so two repos with
// the same directory name still get distinct buses.
function projectSlug(repoRoot) {
  const real = safeRealpath(repoRoot);
  const base = basename(real).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const hash = createHash("sha1").update(real).digest("hex").slice(0, 6);
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

const bus = resolveBus(o);
const BUS = bus.dir;
mkdirSync(BUS, { recursive: true });

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
// Only `from-*.jsonl` files are channels — the projects/, global/ and
// attachments/ subdirs live under bus/ (a level up from any resolved BUS),
// so they can never be mistaken for a channel here.
const channels = () => readdirSync(BUS).filter((f) => f.startsWith("from-") && f.endsWith(".jsonl")).map((f) => f.slice(5, -6));
const fmt = (r) => `#${r.seq} ${r.ts} ${r.from}→${r.to}${r.tag ? " [" + r.tag + "]" : ""}\n${r.body}\n`;

// Print which bus we resolved (stderr — never pollutes stdout parsing) so a
// misrouted command is visible, not silent.
const announceBus = () => process.stderr.write(`bus: ${bus.label}\n`);

// Print messages new to `reader` (optionally only from `only`), advancing the cursor. Returns count.
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
  for (const r of out) process.stdout.write(fmt(r) + "\n");
  return out.length;
}

if (cmd === "send" || cmd === "post") {
  if (!sender || !val(o.to)) { console.error("send: need a sender (--from or --as) and --to"); process.exit(1); }
  let body = val(o.body) || (o._.length ? o._.join(" ") : "");
  if (!body) { try { body = readFileSync(0, "utf8").trim(); } catch { /* no stdin */ } }
  if (!body) { console.error("send: need a message (positional, --body, or stdin)"); process.exit(1); }
  announceBus();
  const rec = { seq: nextSeq(sender), ts: new Date().toISOString(), from: sender, to: o.to, tag: val(o.tag), body };
  appendFileSync(chanFile(sender), JSON.stringify(rec) + "\n");
  console.log(`sent #${rec.seq}  ${sender}→${o.to}`);
} else if (cmd === "monitor") {
  if (!reader) { console.error("monitor: need --as <your-name>"); process.exit(1); }
  announceBus();
  const ms = (Number(o.interval) > 0 ? Number(o.interval) : 2) * 1000;
  const only = val(o.from);
  drain(reader, only);                          // instant catch-up
  setInterval(() => drain(reader, only), ms);   // then poll; prints ONLY new, silent otherwise
} else if (cmd === "read") {
  if (!reader) { console.error("read: need --as <your-name>"); process.exit(1); }
  if (drain(reader, val(o.from)) === 0) console.log("(no new messages)");
} else if (cmd === "peek") {
  if (!reader) { console.error("peek: need --as <your-name>"); process.exit(1); }
  const froms = val(o.from) ? [val(o.from)] : channels().filter((c) => c !== reader);
  const out = [];
  for (const from of froms) { const cur = getCursor(reader, from); out.push(...readLog(from).filter((r) => r.to === reader && r.seq > cur)); }
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  if (!out.length) console.log("(no new messages)"); else out.forEach((r) => console.log(fmt(r)));
} else if (cmd === "log") {
  if (!val(o.from)) { console.error("log: need --from <who>"); process.exit(1); }
  readLog(o.from).forEach((r) => console.log(fmt(r)));
} else {
  console.error('usage: send --from me --to you "msg" | monitor --as me | read --as me | peek --as me | log --from who   [--global]');
  process.exit(1);
}
