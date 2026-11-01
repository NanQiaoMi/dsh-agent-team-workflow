# 05 · 验证证据

> 原则：只写**实际执行过**的命令与真实结果；未验证的项单列并给出复现步骤。
> 证据文件在 [`docs/evidence/`](evidence/)。

## 1. 结论摘要

| # | 验证项 | 方法 | 结论 |
| --- | --- | --- | --- |
| V1 | 引擎状态机正确性（计划校验、版本绑定、累计返修轮、nits 早停、升级、门禁、override、多 reviewer） | 离线单元测试 26 例 | ✅ 全绿 |
| V2 | 8 个工具的参数/返回/权限/失败路径、评审/修复/内存态/override 传递 | 集成测试 14 例（真实 `dsh-tools` 的 JSON-Schema 校验器） | ✅ 全绿 |
| V3 | 插件装配：per-Agent 注册/拆除、提示注入、配置开关、Team 隔离 | 装配测试 5 例（服务替身） | ✅ 全绿 |
| V4 | bundle 能被 DSH 安装并激活（同一份清单与安装机制） | `plugin_manager install_bundle` → `application: applied`；`fiberPhase: active` | ✅ 已验证 |
| V5 | per-Agent 工具注册 + 提示注入在本运行时真实生效 | 骨架版（同机制、仅 1 个诊断工具）被本 Agent 实际调用成功 | ✅ 已验证（骨架代） |
| V6 | 最终组合配置进入 profile 121 | `dsh --profile 121 --dump-config` 输出含本行与配置 | ✅ 已验证 |
| V7 | **最终代码代**在运行中的 Desktop 里 live 跑一次完整团队流程 | 重启 DSH 后真实 run（4 成员 / 2 项 / 约 5 分钟） | ✅ **已验证**，见 [`08-live-run.md`](08-live-run.md) 与 [`evidence/live-run/`](evidence/live-run/) |
| V10 | 对等协作层（workflow v2） | 离线测试 39 例（collaboration 14 + tools 19 + 相关 engine/plugin）：认领/释放、评审邀请与接受、交接、提案投票/平票/Lead 仲裁、阻断提案拦截、频道与摘要、v1 板自动升级；快照 v2 与客户端面板 26+17 例 | ✅ 全绿（113/113）；待真实协作 run 复验（[`13`](13-collaboration-live-run.md)） |
| V9 | 实时看板（聚合/路由/客户端） | 离线测试 30 例（dashboard 14 / 路由 6 / client 契约 10）+ 真实黑板 dry-run + **真实浏览器复验**（独立 Host：启动图/View/路由/渲染/滚动修复） | ✅ 全绿；桌面 App 重启后按 [`10`](10-dashboard-verification.md) §3 复验 | |
| V8 | 对抗性独立审阅 | 独立 reviewer（fresh context）审阅代码与文档 | ✅ 完成：18 条发现（1 blocker / 10 major / 6 minor / 1 nit），处理见 [`07-review-resolution.md`](07-review-resolution.md)，原始记录见 [`06`](06-review-findings.md) |

---

## 2. 静态契约核对（对照安装目录源码）

| 契约 | 本实现 | 依据 |
| --- | --- | --- |
| 工具定义：`{name, description, parameters, output:{schema, render}, execute}` | 全部 8 个工具按此声明 | `dsh-tools/lib/index.js` 的 `ToolRuntime.register` |
| `output.schema` 必须是受支持子集，且运行时**校验返回值** | 输出 schema 仅用 type/oneOf/properties/required/additionalProperties/items/enum + annotation；结果统一 `JSON.parse(JSON.stringify())` 归一化 | `assertSupportedJsonSchema`、`validateJsonSchemaValue`；集成测试直接调用二者 |
| 工具按 Agent 作用域注册 | `maybeInstall` + `ctx.agents.list()` + `agent/created` + `agent/disposed` + `ctx.effect` 兜底 | `dsh-experimental-tool-agent-team/lib/index.js` 官方范式 |
| 只给 Team 成员安装 | `ctx.agentTeams.tryMembership(agent) === undefined` 时跳过 | 同上；装配测试断言非成员 0 个工具 |
| 提示注入 | `systemPrompt.section({name:'team:workflow', order: getSectionOrder('TEAM_POLICY')})` + `context({name:'team:workflow-state', order: getContextOrder('TEAM_IDENTITY')+1, required:true})` | `dsh-system-prompt/lib/index.js` 的 `SECTION_ORDERS`/`CONTEXT_ORDERS` |
| `{{var}}` 插值风险 | 注入文本不含 `{{`；动态 context 只输出固定摘要 | `interpolate()` 对未知名抛错会拖垮整个组装 |
| agentTeams 调用参数 | `createTask{subject,description,blockedBy,writeScopes,signal}`、`updateTask{taskId,expectedRevision,action}`、`sendMessage{target,content,signal}`、`membership()` | `task-board.js` / `roster.js` / `TeamService` 逐字段核对 |
| 任务迁移前置条件 | report 时按 `pending→claim→complete`、rework 时 `completed→reopen` 的顺序驱动，避免 `TEAM_TASK_INVALID_TRANSITION` | `task-board.js` 的 `complete/reopen/claim` 分支 |
| 零外部 import | 仅 `node:fs/promises`、`node:path` | 工作区 `link:` 包无法解析宿主包（[`02`](02-dsh-plugin-api.md) 实测） |
| bundle 清单 | `dsh.bundle.patch` + `exports{".", "./locale/*.json", "./icon"}` + `files` 含 `lib/**` | `references/host-plugin.md` |
| 字段命名风格 | 工具参数 snake_case、返回 snake_case；错误信息含下一步动作 | 与原生 `team_task_*` 一致 |

---

## 3. 测试证据

命令（可复现）：

```bash
cd agentteam-kit/packages/agent-team-workflow
NODE=~/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node
"$NODE" --test test/engine.test.mjs test/tools.integration.test.mjs test/plugin.test.mjs
```

实测结果（审阅修复后，原文见 [`evidence/test-run.txt`](evidence/test-run.txt)）：

```
ℹ tests 45
ℹ pass 45
ℹ fail 0
```

### 3.1 引擎（`test/engine.test.mjs`，26 例）

| 用例 | 覆盖点 |
| --- | --- |
| 计划校验拒绝 | 自审、依赖环、同波次写范围竞争、Lead 拥有 item、缺 DoD、缺 reviewer |
| 计划校验接受 | 依赖排序 + `waves` 计算 |
| 写范围重叠降级 | `allowScopeOverlap` 时只 warning |
| 报告→评审→批准 | 轮次创建、reviewer 指派、非指派者被拒 |
| 返修闭环 | finding 逐条响应、未知 finding 拒绝、第二轮、approve_with_nits 收敛 |
| 非批准 verdict 必须有 finding | 空 findings 被拒 |
| blocker 被 rebut | 自动升级、item=escalated、escalation 记录 kind/blocking |
| 轮次耗尽 | 自动升级 |
| 多 reviewer | 必须全部批准 |
| 门禁 | 缺报告/缺证据/缺评审/未决 finding/越界写（warning vs strict failure） |
| 通过 + override | gate pass、forked reviewer warning、override 可见 |
| 阻断升级 | 未解决 blocking escalation 阻止 gate；解决后放行 |
| 角色化 next_actions | lead / owner / reviewer 三种视角 |
| spawn 简报 | 自包含性断言（身份、scope、DoD、报告与评审指令、禁止派生） |
| 路径工具 | Windows 分隔符归一化、前缀边界（`src/core` 不匹配 `src/core-extra`） |
| 版本绑定（R-01） | 重新报告使旧批准失效；两位 reviewer 都需重审 |
| 依赖顺序（R-07） | 依赖未批准时 report 被拒；门禁把未批准依赖列为 failure |
| 返修预算（R-03） | 多 reviewer 的一次 request_changes 不触发升级 |
| 证据质量（R-05） | 空命令、无 evidence、批准无 `evidence_checked` 均判失败 |
| 成员名校验（R-14） | owner/reviewer 必须 lower-kebab-case |
| 全量放弃评审 | 计划被标记警告 |
| nits 早停（R-19） | `approve_with_nits` 的 findings 记为 `accepted_by_reviewer`，门禁通过、不指派返修 |
| 累计返修预算（R-20） | 重新 report 不清零；第三轮返修触发升级 |

### 3.2 工具集成（`test/tools.integration.test.mjs`，14 例）

- 8 个工具的 output schema 全部通过真实 `assertSupportedJsonSchema`；
- 全链路：plan → status → report → review → gate → finalize（断言 `.agentteam/report.md` 与 `state.json` 落盘、backing task 状态、自动通知收件人）；
- 返修路径：request_changes → backing task reopen → respond → 下一轮 → 通知 reviewer；
- 越权拒绝：非 Lead 调 plan/gate、Lead 代报他人 item、未报告就评审、无 pending review 评审；
- 升级阻断：blocking escalation 阻止 finalize，裁决后放行；
- `replace:true`：归档旧 run 到 `teams/<teamId>/runs/<runId>.json`（phase=aborted），新 run id 生效；
- 双重角色只 spawn 一次（worker 简报内含 reviewer duty）；
- 内存模式（`writeArtifacts:false`）完整可用且不写工作区；
- escalation 不改 item 状态；`team_flow_repair` 的 reopen 生效且非 Lead 被拒；
- `status {item_id}` 返回完整 report/reviews；task revision 可见；
- `workerContext:"fork"` 真正生效；
- override 预览的 `next_actions` 回显参数，finalize 不带 overrides 会失败、带上则收敛且报告标注；
- `status` 区分 `rework_rounds` / `submitted_rounds`，verdicts 不含 pending/superseded；`reset_review` 缺省 reviewer 可用。

### 3.3 装配（`test/plugin.test.mjs`，5 例）

- 只对 Team 成员安装 8 个工具与 2 个提示输入（非成员 subagent = 0）；
- `agent/created` 补装 + `agent/disposed` 完全拆除（工具、section、context 全部归零）；
- 注入的 state context 在 run 建立后能读到 `run_id` 与下一步指引；
- `injectPolicy:false` 时只装工具、不注入提示；
- 同一 workspace 的两支 Team 黑板路径不同、互不可见。

---

## 4. 运行时证据（本机，profile 121）

### 4.1 安装与激活

`plugin_manager(action:"install_bundle", target:"<包绝对路径>")` 返回：

```json
{ "stage": "enable", "target": "@local/dsh-agent-team-workflow", "enabled": true,
  "changed": true, "application": "applied", "version": "1.0.0", "warnings": [] }
```

`plugin_manager(action:"list_plugins")` 中该行：

```json
{ "entryId": "include:agent-team-workflow",
  "moduleName": "@local/dsh-agent-team-workflow",
  "enabled": true, "fiberPhase": "active", "patchId": "agent-team-workflow" }
```

### 4.2 per-Agent 注册真实生效（骨架代）

在同一份 bundle 清单/安装机制下，先用只含 1 个诊断工具的骨架版验证机制，`Tool.listTools` 中出现了该工具，且本 Agent 实际调用返回：

```json
{ "ok": true, "version": "1.0.0-skeleton", "role": "lead", "memberName": "lead",
  "policyInjected": true, "artifactsDir": ".agentteam" }
```

这证明：bundle 安装 → 行激活 → 按 Agent 作用域注册工具 → 工具参数/输出契约被运行时接受 → 该 Agent 能发现并执行，整条链路在本运行时可用。

### 4.3 最终组合配置

`dsh --profile 121 --dump-config` 的输出包含（原文见 [`evidence/composed-config.txt`](evidence/composed-config.txt)）：

```yaml
# == @local/dsh-agent-team-workflow
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

---

## 5. 未验证项与原因

### V7：最终代码代的 live 团队流程 —— 已验证

2026-11-01 重启 DSH 后，在干净的 `/tmp/atw-smoke` 用 4 个成员（Lead + 2 worker + 1 reviewer）跑通完整闭环：
计划 → 并行独立执行 → 升级仲裁 → 结构化报告 → 自动指派并完成相互评审 → 门禁 → finalize 写报告。
完整时间线、证据与残余 nit 见 [`08-live-run.md`](08-live-run.md)；原始工件在 [`evidence/live-run/`](evidence/live-run/)
（`report.md`、`state.json`、`hello.mjs`、`hello.test.mjs`、`README.md`）。

Lead 独立复核（不采信成员自述）：

```bash
cd /tmp/atw-smoke && PATH=<dsh-node-bin>:$PATH node --test
# ℹ tests 3 / ℹ pass 3 / ℹ fail 0   exit=0
```

**如需再复跑**：重启后的任意会话，对 Lead 说「用 Agent Team 工作流做一个小实现 + 独立评审，走完
report→review→gate→finalize」，或直接在空目录里调用 `team_flow_plan` 并按返回的 spawn 简报组队。

> 注：重启前记录的"HMR 只监视 profile、不热替换 linked 插件模块代"仍然成立——所以**改插件代码后需要重启**，这与 live run 无关。

### 其他未验证

| 项 | 原因 |
| --- | --- |
| 真实模型对注入协议的行为（是否遵守、是否绕过） | 已观测 **1 次** live 样本（`08-live-run.md`：4 个成员全部按协议行动，含拒绝作弊与拒绝收敛后漂移），但不是统计结论 |
| `team_flow_gate` 与原生任务板在**跨进程**场景下的一致性 | DSH 一个 Team 只存在于一个 Host 进程，设计上不支持跨进程写 |
| Client UI 呈现（本插件无 UI 部分） | 未实现 UI；`state.json` 可通过文件侧栏查看 |

---

## 6. 工程发现（对后续插件作者有用）

1. **linked 插件不参与 HMR**：`dsh-hmr` 的 `profileModules()` 只覆盖 profile roots；工作区 linked 目录的源码改动不会触发模块替换。开发期请用"改版本 + 重装 + 重启"或把验证逻辑做成可离线测试的纯函数（本包 `lib/workflow.js` 即此策略）。
2. **`output.schema` 是运行时契约**：不是文档，`validateJsonSchemaValue` 会拒绝多出/缺失/类型不符的结果（`additionalProperties:false` 时尤其严格）。返回前统一 JSON 归一化最省事。
3. **`register()` 不校验 `parameters`**：裸 JSON Schema 注册时，参数校验必须自己写在 `execute` 里（本包的 `team_flow_*` 都做了显式校验）。
4. **`Config` 可以不导出**：插件行仍能挂载，配置由插件自行收敛；代价是 `Config.listConfigs` 显示 `absent`、无安装期校验。
5. **任务板的 `complete` 不检查依赖就绪**：`claim` 检查 `taskReady`，`complete` 只要求 `in_progress`；所以"完成顺序"必须由治理层自己保证（本包用 DAG + gate）。
