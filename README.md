# HorizonStudio

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

Agent запускает Claude Code через Claude Agent SDK с учётными данными, уже настроенными на машине (`claude` login или `ANTHROPIC_API_KEY`). Task хранятся в `<Agent Home>/tasks/<id>/`: `workspace/` — Task Directory, `sessions/*.jsonl` — журнал событий Session.

При первом старте Agent создаёт Member `admin` и один раз печатает его Access Token. Остальных Member admin создаёт в Studio (кнопка «Member» у Agent): `user` видит только свои Task, `admin` — все; там же выпускаются и отзываются Access Token. Отзыв сразу закрывает открытые по токену соединения; последний токен admin отозвать нельзя. Конфиг — `<Agent Home>/config.json`: `port` (по умолчанию 7400), `defaultPermissionMode` — Permission Mode новых Task, `ask` (по умолчанию) или `auto`; `completedRetentionDays` — через сколько дней завершённая Task удаляется безвозвратно (по умолчанию 30). Подключение — WebSocket с заголовком `Authorization: Bearer <token>`.

Удалённый Agent подключается через SSH: в Connection указываются хост, пользователь, порт SSH и ключ (необязательные поля берутся из `~/.ssh/config` и ssh-agent). Studio поднимает туннель системным `ssh` (нужен в PATH, на Windows — встроенный OpenSSH), держит его и переподключается при обрыве. Ключ должен быть без пароля или загружен в ssh-agent. Ключи хостов Studio хранит в `known_hosts` рядом со своим конфигом и запоминает при первом подключении.

## Документация

- [CONTEXT.md](CONTEXT.md) — глоссарий терминов
- [docs/spec/mvp.md](docs/spec/mvp.md) — спецификация MVP
- [docs/adr](docs/adr) — архитектурные решения
