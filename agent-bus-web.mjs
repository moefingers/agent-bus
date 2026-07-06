#!/usr/bin/env node
// agent-bus-web — the GitHub Issues transport for agent-bus.
//
// Same six-command surface + same "you only ever see what's NEW" contract as
// the local file bus (agent-bus.mjs), but the bus is a single GitHub ISSUE and
// messages are its COMMENTS. That one change crosses machine boundaries: two
// isolated Claude sessions, a GitHub Action, and your laptop can all reach the
// same repo's issue, so they can all message each other — which the local
// on-disk bus (bus/projects/<slug>/) can never do across machines.
//
//   send    --from me --to you[,them] [--tag X] "msg"   (alias: post)
//           --to a,b,c fans out one comment per recipient. --attach is
//           local-bus only (64k cap) — send a repo-file/gist LINK instead.
//   monitor --as me [--interval 30]   ← the ONE command to RECEIVE (polls, prints only NEW)
//   read    --as me [--from who]         one-shot: print new + advance your cursor
//   peek    --as me                      look without advancing
//   log     [--from who] [--to who]      full history (or just open the issue URL);
//                                        records carry ✓received (see RECEIPTS)
//   who                                  roster: every sender ever seen + last activity
//   --json on any read-side command emits NDJSON instead of the human format
//
// RECEIPTS (best-effort): local cursors are invisible across machines, so when
// a drain DELIVERS a comment to its addressee it stamps an 👀 reaction on that
// comment; `log` then shows ✓received off the reactions rollup. Program-level
// delivery only — not proof the agent acted — and advisory: any human can also
// 👀 a comment. A failed stamp never breaks the drain.
//
// ENCRYPTION (AGENT_BUS_KEY): the private-repo requirement, lifted — for
// channels that CAN'T be private. A private repo with trusted collaborators
// needs none of this; leave the key unset. Otherwise set the SAME passphrase
// on every authorized participant (env var — or the operator hands the phrase
// to each session at its start; MIN 16 CHARS, enforced — the blobs are
// public, so the phrase must survive OFFLINE brute force) and every message
// is sealed with AES-256-GCM (key = scrypt(passphrase), memory-hard +
// repo-salted): outsiders can't read it, can't forge or tamper with it, and
// can't replay an old blob outside a ~10-minute window (the sender's clock is
// sealed inside the ciphertext; a re-post's fresh comment created_at betrays
// it). While a key is set, PLAINTEXT comments are ignored — the channel's
// trust boundary becomes "who holds the key". Roles are still not
// individually authenticated (any key-holder can claim any from:), so
// untrusted-and-verify stays. Tradeoffs: the issue stops being a
// human-readable audit trail (comments are sealed blobs — use `log` with the
// key to read it), and key hygiene is on you (a leaked phrase = a compromised
// channel; rotate by agreeing on a new phrase). No key set → wire format
// unchanged; sealed comments are silently invisible.
//
// WHY A SINGLE ISSUE (not one-issue-per-sender): GitHub serializes comment
// creation, so the local bus's single-writer-file trick is unnecessary — any
// number of writers post to the one issue with no contention. The channel
// collapses to one issue; the per-sender plumbing deletes.
//
// BUS RESOLUTION:
//   1. AGENT_BUS_REPO=owner/repo   → use it verbatim (manual override)
//   2. --global / AGENT_BUS_GLOBAL → the dedicated global repo
//                                    (AGENT_BUS_GLOBAL_REPO, default moefingers/agent-bus)
//                                    ⚠ web buses belong on a PRIVATE repo (authorship is
//                                    forgeable by anyone who can comment) — --global warns.
//   3. default                     → owner/repo parsed from `git remote get-url origin` in cwd
// The bus issue itself is found-or-created by EXACT TITLE "agent-bus" in that
// repo (race-safe: if two agents create one at once, both converge on the
// lowest issue number). Its number is cached locally to skip the lookup.
// Set AGENT_BUS_ISSUE=<number> (on every participant) to PIN the channel to a
// specific issue — or open PR, since PR comments are issue comments to this
// API; a long-lived open draft PR gives hosted receivers webhook PUSH where
// an issue is poll-only. The pin skips title discovery and the cache.
//
// IDENTITY: agents may share one token, so the GitHub comment author is NOT
// trusted. `from`/`to` live in the comment body header, always. A comment that
// doesn't parse as a header (e.g. a human typing in the issue UI) is skipped —
// it silently isn't a message, which is the new "two buses" failure mode, so
// the header parser is the load-bearing correctness surface.
//
// CURSOR: deliberately LOCAL (one file per reader under bus-web/), storing the
// last-CONSUMED comment id (a watermark) + its timestamp + an ETag + a usually-
// empty `delivered` set. Comment ids are monotonic, so "id > watermark" is the
// authoritative only-new filter; the timestamp feeds the server-side `since=`
// fetch; the ETag makes idle polls free (304s don't count against rate limit).
// The watermark only advances past comments that are CONSUMED — delivered to
// you, or never deliverable (foreign traffic, non-messages, your own sends). A
// `--from`-filtered read must not skip your OTHER senders' messages: the
// watermark holds at the first one, and matches delivered beyond it are
// remembered in `delivered` so nothing is ever lost or double-printed — the
// same only-new + exactly-once the local bus gets from per-sender cursors. A
// fresh machine has no cursor and replays history — fine, drain is idempotent.
// Durable cross-machine cursors are deliberately out of scope until they hurt.
//
// Zero npm deps: Node >= 18 builtins only (global fetch + child_process for the
// `gh auth token` fallback).

import {
  mkdirSync, existsSync, readFileSync, writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_ROOT = join(SCRIPT_DIR, "bus-web"); // git-ignored local cursor/cache home
const BUS_TITLE = "agent-bus"; // the exact issue title that IS the bus
const DEFAULT_GLOBAL_REPO = "moefingers/agent-bus";
const MAX_BODY = 65536; // GitHub comment body hard limit
const API = "https://api.github.com";
const ENC_MAGIC = "agent-bus:enc:v1"; // first line of a sealed comment
const ENC_SKEW_MS = 10 * 60 * 1000;   // replay window: |comment created_at − sealed sender clock|

// ── arg parsing (forgiving, ported verbatim from the local bus) ──────────────
const val = (x) => (x && x !== true ? x : null);
const truthy = (v) => v != null && v !== "" && v !== "0" && String(v).toLowerCase() !== "false";

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { o._.push(...argv.slice(i + 1)); break; } // end of flags: rest is body, even if it starts with --
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (k === "global" || k === "json") { o[k] = true; continue; } // pure booleans, never swallow the next token
      o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else o._.push(a);
  }
  return o;
}

const die = (msg) => { console.error(msg); process.exit(1); };

// ── token ────────────────────────────────────────────────────────────────────
function resolveToken() {
  // Prefer a bus-DEDICATED token (a narrowly-scoped Issues-only PAT) over a
  // general GITHUB_TOKEN, so the bus can do no more than post/read comments.
  if (truthy(process.env.AGENT_BUS_GITHUB_TOKEN)) return process.env.AGENT_BUS_GITHUB_TOKEN.trim();
  if (truthy(process.env.GITHUB_TOKEN)) return process.env.GITHUB_TOKEN.trim();
  if (truthy(process.env.GH_TOKEN)) return process.env.GH_TOKEN.trim();
  try {
    const t = execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (t) return t;
  } catch { /* gh not installed / not logged in */ }
  die("agent-bus-web: no token — set AGENT_BUS_GITHUB_TOKEN (or GITHUB_TOKEN), or run `gh auth login`");
}

// ── repo resolution ───────────────────────────────────────────────────────────
function parseOwnerRepo(s) {
  // accepts owner/repo, https://github.com/owner/repo(.git), git@github.com:owner/repo(.git)
  const m = String(s).trim()
    .replace(/\.git$/, "")
    .match(/(?:github\.com[/:])?([^/\s]+)\/([^/\s]+?)\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function resolveRepo(args) {
  if (truthy(process.env.AGENT_BUS_REPO)) {
    const r = parseOwnerRepo(process.env.AGENT_BUS_REPO);
    if (!r) die(`agent-bus-web: AGENT_BUS_REPO="${process.env.AGENT_BUS_REPO}" is not owner/repo`);
    return { repo: r, label: `repo=${r}` };
  }
  if (args.global === true || truthy(process.env.AGENT_BUS_GLOBAL)) {
    const g = parseOwnerRepo(process.env.AGENT_BUS_GLOBAL_REPO || DEFAULT_GLOBAL_REPO);
    // --global is a LOCAL-file-bus concept (gitignored, forgery-proof). On the web
    // transport a shared repo means forgeable authorship — repo-scope to a PRIVATE
    // repo instead. Warn loudly; don't hard-block (a private global repo is possible).
    process.stderr.write(
      `agent-bus-web: WARNING — --global points the web bus at a SHARED repo (${g}); ` +
      `authorship there is forgeable. Web buses belong on a PRIVATE, repo-scoped channel — ` +
      `or seal a shared one with AGENT_BUS_KEY (same phrase on every participant). ` +
      `Use an open --global bus only for local dev.\n`,
    );
    return { repo: g, label: `global repo=${g}` };
  }
  let origin;
  try {
    origin = execSync("git remote get-url origin", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    die("agent-bus-web: no git 'origin' remote in cwd — set AGENT_BUS_REPO=owner/repo or use --global");
  }
  const r = parseOwnerRepo(origin);
  if (!r) die(`agent-bus-web: could not parse owner/repo from origin "${origin}"`);
  return { repo: r, label: `repo=${r}` };
}

// ── sealed channel (AGENT_BUS_KEY → AES-256-GCM) ──────────────────────────────
// The blobs are PUBLIC on a public repo, so the phrase must survive OFFLINE
// brute force (an attacker tests guesses locally; the GCM tag confirms a hit).
// Three defenses: a 16-char minimum (enforced — length is the real
// requirement; composition rules are theater), a memory-hard KDF (scrypt at
// N=2^17 ≈ 128MB and ~hundreds of ms PER GUESS — GPU-hostile; paid once per
// process here), and a repo-scoped salt so a precomputed table for one
// channel is useless on another (lowercased: GitHub repo names are
// case-insensitive, and a case-split key would fork the channel).
function deriveKey(repo) {
  if (!truthy(process.env.AGENT_BUS_KEY)) return null;
  const phrase = process.env.AGENT_BUS_KEY.trim();
  if (phrase.length < 16) {
    die("agent-bus-web: AGENT_BUS_KEY is too short (min 16 chars). Sealed comments are public — a short phrase can be brute-forced offline. Use a long random phrase, e.g. four+ diceware words.");
  }
  return scryptSync(phrase, `agent-bus-web:v1:${repo.toLowerCase()}`, 32,
    { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
}

function encrypt(key, text) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `${ENC_MAGIC}\n${Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64")}`;
}

// Returns plaintext, or null (wrong key / tampered / malformed — not ours).
function decrypt(key, text) {
  try {
    const raw = Buffer.from(text.slice(ENC_MAGIC.length).trim(), "base64");
    if (raw.length < 29) return null; // iv(12) + tag(16) + at least 1 byte
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
  } catch { return null; }
}

// ── local state (cursor + issue-number cache), per repo, git-ignored ──────────
const stateDir = (repo) => join(STATE_ROOT, repo.replace("/", "__"));
const issueCacheFile = (repo) => join(stateDir(repo), "issue");
const cursorFile = (repo, reader) => join(stateDir(repo), `cursor.${reader}.json`);

function readCursor(repo, reader) {
  const f = cursorFile(repo, reader);
  const empty = { lastId: 0, lastTs: null, etag: null, delivered: [] };
  if (!existsSync(f)) return empty;
  try { return { ...empty, ...JSON.parse(readFileSync(f, "utf8")) }; }
  catch { return empty; }
}
function writeCursor(repo, reader, cur) {
  mkdirSync(stateDir(repo), { recursive: true });
  writeFileSync(cursorFile(repo, reader), JSON.stringify(cur));
}

// ── GitHub REST (zero-dep, paginated, ETag-aware) ─────────────────────────────
const TOKEN = resolveToken();
const ghHeaders = (etag) => ({
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "agent-bus-web",
  ...(etag ? { "If-None-Match": etag } : {}),
});

async function gh(method, path, { body, etag } = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: { ...ghHeaders(etag), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 304) return { status: 304, json: null, etag, link: null };
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (res.status >= 400) {
    const msg = (json && json.message) || text || res.statusText;
    const e = new Error(`GitHub ${method} ${path} → ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return { status: res.status, json, etag: res.headers.get("etag"), link: res.headers.get("link") };
}

const nextLink = (linkHeader) => {
  if (!linkHeader) return null;
  const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
};

// GET every page. Returns { items, etag } — etag is page 1's (the stable
// idle-poll key). If firstEtag is supplied and page 1 returns 304, returns
// { notModified: true }.
async function ghGetAll(path, firstEtag) {
  const first = await gh("GET", path, { etag: firstEtag });
  if (first.status === 304) return { notModified: true, items: [], etag: firstEtag };
  const items = [...(first.json || [])];
  let link = nextLink(first.link);
  while (link) {
    const page = await gh("GET", link);
    items.push(...(page.json || []));
    link = nextLink(page.link);
  }
  return { notModified: false, items, etag: first.etag };
}

// ── find-or-create the bus issue (race-safe, cached) ──────────────────────────
async function listBusIssues(repo) {
  // exact-title match across open+closed; the bus issue title is BUS_TITLE.
  const { items } = await ghGetAll(`/repos/${repo}/issues?state=all&per_page=100`);
  // /issues also returns PRs — exclude them (they carry a pull_request field).
  return items.filter((i) => !i.pull_request && i.title === BUS_TITLE).map((i) => i.number).sort((a, b) => a - b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveBusIssue(repo) {
  // Explicit channel pin — issue OR open-PR number (PR comments are issue
  // comments to the API). Bypasses title discovery and the local cache, so
  // every participant that sets it converges on the same channel by fiat.
  if (truthy(process.env.AGENT_BUS_ISSUE)) {
    const n = Number(process.env.AGENT_BUS_ISSUE);
    if (!Number.isInteger(n) || n <= 0) {
      die(`agent-bus-web: AGENT_BUS_ISSUE="${process.env.AGENT_BUS_ISSUE}" is not a positive issue/PR number`);
    }
    return n;
  }
  const cache = issueCacheFile(repo);
  if (existsSync(cache)) {
    const n = Number(readFileSync(cache, "utf8").trim());
    if (n > 0) return n;
  }
  let nums = await listBusIssues(repo);
  if (nums.length === 0) {
    // No bus issue yet — create one. The POST response is AUTHORITATIVE: the
    // /issues LIST lags read-after-write, so an immediate re-list can come back
    // empty and must not be trusted (that bug forked the bus into duplicates).
    // Then re-list with a short retry to CONVERGE — if another agent raced us,
    // we adopt the lowest number so nobody ends up on a different issue.
    const { json } = await gh("POST", `/repos/${repo}/issues`, {
      body: {
        title: BUS_TITLE,
        body:
          "This issue is an **agent-bus** channel (GitHub Issues transport). Its **comments are " +
          "messages** between cooperating agents — each has a `from:`/`to:`/`tag:` header above a " +
          "`---` separator. Humans: commenting here is safe (non-header comments are ignored by " +
          "agents). See agent-bus AGENTS.md.",
      },
    });
    const created = json.number;
    nums = [created];
    for (let i = 0; i < 3; i++) {              // let the index catch up + expose racers
      await sleep(1000);
      const after = await listBusIssues(repo);
      if (after.length) { nums = after.includes(created) ? after : [...after, created]; break; }
    }
  }
  const chosen = Math.min(...nums);            // lowest-numbered wins → convergence
  mkdirSync(stateDir(repo), { recursive: true });
  writeFileSync(cache, String(chosen));
  return chosen;
}

// ── message header (identity lives here, never in the API author field) ───────
function serialize({ from, to, tag, body, sealed }) {
  const head = [`from: ${from}`, `to: ${to}`];
  if (tag) head.push(`tag: ${tag}`);
  // Sealed messages carry the sender's clock INSIDE the ciphertext: a
  // re-posted old blob gets a fresh comment created_at far from it, which is
  // the stateless replay guard (window: ENC_SKEW_MS).
  if (sealed) head.push(`sent: ${new Date().toISOString()}`);
  return `${head.join("\n")}\n---\n${body}`;
}

// Parse a comment body into a message, or null if it isn't one (human comment).
function parseMessage(text) {
  const sep = text.indexOf("\n---");
  if (sep === -1) return null;
  const headBlock = text.slice(0, sep);
  const body = text.replace(/^[\s\S]*?\n---\r?\n?/, "");
  const head = {};
  for (const line of headBlock.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (!m) return null; // any non-header line before --- ⇒ not a message
    head[m[1].toLowerCase()] = m[2].trim();
  }
  if (!head.from || !head.to) return null; // from+to required
  return { from: head.from, to: head.to, tag: head.tag || null, sent: head.sent || null, body };
}

const fmt = (m, mark = "") => `#${m.id} ${m.ts} ${m.from}→${m.to}${m.tag ? " [" + m.tag + "]" : ""}${mark}\n${m.body}\n`;
// One record per stdout line-group: NDJSON with --json (what agents should
// parse), the human format otherwise. `mark` is a human-only status suffix.
const emit = (m, mark = "") => process.stdout.write(JSON_OUT ? JSON.stringify(m) + "\n" : fmt(m, mark) + "\n");

// Map a raw GitHub comment → parsed message (with id/ts) or null.
// With a key set, ONLY validly sealed comments are messages — a plaintext
// header is exactly what a forger without the key would post, so it's
// ignored. Without a key, sealed comments are silently invisible.
function toMessage(c) {
  let text = c.body || "";
  if (KEY) {
    if (!text.startsWith(ENC_MAGIC)) return null;
    text = decrypt(KEY, text);
    if (text === null) return null;              // wrong key / tampered / not ours
  } else if (text.startsWith(ENC_MAGIC)) {
    return null;
  }
  const parsed = parseMessage(text);
  if (!parsed) return null;
  if (KEY) {
    // Stateless replay guard: reject a sealed blob whose comment timestamp is
    // far from the sender clock sealed inside it (a re-post of an old blob).
    const sent = Date.parse(parsed.sent || "");
    if (!Number.isFinite(sent) || Math.abs(Date.parse(c.created_at) - sent) > ENC_SKEW_MS) return null;
  }
  return { id: c.id, ts: c.created_at, ...parsed };
}

// ── drain: fetch new comments, print those addressed to reader, advance cursor ─
// Returns { count, notModified }. The watermark advances past every CONSUMED
// comment — non-messages, foreign traffic, your own sends, and messages
// delivered to you — so none of it is rescanned. It must NOT advance past a
// message addressed to you that a `--from` filter left unprinted (that would
// lose it forever, which the per-sender cursors of the local bus can't do): the
// watermark holds there, matches delivered beyond it go in the cursor's
// `delivered` set, and a later drain hands you the held message exactly once.
async function drain(repo, issue, reader, only, { useEtag = false } = {}) {
  const cur = readCursor(repo, reader);
  const delivered = new Set(cur.delivered);
  const sinceQ = cur.lastTs ? `&since=${encodeURIComponent(cur.lastTs)}` : "";
  const path = `/repos/${repo}/issues/${issue}/comments?per_page=100${sinceQ}`;
  const { notModified, items, etag } = await ghGetAll(path, useEtag ? cur.etag : undefined);
  if (notModified) return { count: 0, notModified: true };

  let lastId = cur.lastId, lastTs = cur.lastTs, advancing = true;
  const out = [];
  for (const c of [...items].sort((a, b) => a.id - b.id)) {
    if (c.id <= cur.lastId) continue;            // behind the watermark: already seen
    const msg = toMessage(c);
    // Deliverable = a real message, addressed to reader, not reader's own send
    // (self-sends are never delivered — matches the local bus).
    const mine = msg !== null && msg.to === reader && msg.from !== reader;
    if (mine && !delivered.has(c.id) && (!only || msg.from === only)) {
      out.push(msg);
      delivered.add(c.id);
    }
    if (advancing && (!mine || delivered.has(c.id))) {
      lastId = c.id; lastTs = c.created_at;      // consumed → watermark moves up…
      delivered.delete(c.id);                    // …and covers this id
    } else advancing = false;                    // held: undelivered message for us
  }
  for (const m of out) emit(m);
  writeCursor(repo, reader, { lastId, lastTs, etag: etag || cur.etag, delivered: [...delivered].sort((a, b) => a - b) });
  // Best-effort delivery receipt: stamp each comment we just delivered with an
  // 👀 reaction so the sender's `log` can show ✓received across machines.
  // Advisory by design — a failed stamp must never fail (or re-run) a drain.
  for (const m of out) {
    try { await gh("POST", `/repos/${repo}/issues/comments/${m.id}/reactions`, { body: { content: "eyes" } }); }
    catch { /* receipts are advisory */ }
  }
  return { count: out.length, notModified: false };
}

// ── main ──────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const o = parseArgs(rest);
const sender = val(o.from) || val(o.as);
const reader = val(o.as) || val(o.from);
const JSON_OUT = o.json === true;
const { repo, label } = resolveRepo(o);
const KEY = deriveKey(repo); // null = open channel; set = sealed (see ENCRYPTION)
const announceBus = () => process.stderr.write(
  `bus: ${label}${KEY ? " enc" : ""}${truthy(process.env.AGENT_BUS_ISSUE) ? ` issue=#${process.env.AGENT_BUS_ISSUE.trim()} (pinned)` : ""}\n`,
);

try {
  if (cmd === "send" || cmd === "post") {
    // --to a,b,c fans out one comment per recipient — still point-to-point.
    const recipients = [...new Set(String(val(o.to) || "").split(",").map((s) => s.trim()).filter(Boolean))];
    if (!sender || !recipients.length) die("send: need a sender (--from or --as) and --to");
    if (val(o.attach) || o.attach === true) {
      die("send: --attach is local-bus only — attachments don't cross the web transport (64k comment cap); commit the file to the repo (or post a gist) and send the LINK instead");
    }
    let body = val(o.body) || (o._.length ? o._.join(" ") : "");
    if (!body) { try { body = readFileSync(0, "utf8").trim(); } catch { /* no stdin */ } }
    if (!body) die("send: need a message (positional, --body, or stdin)");
    announceBus();
    const issue = await resolveBusIssue(repo);
    for (const to of recipients) {
      let payload = serialize({ from: sender, to, tag: val(o.tag), body, sealed: !!KEY });
      if (KEY) payload = encrypt(KEY, payload);
      if (payload.length > MAX_BODY) {
        die(`send: message is ${payload.length} chars, over GitHub's ${MAX_BODY} limit — post a link (gist / file-in-repo) instead`);
      }
      const { json } = await gh("POST", `/repos/${repo}/issues/${issue}/comments`, { body: { body: payload } });
      console.log(JSON_OUT ? JSON.stringify({ sent: json.id, from: sender, to, issue }) : `sent #${json.id}  ${sender}→${to}  (issue #${issue})`);
    }
  } else if (cmd === "monitor") {
    if (!reader) die("monitor: need --as <your-name>");
    announceBus();
    const issue = await resolveBusIssue(repo);
    const ms = Math.max(15, Number(o.interval) > 0 ? Number(o.interval) : 30) * 1000;
    const only = val(o.from);
    // First-ever attach (no cursor): initialize to HEAD without replaying the
    // whole history — a monitor watches for NEW messages, and dumping a long
    // audit log would flood the caller. A prior cursor resumes with catch-up.
    if (!existsSync(cursorFile(repo, reader))) {
      const { items } = await ghGetAll(`/repos/${repo}/issues/${issue}/comments?per_page=100`);
      let maxId = 0, maxTs = null;
      for (const c of items) if (c.id > maxId) { maxId = c.id; maxTs = c.created_at; }
      writeCursor(repo, reader, { lastId: maxId, lastTs: maxTs, etag: null, delivered: [] });
      process.stderr.write(`agent-bus-web: initialized cursor at #${maxId} — watching for new messages\n`);
    } else {
      await drain(repo, issue, reader, only);    // catch up on anything missed since last run
    }
    const tick = async () => {
      try { await drain(repo, issue, reader, only, { useEtag: true }); }
      catch (e) { process.stderr.write(`agent-bus-web: poll error (continuing): ${e.message}\n`); }
      setTimeout(tick, ms);
    };
    setTimeout(tick, ms);
  } else if (cmd === "read") {
    if (!reader) die("read: need --as <your-name>");
    announceBus();
    const issue = await resolveBusIssue(repo);
    const { count } = await drain(repo, issue, reader, val(o.from));
    if (count === 0 && !JSON_OUT) console.log("(no new messages)");
  } else if (cmd === "peek") {
    if (!reader) die("peek: need --as <your-name>");
    announceBus();
    const issue = await resolveBusIssue(repo);
    const cur = readCursor(repo, reader);
    const delivered = new Set(cur.delivered);
    const { items } = await ghGetAll(`/repos/${repo}/issues/${issue}/comments?per_page=100`);
    const out = items.map(toMessage).filter(Boolean)
      .filter((m) => m.to === reader && m.from !== reader && m.id > cur.lastId && !delivered.has(m.id)
        && (!val(o.from) || m.from === val(o.from)))
      .sort((a, b) => a.id - b.id);
    if (!out.length) { if (!JSON_OUT) console.log("(no new messages)"); } else out.forEach((m) => emit(m));
  } else if (cmd === "log") {
    // Cursor-free audit view — debug AND recovery (`log --to me` = everything
    // ever addressed to me). ✓received = the comment carries an 👀 reaction
    // (stamped by the addressee's drain — see RECEIPTS in the header).
    announceBus();
    const issue = await resolveBusIssue(repo);
    process.stderr.write(`https://github.com/${repo}/issues/${issue}\n`);
    const { items } = await ghGetAll(`/repos/${repo}/issues/${issue}/comments?per_page=100`);
    const fromF = val(o.from), toF = val(o.to);
    items
      .map((c) => { const m = toMessage(c); return m && { ...m, received: ((c.reactions || {}).eyes || 0) > 0 }; })
      .filter(Boolean)
      .filter((m) => (!fromF || m.from === fromF) && (!toF || m.to === toF))
      .forEach((m) => emit(m, m.received ? " ✓received" : " ·pending"));
  } else if (cmd === "who") {
    // Roster: everyone who has ever SENT on this bus + last activity (ONBOARD
    // on arrival means presence here ≈ membership).
    announceBus();
    const issue = await resolveBusIssue(repo);
    const { items } = await ghGetAll(`/repos/${repo}/issues/${issue}/comments?per_page=100`);
    const by = new Map();
    for (const m of items.map(toMessage).filter(Boolean)) {
      const r = by.get(m.from) || { name: m.from, sent: 0, lastId: 0, lastTs: null };
      r.sent++; if (m.id > r.lastId) { r.lastId = m.id; r.lastTs = m.ts; }
      by.set(m.from, r);
    }
    const rows = [...by.values()].sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
    if (!rows.length) { if (!JSON_OUT) console.log("(no senders yet)"); }
    else rows.forEach((r) => console.log(JSON_OUT ? JSON.stringify(r) : `${r.name}  ×${r.sent}  last #${r.lastId} ${r.lastTs}`));
  } else {
    die('usage: send --from me --to you[,them] "msg" | monitor --as me | read --as me | peek --as me | log [--from who] [--to me] | who   [--json] [--global | AGENT_BUS_REPO=owner/repo | AGENT_BUS_ISSUE=n]');
  }
} catch (e) {
  die(`agent-bus-web: ${e.message}`);
}
