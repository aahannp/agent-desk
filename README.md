# Agent Desk

A Mac app for running a team of coding agents side by side, like BridgeMind's BridgeSpace. Every pane is a
real terminal running the agent's own CLI, so Claude Code uses your normal Claude login and subscription.

## Use it

    npm install
    npm start            # browser version: open the link it prints
    npm run app          # Mac app, from source
    npm run dist         # builds dist/Agent Desk-<version>-<arch>.dmg
    npm run check        # self-check of the server, security and MCP

The DMG is signed ad-hoc (there's no Apple developer account), so the first time you open the copied app,
right-click it and choose Open (macOS 15+: System Settings → Privacy & Security → Open Anyway).

## What's in it

- **Agents**: up to 16 Claude Code, Codex, Gemini CLI, Cursor Agent or shell panes in a grid. Each one shows
  whether it's working, idle, needs you, or finished, and you get a notification when an agent needs you.
- **Lead agent**: give it a goal and it plans tasks on the board, then starts a worker for each one in its
  own git worktree.
- **Board**: To do / In progress / Review / Done with drag and drop. Run hands a task to an agent. Agents post
  comments and move their own cards through the board's MCP tools.
- **Review**: side-by-side diffs of each worktree against where it branched, then commit, merge, or discard.
- **Files**: a file tree and the Monaco editor (VS Code's editor), for the project or any agent's worktree.
- **Browser panes** for your dev server, **command blocks** in shells (each command and its output as a
  block), **screenshots** you can mark up and hand to an agent, **voice input** (on-device in the Mac app),
  **12 themes**, a **command palette** (⌘K) and an animated cursor.
- **MCP for your own Claude Code**: Settings shows a one-line `claude mcp add` that gives the same 12 board
  tools to Claude Code anywhere.

## Safety

- The server only listens on 127.0.0.1. Every request needs this install's secret (kept in a file only you
  can read) and must come from Agent Desk's own page, so other websites and other users on the Mac can't
  use it.
- Claude agents start in "Ask me" permission mode by default, and nothing here offers the bypass modes.
- A lead agent can't type into other agents or stop them without your approval.
- Merging asks you first, and it stops cleanly on conflicts.
- The Mac app turns off Electron's run-as-Node and inspector switches, uses the hardened runtime, and only
  lets its own page capture the screen.

## Data

The board, settings and the secret live in `data/` (browser version) or `~/Library/Application Support/Agent Desk`
(Mac app). Agent worktrees and screenshots go in `.agent-desk/` inside each project, which is kept out of git.
