# Agent-bus role skills

One skill per agent-bus role, so onboarding is **invoke the skill** instead of **re-read the whole readme**. Each role's `SKILL.md` carries only that role's **essence** — who directs it and how it works. Everything the roles share — onboarding (`init` + doorbell + `ONBOARD`), messaging conventions, git discipline — lives **once** in the [`bus`](bus/SKILL.md) protocol skill, which every role skill points to.

| Skill | Role | Directed by |
|---|---|---|
| [`bus`](bus/SKILL.md) | **shared protocol** — onboarding, conventions, git discipline (every role runs it) | — |
| [`lead`](lead/SKILL.md) | hub + git-master; delegates, reviews, merges, posts `[GIT-SYNC]` | the operator |
| [`deputy`](deputy/SKILL.md) | senior engineer; hardest builds + reviews; may delegate to builders | lead |
| [`builder`](builder/SKILL.md) | delegated implementation (builder-1, builder-2, …); worktree → PR | lead **or** deputy |
| [`design`](design/SKILL.md) | UX/vision owner; specs + copy; routes builds through lead | works with lead |
| [`scout`](scout/SKILL.md) | shared errand-runner — QA, validation, ground-truth, smokes | anyone |
| [`scribe`](scribe/SKILL.md) | shared errand-runner — documentation | anyone |
| [`envoy`](envoy/SKILL.md) | faithful async relay to the operator (the human) | anyone |

The chain of truth is: role skill → [`bus`](bus/SKILL.md) → [`../../AGENTS.md`](../../AGENTS.md) (canon). If any layer disagrees, AGENTS.md wins — fix the skill.

**Web-prefixed roles** (`web-deputy`, `web-builder`, … — remote sessions on another machine) keep the same role manual, but the `bus` skill's commands are local-file-bus only: a web role replaces them with the **web transport** in [AGENTS.md §6](../../AGENTS.md) (`agent-bus-web.mjs`, GitHub-issue channel, `web-` name prefix), and routes all local-team contact through `lead`.

## Discoverability

Claude Code auto-loads a skill only when its directory is a **working directory** for the session (or symlinked into a globally-loaded skills dir, e.g. `~/.claude/skills/`). So these skills load automatically only when the **agent-bus repo is one of the session's working directories**. Two ways to make a role skill reachable from any project:

- Add your **agent-bus checkout** (the repo these skills live in) as an additional working directory for the agent, **or**
- Symlink the role's folder into a globally-discovered skills dir (e.g. `~/.claude/skills/<role>`).

If a skill isn't auto-discovered, an agent can still onboard the manual way: read the role's `SKILL.md` directly, then follow the bus steps in [`../../AGENTS.md`](../../AGENTS.md).
