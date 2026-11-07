# The Launcher runs as a user service, not a system service

The Launcher, and therefore the Agent, runs as the OS user: a LaunchAgent on macOS, `systemd --user` with linger on Linux, and autostart at user login (`HKCU\…\Run`) on Windows. It is not a system service (root / LocalSystem). Engines need a specific user's credentials and environment: `~/.claude`, the git config, SSH keys, PATH. Files in the Task Directory must belong to that user, and installation must not require administrator rights.

## Consequences

On macOS and Windows the Agent starts only after the user logs in, so a dedicated machine needs automatic login.

On Windows, a Task Scheduler task "at system startup" was considered: the Agent would start before login, but creating the task requires administrator rights and the user's saved password, and the task would have to be recreated after a password change. Starting at login was chosen. On Windows the Launcher does not restart by itself if it crashes (launchd and systemd do this on macOS and Linux), and it stops without a graceful Agent shutdown: Sessions continue at the next start.
