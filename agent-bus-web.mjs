#!/usr/bin/env node
// agent-bus-web — the GitHub Issues transport for agent-bus.
//
// Same five-command surface + same "you only ever see what's NEW" contract as
// the local file bus (agent-bus.mjs), but the bus is a single GitHub ISSUE and
// messages are its COMMENTS. That one change crosses machine boundaries: two
// isolated Claude sessions, a GitHub Action, and your laptop can all reach the
// same repo's issue, so they can all message each other — which the local
// on-disk bus (bus/projects/<slug>/) can never do across machines.
//
//   send    --from me --to you [--tag X] "msg"   (alias: post)
//   monitor --as me [--interval 30]   ← the ONE command to RECEIVE (polls, prints only NEW)
//   read    --as me [--from who]         one-shot: print new + advance your cursor
//   peek    --as me                      look without advancing
//   log     --from who | (no flag)       full history (or just open the issue URL)
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
//   3. default                     → owner/repo parsed from `git remote get-url origin` in cwd
// The bus issue itself is found-or-created by EXACT TITLE "agent-bus" in that
// repo (race-safe: if two agents create one at once, both converge on the
// lowest issue number). Its number is cached locally to skip the lookup.
//
// IDENTITY: agents may share one token, so the GitHub comment author is NOT
// trusted. `from`/`to` live in the comment body header, always. A comment that
// doesn't parse as a header (e.g. a human typing in the issue UI) is skipped —
// it silently isn't a message, which is the new "two buses" failure mode, so
// the header parser is the load-bearing correctness surface.
//
// CURSOR: deliberately LOCAL (one file per reader under bus-web/), storing the
// last-seen comment id + its timestamp + an ETag. Comment ids are monotonic, so
// "id > cursor" is the authoritative only-new filter; the timestamp feeds the
// server-side `since=` fetch; the ETag makes idle polls free (304s don't count
// against rate limit). A fresh machine has no cursor and replays history — fine,
// drain is idempotent. Durable cross-machine cursors are deliberately out of
// scope until they hurt.
//
// Zero npm deps: Node >= 18 builtins only (global fetch + child_process for the
// `gh auth token` fallback).

import {
  mkdirSync, existsSync, readFileSync, writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_ROOT = join(SCRIPT_DIR, "bus-web"); // git-ignored local cursor/cache home
const BUS_TITLE = "agent-bus"; // the exact issue title that IS the bus
const DEFAULT_GLOBAL_REPO = "moefingers/agent-bus";
const MAX_BODY = 65536; // GitHub comment body hard limit
const API = "https://api.github.com";

// ── arg parsing (forgiving, ported verbatim from the local bus) ──────────────
const val = (x) => (x && x !== true ? x : null);
const truthy = (v) => v != null && v !== "" && v !== "0" && String(v).toLowerCase() !== "false";

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (k === "global") { o[k] = true; continue; } // pure boolean, never swallows next token
      o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else o._.push(a);
  }
  return o;
}

const die = (msg) => { console.error(msg); process.exit(1); };

// ── token ────────────────────────────────────────────────────────────────────
function resolveToken() {
  if (truthy(process.env.GITHUB_TOKEN)) return process.env.GITHUB_TOKEN.trim();
  if (truthy(process.env.GH_TOKEN)) return process.env.GH_TOKEN.trim();
  try {
    const t = execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (t) return t;
  } catch { /* gh not installed / not logged in */ }
  die("agent-bus-web: no token — set GITHUB_TOKEN or run `gh auth login`");
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
      `authorship there is forgeable. Web buses belong on a PRIVATE, repo-scoped channel. ` +
      `Use --global only for local dev.\n`,
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

// ── local state (cursor + issue-number cache), per repo, git-ignored ──────────
const stateDir = (repo) => join(STATE_ROOT, repo.replace("/", "__"));
const issueCacheFile = (repo) => join(stateDir(repo), "issue");
const cursorFile = (repo, reader) => join(stateDir(repo), `cursor.${reader}.json`);

function readCursor(repo, reader) {
  const f = cursorFile(repo, reader);
  if (!existsSync(f)) return { lastId: 0, lastTs: null, etag: null };
  try { return { lastId: 0, lastTs: null, etag: null, ...JSON.parse(readFileSync(f, "utf8")) }; }
  catch { return { lastId: 0, lastTs: null, etag: null }; }
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
function serialize({ from, to, tag, body }) {
  const head = [`from: ${from}`, `to: ${to}`];
  if (tag) head.push(`tag: ${tag}`);
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
  return { from: head.from, to: head.to, tag: head.tag || null, body };
}

const fmt = (m) => `#${m.id} ${m.ts} ${m.from}→${m.to}${m.tag ? " [" + m.tag + "]" : ""}\n${m.body}\n`;

// Map a raw GitHub comment → parsed message (with id/ts) or null.
function toMessage(c) {
  const parsed = parseMessage(c.body || "");
  if (!parsed) return null;
  return { id: c.id, ts: c.created_at, ...parsed };
}

// ── drain: fetch new comments, print those addressed to reader, advance cursor ─
// Returns { count, notModified }. Advances the cursor to the max id/ts across
// ALL fetched comments (message or not) so foreign/human traffic isn't rescanned.
async function drain(repo, issue, reader, only, { useEtag = false } = {}) {
  const cur = readCursor(repo, reader);
  const sinceQ = cur.lastTs ? `&since=${encodeURIComponent(cur.lastTs)}` : "";
  const path = `/repos/${repo}/issues/${issue}/comments?per_page=100${sinceQ}`;
  const { notModified, items, etag } = await ghGetAll(path, useEtag ? cur.etag : undefined);
  if (notModified) return { count: 0, notModified: true };

  let maxId = cur.lastId, maxTs = cur.lastTs;
  const out = [];
  for (const c of items) {
    if (c.id > maxId) { maxId = c.id; maxTs = c.created_at; }
    if (c.id <= cur.lastId) continue;            // already seen (authoritative id filter)
    const msg = toMessage(c);
    if (!msg) continue;                          // human/non-message comment
    if (msg.to !== reader) continue;             // point-to-point
    if (only && msg.from !== only) continue;
    out.push(msg);
  }
  out.sort((a, b) => a.id - b.id);
  for (const m of out) process.stdout.write(fmt(m) + "\n");
  writeCursor(repo, reader, { lastId: maxId, lastTs: maxTs, etag: etag || cur.etag });
  return { count: out.length, notModified: false };
}

// ── main ──────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const o = parseArgs(rest);
const sender = val(o.from) || val(o.as);
const reader = val(o.as) || val(o.from);
const { repo, label } = resolveRepo(o);
const announceBus = () => process.stderr.write(`bus: ${label}\n`);

try {
  if (cmd === "send" || cmd === "post") {
    if (!sender || !val(o.to)) die("send: need a sender (--from or --as) and --to");
    let body = val(o.body) || (o._.length ? o._.join(" ") : "");
    if (!body) { try { body = readFileSync(0, "utf8").trim(); } catch { /* no stdin */ } }
    if (!body) die("send: need a message (positional, --body, or stdin)");
    const payload = serialize({ from: sender, to: o.to, tag: val(o.tag), body });
    if (payload.length > MAX_BODY) {
      die(`send: message is ${payload.length} chars, over GitHub's ${MAX_BODY} limit — post a link (gist / file-in-repo) instead`);
    }
    announceBus();
    const issue = await resolveBusIssue(repo);
    const { json } = await gh("POST", `/repos/${repo}/issues/${issue}/comments`, { body: { body: payload } });
    console.log(`sent #${json.id}  ${sender}→${o.to}  (issue #${issue})`);
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
      writeCursor(repo, reader, { lastId: maxId, lastTs: maxTs, etag: null });
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
    if (count === 0) console.log("(no new messages)");
  } else if (cmd === "peek") {
    if (!reader) die("peek: need --as <your-name>");
    announceBus();
    const issue = await resolveBusIssue(repo);
    const cur = readCursor(repo, reader);
    const { items } = await ghGetAll(`/repos/${repo}/issues/${issue}/comments?per_page=100`);
    const out = items.map(toMessage).filter(Boolean)
      .filter((m) => m.to === reader && m.id > cur.lastId && (!val(o.from) || m.from === val(o.from)))
      .sort((a, b) => a.id - b.id);
    if (!out.length) console.log("(no new messages)"); else out.forEach((m) => console.log(fmt(m)));
  } else if (cmd === "log") {
    announceBus();
    const issue = await resolveBusIssue(repo);
    process.stderr.write(`https://github.com/${repo}/issues/${issue}\n`);
    const { items } = await ghGetAll(`/repos/${repo}/issues/${issue}/comments?per_page=100`);
    const msgs = items.map(toMessage).filter(Boolean)
      .filter((m) => !val(o.from) || m.from === val(o.from));
    msgs.forEach((m) => console.log(fmt(m)));
  } else {
    die('usage: send --from me --to you "msg" | monitor --as me | read --as me | peek --as me | log [--from who]   [--global | AGENT_BUS_REPO=owner/repo]');
  }
} catch (e) {
  die(`agent-bus-web: ${e.message}`);
}
