import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

// Пользовательский сервис (ADR 0004): Agent работает от имени пользователя, без прав администратора.
const LABEL = 'dev.horizon.agent';
const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unit = join(homedir(), '.config', 'systemd', 'user', 'horizon-agent.service');
const gui = `gui/${userInfo().uid}`;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** Регистрирует и запускает сервис: `launcher run --home <home>`; повторная установка заменяет прежнюю. */
export function installService(home: string, launcher: string) {
  const command = [process.execPath, launcher, 'run', '--home', home];
  // PATH пользователя — чтобы Engine находил git, node и прочие инструменты так же, как в терминале.
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
      spawnSync('launchctl', ['bootout', `${gui}/${LABEL}`]); // прежняя установка, если была
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
# SIGTERM — только Launcher: он сам штатно останавливает Agent.
KillMode=mixed

[Install]
WantedBy=default.target
`,
      );
      execFileSync('systemctl', ['--user', 'daemon-reload']);
      execFileSync('systemctl', ['--user', 'enable', 'horizon-agent']);
      execFileSync('systemctl', ['--user', 'restart', 'horizon-agent']);
      // Без linger сервисы пользователя живут только пока он залогинен.
      const linger = spawnSync('loginctl', ['enable-linger', userInfo().username]);
      if (linger.status !== 0)
        console.warn(`Не удалось включить linger — Agent не стартует после перезагрузки до входа пользователя.
Выполните: sudo loginctl enable-linger ${userInfo().username}`);
      return;
    }
    case 'win32': {
      // Запуск при входе пользователя: без прав администратора и сохранённого пароля.
      // `start` поднимает Launcher без окна консоли и сразу выходит.
      const start = [process.execPath, launcher, 'start', '--home', home];
      execFileSync('reg', ['add', RUN_KEY, '/v', 'HorizonAgent', '/t', 'REG_SZ', '/d', start.map((a) => `"${a}"`).join(' '), '/f']);
      stopWindows(home);
      spawn(start[0], start.slice(1), { stdio: 'ignore', windowsHide: true });
      return;
    }
    default:
      throw new Error(`установка сервиса на ${process.platform} не поддерживается`);
  }
}

/**
 * Останавливает Launcher вместе с Agent и Engine.
 * ponytail: на Windows штатной остановки нет — дерево процессов завершается жёстко; Session продолжатся при следующем старте (#8).
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
      throw new Error(`установка сервиса на ${process.platform} не поддерживается`);
  }
}
