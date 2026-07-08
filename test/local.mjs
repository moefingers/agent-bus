// Contract tests for agent-bus.mjs (the local file bus). Zero deps, no
// network. Runs an ISOLATED COPY of the script in a temp dir — bus/ resolves
// beside the copy, so your live bus is never touched.
//
//   node test/local.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "agent-bus-test-"));
const SCRIPT = join(TMP, "agent-bus.mjs");
copyFileSync(join(REPO, "agent-bus.mjs"), SCRIPT);

// scrub any ambient bus overrides
const ENV = { ...process.env, AGENT_BUS_DIR: "", AGENT_BUS_GLOBAL: "", AGENT_BUS_PROJECT: "" };

let fails = 0;
const ok = (cond, name, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + String(extra).slice(0, 300)}`);
  if (!cond) fails++;
};
const bus = (args, cwd, env = {}, input) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...ENV, ...env }, input });
const busLine = (r) => (r.stderr.split("\n").find((l) => l.startsWith("bus:")) || "").trim();
const ndjson = (out) => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ── 1) fake submodule with RELATIVE gitdir: slug must be cwd-independent ──────
const P = join(TMP, "parent");
mkdirSync(join(P, ".git", "modules", "sub"), { recursive: true });
mkdirSync(join(P, "sub", "deep"), { recursive: true });
writeFileSync(join(P, "sub", ".git"), "gitdir: ../.git/modules/sub\n");
const s1 = busLine(bus(["send", "--from", "a", "--to", "b", "m1"], join(P, "sub")));
const s2 = busLine(bus(["send", "--from", "a", "--to", "b", "m2"], join(P, "sub", "deep")));
ok(s1 === s2 && s1.length > 0, "submodule slug identical from root and subdir", `${s1} vs ${s2}`);
ok(s1.startsWith("bus: project=sub-"), "submodule slug keyed on the submodule's own dir", s1);

// ── 2) linked worktrees still share the main repo's bus ───────────────────────
const M = join(TMP, "wtmain"), W = join(TMP, "wtlinked");
mkdirSync(M, { recursive: true });
const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
git(["init", "-q"], M);
git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], M);
ok(git(["worktree", "add", W], M).status === 0, "git worktree add");
const w1 = busLine(bus(["send", "--from", "a", "--to", "b", "m"], M));
const w2 = busLine(bus(["send", "--from", "a", "--to", "b", "m"], W));
mkdirSync(join(W, "subdir"), { recursive: true });
const w3 = busLine(bus(["send", "--from", "a", "--to", "b", "m"], join(W, "subdir")));
ok(w1 === w2 && w2 === w3 && w1.startsWith("bus: project=wtmain-"),
  "main tree + worktree + worktree-subdir share one bus", `${w1} | ${w2} | ${w3}`);

// ── 3) `--` sentinel lets a body start with "--" ──────────────────────────────
ok(bus(["send", "--from", "a", "--to", "b", "--", "--verbose --dry-run"], M).status === 0, "send with -- sentinel exits 0");
ok(bus(["log", "--from", "a"], M).stdout.includes("\n--verbose --dry-run"), "-- sentinel body stored verbatim");

// ── 4) self-send not delivered; normal delivery works ────────────────────────
bus(["send", "--from", "z", "--to", "z", "note-to-self"], M);
ok(bus(["read", "--as", "z"], M).stdout.trim() === "(no new messages)", "self-send not delivered");
const rb = bus(["read", "--as", "b"], M);
ok(rb.stdout.includes("--verbose --dry-run") && rb.stdout.includes("a→b"), "normal delivery works");

// ── 5) --to a,b,c fan-out + --json output ─────────────────────────────────────
const fo = bus(["send", "--from", "lead", "--to", "b1,b2", "--tag", "GIT-SYNC", "sync-up", "--json"], M);
ok(ndjson(fo.stdout).map((r) => r.to).join() === "b1,b2", "fan-out sends one record per recipient", fo.stdout);
const j1 = ndjson(bus(["read", "--as", "b1", "--json"], M).stdout);
ok(j1.length === 1 && j1[0].from === "lead" && j1[0].tag === "GIT-SYNC" && j1[0].body === "sync-up",
  "--json read emits parseable NDJSON records", JSON.stringify(j1));
ok(bus(["read", "--as", "b2"], M).stdout.includes("sync-up"), "second fan-out recipient delivered");
ok(bus(["read", "--as", "b1", "--json"], M).stdout.trim() === "", "--json read is silent when nothing is new");

// ── 6) --attach copies into this bus's attachments/ + appends the pointer ─────
const SPEC = join(TMP, "spec.md");
writeFileSync(SPEC, "# the spec\n");
bus(["send", "--from", "design", "--to", "lead", "--attach", SPEC, "spec ready"], M);
bus(["send", "--from", "design", "--to", "lead", "--attach", SPEC, "spec v2"], M);
const slugDir = readdirSync(join(TMP, "bus", "projects")).find((d) => d.startsWith("wtmain-"));
const attached = readdirSync(join(TMP, "bus", "projects", slugDir, "attachments")).sort();
ok(attached.join() === "spec-2.md,spec.md", "attachments land in the bus home (collision suffixed)", attached.join());
const dlog = bus(["log", "--from", "design"], M).stdout;
ok(dlog.includes("spec ready — attachment: ") && dlog.includes("spec-2.md"), "pointer appended to the body", dlog);

// ── 7) log: merged view, --to filter, receipts derived from ack cursors ──────
bus(["send", "--from", "a", "--to", "c", "for-c"], M);              // c never reads → pending
const la = bus(["log", "--from", "a"], M).stdout;
ok((la.match(/✓received/g) || []).length === 4 && (la.match(/·pending/g) || []).length === 1,
  "receipts: 4 delivered to b ✓received, 1 unread to c ·pending", la);
const lj = ndjson(bus(["log", "--from", "a", "--json"], M).stdout);
ok(lj.length === 5 && lj.filter((r) => r.received).length === 4 && lj.at(-1).received === false,
  "--json log carries the received field");
ok(bus(["log", "--to", "c"], M).stdout.includes("for-c"), "log --to filters by recipient");
const merged = bus(["log"], M).stdout;
ok(merged.includes("a→b") && merged.includes("lead→b1") && merged.includes("z→z"),
  "bare log merges every channel");

// ── 8) who: roster with last activity ─────────────────────────────────────────
const who = bus(["who"], M).stdout;
ok(["a", "z", "lead", "design"].every((n) => who.includes(n)), "who lists every sender", who);
const wj = ndjson(bus(["who", "--json"], M).stdout);
ok(wj.find((r) => r.name === "a")?.sent === 5, "who --json row carries counts", JSON.stringify(wj));

// ── 9) hooks: deliver + ack at turn boundaries; loop-safe; quiet when idle ───
bus(["send", "--from", "lead", "--to", "h1", "--tag", "LANE", "fix the parser"], M);
const hs = bus(["hook-stop", "--as", "h1"], M, {}, "{}");
let hsj = null; try { hsj = JSON.parse(hs.stdout); } catch { /* fall through */ }
ok(hs.status === 0 && hsj?.decision === "block" && hsj.reason.includes("fix the parser"),
  "Stop hook blocks with pending mail injected", hs.stdout);
ok(hsj?.reason.includes("send --from h1 --to lead --tag LANE"), "single-sender injection bakes the exact reply command", hsj?.reason);
ok(hsj?.reason.includes("bell --as h1"), "Stop hook enforces the missing bell (exact arm command)", hsj?.reason);
ok(bus(["log", "--to", "h1"], M).stdout.includes("✓received"), "hook injection acks (✓received)");
const hs2 = bus(["hook-stop", "--as", "h1"], M, {}, '{"stop_hook_active":true}');
ok(hs2.status === 0 && !hs2.stdout.trim(), "no mail + stop_hook_active → stop passes silently (no nag loop)", hs2.stdout);
const hs3 = bus(["hook-stop", "--as", "h1"], M, {}, "{}");
let hs3j = null; try { hs3j = JSON.parse(hs3.stdout); } catch { /* fall through */ }
ok(hs3j?.decision === "block" && !hs3j.reason.includes("message(s) for"),
  "no mail + no bell → nag-only block (first stop of a cycle)", hs3.stdout);
bus(["send", "--from", "lead", "--to", "h1", "rebase please"], M);
const hp = bus(["hook-prompt", "--as", "h1"], M, {}, "{}");
ok(hp.status === 0 && hp.stdout.includes("rebase please"), "UserPromptSubmit hook piggybacks mail", hp.stdout);
ok(bus(["peek", "--as", "h1"], M).stdout.trim() === "(no new messages)", "prompt hook acked what it delivered");
bus(["send", "--from", "lead", "--to", "h1", "mid-turn ping"], M);
const ht = bus(["hook-posttool", "--as", "h1"], M, {}, "{}");
let htj = null; try { htj = JSON.parse(ht.stdout); } catch { /* fall through */ }
ok(htj?.hookSpecificOutput?.hookEventName === "PostToolUse" && htj.hookSpecificOutput.additionalContext.includes("mid-turn ping"),
  "PostToolUse hook delivers mid-turn via additionalContext", ht.stdout);
bus(["send", "--from", "lead", "--to", "h1", "you rebooted"], M);
const hb = bus(["hook-session", "--as", "h1"], M, {}, "{}");
ok(hb.status === 0 && hb.stdout.includes("You are 'h1'") && hb.stdout.includes("you rebooted"),
  "SessionStart hook re-grounds identity + replays backlog", hb.stdout);
const hq = bus(["hook-prompt", "--as", "h1"], M, {}, "{}");
ok(hq.status === 0 && !hq.stdout.trim(), "hooks are silent when there is nothing to deliver", hq.stdout);

// ── 10) bell: rings without exiting; singleton; grace; --once fallback ───────
const rings = [];
const bell = spawn(process.execPath, [SCRIPT, "bell", "--as", "d1", "--interval", "0.2", "--grace", "0.3"], { cwd: M, env: ENV });
bell.stdout.on("data", (d) => rings.push(d.toString()));
await delay(700);
ok(bell.exitCode === null && !rings.length, "bell sits silent with no mail");
const dup = bus(["bell", "--as", "d1"], M);
ok(dup.status === 0 && dup.stderr.includes("already ringing"), "duplicate bell exits itself (singleton)", dup.stderr);
const wjd = ndjson(bus(["who", "--json"], M).stdout).find((r) => r.name === "d1");
ok(wjd?.bell === true && wjd.lastSeen, "who shows the live bell listener (never sent a thing)", JSON.stringify(wjd));
bus(["send", "--from", "lead", "--to", "d1", "wake up"], M);
await delay(1200);
ok(bell.exitCode === null && rings.join("").includes("pending for 'd1'"), "bell rings but keeps running (no re-arm cycle)", rings.join(""));
await delay(800);
ok((rings.join("").match(/🔔/g) || []).length === 1, "one ring per mail batch — no spam", rings.join(""));
bus(["send", "--from", "lead", "--to", "d1", "second wave"], M);
await delay(1200);
ok((rings.join("").match(/🔔/g) || []).length === 2, "new mail rings again", rings.join(""));
ok(bus(["log", "--to", "d1"], M).stdout.includes("·pending"), "bell never acks — hooks/read do");
bell.kill();
await delay(300);
const slugBus = join(TMP, "bus", "projects", slugDir);
ok(!existsSync(join(slugBus, "bell.d1.pid")), "bell cleans up its pid file");
// grace: mail acked during the window (a hook got it) must NOT ring
const rings2 = [];
const bell2 = spawn(process.execPath, [SCRIPT, "bell", "--as", "d2", "--interval", "0.2", "--grace", "1.2"], { cwd: M, env: ENV });
bell2.stdout.on("data", (d) => rings2.push(d.toString()));
await delay(400);
bus(["send", "--from", "lead", "--to", "d2", "hooks got this"], M);
await delay(300);
bus(["hook-prompt", "--as", "d2"], M, {}, "{}");                    // hook drains + acks inside the grace window
await delay(1600);
ok(!rings2.length, "grace window: hook-acked mail doesn't ring the bell", rings2.join(""));
bell2.kill();
// --once: background-task fallback — exits on the first ring (task-exit wake)
const onceOut = [];
const bonce = spawn(process.execPath, [SCRIPT, "bell", "--as", "d3", "--once", "--interval", "0.2", "--grace", "0.2"], { cwd: M, env: ENV });
bonce.stdout.on("data", (d) => onceOut.push(d.toString()));
await delay(400);
bus(["send", "--from", "lead", "--to", "d3", "ring once"], M);
await new Promise((res) => { bonce.on("exit", res); setTimeout(res, 4000); });
ok(bonce.exitCode === 0 && onceOut.join("").includes("🔔"), "--once exits 0 on first ring (task-exit wake fallback)", onceOut.join(""));
await delay(200);

// ── 11) up: hooks + auto-ONBOARD, idempotent, preserves foreign settings ─────
const T2 = join(TMP, "initproj");
mkdirSync(join(T2, ".claude"), { recursive: true });
git(["init", "-q"], T2);
const SET = join(T2, ".claude", "settings.local.json");
writeFileSync(SET, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keepme" }] }] } }));
const in1 = bus(["up", "--as", "builder-9"], T2);
ok(in1.status === 0 && in1.stdout.includes("wired into") && in1.stdout.includes("bell --as builder-9"),
  "up exits 0 and points at the one remaining step (bell)", in1.stdout + in1.stderr);
const ob = ndjson(bus(["log", "--from", "builder-9", "--json"], T2).stdout);
ok(ob.length === 1 && ob[0].to === "lead" && ob[0].tag === "ONBOARD", "up announces ONBOARD automatically", JSON.stringify(ob));
let cfg = JSON.parse(readFileSync(SET, "utf8"));
ok(cfg.permissions.allow[0] === "Bash(ls:*)", "up preserves unrelated settings");
ok(cfg.hooks.Stop.some((m) => m.hooks.some((h) => h.command === "echo keepme")), "up preserves foreign hooks");
const flat = (evt) => (cfg.hooks[evt] || []).flatMap((m) => m.hooks.map((h) => h.command)).filter((c) => c.includes("agent-bus.mjs"));
ok(["Stop", "UserPromptSubmit", "PostToolUse", "SessionStart"].every((e) => flat(e).length === 1 && flat(e)[0].includes("--as builder-9")),
  "up wires all four events with the role baked in", JSON.stringify(cfg.hooks));
bus(["up", "--as", "builder-9"], T2);                               // idempotent re-run
cfg = JSON.parse(readFileSync(SET, "utf8"));
ok(flat("Stop").length === 1 && cfg.hooks.Stop.length === 2, "re-up replaces its entries, never duplicates", JSON.stringify(cfg.hooks.Stop));
const in3 = bus(["init", "--as", "scout", "--no-eager"], T2);       // init stays as an alias
cfg = JSON.parse(readFileSync(SET, "utf8"));
ok(in3.status === 0 && flat("PostToolUse").length === 0 && flat("Stop")[0].includes("--as scout"),
  "--no-eager skips PostToolUse; role swap replaces cleanly (init = alias)", JSON.stringify(cfg.hooks));
const inLead = bus(["up", "--as", "lead"], T2);
ok(inLead.status === 0 && inLead.stdout.includes("hub") && bus(["log", "--from", "lead", "--json"], T2).stdout.trim() === "",
  "up as lead: no self-ONBOARD (the hub receives them)", inLead.stdout);

// ── 12) parallel sends from one role mint unique seqs (send lock) ────────────
await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((res) => {
  spawn(process.execPath, [SCRIPT, "send", "--from", "racer", "--to", "x", `r${i}`], { cwd: M, env: ENV }).on("exit", res);
})));
const rl = ndjson(bus(["log", "--from", "racer", "--json"], M).stdout);
ok(rl.length === 6 && new Set(rl.map((r) => r.seq)).size === 6,
  "6 concurrent sends → 6 unique seqs", JSON.stringify(rl.map((r) => r.seq).sort((a, b) => a - b)));

// ── 13) presence: absence warnings at send time ───────────────────────────────
const g = bus(["send", "--from", "lead", "--to", "ghost-role", "anyone there?"], M);
ok(g.stderr.includes("never been seen"), "send warns when the recipient has never been seen", g.stderr);
const p = bus(["send", "--from", "lead", "--to", "h1", "ping"], M); // h1 was hook-active moments ago
ok(!p.stderr.includes("note —"), "no warning for a recently-active recipient", p.stderr);

// ── 14) --global + AGENT_BUS_PROJECT pins unaffected ──────────────────────────
ok(busLine(bus(["send", "--from", "a", "--to", "b", "g", "--global"], M)) === "bus: global", "--global bus");
ok(busLine(bus(["send", "--from", "a", "--to", "b", "p"], M, { AGENT_BUS_PROJECT: "Team X" })) === "bus: project=team-x",
  "AGENT_BUS_PROJECT pin");

// ── 15) retired commands point at the current shape ───────────────────────────
const mret = bus(["monitor", "--as", "old-timer"], M);
ok(mret.status === 1 && mret.stderr.includes("up --as"), "monitor exits 1 pointing at up", mret.stderr);
const dret = bus(["doorbell", "--as", "old-timer"], M);
ok(dret.status === 1 && dret.stderr.includes("bell"), "doorbell exits 1 pointing at bell", dret.stderr);

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL LOCAL TESTS PASSED");
process.exit(fails ? 1 : 0);
