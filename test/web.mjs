// Contract tests for agent-bus-web.mjs (the GitHub Issues transport). Zero
// deps, no network: fetch is replaced by test/mock.mjs (a file-backed GitHub
// API), and an ISOLATED COPY of the script runs in a temp dir so bus-web/
// state never touches your checkout.
//
//   node test/web.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "agent-bus-webtest-"));
const SCRIPT = join(TMP, "agent-bus-web.mjs");
const DB = join(TMP, "db.json");
copyFileSync(join(REPO, "agent-bus-web.mjs"), SCRIPT);
writeFileSync(DB, JSON.stringify({ issues: [{ number: 1, title: "agent-bus" }], comments: [] }));
const MOCK = pathToFileURL(join(REPO, "test", "mock.mjs")).href;

const ENV = {
  ...process.env,
  AGENT_BUS_GITHUB_TOKEN: "test-token", AGENT_BUS_REPO: "t/r", MOCK_DB: DB,
  AGENT_BUS_ISSUE: "", AGENT_BUS_GLOBAL: "",
};

let fails = 0;
const ok = (cond, name, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + String(extra).slice(0, 300)}`);
  if (!cond) fails++;
};
const bus = (args) => spawnSync(process.execPath, ["--import", MOCK, SCRIPT, ...args],
  { cwd: TMP, encoding: "utf8", env: ENV });
const db = () => JSON.parse(readFileSync(DB, "utf8"));
const cursor = (reader) => JSON.parse(readFileSync(join(TMP, "bus-web", "t__r", `cursor.${reader}.json`), "utf8"));
const msgs = (out) => [...out.matchAll(/^#\d+ .* (\S+→\S+).*\n(.*)$/gm)].map((m) => `${m[1]}:${m[2]}`);
const ndjson = (out) => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const send = (from, to, body) => ok(bus(["send", "--from", from, "--to", to, body]).status === 0, `send ${from}→${to} "${body}"`);

// ── seed traffic: alice's message lands BEFORE bob's ──────────────────────────
send("alice", "me", "a1");
send("bob", "me", "b1");
send("bob", "me", "b2");
send("me", "me", "self-note");     // self-send: must never be delivered
send("me", "bob", "outbound");     // reader's own outbound traffic
// a raw human comment (no header) injected straight into the issue
{ const d = db(); const id = d.comments.at(-1).id + 1;
  d.comments.push({ id, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id - 100)).toISOString(), body: "hi, human here", reactions: { eyes: 0 } });
  writeFileSync(DB, JSON.stringify(d)); }

// ── filtered read must deliver bob's messages WITHOUT losing alice's ─────────
const r1 = bus(["read", "--as", "me", "--from", "bob"]);
ok(JSON.stringify(msgs(r1.stdout)) === JSON.stringify(["bob→me:b1", "bob→me:b2"]),
  "filtered read delivers only bob's (b1,b2)", r1.stdout);
const c1 = cursor("me");
ok(c1.lastId === 0 && c1.delivered.length === 2,
  "watermark held before alice's a1; b1,b2 remembered as delivered", JSON.stringify(c1));

// ── unfiltered read: a1 arrives exactly once; b1,b2 are NOT repeated ──────────
const r2 = bus(["read", "--as", "me"]);
ok(JSON.stringify(msgs(r2.stdout)) === JSON.stringify(["alice→me:a1"]),
  "unfiltered read delivers a1 once — no repeats, no self-send, no human noise", r2.stdout);
const c2 = cursor("me");
ok(c2.delivered.length === 0 && c2.lastId === db().comments.at(-1).id,
  "delivered set drained; watermark at head", JSON.stringify(c2));
ok(bus(["read", "--as", "me"]).stdout.trim() === "(no new messages)", "steady state: nothing new");

// ── receipts: delivered comments carry the 👀 stamp; log shows it ─────────────
const eyes = Object.fromEntries(db().comments.map((c) => [c.body.split("\n").pop(), c.reactions.eyes]));
ok(eyes["a1"] > 0 && eyes["b1"] > 0 && eyes["b2"] > 0, "delivered comments stamped with 👀", JSON.stringify(eyes));
ok(eyes["self-note"] === 0 && eyes["outbound"] === 0 && eyes["hi, human here"] === 0,
  "undelivered comments unstamped", JSON.stringify(eyes));
const lb = bus(["log", "--from", "bob"]).stdout;
ok((lb.match(/✓received/g) || []).length === 2, "log --from bob: both ✓received", lb);
const lm = bus(["log", "--from", "me"]).stdout;
ok((lm.match(/·pending/g) || []).length === 2, "own sends nobody drained stay ·pending", lm);
const ljson = ndjson(bus(["log", "--from", "bob", "--json"]).stdout);
ok(ljson.length === 2 && ljson.every((m) => m.received === true), "--json log carries received field");

// ── peek never consumes; a mismatched filter can't eat a waiting message ──────
send("alice", "me", "a2");
ok(msgs(bus(["peek", "--as", "me"]).stdout).join() === "alice→me:a2", "peek shows a2");
ok(bus(["read", "--as", "me", "--from", "bob"]).stdout.trim() === "(no new messages)", "filtered read (no match) prints nothing");
ok(msgs(bus(["peek", "--as", "me"]).stdout).join() === "alice→me:a2", "a2 still pending after mismatched filtered read");
const r5 = ndjson(bus(["read", "--as", "me", "--json"]).stdout);
ok(r5.length === 1 && r5[0].body === "a2" && r5[0].from === "alice", "a2 delivered exactly once, as NDJSON");

// ── --to fan-out; log --to filter ─────────────────────────────────────────────
const before = db().comments.length;
const fo = bus(["send", "--from", "lead", "--to", "me,web-x", "fanout", "--json"]);
ok(ndjson(fo.stdout).map((r) => r.to).join() === "me,web-x" && db().comments.length === before + 2,
  "--to a,b fans out one comment per recipient", fo.stdout);
ok(msgs(bus(["read", "--as", "me"]).stdout).join() === "lead→me:fanout", "fan-out copy delivered to me");
const lt = bus(["log", "--to", "web-x"]).stdout;
ok(lt.includes("lead→web-x") && lt.includes("·pending"), "log --to web-x shows the undrained copy pending", lt);

// ── who: roster aggregated from headers ───────────────────────────────────────
const who = ndjson(bus(["who", "--json"]).stdout);
ok(who.find((r) => r.name === "bob")?.sent === 2 && ["alice", "me", "lead"].every((n) => who.some((r) => r.name === n)),
  "who aggregates senders + counts", JSON.stringify(who));

// ── --attach refuses with guidance (web transport has no attachments) ─────────
const at = bus(["send", "--from", "me", "--to", "bob", "--attach", "x.md", "hi"]);
ok(at.status === 1 && (at.stderr + at.stdout).includes("local-bus only"), "--attach dies with repo-file/gist guidance");

// ── monitor first-attach initializes at HEAD (no history replay) ──────────────
const mon = spawn(process.execPath, ["--import", MOCK, SCRIPT, "monitor", "--as", "newbie"], { cwd: TMP, env: ENV });
const monErr = [];
mon.stderr.on("data", (d) => monErr.push(d.toString()));
await delay(1200);
mon.kill();
ok(monErr.join("").includes("initialized cursor at #"), "fresh monitor initialized at HEAD", monErr.join(""));
send("eve", "newbie", "n1");
ok(msgs(bus(["read", "--as", "newbie"]).stdout).join() === "eve→newbie:n1", "newbie gets only post-attach traffic");

// ── log still shows full history ──────────────────────────────────────────────
const lg = bus(["log"]).stdout;
ok(lg.includes("a1") && lg.includes("b1") && lg.includes("self-note"), "log shows full parsed history");

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL WEB TESTS PASSED");
process.exit(fails ? 1 : 0);
