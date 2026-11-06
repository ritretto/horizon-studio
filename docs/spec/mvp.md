# HorizonStudio: MVP

For terms, see [CONTEXT.md](../../CONTEXT.md). For key decisions, see [docs/adr](../adr).

## Goal

One person runs Studio on their machine, connects one or more Agents to it (local or remote) and runs Tasks on them with Claude Code: creates them, switches between them, answers questions and permission requests, pauses and completes them. Work is not lost when Studio closes, a tunnel drops or the Agent's machine reboots.

## Components

- **Agent**: a Node.js service for Windows/macOS/Linux. It listens only on `127.0.0.1` and keeps all its state in the Agent Home.
- **Launcher**: a minimal process that starts the current Agent version and rolls back a failed update. It is installed together with the first Agent version.
- **Studio**: a web server and frontend that runs locally, for a single user, with no login and no database (a config file).
- **protocol**: a shared package with the message types between the Agent, the Studio server and the frontend.

## Technology

- TypeScript, Node.js 22+, npm workspaces: `agent`, `launcher`, `studio`, `protocol`.
- **Studio ↔ Agent protocol**: one HTTP port per Agent. A WebSocket with JSON messages `request {id, method, params}` / `response {id, result | error}` / `event {sessionId, seq, ...}`. The Access Token is passed when the connection opens. Session events have a running `seq` and are written to the Session log. `subscribe {sessionId, fromSeq}` delivers the history and then streams new events. The bundle for an Agent Update is uploaded with HTTP `PUT /update`, with the token in a header.
- **Studio**: the browser talks only to the Studio server (`node:http` + `ws`). The Studio server holds Connections, SSH tunnels and Access Tokens, and relays requests and events, adding `agentId`. The frontend is React + Vite.
- **Launcher** runs as a user service (as the OS user, with no administrator rights): LaunchAgent on macOS, `systemd --user` + `loginctl enable-linger` on Linux, autostart at user login on Windows (`HKCU\…\Run`). Installation: `horizon-launcher install` / `uninstall`. On macOS and Windows the Agent starts only after the user logs in (a dedicated machine needs automatic login).

## Requirements

### Agent: installation and access
1. The Agent Home is set with a startup flag or in the config.
2. On first start the Agent creates a Member with the `admin` level and prints their Access Token.
3. Every connection authenticates with an Access Token; without a valid token the connection is closed.
4. An admin can create Members (`admin` | `user`), issue them new Access Tokens and revoke tokens one at a time.

### Studio: Connection
5. The user adds a Connection: local (`127.0.0.1:port`) or through an SSH tunnel (host, user, key, the Agent's remote port), plus an Access Token.
6. Studio opens the SSH tunnel itself, keeps it open and reconnects after a drop.
7. Studio shows each Agent's state: online/offline, version, available Engines.
8. Studio shows a shared list of Tasks from all connected Agents, marking which Agent each one lives on.

### Task and Session
9. The Agent is the source of truth for Tasks and Sessions. Studio does not store them.
10. Creating a Task: a name, an Engine (Claude Code in the MVP), a Permission Mode (`ask` | `auto`; the default comes from the Agent config, initially `ask`). An empty Task Directory in the Agent Home and one Session are created.
11. A Member with the `user` level sees only their own Tasks; an `admin` works with their own and sees all.
12. A Session works with the Engine through a structured protocol (Claude Agent SDK), not a PTY. Studio shows it as a chat: messages, tool calls, permission requests.
13. A Session keeps working when Studio disconnects. On connecting, Studio gets the Session history and then a real-time stream of events. Several Studios can watch one Session at the same time.
14. A Session goes to Waiting when the Engine asks a question or (in `ask` mode) requests permission; the user answers from Studio.
15. **Pause**: all Sessions of a Task stop cleanly, keeping the Engine's conversation id. **Resume** continues them. A Paused Task does not continue automatically.
16. **Complete**: Sessions stop, the Task goes to Completed, and the Task Directory and history are kept. A Completed Task can be reopened to Paused. After 30 days (configurable in the Agent config) the Task is permanently deleted; its owner or an admin can delete it sooner.

### Reliability
17. After an Agent restart (a crash, a reboot, an update), Sessions that were working become Interrupted and continue automatically through resume, with a service message: "A failure interrupted you. Check the state, fix what is needed and continue. If you cannot, ask the user."

### Engine
18. The Agent automatically detects available Engines and their status (`ready` | `not installed` | `no credentials`) and reports them to Studio.
19. In the MVP, an Engine works with the credentials already set up on the machine (shared by all Members).

### Agent Update
20. An admin uploads a locally built Agent bundle from Studio. The Agent saves it in `Agent Home/versions/<version>` and restarts on the new version through the Launcher.
21. If the new version does not confirm it is working within N seconds, the Launcher rolls back to the previous one. Studio shows the update result.

## Out of MVP scope
Setup Steps; sharing Tasks; Roles and Tasks with several Sessions; per-Member Engine Credentials and configuring them from Studio; Engines other than Claude Code; logins and several Users in Studio; audit; TLS; a separate shell console in the Task Directory; notifications about Waiting outside Studio; viewing files and diffs in the Task Directory; streaming the window of the app being developed, with control (a separate channel, most likely WebRTC).
