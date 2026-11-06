# HorizonStudio

An environment for distributed software development: a central hub that connects to agents on different machines, which run software development tasks.

## Language

**Studio** (HorizonStudio):
The central hub (web server and frontend) that connects to one or more Agents and shows their state and a shared list of Tasks.
_Avoid_: Hub, server, panel

**Agent** (HorizonAgent):
An installed process on a local or remote machine (Windows/macOS/Linux) that one or more Studios connect to, and that runs Tasks. It is the source of truth for its Tasks and Sessions.
_Avoid_: Runner, worker, node, client

**Launcher**:
A minimal, rarely changing process installed once on a machine. It starts the right Agent version and rolls back to the previous one if a new version fails to start.
_Avoid_: updater, supervisor, bootstrap

**Agent Update**:
Replacing the Agent version, started by an admin from Studio by uploading a build to the Agent. If it fails, the Launcher rolls it back.
_Avoid_: deploy, upgrade

**Connection**:
A record owned by Studio of how to reach a specific Agent: directly (same machine) or through an SSH tunnel that Studio opens and maintains itself. An Agent is reachable only from localhost. Each User attaches their own Access Token to a Connection.
_Avoid_: agent connection, link, endpoint

**User**:
A person from Studio's point of view (an account in Studio). Not to be confused with Member, which is the same person from an Agent's point of view.
_Avoid_: agent user, Member

**Member**:
A person known to a specific Agent, with a certain Access Level. The same Member can work with an Agent from different Studios.
_Avoid_: agent user, account, client

**Access Token**:
A secret belonging to a Member, by which the Agent recognizes them. A Member usually has one token per Studio; tokens are revoked individually.
_Avoid_: key, password, API key

**Access Level**:
A Member's rights on an Agent: `admin` (including managing Members and Access Tokens) or `user`.
_Avoid_: role, agent rights

**Agent Home**:
The Agent's working directory (set at startup or in the config), where it keeps its data and Task Directories.
_Avoid_: data dir, agent workdir

**Task**:
A unit of a Member's work on an Agent. It belongs to one Member, contains one or more Sessions, and can be paused, completed and later deleted. Access is checked at the Task level. It sets the default Engine; in the simple case it has one Session on that Engine, and in the complex case each Session is configured separately.
_Avoid_: session, scope, job, workspace

**Paused** (Task):
The state of a Task whose Sessions have all stopped cleanly and can be resumed. It does not continue automatically, including after an Agent restart.
_Avoid_: frozen, suspended

**Completed** (Task):
The state of a Task whose Sessions have all stopped, with its Task Directory and history kept for viewing. It can be reopened to Paused. After 30 days (configurable on the Agent) the Task is permanently deleted.
_Avoid_: archived, closed, done

**Permission Mode**:
A Task setting that decides how Sessions handle the Engine's permission requests: `ask` (each request puts the Session in Waiting; the default) or `auto` (everything is allowed without asking). An Agent's admin sets the default in its config.
_Avoid_: safety mode, autonomy level

**Task Directory**:
A separate directory inside the Agent Home, created for each Task. All Sessions of that Task work in it.
_Avoid_: workspace, working folder

**Setup Step**:
A configurable preliminary step of a Task that prepares the Task Directory (download a repository, apply settings, check tools). A Task can have several; by default it has none, and the Task Directory is empty.
_Avoid_: init, bootstrap, hook

**Engine**:
A type of AI development tool that an Agent can run (Claude Code, Codex, Aider).
_Avoid_: AI agent, Provider, Backend, model

**Engine Credentials**:
The credentials a Session starts an Engine with (a subscription or an API key). They belong to a Member and Engine pair and are stored on the Agent (configured through Studio). If a Member has none, the Agent's shared credentials are used, if an admin allows it.
_Avoid_: keys, AI account, login

**Session**:
A specific running instance of an Engine inside a Task, with its own console and history. It lives on the Agent regardless of Studio's connection and survives an Agent restart.
_Avoid_: AI agent, process, instance

**Waiting** (Session):
The state of a Session when the Engine is waiting for the user to answer a question or a permission request.
_Avoid_: blocked, idle

**Interrupted** (Session):
The state of a Session whose process died without the user asking for it (a crash, a reboot). The Agent automatically tries to continue it.
_Avoid_: crashed, failed

**Role**:
The purpose of a Session in a multi-Session scenario (architect, reviewer, tester).
_Avoid_: persona, agent type
