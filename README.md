# <img src="assets/icon.png" alt="" width="40" align="top"> HorizonStudio

Среда для распределённой разработки кода с ИИ. **Studio** (веб-интерфейс) подключается к **Agent**'ам на локальных и удалённых машинах (Windows/macOS/Linux) и ведёт на них **Task** с ИИ-инструментами (Engine), например Claude Code. Работа продолжается при отключении Studio и переживает перезагрузку машины.

## Компоненты

- `agent` — сервис на машине; хранит Task и Session, запускает Engine. Доступен только с localhost, удалённо — через SSH-туннель.
- `launcher` — запускает нужную версию Agent и откатывает неудачные обновления.
- `studio` — веб-сервер и фронт; подключение к Agent'ам, Task, чат с Session, обновление Agent.
- `protocol` — общие типы сообщений.

## Разработка

Требуется Node.js 22.18+.

```sh
npm install
npm run typecheck
npm test
npm run build

npm run dev -w @horizon/agent -- --home ./.agent-home  # Agent; Agent Home по умолчанию ~/.horizon-agent
npm run dev:server -w @horizon/studio  # Studio-сервер на 127.0.0.1:7300 (HORIZON_STUDIO_PORT), конфиг --config, по умолчанию ~/.horizon-studio/config.json
npm run dev -w @horizon/studio         # фронт Studio (Vite), /ws проксируется на Studio-сервер
```

### Установка Agent как сервиса

```sh
npm run build
node packages/launcher/dist/launcher.mjs install [--home <Agent Home>] [--agent <сборка Agent, по умолчанию packages/agent/dist>]
node packages/launcher/dist/launcher.mjs uninstall   # Agent Home остаётся
```

`install` кладёт сборку Agent в `<Agent Home>/versions/<версия>` (с `npm install` зависимостей), копирует Launcher в `<Agent Home>/launcher/` и регистрирует пользовательский сервис: на macOS — LaunchAgent `dev.horizon.agent`, на Linux — `systemd --user` `horizon-agent` + `loginctl enable-linger`, на Windows — автозапуск при входе (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, значение `HorizonAgent`), без прав администратора. Launcher запускает версию из `<Agent Home>/current` и перезапускает Agent при падении. Вывод Agent пишется в `<Agent Home>/agent.log`, и при первой установке `install` печатает оттуда Access Token admin. Сервис получает PATH из окружения, в котором выполнен `install`; другие переменные окружения (например, `ANTHROPIC_API_KEY`) в сервис не передаются.

**Agent Update.** Admin нажимает «Обновить» у Agent в Studio: Studio-сервер отправляет на Agent локальную сборку `packages/agent/dist` (`PUT /update`). Agent ставит её в `versions/<версия>-<хэш>`; зависимости общие для сборок с одинаковым набором и лежат в `deps/`. Затем Agent выходит, и Launcher запускает новую версию на пробу. Если за 30 секунд она не начала слушать порт или упала при старте, Launcher откатывается на прежнюю. Результат Studio показывает у Agent. Хранятся текущая и предыдущая версии. Обновить можно только Agent, запущенный через Launcher.

Agent запускает Claude Code через Claude Agent SDK с учётными данными, уже настроенными на машине (`claude` login или `ANTHROPIC_API_KEY`). Task хранятся в `<Agent Home>/tasks/<id>/`: `workspace/` — Task Directory, `sessions/*.jsonl` — журнал событий Session.

При первом старте Agent создаёт Member `admin` и один раз печатает его Access Token. Остальных Member admin создаёт в Studio (кнопка «Member» у Agent): `user` видит только свои Task, `admin` — все; там же выпускаются и отзываются Access Token. Отзыв сразу закрывает открытые по токену соединения; последний токен admin отозвать нельзя. Конфиг — `<Agent Home>/config.json`: `port` (по умолчанию 7400), `defaultPermissionMode` — Permission Mode новых Task, `ask` (по умолчанию) или `auto`; `completedRetentionDays` — через сколько дней завершённая Task удаляется безвозвратно (по умолчанию 30). Подключение — WebSocket с заголовком `Authorization: Bearer <token>`.

Удалённый Agent подключается через SSH: в Connection указываются хост, пользователь, порт SSH и ключ (необязательные поля берутся из `~/.ssh/config` и ssh-agent). Studio поднимает туннель системным `ssh` (нужен в PATH, на Windows — встроенный OpenSSH), держит его и переподключается при обрыве. Ключ должен быть без пароля или загружен в ssh-agent. Ключи хостов Studio хранит в `known_hosts` рядом со своим конфигом и запоминает при первом подключении.

## Документация

- [CONTEXT.md](CONTEXT.md) — глоссарий терминов
- [docs/spec/mvp.md](docs/spec/mvp.md) — спецификация MVP
- [docs/adr](docs/adr) — архитектурные решения
