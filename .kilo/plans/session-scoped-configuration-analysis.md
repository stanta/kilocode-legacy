# Анализ плана: Session-Scoped Configuration

## Общий вердикт

План концептуально правильный, но **неполный в критических аспектах**:

1. **Single-open invariant** — система физически не поддерживает параллельные задачи, план этого не учитывает
2. **46+ потребителей глобального apiConfiguration** — план не описывает их миграцию
3. **McpHub без интерфейса** — FilteredMcpHub потребует либо извлечения IMcpHub, либо другого подхода
4. **План смешивает «параллельные окна» (VS Code) с «параллельными задачами» (внутри окна)**

---

## 1. Single-Open Invariant vs «Параллельные Сессии»

### Реальная архитектура

Система **строго запрещает** более одной активной задачи одновременно:

| Точка входа | Single-open? | Механизм |
|---|---|---|
| Пользователь создаёт новый чат | Да | `createTask()` → `removeClineFromStack()` |
| Пользователь открывает из истории | Да | `createTaskWithHistoryItem()` → `removeClineFromStack()` |
| Агент вызывает `new_task` tool | Да | `delegateParentAndOpenChild()` → `removeClineFromStack()` |
| IPC API | Да | `api.startNewTask()` → `removeClineFromStack()` |
| Загрузка webview | Да | `resolveWebviewView()` → `removeClineFromStack()` |
| Dispose провайдера | Да | `dispose()` выталкивает ВСЕ задачи |

`clineStack` может содержать несколько задач, но на практике
**никогда не содержит >1 задачи в production-коде.**

### Что такое «параллельная работа»

Пользователь спросил: «изменение модели в одном окне ведёт к изменению во всех, параллельно работающих».
Это относится к:

1. **Несколько окон VS Code** — разные инстансы Kilo Code в разных окнах VS Code читают один глобальный `ExtensionContext.globalState`/`secrets`
2. **Agent Manager worktrees** — изолированные процессы, уже используют `AGENT_CONFIG`

План описывает «несколько активных задач внутри одного ClineProvider»
(тест: «Create task A with provider X, Create task B with provider Y» — этот тест НЕ может работать
при текущем single-open invariant).

### Что нужно исправить в плане

**Вариант А**: Менять single-open invariant на multi-task — очень сложно, глубокие изменения в UI, webview, таск-менеджменте.

**Вариант Б** (рекомендуемый): Признать, что в рамках одного ClineProvider всегда 1 активная задача.
Фокус: изоляция между **независимыми ClineProvider** (разные окна VS Code), а не между задачами одного провайдера.

При варианте Б:
- Каждый ClineProvider получает свой снимок конфигурации при открытии
- Изменения в одном окне не пишутся в глобальный state
- При создании новой задачи снимок обновляется из глобального дефолта
- Задачи внутри одного провайдера переключаются через снимок (а не глобальный state)
- Agent Manager уже изолирован — менять не нужно

---

## 2. 46 Потребителей Глобального apiConfiguration

План **не упоминает** потребителей глобального apiConfiguration. Исследование нашло **46+ мест в 21+ файле**, которые ломаются:

### Категория 1: Инфраструктура (6 local)
- `ContextProxy.ts:320` — центральный `getProviderSettings()`
- `ClineProvider.ts:2585-2608` — `getState()` агрегация
- `ClineProvider.ts:446,1486,1599,1636,1696,2251,2439,2755,3461` — чтение `currentApiConfigName`

### Категория 2: CLI и Agent Manager (4 local)
- `ExtensionMessengerImpl.ts:17-27` — completions для CLI сессий
- `session-manager-utils.ts:74-76,117-118` — org ID + model
- `AgentManagerProvider.ts:736-744,1668-1669` — конфигурация для spawned agents + model fetching

### Категория 3: Сервисы (3 local)
- `terminalCommandGenerator.ts:154-191` — генерация терминальных команд
- `CommitMessageGenerator.ts:109-158` — генерация commit messages
- `webviewMessageHandlerUtils.ts:140-167` — нотификации при старте

### Категория 4: webviewMessageHandler (10+ local)
- Инициализация, телеметрия, router models, токены, org management, single completion

### Категория 5: Tool contribution tracking (6 local)
- `EditFileTool`, `ApplyDiffTool`, `WriteToFileTool`, `MultiApplyDiffTool`, `kilocode/editFileTool`
- Читают `state?.apiConfiguration?.kilocodeOrganizationId` + `kilocodeToken`

### Категория 6: Code Index и Autocomplete (3 local)
- `ManagedIndexer.ts:161-270` — читает токены из ContextProxy напрямую
- `config-manager.ts:40-76` — хранит Kilo org props
- `AutocompleteModel.ts:63-73` — проверка баланса

### Категория 7: Settings API (2 local)
- `importExport.ts:56,78,80` — импорт/экспорт
- `extension/api.ts:375,450` — REST API

### Категория 8: Prompts и State (3 local)
- `generateSystemPrompt.ts:15-18`
- `kiloWebviewMessgeHandlerHelpers.ts:43-58`
- `getEnvironmentDetails.ts:290`

### Что нужно добавить в план

Для **каждой** категории нужно решение:

- **CLI и Agent Manager**: `ExtensionMessengerImpl` и `session-manager-utils` должны читать из provider-level снимка (не глобального)
- **Терминал и commit messages**: нужно получать apiConfiguration через контекст задачи, а не глобально
- **Contribution tracking в tools**: tools уже имеют доступ к `task.apiConfiguration` — можно переключить на task-level
- **Code Index и Autocomplete**: эти сервисы живут независимо от задач, им нужен глобальный fallback + возможность переопределения через задачу
- **Settings API**: должен остаться глобальным (управление профилями), но не активировать профили глобально

---

## 3. McpHub — Нет Интерфейса

`FilteredMcpHub` из плана потребует одного из:

### Вариант А: Интерфейс IMcpHub (рекомендуется)
```typescript
interface IMcpHub {
  getServers(): McpServer[]
  getAllServers(): McpServer[]
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<McpToolCallResponse>
  readResource(serverName: string, uri: string): Promise<McpResourceResponse>
  isConnecting: boolean
  // + все остальные методы
}
```
McpHub implements IMcpHub, FilteredMcpHub implements IMcpHub.
Все потребители меняют тип с `McpHub` на `IMcpHub`.

**Сложность**: McpHub имеет ~20 методов, ~15 из них потребляются снаружи.
Создание интерфейса — ~100-150 строк кода.

### Вариант Б: Proxy-обёртка (проще, рискованнее)
```typescript
class FilteredMcpHub implements Partial<McpHub> { ... }
```
Без интерфейса, с `as unknown as McpHub` в местах использования.
Не рекомендуется: отсутствие compile-time проверок.

### Вариант В: Фильтрация на уровне серверов (альтернативный подход)
Вместо FilteredMcpHub, предоставить McpHub метод:
```typescript
getServersForTask(taskId: string): McpServer[] {
  const filter = this.sessionConfigs.get(taskId)?.mcpServerNames
  if (!filter) return this.getServers()
  return this.getServers().filter(s => filter.includes(s.name))
}
```

**Рекомендация**: Вариант В проще всего реализовать. Не нужен новый класс или интерфейс.
Добавляем в McpHub `sessionFilter?: Set<string>` и метод `setSessionFilter(filter)`.

---

## 4. Skills — Анализ и Рекомендации

Текущая архитектура Skills проще, чем MCP:
- `SkillsManager` — один на `ClineProvider`
- Skills загружаются из файловой системы
- Нет toggle/settings — всегда все доступны
- Фильтрация только по mode

### Что нужно в плане

- `getSkillsSection()` уже принимает `skillsManager`, `mode` — добавить `skillOverrides` параметр
- UI для переключения skills в сессии
- В webview state добавить `activeSession.skillOverrides`

Это наиболее простая часть плана — уже правильно описана, но без деталей UI.

---

## 5. Неучтённые Сценарии

### 5.1 Перенос задачи между Provider (делегация)
Parent task → child task передача конфигурации.
План не описывает, должен ли child наследовать конфигурацию parent или получать глобальный дефолт.

**Рекомендация**: Child наследует конфигурацию parent (mode, provider), но может переопределить.

### 5.2 Task cancel / dispose
Что происходит с sessionConfig при dispose? Должна ли она сохраняться в истории?
План не описывает.

**Рекомендация**: Сохранять в историю при dispose (текущий механизм уже сохраняет taskHistory).

### 5.3 Переключение workspace (VS Code workspace folders)
При переключении workspace меняется `McpHub` (project-level MCP servers).
План не описывает, как это влияет на session-scoped MCP.

**Рекомендация**: При смене workspace обновлять `mcpServerNames` активного task (удалять серверы из другого workspace, добавлять новые).

### 5.4 Настройки по умолчанию для новых задач
План говорит «глобальные defaults», но не уточняет:
- Откуда берётся default provider при создании новой задачи?
- Откуда берётся default mode?

**Рекомендация**:
- Provider: из `ContextProxy.getValue("currentApiConfigName")` (остаётся глобальным)
- Mode: из `ContextProxy.getValue("mode")` (остаётся глобальным)
- При создании задачи снимается snapshot, дальше задача живёт независимо

---

## 6. kilocode_change Маркеры

Кодовая база требует маркеры `kilocode_change` для всех изменений в общих файлах.
План не упоминает это требование.

**Нужно добавить**: Для каждого изменяемого файла указать, общий ли он (с upstream) и нужны ли маркеры.

---

## 7. Полнота Плана — Оценка

| Аспект | Статус | Проблема |
|--------|--------|----------|
| SessionConfiguration в Task | ✅ | Хорошо описано |
| Persist в taskHistory | ✅ | Хорошо описано |
| Model/Provider switching | ⚠️ | Не учитывает 46 потребителей |
| Mode switching | ⚠️ | Не учитывает потребителей |
| MCP isolation | ⚠️ | FilteredMcpHub требует IMcpHub; проще sessionFilter в McpHub |
| Skills isolation | ✅ | Хорошо описано |
| Webview state model | ⚠️ | Не учитывает single-open invariant |
| Single-open invariant | ❌ | НЕ ОПИСАН — критический пробел |
| 46 потребителей | ❌ | НЕ ОПИСАНЫ — критический пробел |
| CLI / Agent Manager | ❌ | НЕ ОПИСАНЫ |
| Terminal / Commit generators | ❌ | НЕ ОПИСАНЫ |
| Tool contribution tracking | ❌ | НЕ ОПИСАНЫ (6 tools) |
| Code Index / Autocomplete | ❌ | НЕ ОПИСАНЫ |
| Settings API | ❌ | НЕ ОПИСАНЫ |
| Тесты | ✅ | Хорошо описаны, но сценарии нужно скорректировать под single-open invariant |
| kilocode_change маркеры | ❌ | НЕ ОПИСАНЫ |

---

## 8. Скорректированный Token Budget

С учётом неучтённых потребителей:

| Компонент | Входящие | Исходящие |
|-----------|----------|-----------|
| Session config core | 0.3-0.5M | 0.05-0.12M |
| Provider/mode switching | 0.4-0.7M | 0.08-0.18M |
| 46 потребителей миграция | 0.8-1.5M | 0.15-0.35M |
| MCP isolation (sessionFilter) | 0.3-0.5M | 0.06-0.15M |
| Skills isolation | 0.1-0.2M | 0.03-0.06M |
| Webview state model | 0.3-0.5M | 0.06-0.15M |
| Migration | 0.2-0.4M | 0.04-0.10M |
| Tests | 0.3-0.6M | 0.08-0.18M |
| **Total** | **2.7-4.9M** | **0.55-1.29M** |

Реалистичная оценка: **3.5M input / 0.8M output / 4.3M total**

---

## 9. Рекомендации по Доработке Плана

1. **Прояснить single-open invariant**: описать, что «независимость сессий» означает изоляцию между ClineProvider (окна VS Code, Agent Manager), а не между задачами одного провайдера.

2. **Добавить секцию «Миграция потребителей»** для каждой из 8 категорий:
   - Инфраструктура: ClineProvider, ContextProxy, generateSystemPrompt
   - CLI/Agent: ExtensionMessengerImpl, session-manager-utils, AgentManagerProvider
   - Сервисы: terminalCommandGenerator, CommitMessageGenerator, notifications
   - webviewMessageHandler: 10+ local
   - Tools: 6 файлов contribution tracking
   - Code Index: ManagedIndexer, config-manager, AutocompleteModel
   - Settings API: importExport, extension/api

3. **Заменить FilteredMcpHub на sessionFilter в McpHub**: проще, не требует интерфейса.

4. **Добавить обработку**: task делегация (parent→child config), workspace переключение, dispose.

5. **Добавить секцию «kilocode_change маркеры»** для каждого файла.

6. **Скорректировать тесты**: убрать сценарий «two tasks maintain independent apiConfiguration» (невозможно при single-open), заменить на «two ClineProvider instances maintain independent apiConfiguration».
