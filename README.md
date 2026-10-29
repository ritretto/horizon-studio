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
npm run build

npm run dev -w @horizon/agent          # Agent на 127.0.0.1:7400 (HORIZON_AGENT_PORT)
npm run dev -w @horizon/studio         # фронт Studio (Vite)
npm run dev:server -w @horizon/studio  # Studio-сервер на 127.0.0.1:7300 (HORIZON_STUDIO_PORT), отдаёт собранный фронт
```

## Документация

- [CONTEXT.md](CONTEXT.md) — глоссарий терминов
- [docs/spec/mvp.md](docs/spec/mvp.md) — спецификация MVP
- [docs/adr](docs/adr) — архитектурные решения
