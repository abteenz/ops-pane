# ops-pane

An observe-only [Claude Code](https://claude.com/claude-code) mod that shows what the session is doing:

- **Files touched**: grouped as Read / Edited / Created, with counts, most recent first
- **Tool calls**: a rolling log of the last 15 (tool name and a short argument summary)
- **Subagents**: how many were launched, which are still running, and the task each was given
- **Context and tokens**: context window use after each request, and the session's input/output tokens

A one-line band above the prompt shows `ctx % · tool calls · subagents active`.

It only observes. It never changes, approves or blocks a tool call, and it makes no network requests or model calls.

## Commands

- `/ops` opens or closes the pane. In fullscreen at 110 columns or wider it docks beside the transcript; on a narrower terminal it opens above the prompt.
- `/ops-export` writes the session's tool-call ledger as JSONL to `.claude/logs/<session-id>.jsonl` in the current repo (or in the working directory outside a git repo).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install ops-pane --marketplace abteenz/ops-pane
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install ops-pane --marketplace abteenz/ops-pane
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `abteenz/ops-pane`, then Add plugin.
