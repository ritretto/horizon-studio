import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

// User service (ADR 0004): the Agent runs as the user, without administrator rights.
const LABEL = 'dev.horizon.agent';
const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unit = join(homedir(), '.config', 'systemd', 'user', 'horizon-agent.service');
const gui = `gui/${userInfo().uid}`;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** Registers and starts the service: `launcher run --home <home>`; reinstalling replaces the previous install. */
export function installService(home: string, launcher: string) {
  const command = [process.execPath, launcher, 'run', '--home', home];
  // The user's PATH, so the Engine finds git, node and other tools as it would in a terminal.
  const path = process.env.PATH ?? '';
  switch (process.platform) {
    case 'darwin': {
      const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(home, 'launcher.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, 'launcher.log'))}</string>
</dict>
</plist>
`,
      );
      spawnSync('launchctl', ['bootout', `${gui}/${LABEL}`]); // the previous install, if any
      execFileSync('launchctl', ['bootstrap', gui, plist]);
      return;
    }
    case 'linux': {
      const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
      writeFileSync(
        unit,
        `[Unit]
Description=HorizonStudio Agent

[Service]
ExecStart=${command.map(quote).join(' ')}
Environment=${quote(`PATH=${path}`)}
Restart=always
RestartSec=3
# SIGTERM goes to the Launcher only: it stops the Agent gracefully.
KillMode=mixed

[Install]
WantedBy=default.target
`,
      );
      execFileSync('systemctl', ['--user', 'daemon-reload']);
      execFileSync('systemctl', ['--user', 'enable', 'horizon-agent']);
      execFileSync('systemctl', ['--user', 'restart', 'horizon-agent']);
      // Without linger, user services live only while the user is logged in.
      const linger = spawnSync('loginctl', ['enable-linger', userInfo().username]);
      if (linger.status !== 0)
        console.warn(`Could not enable linger, so after a reboot the Agent will not start until the user logs in.
Run: sudo loginctl enable-linger ${userInfo().username}`);
      return;
    }
    case 'win32': {
      // Start at user login: no administrator rights or saved password needed.
      // `start` launches the Launcher with no console window and exits at once.
      const start = [process.execPath, launcher, 'start', '--home', home];
      execFileSync('reg', ['add', RUN_KEY, '/v', 'HorizonAgent', '/t', 'REG_SZ', '/d', start.map((a) => `"${a}"`).join(' '), '/f']);
      stopWindows(home);
      spawn(start[0], start.slice(1), { stdio: 'ignore', windowsHide: true });
      return;
    }
    default:
      throw new Error(`service installation is not supported on ${process.platform}`);
  }
}

/**
 * Stops the Launcher together with the Agent and Engine.
 * ponytail: Windows has no graceful stop, so the process tree is killed; Sessions continue at the next start (#8).
 */
function stopWindows(home: string) {
  const pid = join(home, 'launcher.pid');
  if (existsSync(pid)) spawnSync('taskkill', ['/PID', readFileSync(pid, 'utf8').trim(), '/T', '/F']);
}

export function uninstallService(home: string) {
  switch (process.platform) {
    case 'darwin':
      spawnSync('launchctl', ['bootout', `${gui}/${LABEL}`]);
      rmSync(plist, { force: true });
      return;
    case 'linux':
      spawnSync('systemctl', ['--user', 'disable', '--now', 'horizon-agent']);
      rmSync(unit, { force: true });
      spawnSync('systemctl', ['--user', 'daemon-reload']);
      return;
    case 'win32':
      spawnSync('reg', ['delete', RUN_KEY, '/v', 'HorizonAgent', '/f']);
      stopWindows(home);
      return;
    default:
      throw new Error(`service installation is not supported on ${process.platform}`);
  }
}
