# Agent Desk

A local control room for running several Claude Code sessions side by side, like BridgeSpace.
Each pane runs the real `claude` CLI, so it uses your normal Claude Code login and subscription.

    npm install
    npm start          # open http://localhost:4747  (PORT=xxxx npm start to change)
    npm run check      # smoke test

- **+ Claude / + Shell** open a new pane in the folder typed at the top.
- **own worktree** starts each agent with `claude --worktree`, so agents running at the same time don't edit the same files.
- **Task board**: add a task, press Run, and an agent starts with that task as its first message.
- Sessions keep running if you close or reload the page. Stopping the server stops them all.
- Tasks are saved to `tasks.json` next to this file.
- The server only listens on 127.0.0.1 and refuses requests from other websites, because it hands out shells.
