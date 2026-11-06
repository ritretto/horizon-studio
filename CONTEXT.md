# HorizonStudio

Среда для распределённой разработки кода: центральный хаб, к которому подключаются агенты на разных машинах и на которых запускаются задачи разработки ПО.

## Language

**Studio** (HorizonStudio):
Центральный хаб (веб-сервер + фронт), который подключается к одному или нескольким Agent, показывает их состояние и общий список Task.
_Avoid_: Hub, сервер, панель

**Agent** (HorizonAgent):
Устанавливаемый процесс на локальной или удалённой машине (Windows/macOS/Linux), к которому подключаются одна или несколько Studio и который выполняет Task. Является источником истины по своим Task и Session.
_Avoid_: Runner, worker, нода, клиент

**Launcher**:
Минимальный, редко меняющийся процесс, который устанавливается на машину один раз, запускает нужную версию Agent и откатывает её на предыдущую, если новая не поднялась.
_Avoid_: updater, supervisor, bootstrap

**Agent Update**:
Замена версии Agent, которую admin инициирует из Studio, загружая сборку в Agent; при неудаче Launcher откатывает её.
_Avoid_: деплой, апгрейд

**Connection**:
Принадлежащая Studio запись о том, как достучаться до конкретного Agent: напрямую (та же машина) или через SSH-туннель, который Studio сама поднимает и поддерживает. Agent доступен только с localhost. Каждый User привязывает к Connection свой Access Token.
_Avoid_: подключение агента, link, endpoint

**User**:
Человек с точки зрения Studio (учётная запись в Studio). Не путать с Member — тот же человек с точки зрения Agent.
_Avoid_: пользователь агента, Member

**Member**:
Человек, известный конкретному Agent, с определённым Access Level. Один и тот же Member может работать с Agent из разных Studio.
_Avoid_: пользователь агента, аккаунт, клиент

**Access Token**:
Секрет, принадлежащий Member, по которому Agent его узнаёт. У Member обычно по одному токену на каждую Studio; токены отзываются по отдельности.
_Avoid_: ключ, пароль, API key

**Access Level**:
Права Member на Agent: `admin` (в т.ч. управление Member и Access Token) или `user`.
_Avoid_: роль, права агента

**Agent Home**:
Рабочая директория Agent (задаётся при запуске или в конфиге), где он хранит свои данные и Task Directory.
_Avoid_: data dir, workdir агента

**Task**:
Единица работы Member на Agent: принадлежит одному Member, содержит одну или несколько Session, может быть поставлена на паузу, завершена и позже удалена. Права доступа проверяются на уровне Task. Задаёт Engine по умолчанию; в простом случае содержит одну Session на этом Engine, в сложном каждая Session настраивается отдельно.
_Avoid_: сессия, скоуп, job, workspace

**Paused** (Task):
Состояние Task, все Session которой корректно остановлены с возможностью продолжить; не продолжается автоматически, в том числе после перезапуска Agent.
_Avoid_: frozen, suspended

**Completed** (Task):
Состояние Task, все Session которой остановлены, а Task Directory и история сохранены для просмотра. Можно переоткрыть в Paused; через 30 дней (настраивается в Agent) Task удаляется безвозвратно.
_Avoid_: archived, closed, done

**Permission Mode**:
Настройка Task, определяющая, как Session обрабатывают запросы Engine на разрешение действий: `ask` (каждый запрос переводит Session в Waiting, по умолчанию) или `auto` (всё разрешается без вопросов). Значение по умолчанию задаёт admin Agent в его конфиге.
_Avoid_: режим безопасности, autonomy level

**Task Directory**:
Отдельная директория внутри Agent Home, создаваемая под каждую Task; в ней работают все Session этой Task.
_Avoid_: workspace, рабочая папка

**Setup Step**:
Настраиваемый предварительный шаг Task, готовящий Task Directory (скачать репозиторий, применить настройки, проверить инструменты). У Task их может быть несколько; по умолчанию нет ни одного, и Task Directory пуста.
_Avoid_: init, bootstrap, хук

**Engine**:
Тип ИИ-инструмента для разработки, который Agent умеет запускать (Claude Code, Codex, Aider).
_Avoid_: ИИ-агент, Provider, Backend, модель

**Engine Credentials**:
Учётные данные, с которыми Session запускает Engine (подписка или API-ключ). Принадлежат паре Member + Engine и хранятся на Agent (настраиваются через Studio); если у Member их нет, используются общие учётные данные Agent, если admin их разрешил.
_Avoid_: ключи, аккаунт ИИ, логин

Current implementation for Claude Code and Codex uses shared credentials configured on the Agent machine under its OS user. Per-Member credentials and login from Studio are future work. Codex is installed as a pinned Agent dependency and updated through Agent Update. Run `npx @openai/codex login` for ChatGPT, `npx @openai/codex login --device-auth` on a headless machine, or `npx @openai/codex login --with-api-key` with the key on stdin. Studio displays readiness and the login method from `account/read`. The credential cache stays on the Agent machine.

A Task selects Claude Code or Codex at creation and keeps that Engine. Existing Tasks use Claude Code. Engine process failure ends the current turn with an error and leaves the Task active. The next user message starts a new process and resumes the saved conversation. This differs from recovery after an Agent restart, which automatically continues a previously interrupted Session. See [ADR 0005](docs/adr/0005-codex-app-server.md) for Codex permission modes and protocol handling.

**Session**:
Конкретный запущенный экземпляр Engine внутри Task, со своей консолью и историей. Живёт на Agent независимо от подключения Studio и переживает перезапуск Agent.
_Avoid_: ИИ-агент, процесс, инстанс

**Waiting** (Session):
Состояние Session, когда Engine ждёт ответа пользователя — на вопрос или на запрос разрешения.
_Avoid_: blocked, idle

**Interrupted** (Session):
Состояние Session, чей процесс умер не по воле пользователя (сбой, перезагрузка); Agent автоматически пытается её продолжить.
_Avoid_: crashed, failed

**Role**:
Назначение Session в многосессионном сценарии (архитектор, ревьюер, тестировщик).
_Avoid_: персона, тип агента
