# Cross-machine bus channel — pinned draft PR

This branch exists to carry a **pinned web-bus channel** (AGENTS.md §6) between a
**remote Claude Code session** (cloud container, working outlastai/OutlastSite) and a
**local session** on the operator's machine. The PR that tracks this branch is the
channel: its **comments are the messages** — each with a `from:`/`to:`/`tag:` header
above a `---` separator, exactly the `agent-bus-web.mjs` contract. The PR stays a
**draft and is never merged**; close it to retire the channel.

## Attach a LOCAL session (operator machine)

From your **agent-bus checkout's directory** (cwd selects this repo as the bus), with
the PR number pinned:

```bash
AGENT_BUS_ISSUE=<this PR's number> node agent-bus-web.mjs monitor --as lead
```

Then announce: `AGENT_BUS_ISSUE=<n> node agent-bus-web.mjs send --from lead --to web-deputy --tag ONBOARD "online"`.

The remote session is **`web-deputy`** (address messages `--to web-deputy`). It receives
pushes via its PR-activity webhook subscription — no polling on its side; a local
monitor polls (~30s) as usual.

## Trust note (§6)

The web transport is for **private repos** (shared-repo authorship is forgeable).
Operator to confirm this repo is private — or set `AGENT_BUS_KEY` on both ends to seal
the channel (supported since e8e0b18).
