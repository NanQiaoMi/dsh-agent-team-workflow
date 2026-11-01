# 02 · DSH Host 插件 API 事实手册（逆向取证版）

> 目标：给 `agentteam-kit` bundle 的实现者一份**可直接照抄、逐条带证据**的 Host 侧 API 事实。
> 环境：DSH Desktop `0.2.1-rc.2`，profile `121`（`~/.dsh/profiles/121`）。
> 结论优先，证据在后。找不到的写「未找到/未验证」，不做推测性断言。

## 0. 取证方式与路径简写

本文件所有 `文件:行号` 都基于下面四个前缀（shell 可读、已验证）：

| 简写 | 绝对路径 |
|---|---|
| `APP` | `/Applications/DSH Desktop.app/Contents/Resources/app` |
| `PKG` | `APP/node_modules/@deepseek-ai` |
| `SKILL` | `PKG/dsh-agent-preset/skills/cordis-plugin-development` |
| `CAT` | `PKG/dsh-tool-cordis/lib/types/api-catalog.js` |

三条必须先知道的取证事实：

1. **本安装没有 `.d.ts`**：`find PKG -name '*.d.ts' | wc -l` → `0`。`package.json#types` 指向的 `lib/types/index.d.ts` 全部不存在。
   实际类型证据来自两处：① 每个包 `lib/types/*.js` 里保留的 JSDoc + 运行时实现；② `CAT` —— 由 `scripts/gen-cordis-api.ts` 从源码 AST 生成的**权威 API 目录**（`CAT:1-11` 自述），含全部 `Service`/`Event`/`Type` 的 TypeScript 声明字符串。
2. **`CAT` 就是 `cordis_inspect_query` 背后的同一份数据**：`PKG/dsh-tool-cordis/lib/types/providers.js:1-3` `import { EVENT_API, queryEventApi, queryServiceApi } from "./api-catalog.js"`。所以直接读 `CAT` 与调用 inspect 等价，且能拿到行号。
3. **live 证据已经取到**：`Tool.listTools`（无参）返回中包含本团队骨架注册的 `team_workflow_info`；`plugin_manager list_plugins` 返回 `include:agent-team-workflow / fiberPhase: active`（详见 §G.2）。下文凡标「live inspect」的签名均来自本机实际调用。

---

## A. 工具注册（`ctx.tools.register`）

### A.1 结论

| 问题 | 答案 |
|---|---|
| 签名 | `register(definition: ToolDefinition): () => void`（`CAT:3358`；实现 `PKG/dsh-tools/lib/types/index.js:468-489`） |
| 参数 schema 用什么库 | **都不是**。`register()` 收的是**已编译好的原始 JSON Schema**（`ToolSchema.parameters: Record<string, unknown>`，`CAT:8255`）。`zod`/`schemastery` 都不用于工具参数。`schemastery` 只用于插件 `Config`；`defineTool` 的 TS 友好 DSL 属于 `dsh-tools` 包内工具（`PKG/dsh-tools/lib/types/schema.js:274`） |
| `execute` 形状 | `execute(args: unknown, exec: ToolRunContext): Promise<unknown>`，返回值 = **规范化 JSON 值**（不是 `{content}`） |
| 结果如何给模型 | 注册表先 `validateJsonSchemaValue(output.schema, value)`，再 `output.render(args, value) → ContentBlock[]`（`index.js:1198-1230`） |
| 紧凑 JSON 结果 | `output.schema` 声明对象根 + `render: (_a,v) => [{type:'text', text: JSON.stringify(v)}]`（官方实现 `PKG/dsh-experimental-tool-agent-team/lib/index.js:211-219`） |
| 按 Agent 作用域注册 | 在 `agent.ctx` 上 `register()`；用 `agent/created` 事件 + `ctx.agents.list()` 补装；在插件 `ctx.effect` 里兜底拆除（完整范式 `.../tool-agent-team/lib/index.js:227-554`） |

**关键差异（容易踩）**：`register()` **不校验 `parameters`**。它只校验 `output` 形状、`output.schema` 是否在受支持子集内、`timeoutMs`、以及名字不能是保留的 `run_code`（`index.js:468-489`）。参数校验只在 `defineTool` 生成的 `execute` 包装里发生（`schema.js:315-320` + `schema.js:297`）。所以**用裸 JSON Schema 注册时，args 校验必须自己写在 execute 里**。

### A.2 完整字段（`CAT:8151`、`CAT:8255`、`CAT:8211`、`CAT:8243`）

```ts
interface ToolSchema { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown> }

interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition;
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  projectContent?(exec, result): ContentBlock[] | undefined;
  finalizeContent?(exec, result): ContentBlock[] | undefined;
  timeoutMs?: number;                       // 仅声明，注册表不强制执行
  isConcurrencySafe?(args: unknown): boolean;
  presentCall?(args: unknown): ToolCallView | undefined;      // Host 本地展示，Web 不消费
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}

interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode;                                   // 返回值契约（必填）
  render(args: unknown, value: JsonValue): ContentBlock[];           // 喂给模型的内容（必填）
  presentationMeta?(args: unknown, value: JsonValue): JsonValue;     // 可选 meta
}

// execute 收到的第二个参数
interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void;
  concludeTurn(): void;
}
interface ToolExecution extends ToolExecutionInput {
  readonly rootCallId: ToolCallId; readonly token: ToolExecutionToken;
}
interface ToolExecutionInput {
  readonly callId: ToolCallId; readonly rootCallId?: ToolCallId;
  readonly name: string; readonly schema?: ToolSchema;
  readonly arguments: unknown;
  readonly agent?: Agent;          // ← 调用方 Agent；Agent 作用域注册时必定存在
  readonly parent?: ToolExecutionToken;
  readonly signal: AbortSignal;    // ← 必须协作式观测
}
```

`output` 三项都是**硬校验**：缺 `output`/`render` 直接抛
``tool "${name}" must declare output { schema, render, presentationMeta? }``（`index.js:471-475`）。
返回值不合 `output.schema` → `ToolOutputError`，code `INVALID_TOOL_OUTPUT`（`index.js:77-82`, `:1200`）。
渲染或投影抛异常 → 同样折叠成 `INVALID_TOOL_OUTPUT`（`index.js:87-96`）。

`JsonSchemaNode` 受支持子集（`CAT:5799`，实现 `PKG/dsh-tools/lib/types/json-schema.js`）：
`type`(object/array/string/number/integer/boolean/null) · `oneOf`（恰好匹配一支）· `properties` · `required` · `additionalProperties`(boolean，**object 必须显式给**) · `items` · `enum` · `const` · `description`/`title`/`default`/`examples`。其余关键字会被拒绝（`UNSUPPORTED_SCHEMA`）。

### A.3 最小可运行样例（零 import，适配 `link:` 工作区包 —— 见陷阱 T1）

```js
/** output 契约：紧凑 JSON，一个 text block 装序列化值。 */
function jsonOutput(schema) {
  return { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
}

const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' }, revision: { type: 'integer' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    ready: { type: 'boolean' }, ownerName: { type: 'string' },
  },
  required: ['id', 'revision', 'status', 'ready'],
}

const dispose = ctx.tools.register({
  name: 'team_probe',
  description: 'Report the calling member and one shared task.',
  // ← 裸 JSON Schema；注册表不校验，模型侧照样看到精确 schema
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { task_id: { type: 'string', description: 'Shared task id.' } },
    required: ['task_id'],
  },
  output: jsonOutput(TASK_VIEW_SCHEMA),
  async execute(args, exec) {
    if (typeof args?.task_id !== 'string') throw new Error('task_id must be a string') // 自己校验
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_probe requires a calling Agent')
    return ctx.agentTeams.getTask(agent, args.task_id)
  },
})
// dispose() 注销；在 apply 内注册时，插件卸载会自动回收（Cordis fiber effect）
```

### A.4 作用域：全局 ctx vs `agent.ctx`

- **全局（插件自己的 `ctx`）**：对所有 Agent 可见、可调用。适合"人人都该有"的工具。
- **Agent 作用域（`agent.ctx`）**：只对该 Agent 可见；同层重名会抛
  ``tool "x" is already registered in this scope``（`index.js:178-180`），而**作用域注册会遮蔽全局同名工具**（`index.js:463`「Scoped tools shadow globals」）。
- `restrict()` **只能在 `agent.ctx` 上用**，在全局 ctx 上直接抛
  ``tools.restrict() requires a scoped context (agent.ctx)``（`index.js:497-500`）。
- 判断"这个 Agent 归我们管"：`ctx.agentTeams.tryMembership(agent) !== undefined`（**不要**用 `membership()`，非成员会抛 `TEAM_NOT_MEMBER`，见 `PKG/dsh-experimental-agent-team/lib/index.js:860-864`）。

官方 per-agent 安装范式（逐行可抄，`PKG/dsh-experimental-tool-agent-team/lib/index.js`）：

```js
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']   // :9-14

export function apply(ctx, config = {}) {
  const installed = new Map()
  const maybeInstall = (agent) => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return  // :538-541
    installed.set(agent, install(agent, ctx, resolved))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)                              // :542
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })                         // :543-545
  ctx.on('agent/disposed', ({ agent }) => { installed.get(agent)?.(); installed.delete(agent) }) // :546-549
  ctx.effect(() => () => {                                                               // :550-553
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team.scopedTools()')
}

function install(agent, ctx, config) {
  const scoped = agent.ctx            // :228 ← Agent 作用域注册边界
  const disposers = []
  try {
    disposers.push(scoped.tools.register({ /* ... */ }))
    // 出错时反序拆除，避免半装
  } catch (error) { for (const d of disposers.reverse()) d(); throw error }
  return () => { for (const d of disposers.reverse()) d() }
}
```

为什么**两个 owner 都要留 disposer**：`agent.ctx` 上的注册在 Agent 销毁时回收；但插件卸载**不会**连带销毁 `agent.ctx`（`SKILL/references/practices.md:8`、`:19`）。所以既挂 `agent/disposed`，又在插件 `ctx.effect` 里兜底。

---

## B. 系统提示注入（`ctx.systemPrompt`）

### B.1 结论

| 问题 | 答案 |
|---|---|
| API | `section(PromptSection): () => void`、`context(PromptContext): () => void`、`variable(name, provider)`、`tools(provider)`、`suppressRuntimeContext()`、`assemble()`（`CAT:3089-3122`） |
| 字段 | 只有 `name / order / text / interpolate? / complete?`（section）与 `name / order / text / interpolate? / required?`（context）。**没有** `audience` / `scope` / `priority` / `role` 字段 |
| 作用域怎么定 | 由**注册所在的 ctx** 决定：插件 ctx = 全局；`agent.ctx` = 只影响该 Agent，且**同名遮蔽全局**（`PKG/dsh-system-prompt/lib/index.js:249-252`） |
| 回调里能拿到 Agent 吗 | **不能**。`text` 函数收到的是 `AssembleContext { scope?: ScopeKey; signal?: AbortSignal }`（`CAT:4779`）；`AssembleContext.scope` 只是 scope key。要按 Agent 定制只能**闭包捕获 agent**（官方 `team:identity` 就是这么做的） |

`PromptSection` / `PromptContext`（`CAT:6495` / `CAT:6479`）：

```ts
interface PromptSection {
  readonly name: string;                                    // 同层重名 → 抛错
  readonly order: number;                                   // 必须有限数（:253-255）
  readonly text: string | ((context: AssembleContext) => string);
  readonly interpolate?: boolean;                           // false → 原样保留 {{...}}
  readonly complete?: boolean;                              // 成为"精确完整提示词"，仅允许 1 个
}
interface PromptContext { /* 同 section，but required?: boolean 替代 complete */ }
interface PromptAssembly { sections: AssembledSection[]; contexts: AssembledContext[]; tools: ToolSchema[]; variables: Record<string, string | undefined> }
```

**排序**：段按 `order` 升序拼接，同值再按 name 的代码单元序（`PKG/dsh-system-prompt/README.zh.md`「贡献提示词段」）。
第一方位置用 `ctx.systemPrompt.getSectionOrder(name)` / `getContextOrder(name)` 取，**不要硬编码**：

```
SECTION_ORDERS   (PKG/dsh-system-prompt/lib/index.js:10-41)
  HARNESS_IDENTITY -1000 · DEPLOYMENT_PERSONA_PREFIX 0 · PLAN_POLICY 500 · TEAM_POLICY 600
  PTC_ONLY 800 · FILE_REFERENCE 900 · TOOL_BASH 1000 … TOOL_SUBAGENT 2800
  MCP_SERVERS 3100 · TOOLS_SDK 5000 · DELIVERABLE_FILE_REFERENCES 9000
  STRUCTURED_OUTPUT 9900 · HARNESS_SOURCE 10000 · WEB_SURFACE 10100 · DEPLOYMENT_PERSONA_SUFFIX 10200

CONTEXT_ORDERS   (同文件 :44-51)
  WORKING_DIRECTORY 100 · SANDBOX_POLICY 110 · APPROVAL_POLICY 115
  SUBAGENT_DELEGATION 120 · TEAM_IDENTITY 125 · HARNESS_SOURCE 200 · WEB_SURFACE 210
```

注入**协作策略**的最小样例（Team 成员专用，官方同构版见 `tool-agent-team/lib/index.js:234-249`）：

```js
// 在 install(agent, ctx, config) 内，scoped = agent.ctx
scoped.systemPrompt.section({
  name: 'team:workflow',
  order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),   // = 600
  text: `Agent Team Workflow v1.0.0 is active.
- Plan on the shared task board before writing code; declare write_scopes.
- Each work item gets at most ${config.maxReviewRounds} review rounds, then Lead arbitration.
- Artifacts go to ${config.artifactsDir}/ (board.json + report.md).`,
})

// 按当前 Agent 定制：注册在 agent.ctx + 闭包读 membership
scoped.systemPrompt.context({
  name: 'team:workflow-role',
  order: scoped.systemPrompt.getContextOrder('TEAM_IDENTITY'),  // = 125
  required: true,                                               // 不受 suppressRuntimeContext 影响
  text: () => {
    const { role, name } = ctx.agentTeams.membership(agent)
    return role === 'lead'
      ? `You are the Team Lead ("lead"). You own review arbitration and final verification.`
      : `You are teammate "${name}". Report to "lead"; do not reassign or spawn.`
  },
})
```

变量与工具 schema（可选）：
`ctx.systemPrompt.variable('review_round', () => String(round))` → 文本里写 `{{review_round}}`；名字必须匹配 `/^[a-z][a-z0-9_]*$/`（`lib/index.js:63`, `:310-315`）。`tools(provider)` 一般不用：`ToolRuntime` 已自动注册自己的 provider（README `贡献工具 schema`）。
文本里若要原样保留 `{{...}}`（例如写文档示例），必须 `interpolate: false`，否则未解析变量会让**组装失败**（`lib/index.js:165`、README「贡献提示词变量」）。

**一次性注入 vs 每步提示词**：如果只是"告知一次某件事"（例如"Lead 已指派你处理 task-3"），用 `agent.inject(message)`：`send(input,'next-step',false)`，进下一步但不唤醒 Agent（`PKG/dsh-agent-loop/lib/index.js:806-814`；`practices.md:18`、`:29`）。常驻规则才用 `section()`。

---

## C. `ctx.agentTeams`（`PKG/dsh-experimental-agent-team`）

### C.1 方法签名（live inspect `Service.listService`；类型 `CAT` 同源）

```ts
membership(agent: Agent): TeamMembership                                  // 非成员抛 TEAM_NOT_MEMBER
listMembers(agent: Agent): TeamMemberView[]                               // 含 Lead 行
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>
getTask(caller: Agent, id: TeamTaskId): TeamTaskView
listTasks(caller: Agent): TeamTaskView[]
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>
async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>
interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' }
tryMembership(agent: Agent): TeamMembership | undefined
```

`TeamMembership`（`CAT:7959`）：

```ts
interface TeamMembership { readonly root: Agent; readonly id: TeamId; readonly role: 'lead' | 'teammate'; readonly name: string }
```

`TeamMemberView`（`CAT:7963`）—— roster 行：

```ts
interface TeamMemberView {
  readonly id: SessionId; readonly name: string; readonly role: 'lead' | 'teammate';
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed';
  readonly description?: string; readonly provider?: string;
  readonly context?: 'fresh' | 'fork'; readonly model?: string;
  readonly diagnostics: string[];
}
```

`status` 语义（README「Teammate」）：`running` 有轮次在跑；`inactive` 当前无执行轮次（**包含已加载和仅存储的成员**，不代表任务完成/失败/在等别人）；`provisioning` 创建中；`failed` 创建失败。

### C.2 创建与消息（`CAT:7635/7639/6907/6911`）

```ts
interface SpawnTeammateRequest {
  readonly name: string;            // 唯一 lower-kebab-case；失败也占名，永不复用
  readonly description: string;
  readonly prompt: ContentBlock[];  // 常用 [{ type:'text', text:'...' }]
  readonly context: 'fresh' | 'fork';
  readonly provider: string;        // 'spawn' | 'fork'（由 tool-agent-team Config freshProvider/forkProvider 给出）
  readonly signal: AbortSignal;
}
interface SpawnTeammateResult { readonly member: TeamMemberView }

interface SendTeamMessageRequest { readonly target: string; readonly content: ContentBlock[]; readonly signal: AbortSignal }
interface SendTeamMessageResult { readonly messageId: MessageId }
```

- `target` 用成员 **name**（`modelMember` 把 `vertex: {id,name,...}` 投影成 `{target: name, ...}`：`tool-agent-team/lib/index.js:76-82`），不是 session id。
- 发送成功 = 目标 inbox 接收，**不等于**模型已处理（README「teammate 之间的消息」）。
- 只有 Lead 能 spawn / reassign / interrupt（README「成功与失败的表现」）。

### C.3 共享任务板（`CAT:5199/8475/7967/7979/7983`）

```ts
interface CreateTeamTaskRequest {
  readonly subject: string; readonly description: string;
  readonly blockedBy?: readonly TeamTaskId[];
  readonly writeScopes?: readonly string[];       // 工作区相对路径前缀，仅"提示"
}
type TeamTaskAction = 'claim' | 'release' | 'edit' | 'set_dependencies' | 'complete' | 'reopen' | 'reassign' | 'delete'
interface UpdateTeamTaskRequest {
  readonly taskId: TeamTaskId;
  readonly expectedRevision: number;              // CAS：过期副本被拒
  readonly action: TeamTaskAction;
  readonly subject?: string; readonly description?: string;
  readonly blockedBy?: readonly TeamTaskId[]; readonly writeScopes?: readonly string[];
  readonly owner?: string;                        // 仅 reassign 用；省略 = 取消 assign
}
type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'
interface TeamTaskView {
  readonly id: TeamTaskId; readonly revision: number;
  readonly subject: string; readonly description: string;
  readonly status: TeamTaskStatus;
  readonly blockedBy: TeamTaskId[]; readonly writeScopes: string[];
  readonly ownerName?: string;
  readonly ready: boolean;                        // 全部 blockedBy 都完成才 true；ready ≠ 会唤醒 owner
  readonly writeScopeWarnings: string[];          // 两个 in_progress 任务路径重叠的告警，永不阻断
}
```

`TeamTaskId`（`CAT:7971`）/ `TeamId`（`CAT:7955`）是 `Branded<'...'>`。把 string 变 id：包导出了 `TeamTaskId` 铸造函数（`tool-agent-team/lib/index.js:2` `import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'`，用法 `:394`）。**零 import 插件**无法导入它——见陷阱 T1 的应对（`ctx.agentTeams.getTask` 会自行接受字符串形式的 id；实测官方工具自己也只做 `TeamTaskId(args.task_id)`，即恒等转换）。

### C.4 等待与中断

```ts
interface TeamWaitResult { readonly timedOut: boolean }
interrupt(caller, targetName): { previousStatus: 'running' | 'inactive' }
```
`waitForChange` **只报告是否超时**，调用方必须重读状态；**不会唤醒** inactive 成员；当没有其它 running/provisioning 成员时不会产生任何变化 —— 官方工具因此在调用前先 `listMembers()` 检查并直接返回 `noProgress`（`tool-agent-team/lib/index.js:31-32`, `:337-349`）。

### C.5 `Agent` 与 `ctx.agents`

```ts
export interface Agent { readonly id: SessionId }        // CAT:4643 —— 公开契约只有 id
```
**运行时实际形状**（`PKG/dsh-agent-loop/lib/index.js:747-790`，类 `ReactLoopAgent`）：
`loopCtx, id, options, session, inbox, phase, activityDone, scope, ctx, dispatch, requestSurfaceGeneration, runtimeContext, systemPrompt, status(getter)` + 方法 `send/followup/steer/inject/cancel/runMaintenance/whenIdle`。
其中最关键的是 **`agent.ctx`**（`:779-780` `this.ctx = this.scope.ctx`）—— 这就是 per-Agent 注册边界（官方包 `tool-agent-team/lib/index.js:228` 直接用 `agent.ctx`）。
因此：动态读 `agent.session` / `agent.status` 可行，但**别把它写进持久契约**；跨版本稳定的是 `id`、`ctx`、`session`。

`ctx.agents`（`PKG/dsh-agent/lib/...`，签名见 live inspect；描述取自 `CAT` 的 service 目录）：

| 方法 | 语义 |
|---|---|
| `list(): Agent[]` | 所有 live agent，注册顺序 |
| `roots(): Agent[]` | 所有 live **顶层** agent（创建时无 owning agent）；durable lineage 不影响，resume 的 fork 仍可能是 root |
| `get(id): Agent \| undefined` | 按 session id 查 |
| `currentInitiator() / requireInitiator() / withInitiator(agent, op) / withoutInitiator(op)` | 进程内异步驱动链上携带"发起 Agent" |

`withInitiator` 是让 Host 侧异步代码在正确 Agent 上下文里跑的正规手段；直接读 `exec.agent`（工具执行内）更简单。

---

## D. 生命周期与安装

### D.1 插件导出形式（`SKILL/references/host-plugin.md:57-64`）

```js
export function apply(ctx, config) {}          // 形式一（推荐；Host-only）
export const inject = ['tools']                // 可选：依赖服务
export const Config = /* schemastery 或 Standard Schema */   // 可选：配置校验
// 或者：export default class XxxService extends Service  （形式二，二选一，不要混用）
```

`inject` 语义（`PKG/cordis/src/registry.ts:330` `new Fiber(this.ctx, config, Inject.resolve(plugin.inject), ...)`；`Inject.resolve` 见 `:71-85`）：数组或 `{name: config}` 映射；**依赖不满足时插件保持 inactive（不加载、不抛错）**。所以可选服务一定放进 `inject` 或 `ctx.inject([...], cb)`，否则整个 profile 在某些组合下会炸（`practices.md:20`）。

### D.2 `Config`：不需要 import 也能有校验（已验证）

Cordis 只要求 `Config` 是一个 **Standard Schema**：

```js
// PKG/cordis/src/fiber.ts:50-59
export function resolveConfig(runtime, config) {
  if (!runtime.Config) return config                                   // 无 Config → 原样透传
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) throw new TypeError('Async config validation is not supported')
  if (result.issues) throw new ValidationError(result.issues)
  return result.value
}
```

实测（本机 node + `import('@deepseek-ai/cordis')`）：

```
resolveConfig({}, {a:1})                       -> {"a":1}                          // 无 Config 原样透传
resolveConfig({Config: handRolled}, {artifactsDir:'x'})
                                               -> {"artifactsDir":"x","maxReviewRounds":2}   // 默认值生效
resolveConfig({Config: handRolled}, 5)         -> ValidationError "invalid config:\n  - config must be an object"
```

所以**零 import 插件**也可以自带默认值与校验：

```js
export const Config = {
  '~standard': {
    version: 1, vendor: 'agentteam-kit',
    validate(config) {
      if (typeof config !== 'object' || config === null || Array.isArray(config))
        return { issues: [{ message: 'config must be an object' }] }
      return { value: {
        artifactsDir: typeof config.artifactsDir === 'string' ? config.artifactsDir : '.agentteam',
        maxReviewRounds: Number.isSafeInteger(config.maxReviewRounds) ? config.maxReviewRounds : 2,
        maxParallelItems: Number.isSafeInteger(config.maxParallelItems) ? config.maxParallelItems : 4,
        workerContext: config.workerContext === 'fork' ? 'fork' : 'fresh',
        injectPolicy: config.injectPolicy !== false,
        writeArtifacts: config.writeArtifacts !== false,
      } }
    },
  },
}
```

代价：`Config.listConfigs` 对该行报 `status: 'unsupported'`（`isNativeConfigSchema` 只认带 `Symbol.for('schemastery')` 的 schemastery schema：`PKG/dsh-app-boot/lib/index.js:2456-2460`），但**加载与校验正常**。要 `status:'schema'` 就必须 import `@deepseek-ai/schemastery`（= 放弃 `link:` 安装形态，见 T1）。

### D.3 `ctx.effect` / `ctx.on` 与清理

```ts
// PKG/cordis/src/fiber.ts:415-418
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect,     label?: string): AsyncDisposable<Promise<void>>

// Effect 允许的形状（src/fiber.ts:76-90）：
//   () => void | Promise<void> | Iterable<disposer> | AsyncIterable<disposer>
```
- `execute` 立即执行；返回的 disposer 在 **fiber 卸载**或**调用返回的 disposer**时（先发生的那个）反序执行；disposer 只能调用一次，重复调用是 no-op（`fiber.ts:400-425`）。
- `ctx.on(name, listener)`：`@returns a disposer removing the listener`，且 **fiber 卸载时自动移除**（`PKG/cordis/src/events.ts:97-102`、`:288-302`）。
- 所以 `apply()` 内的 `scoped.tools.register()` / `systemPrompt.section()` 在**插件 ctx** 上会自动回收；但 **`agent.ctx` 上的注册不会**（practices.md:8/19）→ 必须像 §A.4 那样双保险。

`agent/created`（`CAT:3956`；`agent/disposed` 在 `CAT:3964`）：

```ts
mode: 'serial'
'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined | Promise<undefined>
```
描述（原文）：*"An entered agent is ready for per-agent initialization after factory setup. Listeners run in order and are awaited before creation resolves. … A throw or rejection fails creation and skips later listeners. Disposal retains the scope and session until dispatch settles; listeners must not await `agent.whenIdle()` or their own owner's disposal."*
另：`agent/disposed` 是 `emit`，在 driver quiescence + scoped 注册回卷之后、session 分离之前触发。

### D.4 HMR / 重复安装 / 去重

- profile 每次加载都会按 `package.json#dsh.profile.bundles` 顺序叠加 patch 层，**行按 `id` 定位**；同 id 后层覆盖前层，`config` 是**整体替换、不深合并**（`SKILL/cordis-composition-reference/SKILL.md:15-16`）。
- HMR（本 profile 的 `hmr` 行 `active`）：文件变化 → 下一次 profile 重组时**替换**插件；替换版本加载失败时插件被停掉并报 `failed`，而不是 `restart-required`（`PKG/dsh-hmr/README.zh.md` 使用本包 §4）。已链接包的目标目录也在监听范围内；判定的写入稳定窗口默认 2s。
- **安装新 bundle 可经 HMR 直接生效；替换已安装的包需要重启**（`SKILL/references/host-plugin.md:70`；`PKG/dsh-plugin-manager/README.zh.md` 同结论）。
- 重复安装的"去重"不是靠插件自己：`id` 决定行身份，bundle 选择列表决定包身份。同一 package 在两个 id 下插入 = **两个插件实例**（`apply` 跑两次），务必保证 `id` 唯一且 patch 里只 insert 一次。
- 保留名：工具名 `run_code` 被工具注册表无条件占用（`index.js:482-487`）。

---

## E. bundle 清单与安装

### E.1 `package.json` 硬性要求

Host-only bundle 不必有依赖/构建脚本（`SKILL/references/host-plugin.md:7-18`）。当前骨架包的最小可用形态：

```json
{
  "name": "@local/dsh-agent-team-workflow",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

| 字段 | 硬性 | 依据 / 说明 |
|---|---|---|
| `dsh.bundle.patch` | **必须** | 没有它 `install_bundle` 报 `not-a-package`/`not-bundle`；`list_bundles` 把它列为 `not-bundle`（`PKG/dsh-plugin-manager/README.zh.md`） |
| `exports` | 必须含 `.`；有资源再加 `./locale/*.json`、`./icon` | `SKILL/references/host-plugin.md:31-51` |
| `files` | 必须含**运行时全部文件** + patch + locale + icon；加模块就更新 | 同上 `:35`。本地目录安装是 `link:`，`files` 不过滤，但发布/pack 会过滤，属陷阱 |
| `locale/<lang>.json` | 强烈建议（效果上必需） | 见下 |
| `icon` | 建议；`package.json#icon`（包根相对路径）优先于 `./icon` 导出 | `PKG/dsh-app-boot/lib/index.js:2204-2262` |
| `type` | 建议 `module`（模板如此） | — |

**显示元数据的真实读取逻辑**（`PKG/dsh-app-boot/lib/index.js:2172-2262`，函数 `readPluginMeta`）：
- 先读 `<specifier>/locale/en.json`；同目录下所有 `*.json` 按**文件名当 language id** 收集（`:2172-2192`）。`meta.title` / `meta.description` 必须是非空字符串，否则抛（`:2157-2162` `textOf`）。
- **`en.json` 不存在 → title 回退到 `package.json#name`（完整 specifier，如 `@local/dsh-agent-team-workflow`），description 回退到 `package.json#description`**（`:2162` `fallbackText`, `:2247-2250`）。
- 失败不阻断安装：返回 `error: "Plugin metadata for <spec>: …"`，文本仍保留（`:2255-2262`）。
- icon 允许 SVG/PNG/JPEG/WebP，≤ 256 KiB，必须位于包内、不能越出（realpath 校验）（`:2208-2218` 注释）。
- 因此"没有 locale 目录"= 插件列表里标题显示成包名。**交付前必须补 `locale/en.json` + `locale/zh.json`**：

```json
{ "meta": { "title": "Agent Team Workflow", "description": "Injects a plan / parallel / review / gate workflow over Agent Teams." } }
```

### E.2 `cordis.patch.yml` 方言

权威说明：`SKILL/cordis-composition-reference/SKILL.md:10-25`。要点：

- 一个 patch 文件 = 顶层 **YAML 数组**，每项是 mapping。
- `insert: [rows]` 追加行；若 `id` 命中一个 `group: true` 行，则插进该 group 的 `config` 列表（`:14`）。
- **有 `id` 无 `insert` = 覆盖既有行**：给出的字段替换该行字段，`config` **整体替换、绝不深合并**（`:15`）。`name` 非空表示"断言既有行就是这个插件"，不是重命名。
- 无 `id` 且非 insert、或 id 匹配不到任何行 → 警告并跳过（`:16`）。
- 行字段：`id / name / config? / disabled? / inject? / intercept? / isolate?`（`:18`）。
- `disabled` 接受 boolean、null 或 `!!js` 表达式，每次挂载决策都求值；`disabled` 行可省略必需 `config`（`:21`）。
- `!!js` 是 **Loader 表达式**，不是 `!js`。写在 `config` 里的在**该行注入的服务激活后**、以该插件 ctx 求值（可用 `ctx.<service>`；例如 `!!js dshHomePath('storages')`）；其它行元数据保持字面量（`:22`）。
- `isolate` 把服务名映射到 `true` 或 realm 标签；scope 管贡献与事件可见性，`isolate` 管服务实例（`:23`）。

真实样例（本机 profile patch 层 `~/.dsh/profiles/121/cordis.patch.yml`）：
`- id: llm-pi-ai` + `name:` + `config:` 整体替换既有行；`- insert:` 下追加 `desktop-shell`(带 config)、`desktop-terminal`(带 `disabled: !!js process.platform === 'linux'`)。

本团队 bundle 应写成"纯追加、不劫持别人的行"：

```yaml
- insert:
    - id: agent-team-workflow
      name: '@local/dsh-agent-team-workflow'
      config:
        artifactsDir: .agentteam
        maxReviewRounds: 2
        maxParallelItems: 4
        workerContext: fresh
        injectPolicy: true
        writeArtifacts: true
```

模板 `SKILL/templates/decoration/{package.json,cordis.patch.yml,index.js,locale/en.json,icon.svg}` 可直接复制改编。

### E.3 安装（只能用 `plugin_manager`）

```
plugin_manager(action="install_bundle", target="~/dsh-workspace/agentteam-kit/packages/agent-team-workflow")
```
- `target` 传**绝对目录**（本地路径直接读 `package.json`，不加 registry）。**不要**用 pnpm/shell 手装；`install_bundle` 负责写 profile 的 `package.json` + `cordis.patch.yml` 并触发组合（`SKILL/references/host-plugin.md:68`）。
- 结果字段 `application` 的取值来自 `PKG/dsh-plugin-manager/lib/index.js:2380-2400`：
  `applied`（HMR 已生效）/ `restart-required`（含 `restartReason`）/ `cancelled` / `failed`（含 `error`）。
  **以 `application` + `warnings` 判定是否 live，不要看日志或进程**。
- 若有依赖构建脚本：先拿 `pendingBuilds`，**用户明确批准后**再传 `approvedBuilds`（`README.zh.md`「pnpm 11 拦下依赖脚本时…」）。
- 版本/peer 预检：本地路径安装会读其 `package.json` 的 `engines` / `peerDependencies`，不满足 DSH 运行时直接失败，不会下载任何东西（`README.zh.md`「版本兼容性与豁免」）。**Host-only 零依赖 bundle 天然免疫**——这也是一条"不要声明 peerDependencies"的理由（声明的 `@deepseek-ai/dsh-*` 版本必须与 `0.2.1-rc.2` 严格一致）。
- `list_plugins` / `list_bundles` 取精确标识；`set_plugin`/`set_bundle` 开关；`remove_bundle` 移除。

---

## F. 持久化：插件要保存"团队运行态"

### F.1 结论（按推荐顺序）

| 方案 | 可行性 | 适用 |
|---|---|---|
| **① 复用 `ctx.agentTeams` 任务板**（subject/description/writeScopes/blockedBy/revision） | ✅ 零依赖、零新存储、durable（Lead session log） | "角色 / 轮次 / 判据"里**能被表达为任务与依赖**的部分——强烈建议作为真源 |
| **② 工作区 JSON 工件文件**（`node:fs/promises`，tmp+rename 原子写） | ✅ 零依赖，可读可审 | board.json / report.md / 轮次计数等"人类与后续会话可读"的运行态 |
| ③ `ctx.storageDomain.open(spec)` KV 领域 | ⚠️ API 存在且已挂载，但**要求 zod schema**，链接安装的插件无法 import zod | 仅当插件从 registry 真装（自己的 node_modules）时 |
| ④ `ctx.fs` 组合文件系统 | ✅ 服务可用，签名见下 | 想走 Harness 统一文件层、受沙箱策略约束时 |
| ⑤ 新增 session event 类型 | ❌ 禁止 | `practices.md:21`：未知存储事件只有 `ignorable:true` 才能被读，`Session.append()` 无法设置该标记 → 会拒绝重开会话 |

`practices.md:7` 的总原则：**会话日志是唯一真源**，插件内存是派生缓存。所以"审阅轮次/判据"第一优先落在**任务板（本身就在 Lead 日志里）**，第二优先落成**工作区工件**；不要把运行态当成插件私有 secret。

### F.2 方案①：任务板即状态机（推荐）

```js
// 一轮审阅 = 一个任务；判据写进 description（模型与人都能读到）；依赖表达顺序
const review = await ctx.agentTeams.createTask(caller, {
  subject: 'review: src/auth.js',
  description: `Round 1/2.\nCriteria:\n- no plaintext token\n- peer review by a non-author\nAcceptance: report.md cites file:line.`,
  blockedBy: [implTask.id],
  writeScopes: ['src/auth.js', 'reports/'],
})
// 轮次推进 = CAS update（不会覆盖并发成果）
await ctx.agentTeams.updateTask(caller, {
  taskId: review.id, expectedRevision: review.revision, action: 'edit',
  description: `Round 2/2.\nCriteria: …`,
})
```
局限（必须知道）：任务没有自定义字段，`revision` 只有 CAS 语义；想存"结构化判据 JSON"只能塞进 `description` 文本，或另写工件文件。

### F.3 方案②：工作区 JSON 工件（零依赖，实测可用）

得到目录：`ctx.workingDirectory.ensure(agent): Promise<string>`（服务 `workingDirectory`，live inspect 签名 `ensure(agent: Agent, signal?: AbortSignal): Promise<string>`；另有 `get(session)`、`set(agent, path)`）。写入用 Node 内置模块（链接安装也能解析）：

```js
import { mkdir, rename, writeFile } from 'node:fs/promises'   // Node 内置模块，链接包可用
import { join } from 'node:path'

async function writeArtifact(agent, settings, name, value) {
  const cwd = await ctx.workingDirectory.ensure(agent)
  const dir = join(cwd, settings.artifactsDir)
  await mkdir(dir, { recursive: true })
  const target = join(dir, name)
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, target)          // 原子替换；不要直接写目标文件
  return target
}
// state = { version: 1, items: [{ id, owner, round, maxRounds, criteria: [...], status }] }
```
注意：工件目录是**工作区可见文件** → 会出现在用户的 git status 里；`.agentteam/` 应提示用户加入 `.gitignore`（或让 `artifactsDir` 可配）。

### F.4 方案③：`ctx.storageDomain`（API 已核实，但当前形态不可用）

live inspect（`storageDomain` 与 `storage` 两服务都在目录中）：

```ts
// storageDomain: async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>; get(name); async closeAll()
interface DomainSpec {                    // name 必须匹配 UNIT_NAME_RE；version 非负整数
  readonly name: string; readonly version: number;
  readonly layout?: 'single' | 'per-record'; readonly compatibleVersions?: readonly number[];
  readonly invalidRecords?: 'backup-and-skip';
  readonly global?: { schema: ZodType<G>; initial: G };
  readonly tables: Record<string, { valueSchema: ZodType<V> }>;   // ← zod 硬依赖
}
interface Domain<S> { readonly global: DomainGlobalHandleOf<S>; table(name): KvTable; close(): Promise<void> }
interface KvTable<K,V> { get(k):V|undefined; entries(); keys(); size; put(k,v); delete(k); update(k, fn) }
```
（`CAT:5307/5339/5343/5347/5327/5819/5815`；语义 `PKG/dsh-storage-domain/README.zh.md`：读内存同步、写先持久化后改内存、按序发 `domain/changed`、失败码 `already-open|facet-unsupported|invalid-record|missing-key|closed`。）
本 profile 已挂载该栈：`PKG/dsh-base/cordis.patch.yml:179-190`（`storage` + `storage-json` root `!!js dshHomePath('storages')` + `storage-domain` backend `json`）。
**阻塞点**：`valueSchema` 必须是真 zod schema（`defineDomain` 会调 `spec.global.schema.safeParse(null)` 等，`PKG/dsh-storage-domain/lib/index.js:61-90`）。`defineDomain`/`domainTable` 与 `zod` 都只能通过 `import '@deepseek-ai/dsh-storage-domain'` / `import 'zod'` 取得，而**链接安装的工作区包解析不到**（见 T1）。→ 除非改成从 registry 安装，否则不要选它。

### F.5 方案④：`ctx.fs`

服务方法（live inspect `fs`）：`resolve(path, opts?) → Promise<FsTarget>`、`readText(target)`、`writeText(target, content, expected?: FsWriteIntent, signal?, sandboxPolicy?: SandboxExecutionPolicy)`、`editText(target, edit, expected?)`。
`FsTarget` 是不透明句柄（`{targetKey, displayPath}`，`CAT`），必须由 `resolve()` 拿到；`expected` 用 `{kind:'createIfAbsent'}` 或 `{kind:'replaceIfVersion', version}`（`FsWriteIntent`）。
比 `node:fs` 多一层**沙箱策略**约束（写工作区外会被策略拒），适合想继承用户"文件权限/Sandbox"设置的场景；单纯写团队工件用 `node:fs` 更省事。

---

## G. 验证手段：不重启怎么确认插件活着

### G.1 各机制能证明什么（这是本节的唯一重点）

| 手段 | 数据来源 | **能证明** | **不能证明** |
|---|---|---|---|
| `cordis_inspect_query(host, Service, listService)` | **静态**生成目录 `CAT`（`providers.js:1-3`） | 这个 DSH 版本里该 service/method 存在、签名是什么 | ❌ 该行是否挂载、你的插件是否加载（catalog 与服务是否 live 无关） |
| `cordis_inspect_query(host, Event, listEvents)` | 同上 | 事件名、mode（emit/serial/waterfall/parallel）、listener 签名 | ❌ 有没有 listener 注册 |
| `cordis_inspect_query(host, Config, listConfigs)` | **live** Loader 树（`PKG/dsh-tool-cordis/lib/types/config.js:4-26`） | 行在组合树里存在、`patchId`、以及 Config 状态：`tree`(group/include 子树) / `inactive`(无 fiber / uid 为空 / disabled) / `absent`(fiber 活跃但**没有 Config 导出**) / `schema`(活跃且 Config 原生 schema) / `unsupported` | ❌ `apply()` 是否跑完、工具/提示词是否注册成功 |
| `cordis_inspect_query(host, Tool, listTools)` | **live** `ctx.tools.schemas(context.agent)`（`providers.js:40-54`） | 以**当前请求 Agent** 视角，某工具此刻可调用（含 scoped 与动态注册） | ❌ 别的 Agent 也看得到；❌ 提示词段注入；❌ 工具实现是否正确 |
| `plugin_manager(action="list_plugins")` | live 管理服务 | 行 `enabled`、`fiberPhase`（`pending/loading/active/failed/unloading/null`，`CAT` `PluginFiberPhase`）、`patchId`、`readOnlyReason` | ❌ `enabled` 是**保存的选择**，不是加载成功；❌ 工具是否注册；❌ 显示元数据（工具版不返回 meta） |
| `plugin_manager(action="list_bundles")` | live 管理服务 | 包是否 `installed`、`availability`、`enabled`、`rows`、`error` | ❌ 运行时能力 |
| 插件自报工具（如 `team_workflow_info` 返回 `policyInjected`） | 你的代码 | **提示词注入路径是否走过**（系统提示没有 inspect provider） | ❌ 模型是否真的读到（只能靠行为观察） |

### G.2 本环境实测（可直接复现）

- `Tool.listTools`（无 input）→ 返回本团队骨架注册的 `team_workflow_info`（参数/描述/输出 schema 都在），同批还有 `spawn_teammate`、`wait_agent`、`send_message`、`interrupt_agent`、`list_agents`、`team_task_create/list/get/update`。**这是"A 已装上且按 Agent 作用域注册成功"的 live 证据。**
- `plugin_manager(list_plugins, offset=205, limit=20)` → 末页含 `{"entryId":"include:agent-team-workflow","moduleName":"@local/dsh-agent-team-workflow","enabled":true,"fiberPhase":"active","patchId":"agent-team-workflow"}`。**行存在 + fiber active。**
- `Config.listConfigs`（无 input，默认第一页）→ `total: 225`，行形如 `{id:"include:xxx", patchId:"xxx", name:"...", status:"schema|inactive|absent"}`。

### G.3 已知缺陷：`cordis_inspect_query` 的 `input` 传不进去

`cordis_inspect_query` 的 `input` 参数声明为 author-only `type:'json'`（`PKG/dsh-tool-cordis/lib/types/index.js:44`）→ 编成**无类型注解的 schema**。实测：任何非空 `input`（含 `{}`）都被 Host 侧拒绝：

```
Host Cordis inspect Config.listConfigs rejected input: "input" must be an object
Host Cordis inspect Service.listService rejected input: "input" must be an object
Host Cordis inspect Event.listEvents  rejected input: "input" must be an object
```
来自 `PKG/dsh-cordis-host-runner/lib/types/inspect-registry.js:223-226` `validateJsonSchemaValue(method.inputSchema, input ?? {}, 'input')` —— 说明到达校验器的值不是对象。
**结论**：本 build 里 inspect **只能做无参调用**（catalog 首页 / listTools）。要精确的 `Service`/`Event` 契约或某个 entry 的 Config schema，直接读 `CAT` 与 `PKG/*/lib/types/*.js`；`Config` 分页也用 `plugin_manager list_plugins` 的 `offset/limit` 代替（后者参数是强类型，工作正常，已实测）。
**给插件作者的教训**：自己的工具里**别**把嵌套对象参数声明成 `type:'json'`，用 `type:'object' + properties`；否则模型侧调用同样会坏。

---

## 陷阱清单（按踩到概率排序）

- **T1（最致命）工作区 `link:` 插件不能用 `import '@deepseek-ai/...'` / `'zod'` / `'@deepseek-ai/schemastery'`。**
  实测在 `agentteam-kit/packages/agent-team-workflow` 目录下 `import('zod' | '@deepseek-ai/dsh-tools' | '@deepseek-ai/schemastery' | '@deepseek-ai/dsh-system-prompt')` **全部 `Cannot find package`**（Node 从插件文件真实路径向上找 node_modules；profile 的 hoisted 模块不在那条链上）。
  后果：`defineTool()`、zod 版 `defineDomain`、schemastery `Config` 全都用不了。→ **写零 import 的纯 JS 插件**（只 import `node:*` 内置模块），工具用裸 JSON Schema + 自写 args 校验，Config 用 §D.2 的 Standard Schema。
- **T2** 以为 `output` 可以省或返回 `{content}`。必须 `{schema, render}`；`execute` 返回的是**被 schema 校验的规范 JSON 值**，渲染由 `output.render` 负责。
- **T3** 以为 `register()` 会校验参数。不会。裸 JSON Schema 注册时 args 全裸，`execute` 里要自己 `typeof` 校验，否则模型传坏参数会以奇怪异常崩在业务代码里。
- **T4** 在 `type:'json'` 上栽跟头（§G.3）：嵌套对象参数写成 `type:'json'` → 模型侧调用报 `must be an object`。
- **T5** 工具名 `run_code` 被保留（`index.js:485-487`），PTC 模式下还会变成唯一可直呼的工具。
- **T6** 只在 `agent.ctx` 注册、插件卸载时忘了拆 → 卸载后再装出现
  `tool "x" is already registered in this scope`。必须 `agent/disposed` + 插件 `ctx.effect` 双保险。
- **T7** 不用闭包而想在 `section.text(ctx)` 里拿 agent：拿不到（只有 `{scope, signal}`）。
- **T8** 硬编码 `order: 600` 而非 `getSectionOrder('TEAM_POLICY')`：第一方顺序调整后你的段落错位（同 order 时退化成按 name 排序）。
- **T9** 段/上下文 text 里的 `{{...}}` 没关插值 → 组装直接失败，整个 Agent 发不出请求（比工具报错严重得多）。要原样保留就 `interpolate:false`。
- **T10** 多个 `complete:true` 段 → 组装失败（`PKG/dsh-system-prompt/lib/index.js:381-383`）。
- **T11** 漏 `locale/en.json` → 插件列表标题显示成 `@local/dsh-agent-team-workflow`（title 回退到 `package.json#name`，`app-boot:2247-2250`）；只有 `package.json#description` 能救描述，救不了标题。
- **T12** `files` 不含运行时文件：本地 link 安装不报错（不过滤），但打包/发布后运行时缺失 → 一定同步更新 `files`。
- **T13** 在 bundle package.json 里声明 `peerDependencies`/`engines` 指向 `@deepseek-ai/dsh-*`：版本必须与 `0.2.1-rc.2` 完全匹配，否则 `install_bundle` 在 pnpm 之前就报 `incompatible-version`。Host-only bundle **不要**声明依赖。
- **T14** 用 pnpm/shell 手工装或用 `file:`/`link:` 手改 profile：`install_bundle` 才是唯一正规路径（会同时维护 `package.json` + patch 层 + 组合）；手改需要逐项审批，且不被记录。
- **T15** 在 `apply` 里追加新的 session event `type`：`Session.append()` 无法写 `ignorable:true`，会话将**拒绝重新打开**（`practices.md:21`）。
- **T16** 把运行态当成插件私有内存：进程重启即丢；身份/任务真源在 Lead 日志，插件状态必须是**可从日志/工件重建的缓存**。
- **T17** 以 `Config.listConfigs` 的 `status` 判断"插件没加载"：`absent` 的含义是**已加载但没有 Config 导出**；`inactive` 才是没挂载。
- **T18** 用 `plugin_manager` 的 `enabled:true` 当"已生效"：README 明确 `enabled` 只是保存的选择；要看 `fiberPhase` 与 `application`。
- **T19** 在 `agent/created` 里 await `agent.whenIdle()` 或自己 owner 的销毁：会把创建挂死（事件描述原文）。
- **T20** `install_bundle` 后不读 `application`：`restart-required` 时不重启就一直跑旧代码；替换已安装包必须重启（新装可走 HMR）。

---

## 未验证 / 不确定清单（写文档时明确保留）

1. **`Config` 用 Standard Schema 的实际加载**：我只在 `import('@deepseek-ai/cordis')` 里对 `resolveConfig` 做了离线验证（默认值+校验错误都正确），**没有**真的通过 Loader 挂载一个带手写 `Config` 的 bundle。激活时 Loader 是否有额外检查（例如 patch 里 `!!js` 与 Config 的交互）未验证。
2. **`TeamTaskId()` 铸造函数在零 import 下不可用**：官方工具用它做 `string → TeamTaskId`。我未验证 `getTask(caller, '能直接传的字符串')` 是否在所有路径都被接受；实现里 `TeamTaskId` 看起来是 identity 铸造（`Branded` 类型），但**没有实测裸字符串调用**。若失败，改成只做 `listTasks()`（返回真实 `TeamTaskView[]`，再按 id 字符串比较）。
3. **`ctx.fs` 写策略**：未实测 `writeText` 在无 `sandboxPolicy` 参数时对工作区外路径的行为；`FsSandbox` 具体拒绝条件没读。
4. **HMR 替换"已链接工作区包"的时延**：README 说下一次 profile 重组会替换，精确触发条件（是否需要 `hmr` 行 `root:["."]` 才监听源码）我没在本 profile 上实测；只确认 `hmr` 行 `fiberPhase: active`。
5. **两个 id 插同一 package 是否真产生两个实例**：由 Cordis `Fiber` 语义推导（同一 plugin 函数可被多次 `ctx.plugin`），未实测。
6. **`agent.session` 等运行时字段的跨版本稳定性**：只确认当前实现存在（`ReactLoopAgent`），未找到官方稳定契约文档。
7. **`system-prompt/assemble` 这个 waterfall 的改造边界**：`practices.md:17` 明确"不要监听它来加/删工具或文本"，我未去验证违反后的具体失败形态。
8. **`interrupt` 的 Lead-only 校验在非 Lead 调用时的错误码**：只从 README 得知"只有 Lead 可以…中断"，未读具体错误类型。
