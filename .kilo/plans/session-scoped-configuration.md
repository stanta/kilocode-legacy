# Plan: Session-Scoped Configuration for Kilo Code

## Goal

Make each active session/task have **independent settings** that do not affect parallel sessions:

- Selected model
- Selected provider profile
- Mode/role
- MCP servers
- Skills
- Runtime `apiConfiguration`

## Current Architecture (Problem)

### What is Global (Shared)

| Component | Storage | Access Pattern |
|-----------|---------|----------------|
| **Provider Profile** | `ContextProxy.globalState` + `ProviderSettingsManager` (secrets) | `currentApiConfigName` is global |
| **Mode/Role** | `ContextProxy.globalState("mode")` | Single global value |
| **MCP Servers** | `McpServerManager` singleton → single `McpHub` | All tasks share one hub |
| **Skills** | `SkillsManager` on `ClineProvider` | All tasks share one manager |
| **apiConfiguration** | `ContextProxy` → `ProviderSettings` | Global state, overwritten on switch |

### Key Files

- `src/core/config/ContextProxy.ts` — global state wrapper
- `src/core/config/ProviderSettingsManager.ts` — profiles storage (secrets key: `roo_cline_config_api_config`)
- `src/core/webview/ClineProvider.ts` — owns `mcpHub`, `skillsManager`, `clineStack`
- `src/core/task/Task.ts` — task instance, has `_taskMode`, `_taskApiConfigName`, `apiConfiguration`
- `src/services/mcp/McpServerManager.ts` — static singleton for MCP
- `src/services/mcp/McpHub.ts` — shared connections
- `src/services/skills/SkillsManager.ts` — filesystem-based skill discovery
- `src/core/webview/webviewMessageHandler.ts` — UI message routing

### Current Flow (Problematic)

```
User switches model in UI
  → webviewMessageHandler receives "upsertApiConfiguration"
  → ClineProvider.upsertProviderProfile()
    → contextProxy.setValue("currentApiConfigName", name)     // GLOBAL
    → contextProxy.setProviderSettings(providerSettings)      // GLOBAL
    → providerSettingsManager.setModeConfig(mode, id)         // GLOBAL
    → task.api = buildApiHandler(providerSettings)            // only current task
  → ALL other tasks still read from global state
```

## Target Architecture

### Session Configuration Object

```typescript
// New type in @roo-code/types or src/core/task/types.ts
interface SessionConfiguration {
  taskId: string
  apiConfiguration: ProviderSettings
  apiConfigName: string
  mode: Mode
  mcpServerNames: string[]        // subset of available MCP servers
  skillOverrides?: string[]       // optional: enabled skill names (empty = all)
  createdAt: number
  updatedAt: number
}
```

### What Becomes Session-Scoped

| Component | Current | Target |
|-----------|---------|--------|
| **Model/Provider** | Global `currentApiConfigName` | `Task.sessionConfig.apiConfiguration` |
| **Mode** | Global `mode` | `Task._taskMode` (already exists, make authoritative) |
| **MCP** | Shared `McpHub` | Per-task MCP server **filter** (shared hub, task sees subset) |
| **Skills** | Shared `SkillsManager` | Per-task skill **filter** (shared manager, task sees subset) |
| **apiConfiguration** | Global `ProviderSettings` | `Task.sessionConfig.apiConfiguration` |

### What Stays Global

- Saved provider profiles (templates)
- Saved MCP server definitions (files)
- Discovered skills (filesystem)
- Global defaults for new tasks

## Implementation Plan

### Phase 1: Session Configuration Core

#### 1.1 Add `SessionConfiguration` to Task

**File: `src/core/task/Task.ts`**

- Add field: `private _sessionConfig: SessionConfiguration`
- Initialize in constructor from:
  - `historyItem.sessionConfig` (if resuming)
  - Or snapshot of current global state (if new task)
- Add getter: `get sessionConfig(): SessionConfiguration`
- Add method: `updateSessionConfig(partial: Partial<SessionConfiguration>)`

#### 1.2 Persist Session Config in Task History

**File: `src/core/task/Task.ts`** + **`@roo-code/types`**

- Add `sessionConfig?: SessionConfiguration` to `HistoryItem` type
- On task creation: save initial `sessionConfig` to history
- On session config change: update history item
- On task resume: restore `sessionConfig` from history

#### 1.3 Remove Global State Writes for Session Changes

**File: `src/core/webview/ClineProvider.ts`**

Current (lines 1571-1623):
```typescript
async upsertProviderProfile(name, providerSettings, activate) {
  // ...
  await this.updateGlobalState("currentApiConfigName", name)        // REMOVE for session
  await this.contextProxy.setProviderSettings(providerSettings)      // REMOVE for session
  await this.providerSettingsManager.setModeConfig(mode, id)         // REMOVE for session
  // ...
}
```

New approach:
- `upsertProviderProfile()` — saves profile globally (template), does NOT activate
- `applyProviderProfileToTask(taskId, profileName)` — applies to specific task only
- `setDefaultProviderProfile(name)` — sets global default for NEW tasks only

### Phase 2: Model/Provider Switching

#### 2.1 Task-Scoped Provider Activation

**File: `src/core/webview/ClineProvider.ts`**

Add method:
```typescript
async switchTaskProviderProfile(taskId: string, profileName: string): Promise<void> {
  const task = this.findTask(taskId)
  if (!task) return

  const profile = await this.providerSettingsManager.getProfile({ name: profileName })

  // Update ONLY this task
  task.updateSessionConfig({
    apiConfiguration: profile,
    apiConfigName: profileName,
  })

  // Rebuild task's API handler
  task.api = buildApiHandler(profile)

  // Persist to history
  await this.updateTaskHistoryWithSessionConfig(task.taskId, task.sessionConfig)

  // Notify webview for THIS task only
  await this.postTaskStateToWebview(task.taskId)
}
```

#### 2.2 Remove Global `ProviderProfileChanged` Broadcast

**File: `src/core/task/Task.ts`** (lines 830-850)

Current:
```typescript
provider.on(RooCodeEventName.ProviderProfileChanged, this.providerProfileChangeListener)
```

Change to:
- Remove this listener entirely
- Task's `apiConfiguration` is now authoritative from `sessionConfig`
- Only update if explicitly switched via `switchTaskProviderProfile()`

#### 2.3 Webview Message Handler

**File: `src/core/webview/webviewMessageHandler.ts`**

Add new message type:
```typescript
case "switchSessionProviderProfile": {
  const { apiConfigName, taskId } = message
  const targetTaskId = taskId ?? provider.getCurrentTask()?.taskId
  if (targetTaskId) {
    await provider.switchTaskProviderProfile(targetTaskId, apiConfigName)
  }
  break
}
```

### Phase 3: Mode/Role Switching

#### 3.1 Task-Scoped Mode

**File: `src/core/webview/ClineProvider.ts`** (around line 1451)

Current:
```typescript
await this.updateGlobalState("mode", newMode)  // GLOBAL
```

Change to:
```typescript
async switchTaskMode(taskId: string, newMode: Mode): Promise<void> {
  const task = this.findTask(taskId)
  if (!task) return

  // Update task's mode
  task._taskMode = newMode

  // Update session config
  task.updateSessionConfig({ mode: newMode })

  // Persist to history
  await this.updateTaskHistoryWithSessionConfig(task.taskId, task.sessionConfig)

  // If mode has associated provider profile, apply it to THIS task only
  const savedConfigId = await this.providerSettingsManager.getModeConfigId(newMode)
  if (savedConfigId) {
    const profile = await this.providerSettingsManager.getProfile({ id: savedConfigId })
    if (profile.apiProvider) {
      await this.switchTaskProviderProfile(taskId, profile.name)
    }
  }

  // Notify webview
  await this.postTaskStateToWebview(task.taskId)
}
```

#### 3.2 Webview Message Handler

**File: `src/core/webview/webviewMessageHandler.ts`**

Add:
```typescript
case "switchSessionMode": {
  const { mode, taskId } = message
  const targetTaskId = taskId ?? provider.getCurrentTask()?.taskId
  if (targetTaskId) {
    await provider.switchTaskMode(targetTaskId, mode)
  }
  break
}
```

### Phase 4: MCP Server Isolation

#### 4.1 Per-Task MCP Server Filter

**File: `src/core/task/Task.ts`**

Add to `SessionConfiguration`:
```typescript
mcpServerNames: string[]  // names of MCP servers enabled for this task
```

Initialize with all available servers:
```typescript
// On task creation
const allServers = mcpHub?.getServers().map(s => s.name) ?? []
sessionConfig.mcpServerNames = allServers
```

#### 4.2 Filtered MCP Access

**File: `src/core/task/Task.ts`**

Add method:
```typescript
getFilteredMcpHub(): McpHub | undefined {
  const hub = this.providerRef.deref()?.getMcpHub()
  if (!hub) return undefined

  // Return a wrapper that filters servers by sessionConfig.mcpServerNames
  return new FilteredMcpHub(hub, this.sessionConfig.mcpServerNames)
}
```

**New file: `src/services/mcp/FilteredMcpHub.ts`**

```typescript
class FilteredMcpHub {
  constructor(
    private hub: McpHub,
    private allowedServers: string[]
  ) {}

  getServers() {
    return this.hub.getServers().filter(s => this.allowedServers.includes(s.name))
  }

  // Delegate other methods with filtering...
  callTool(serverName: string, toolName: string, args: any) {
    if (!this.allowedServers.includes(serverName)) {
      throw new Error(`MCP server "${serverName}" not enabled for this task`)
    }
    return this.hub.callTool(serverName, toolName, args)
  }
  // ... etc
}
```

#### 4.3 Update Task MCP Access

**File: `src/core/task/Task.ts`** (line 4143)

Change:
```typescript
mcpHub = await McpServerManager.getInstance(provider.context, provider)
```

To:
```typescript
mcpHub = this.getFilteredMcpHub()
```

#### 4.4 Webview MCP Toggle

**File: `src/core/webview/webviewMessageHandler.ts`**

Add:
```typescript
case "toggleSessionMcpServer": {
  const { serverName, enabled, taskId } = message
  const task = provider.findTask(taskId ?? provider.getCurrentTask()?.taskId)
  if (!task) break

  const current = task.sessionConfig.mcpServerNames
  const updated = enabled
    ? [...current, serverName]
    : current.filter(n => n !== serverName)

  task.updateSessionConfig({ mcpServerNames: updated })
  await provider.updateTaskHistoryWithSessionConfig(task.taskId, task.sessionConfig)
  break
}
```

### Phase 5: Skills Isolation

#### 5.1 Per-Task Skill Filter

**File: `src/core/task/Task.ts`**

Add to `SessionConfiguration`:
```typescript
skillOverrides?: string[]  // if set, only these skills are visible
```

Default: `undefined` means "all skills" (current behavior).

#### 5.2 Filtered Skills in System Prompt

**File: `src/core/prompts/sections/skills.ts`**

Modify `getSkillsSection()`:
```typescript
export function getSkillsSection(
  skillsManager: SkillsManager | undefined,
  mode: string,
  skillOverrides?: string[]  // NEW parameter
): string {
  if (!skillsManager) return ""

  let skills = skillsManager.getSkillsForMode(mode)

  // Apply task-level filter if set
  if (skillOverrides && skillOverrides.length > 0) {
    skills = skills.filter(s => skillOverrides!.includes(s.name))
  }

  // ... rest of existing logic
}
```

**File: `src/core/task/Task.ts`** (line 4233)

Change:
```typescript
provider.getSkillsManager(),
```

To pass filter:
```typescript
provider.getSkillsManager(),
state,
this.sessionConfig.skillOverrides,  // NEW
```

#### 5.3 Webview Skill Toggle

**File: `src/core/webview/webviewMessageHandler.ts`**

Add:
```typescript
case "setSessionSkillOverrides": {
  const { skillNames, taskId } = message
  const task = provider.findTask(taskId ?? provider.getCurrentTask()?.taskId)
  if (!task) break

  task.updateSessionConfig({ skillOverrides: skillNames })
  await provider.updateTaskHistoryWithSessionConfig(task.taskId, task.sessionConfig)
  break
}
```

### Phase 6: Webview State Model

#### 6.1 Dual-Layer State

**File: `src/core/webview/ClineProvider.ts`**

Modify `getStateToPostToWebview()`:
```typescript
async getStateToPostToWebview() {
  const task = this.getCurrentTask()

  return {
    // Global defaults (for settings UI, new task defaults)
    globalDefaults: {
      apiConfiguration: this.contextProxy.getProviderSettings(),
      currentApiConfigName: this.contextProxy.getValue("currentApiConfigName"),
      mode: this.contextProxy.getValue("mode"),
      listApiConfigMeta: await this.providerSettingsManager.listConfig(),
    },

    // Active session (for current task UI)
    activeSession: task ? {
      taskId: task.taskId,
      apiConfiguration: task.sessionConfig.apiConfiguration,
      apiConfigName: task.sessionConfig.apiConfigName,
      mode: task.sessionConfig.mode,
      mcpServerNames: task.sessionConfig.mcpServerNames,
      skillOverrides: task.sessionConfig.skillOverrides,
    } : null,

    // ... other state
  }
}
```

#### 6.2 UI Selectors Read from `activeSession`

**File: `webview-ui/src/components/`**

Update model selector, mode selector, MCP panel, skills panel to read from `state.activeSession` instead of global state.

### Phase 7: Migration

#### 7.1 History Migration

**File: `src/core/task/Task.ts`**

On task resume, if `historyItem.sessionConfig` is missing:
```typescript
if (!historyItem.sessionConfig) {
  // Lazy migration: construct from available data
  sessionConfig = {
    taskId: historyItem.id,
    apiConfiguration: historyItem.apiConfiguration ?? globalDefaults.apiConfiguration,
    apiConfigName: historyItem.apiConfigName ?? globalDefaults.currentApiConfigName,
    mode: historyItem.mode ?? globalDefaults.mode,
    mcpServerNames: allAvailableMcpServers,  // all enabled by default
    skillOverrides: undefined,  // all skills by default
    createdAt: historyItem.ts,
    updatedAt: Date.now(),
  }
}
```

#### 7.2 Backward Compatibility

- Old tasks without `sessionConfig` get migrated on first open
- Global state still written for backward compatibility with extensions that read it
- New session changes do NOT write to global state

### Phase 8: Tests

**New file: `src/core/task/__tests__/session-scoped-config.spec.ts`**

```typescript
describe("Session-scoped configuration", () => {
  it("two tasks maintain independent apiConfiguration", async () => {
    // Create task A with provider X
    // Create task B with provider Y
    // Switch task A to provider Z
    // Assert: task A has Z, task B still has Y
  })

  it("two tasks maintain independent mode", async () => {
    // Create task A in mode "code"
    // Create task B in mode "architect"
    // Switch task A to "debug"
    // Assert: task A is "debug", task B is still "architect"
  })

  it("MCP server filter is per-task", async () => {
    // Task A enables server "github"
    // Task B disables server "github"
    // Assert: task A sees github tools, task B does not
  })

  it("skill overrides are per-task", async () => {
    // Task A has skillOverrides: ["skill-x"]
    // Task B has skillOverrides: undefined (all skills)
    // Assert: task A system prompt only mentions skill-x
    // Assert: task B system prompt mentions all skills
  })

  it("new task gets global defaults", async () => {
    // Set global default to provider X, mode "code"
    // Create new task
    // Assert: task.sessionConfig matches global defaults
  })

  it("changing global defaults does not affect existing tasks", async () => {
    // Create task A
    // Change global default to provider Y
    // Assert: task A still has original provider
  })

  it("task history restores session config", async () => {
    // Create task with specific config
    // Close task
    // Reopen from history
    // Assert: session config matches original
  })
})
```

## File Changes Summary

| File | Changes |
|------|---------|
| `src/core/task/Task.ts` | Add `_sessionConfig`, `updateSessionConfig()`, `getFilteredMcpHub()`, modify `getSystemPrompt()` |
| `src/core/webview/ClineProvider.ts` | Add `switchTaskProviderProfile()`, `switchTaskMode()`, `findTask()`, modify `getStateToPostToWebview()` |
| `src/core/webview/webviewMessageHandler.ts` | Add `switchSessionProviderProfile`, `switchSessionMode`, `toggleSessionMcpServer`, `setSessionSkillOverrides` |
| `src/services/mcp/FilteredMcpHub.ts` | **NEW** — wrapper that filters MCP servers |
| `src/core/prompts/sections/skills.ts` | Add `skillOverrides` parameter to `getSkillsSection()` |
| `@roo-code/types` | Add `SessionConfiguration` interface, add `sessionConfig` to `HistoryItem` |
| `webview-ui/src/components/` | Update selectors to read from `activeSession` |

## Implementation Order

1. **Phase 1**: Session config core (Task, HistoryItem types)
2. **Phase 2**: Model/provider switching
3. **Phase 3**: Mode/role switching
4. **Phase 4**: MCP isolation (FilteredMcpHub)
5. **Phase 5**: Skills isolation (filter parameter)
6. **Phase 6**: Webview state model
7. **Phase 7**: Migration
8. **Phase 8**: Tests

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing sticky profile/mode behavior | Keep sticky behavior but scope it to task, not global |
| MCP server connections are expensive | Share connections, only filter visibility |
| Skills are filesystem-based | Share discovery, only filter at prompt generation |
| Webview state model change | Add `activeSession` alongside existing state, migrate UI gradually |
| History migration | Lazy migration on first open, preserve old fields |

## Token Budget Estimate

| Phase | Input Tokens | Output Tokens |
|-------|-------------|---------------|
| Phase 1-3 (core) | 0.6-1.0M | 0.15-0.3M |
| Phase 4-5 (MCP/Skills) | 0.4-0.7M | 0.1-0.2M |
| Phase 6-7 (UI/Migration) | 0.3-0.5M | 0.08-0.15M |
| Phase 8 (Tests) | 0.2-0.4M | 0.05-0.1M |
| **Total** | **1.5-2.6M** | **0.38-0.75M** |
