// Contract tests for agent-bus.mjs (the local file bus). Zero deps, no
// network. Runs an ISOLATED COPY of the script in a temp dir — bus/ resolves
// beside the copy, so your live bus is never touched.
//
//   node test/local.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, copyFileSync, readFileSync } from "node:fs";
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
const bus = (args, cwd, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...ENV, ...env } });
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

// ── 7) log: merged view, --to filter, receipts derived from cursors ──────────
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

// ── 9) monitor survives a transient bus-dir wipe and keeps delivering ─────────
const monOut = [], monErr = [];
const mon = spawn(process.execPath, [SCRIPT, "monitor", "--as", "mon", "--interval", "1"], { cwd: M, env: ENV });
mon.stdout.on("data", (d) => monOut.push(d.toString()));
mon.stderr.on("data", (d) => monErr.push(d.toString()));
await delay(500);
bus(["send", "--from", "a", "--to", "mon", "hello-mon"], M);
await delay(1800);
ok(monOut.join("").includes("hello-mon"), "monitor delivers", monOut.join(""));
rmSync(join(TMP, "bus"), { recursive: true, force: true });        // sweep the bus out from under it
await delay(1800);
ok(mon.exitCode === null, "monitor still alive after bus dir wipe");
ok(monErr.join("").includes("poll error (continuing)"), "monitor reported the error and continued");
bus(["send", "--from", "a", "--to", "mon", "after-recovery"], M);  // send recreates the bus
await delay(1800);
ok(monOut.join("").includes("after-recovery"), "monitor delivers again after recovery");
mon.kill();

// ── 10) --global + AGENT_BUS_PROJECT pins unaffected ──────────────────────────
ok(busLine(bus(["send", "--from", "a", "--to", "b", "g", "--global"], M)) === "bus: global", "--global bus");
ok(busLine(bus(["send", "--from", "a", "--to", "b", "p"], M, { AGENT_BUS_PROJECT: "Team X" })) === "bus: project=team-x",
  "AGENT_BUS_PROJECT pin");

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL LOCAL TESTS PASSED");
process.exit(fails ? 1 : 0);
