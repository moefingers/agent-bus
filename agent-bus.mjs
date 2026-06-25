#!/usr/bin/env node
// agent-bus — dead-simple append-only message bus for cooperating agents.
//
// FIVE commands. Forgiving on purpose:
//   • sender flag is --from OR --as (either works)
//   • the message body is a positional arg, --body, OR stdin (any works)
//   • the bus dir auto-resolves next to THIS script — no env var needed
//     (override with $AGENT_BUS_DIR if you must)
//
//   send    --from me --to you [--tag X] "your message"     (alias: post)
//   monitor --as me [--interval 2]   ← the ONE command to RECEIVE: polls, prints only NEW
//   read    --as me [--from who]        one-shot: print new + advance your cursor
//   peek    --as me                     look without advancing
//   log     --from who                  full history (debug)
//
// How it works: one JSONL log per SENDER (from-<id>.jsonl) = single-writer, no append
// contention. A PERSISTED per-reader cursor means you only ever see what's NEW (implicit
// acks; survives restarts). Point-to-point: a message reaches a reader only if to === their
// name (no broadcast). No deps; node builtins only.

import { mkdirSync, readFileSync, appendFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The bus lives in ./bus, right next to this script. Run THIS repo's copy of the script
// from any project and every agent — even those in worktrees — hits the one shared bus.
// No $AGENT_BUS_DIR needed (override it only if you want a private/isolated bus).
const BUS = process.env.AGENT_BUS_DIR || join(dirname(fileURLToPath(import.meta.url)), "bus");
mkdirSync(BUS, { recursive: true });

const chanFile = (from) => join(BUS, `from-${from}.jsonl`);
const cursorFile = (as, from) => join(BUS, `cursor.${as}.from-${from}`);
const val = (x) => (x && x !== true ? x : null);

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else o._.push(a);
  }
  return o;
}
function readLog(from) {
  const f = chanFile(from);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const nextSeq = (from) => { const l = readLog(from); return l.length ? l[l.length - 1].seq + 1 : 1; };
const getCursor = (as, from) => (existsSync(cursorFile(as, from)) ? Number(readFileSync(cursorFile(as, from), "utf8").trim()) || 0 : 0);
const setCursor = (as, from, seq) => writeFileSync(cursorFile(as, from), String(seq));
const channels = () => readdirSync(BUS).filter((f) => f.startsWith("from-") && f.endsWith(".jsonl")).map((f) => f.slice(5, -6));
const fmt = (r) => `#${r.seq} ${r.ts} ${r.from}→${r.to}${r.tag ? " [" + r.tag + "]" : ""}\n${r.body}\n`;

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

const [cmd, ...rest] = process.argv.slice(2);
const o = parseArgs(rest);
const sender = val(o.from) || val(o.as);
const reader = val(o.as) || val(o.from);

if (cmd === "send" || cmd === "post") {
  if (!sender || !val(o.to)) { console.error("send: need a sender (--from or --as) and --to"); process.exit(1); }
  let body = val(o.body) || (o._.length ? o._.join(" ") : "");
  if (!body) { try { body = readFileSync(0, "utf8").trim(); } catch { /* no stdin */ } }
  if (!body) { console.error("send: need a message (positional, --body, or stdin)"); process.exit(1); }
  const rec = { seq: nextSeq(sender), ts: new Date().toISOString(), from: sender, to: o.to, tag: val(o.tag), body };
  appendFileSync(chanFile(sender), JSON.stringify(rec) + "\n");
  console.log(`sent #${rec.seq}  ${sender}→${o.to}`);
} else if (cmd === "monitor") {
  if (!reader) { console.error("monitor: need --as <your-name>"); process.exit(1); }
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
  console.error('usage: send --from me --to you "msg" | monitor --as me | read --as me | peek --as me | log --from who');
  process.exit(1);
}
