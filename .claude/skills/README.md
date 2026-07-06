# Agent-bus role skills

One skill per agent-bus role, so onboarding is **invoke the skill** instead of **re-read the whole readme**. Each `SKILL.md` is a project-agnostic operating manual for that role: who directs it, how it works, and the shared bus protocol (run one monitor, announce `ONBOARD`, tag every message, close loops both ways, never commit to `<main>` — the project's default branch).

| Skill | Role | Directed by |
|---|---|---|
| [`lead`](lead/SKILL.md) | hub + git-master; delegates, reviews, merges, posts `[GIT-SYNC]` | the operator |
| [`deputy`](deputy/SKILL.md) | senior engineer; hardest builds + reviews; may delegate to builders | lead |
| [`builder`](builder/SKILL.md) | delegated implementation (builder-1, builder-2, …); worktree → PR | lead **or** deputy |
| [`design`](design/SKILL.md) | UX/vision owner; specs + copy; routes builds through lead | works with lead |
| [`scout`](scout/SKILL.md) | shared errand-runner — QA, validation, ground-truth, smokes | anyone |
| [`scribe`](scribe/SKILL.md) | shared errand-runner — documentation | anyone |
| [`envoy`](envoy/SKILL.md) | faithful async relay to the operator (the human) | anyone |

The canonical bus protocol these skills point back to lives in [`../../AGENTS.md`](../../AGENTS.md). If a skill disagrees with AGENTS.md, AGENTS.md wins — fix the skill.

**Web-prefixed roles** (`web-deputy`, `web-builder`, … — remote sessions on another machine) keep the same role manual, but every skill's **Bus** section is local-file-bus only: a web role replaces those commands with the **web transport** in [AGENTS.md §6](../../AGENTS.md) (`agent-bus-web.mjs`, GitHub-issue channel, `web-` name prefix), and routes all local-team contact through `lead`.

## Discoverability

Claude Code auto-loads a skill only when its directory is a **working directory** for the session (or symlinked into a globally-loaded skills dir, e.g. `~/.claude/skills/`). So these skills load automatically only when the **agent-bus repo is one of the session's working directories**. Two ways to make a role skill reachable from any project:

- Add your **agent-bus checkout** (the repo these skills live in) as an additional working directory for the agent, **or**
- Symlink the role's folder into a globally-discovered skills dir (e.g. `~/.claude/skills/<role>`).

If a skill isn't auto-discovered, an agent can still onboard the manual way: read the role's `SKILL.md` directly, then follow the bus steps in [`../../AGENTS.md`](../../AGENTS.md).
