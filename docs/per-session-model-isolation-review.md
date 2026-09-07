# Проверка изоляции модели между сессиями

## Резюме

Цель проверки: подтвердить, что каждая сессия Kilo Code использует собственную модель и что выбор модели одной сессии не может изменить модель другой.

В кодовой базе существуют два разных жизненных цикла сессий:

1. Обычные sidebar/history-задачи, исполняемые экземплярами [`Task`](../src/core/task/Task.ts:494) внутри [`ClineProvider`](../src/core/webview/ClineProvider.ts:360).
2. Сессии Agent Manager, запускаемые отдельными процессами через [`RuntimeProcessHandler.spawnProcess()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:298).

Для уже запущенных сессий базовая изоляция реализована правильно:

- sidebar-задача хранит собственную копию конфигурации провайдера и модели;
- Agent Manager передает каждой сессии отдельный снимок настроек через переменную окружения и запускает отдельный процесс;
- изменение модели в одном активном процессе не может напрямую изменить память другого процесса.

Но полное требование **пока не гарантируется**. Найдены два сценария, в которых сессия фактически запускается не на своей сохраненной/выбранной модели, и один сценарий рассинхронизации после авторизации.

**Вердикт: Request Changes.** Активная межсессионная изоляция хорошая, но восстановление удаленной сессии и provider-agnostic выбор модели должны быть исправлены до заявления «у каждой сессии всегда своя модель».

## Что реализовано хорошо

### 1. Sidebar-задача владеет собственным снимком модели

Конструктор [`Task.constructor()`](../src/core/task/Task.ts:494) копирует входную конфигурацию на [`Task.apiConfiguration`](../src/core/task/Task.ts:565), а затем создает или восстанавливает версионированный runtime-снимок:

- новая сессия инициализируется в [`Task.createSessionRuntimeConfig()`](../src/core/task/Task.ts:770);
- история восстанавливается в [`Task.createSessionRuntimeConfigFromHistoryItem()`](../src/core/task/Task.ts:797);
- привязка режима содержит полную [`ProviderSettings`](../packages/types/src/history.ts:10), а не только имя общего профиля;
- возвращаемый наружу снимок клонируется в [`Task.cloneSessionRuntimeConfig()`](../src/core/task/Task.ts:823).

Это важнее, чем хранение одного `modelId`: полная конфигурация сохраняет провайдера, модель, reasoning-настройки, endpoint и другие параметры, влияющие на фактический запрос.

### 2. Основной LLM-запрос читает модель из сессии

В [`Task.attemptApiRequest()`](../src/core/task/Task.ts:4698) конфигурация берется через [`Task.getSessionApiConfiguration()`](../src/core/task/Task.ts:861), а запрос отправляется экземпляром API handler текущей задачи в [`Task.attemptApiRequest()`](../src/core/task/Task.ts:5038).

Следствие: изменение global/window defaults после создания задачи не должно менять модель следующего запроса этой задачи.

### 3. Переключение профиля обновляет только текущую задачу

[`ClineProvider.applyRuntimeProviderProfile()`](../src/core/webview/ClineProvider.ts:419) обновляет runtime-снимок текущего окна и binding текущей задачи. Обычная активация профиля в [`ClineProvider.activateProviderProfile()`](../src/core/webview/ClineProvider.ts:2068) по умолчанию не записывает выбранную модель в глобальные defaults.

Это предотвращает прежний класс ошибок, при котором переключение профиля в одной сессии могло менять модель всех задач, читающих общий state.

### 4. Agent Manager обеспечивает сильную process-level изоляцию

При создании Agent Manager сессии:

- снимок настроек получается в [`AgentManagerProvider.getApiConfigurationForCli()`](../src/core/kilocode/agent-manager/AgentManagerProvider.ts:736);
- он передается в [`RuntimeProcessHandler.buildAgentConfig()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:215);
- отдельный процесс создается в [`RuntimeProcessHandler.spawnProcess()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:365);
- JSON-конфигурация передается через `AGENT_CONFIG` в [`RuntimeProcessHandler.spawnProcess()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:367);
- дочерний процесс читает собственную конфигурацию в [`main()`](../packages/agent-runtime/src/process.ts:209) и создает собственный extension host в [`main()`](../packages/agent-runtime/src/process.ts:266);
- state и secrets процесса хранятся в памяти его собственного [`ExtensionContext`](../packages/agent-runtime/src/host/VSCode.ts:949).

Так как процессы не разделяют heap, последующая мутация конфигурации сессии A не может изменить объект конфигурации сессии B.

### 5. Локально зарегистрированная сессия помнит модель при resume

Модель записывается в [`AgentRegistry.createSession()`](../src/core/kilocode/agent-manager/AgentRegistry.ts:57), а для локальной завершенной сессии снова передается при восстановлении в [`AgentManagerProvider.resumeSession()`](../src/core/kilocode/agent-manager/AgentManagerProvider.ts:1465) и [`AgentManagerProvider.resumeSession()`](../src/core/kilocode/agent-manager/AgentManagerProvider.ts:1483).

## Критические и major findings

### Major 1 — Удаленная сессия восстанавливается на текущей модели окна, а не на своей `last_model`

Контракт удаленной сессии уже содержит `last_model` в [`Session`](../src/shared/kilocode/cli-sessions/core/SessionClient.ts:3). Frontend также отображает его как модель сессии в [`toAgentSession()`](../webview-ui/src/kilocode/agent-manager/state/atoms/sessions.ts:106).

Но backend-путь resume теряет это поле:

1. [`RemoteSessionService.fetchSessionDataForResume()`](../src/core/kilocode/agent-manager/RemoteSessionService.ts:83) извлекает `last_mode`, но не извлекает `last_model` в локальный тип ответа.
2. Возвращаемая metadata содержит только mode в [`RemoteSessionService.fetchSessionDataForResume()`](../src/core/kilocode/agent-manager/RemoteSessionService.ts:119).
3. Для remote-only сессии [`AgentRegistry.getSession()`](../src/core/kilocode/agent-manager/AgentRegistry.ts:120) возвращает `undefined`, поскольку remote-сессии существуют только в frontend state.
4. [`AgentManagerProvider.resumeSession()`](../src/core/kilocode/agent-manager/AgentManagerProvider.ts:1483) передает `model: session?.model`, то есть `undefined`.
5. Новый процесс получает текущий снимок основной панели через [`AgentManagerProvider.getApiConfigurationForCli()`](../src/core/kilocode/agent-manager/AgentManagerProvider.ts:736), поэтому фактической моделью становится текущая модель окна.

#### Влияние

- Сессия, созданная на модели A, после перезапуска VS Code может продолжиться на модели B.
- UI может показывать `last_model = A`, тогда как процесс реально использует B.
- Поведение зависит от текущего sidebar-профиля, то есть модель удаленной сессии не является автономной.

#### Рекомендация

Добавить модель в resume metadata и всегда использовать ее как приоритетный источник:

```ts
interface SessionMetadata {
	sessionId: string
	title: string
	createdAt: string
	mode: string | null
	model: string | null
}

const resumeModel = sessionData?.metadata.model ?? session?.model
```

Поле должно заполняться из `last_model` в [`RemoteSessionService.fetchSessionDataForResume()`](../src/core/kilocode/agent-manager/RemoteSessionService.ts:83), передаваться через resume DTO и проверяться тестом remote-only resume.

### Major 2 — Выбранная модель применяется только к `kilocodeModel`, независимо от провайдера

Agent Manager получает список моделей для любого router-провайдера в [`AgentManagerProvider.fetchAndPostAvailableModels()`](../src/core/kilocode/agent-manager/AgentManagerProvider.ts:1652). Однако выбранный model ID применяется так:

```ts
;(config.providerSettings as Record<string, unknown>).kilocodeModel = options.model
```

Эта запись находится в [`RuntimeProcessHandler.buildAgentConfig()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:247).

Для `kilocode` это корректно. Для других поддержанных router-провайдеров фактическое поле модели другое, например `openRouterModelId`, `requestyModelId` или provider-specific model field. В таком случае:

- registry/UI сохраняют новую выбранную модель;
- `kilocodeModel` меняется, но текущий provider его не читает;
- фактический API handler продолжает использовать модель из исходного sidebar-снимка.

#### Влияние

- Сессии формально имеют разные `session.model`, но реально могут работать на одной исходной модели.
- UI и telemetry сообщают модель, которая не совпадает с моделью запроса.
- Требование изоляции нарушается функционально, даже если память процессов изолирована.

#### Рекомендация

Не изменять `kilocodeModel` напрямую. Нужен единый provider-aware helper, являющийся обратной операцией к [`getModelId()`](../src/api/index.ts):

```ts
const providerSettings = applyModelId(options.apiConfiguration, options.model)
```

Helper должен:

1. определить активный `apiProvider`;
2. записать ID в правильное поле этого провайдера;
3. не мутировать входной объект;
4. после построения handler проверить инвариант `handler.getModel().id === requestedModel`;
5. отклонить запуск с понятной ошибкой, если выбранная модель не может быть применена.

### Major 3 — Kilo Code auth callback перезаписывает handler без session model

[`ClineProvider.handleKiloCodeCallback()`](../src/core/webview/ClineProvider.ts:2241) сначала сохраняет профиль с текущей конфигурацией, но затем напрямую заменяет handler текущей задачи в [`ClineProvider.handleKiloCodeCallback()`](../src/core/webview/ClineProvider.ts:2253), передавая только provider и token.

Модель, organization и остальные session-local настройки в этот handler не попадают. При этом [`Task.apiConfiguration`](../src/core/task/Task.ts:565) и persisted runtime могут продолжать указывать исходную модель.

#### Влияние

- после login/callback текущая сессия может отправить запрос на default model;
- runtime metadata и фактический handler расходятся;
- проблема ограничена текущей сессией и не создает прямого cross-session shared state, но нарушает инвариант «сессия использует свою модель».

#### Рекомендация

Удалить ручную замену handler либо строить его из полного session-local снимка:

```ts
const task = this.getCurrentTask()
if (task) {
	task.updateApiConfiguration({
		...task.getSessionApiConfiguration(),
		apiProvider: "kilocode",
		kilocodeToken: token,
	})
}
```

Предпочтительнее оставить один путь обновления через [`ClineProvider.applyRuntimeProviderProfile()`](../src/core/webview/ClineProvider.ts:419), чтобы конфигурация, handler и persisted binding обновлялись атомарно.

## Minor findings и hardening

### Minor 1 — Нет runtime-проверки соответствия requested и effective model

После fork родитель хранит `options.model` в registry, но не получает подтверждение фактической модели от child process. Событие `ready` в [`main()`](../packages/agent-runtime/src/process.ts:280) не содержит effective model.

Рекомендация: child process должен после создания handler вернуть `{ requestedModel, effectiveModel, provider }`. При несовпадении запуск следует завершить ошибкой или явно показать fallback пользователю.

### Minor 2 — Pending session не хранит выбранную модель

[`AgentRegistry.setPendingSession()`](../src/core/kilocode/agent-manager/AgentRegistry.ts:34) не записывает `model`, хотя active session это делает. Фактическая конфигурация не теряется, потому что она есть в [`PendingProcessInfo`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:79), но UI не может достоверно показать модель до события `ready`.

Рекомендация: добавить model в pending schema/state для наблюдаемости и диагностики, не используя его как источник истины для процесса.

### Minor 3 — Изоляция полагается на shallow copy

Основные копии [`ProviderSettings`](../packages/types/src/provider-settings.ts) выполняются через object spread. Для текущей преимущественно scalar-структуры это работает, но вложенные mutable поля могут остаться общими внутри одного процесса.

В Agent Manager это не создает cross-process shared memory, потому что `AGENT_CONFIG` сериализуется JSON. В sidebar runtime стоит либо зафиксировать immutability контракта, либо применять schema parse/structured clone при создании session snapshot.

## Оценка тестового покрытия

Был выполнен focused test run из workspace [`src/package.json`](../src/package.json):

```text
pnpm test core/task/__tests__/Task.sticky-profile-race.spec.ts \
  core/webview/__tests__/ClineProvider.sticky-profile.spec.ts \
  core/webview/__tests__/ClineProvider.sticky-mode.spec.ts \
  core/kilocode/agent-manager/__tests__/AgentManagerProvider.spec.ts \
  core/kilocode/agent-manager/__tests__/startSession-validation.spec.ts
```

Результат:

```text
5 test files passed
106 tests passed
```

Предупреждение окружения:

```text
Expected Node 20.20.0; tests were run on Node 22.20.0.
```

Существующий тест [`Task.sticky-profile-race.spec.ts`](../src/core/task/__tests__/Task.sticky-profile-race.spec.ts:203) хорошо подтверждает, что две sidebar-сессии с одинаковым mode slug хранят разные provider/model/reasoning bindings.

Однако Agent Manager тесты проверяют создание процессов и schema validation, но не доказывают фактическую модель двух параллельных child processes.

## Обязательные дополнительные тесты

1. Создать две Agent Manager сессии с моделями A и B; проверить два независимых `AGENT_CONFIG` и отсутствие мутации первого снимка после запуска второй.
2. В каждом child process построить handler и вернуть effective model; проверить A для первой сессии и B для второй.
3. Повторить тест для как минимум `kilocode` и `openrouter`, чтобы обнаружить hardcoded `kilocodeModel`.
4. Восстановить local session и доказать, что используется `session.model`, а не текущая sidebar-модель.
5. Восстановить remote-only session с `last_model = A`, при текущей sidebar-модели B, и доказать effective model A.
6. Выполнить Kilo Code auth callback при session model A и проверить, что `task.api.getModel().id`, `task.getSessionApiConfiguration()` и persisted runtime по-прежнему согласованы.
7. Проверить отрицательный сценарий: неизвестная/недоступная модель не должна молча заменяться default model.

## Итоговая матрица гарантий

| Сценарий                                                               | Статус                            | Обоснование                                                                       |
| ---------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| Две активные sidebar-сессии с разными моделями                         | Pass                              | Каждая [`Task`](../src/core/task/Task.ts:494) владеет runtime snapshot            |
| Изменение global profile после создания sidebar-задачи                 | Pass                              | Запрос читает [`Task.getSessionApiConfiguration()`](../src/core/task/Task.ts:861) |
| Две активные Agent Manager сессии                                      | Pass по архитектуре               | Отдельные процессы и отдельный serialized config                                  |
| Новая Agent Manager сессия на выбранной Kilo Code модели               | Pass, но без end-to-end assertion | Override записывается в `kilocodeModel`                                           |
| Новая Agent Manager сессия на выбранной модели другого router provider | Fail                              | Override записывается не в provider-specific field                                |
| Resume локальной Agent Manager сессии                                  | Pass                              | Registry model передается в spawn path                                            |
| Resume remote-only Agent Manager сессии                                | Fail                              | `last_model` теряется в backend resume metadata                                   |
| Kilo Code login callback внутри активной sidebar-сессии                | Fail                              | Handler пересоздается без session model                                           |

## Приоритетный план исправлений

1. Протянуть `last_model` через [`RemoteSessionService`](../src/core/kilocode/agent-manager/RemoteSessionService.ts:38) и resume DTO.
2. Заменить hardcoded `kilocodeModel` на provider-aware model override.
3. Удалить token-only rebuild из [`ClineProvider.handleKiloCodeCallback()`](../src/core/webview/ClineProvider.ts:2241).
4. Добавить child-to-parent подтверждение effective model.
5. Добавить multi-session и remote-resume тесты из списка выше.
6. После этого закрепить инвариант: модель сессии определяется один раз при start/resume и изменяется только явной командой, адресованной по `sessionId`.

## Post-fix evidence

The fix centralizes model overrides in [`withModelId()`](../packages/types/src/provider-settings.ts:796), creating an independent provider-settings snapshot and rejecting unsupported selector-only providers. Agent Manager validates the selected model through [`buildApiHandler()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:249) before [`fork()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:388), so a resolved-model mismatch fails visibly instead of falling back.

Resume metadata carries cloud `last_model` as `metadata.model`; [`AgentManagerProvider.resumeSession()`](../src/core/kilocode/agent-manager/AgentManagerProvider.ts:1474) prioritizes it over the local registry. The composed regression drives a remote model A and a conflicting local/sidebar model B through the real [`RuntimeProcessHandler.spawnProcess()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:311) preparation path, then verifies serialized `AGENT_CONFIG` has the Kilo Code-specific `kilocodeModel: A`, rebuilds an API handler from that serialized snapshot to resolve A, and confirms that the pending runtime binding records A. Legacy cloud sessions without `last_model` retain the compatible no-override behavior and emit a dedicated log entry.

[`ClineProvider.handleKiloCodeCallback()`](../src/core/webview/ClineProvider.ts:2242) reads `kilocodeModel` directly for an existing Kilo Code task, rather than relying on the generic [`getModelId()`](../packages/types/src/provider-settings.ts:779) ordering. The regression includes stale `apiModelId: B` alongside `kilocodeModel: A` and verifies that the rebuilt task handler, session configuration, and persisted runtime binding all retain A. The focused fixture is behavior-faithful rather than a real [`Task`](../src/core/task/Task.ts:2006): the suite's common setup mocks [`Task`](../src/core/webview/__tests__/ClineProvider.kilocode-organization.spec.ts:4), so the test explicitly verifies that [`Task.updateApiConfiguration()`](../src/core/task/Task.ts:2006)'s equivalent rebuild and runtime-binding effects occur in the fixture.

Focused regression coverage verifies independent A/B process configurations, non-Kilo Code field mapping, pre-fork mismatch rejection, local/remote/legacy resume behavior, remote-over-local effective configuration, and Kilo Code/non-Kilo Code re-auth handler and runtime metadata consistency.
