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
| V10 | 对等协作层（workflow v2） | 离线测试 39 例（collaboration 14 + tools 19 + 相关 engine/plugin）：认领/释放、评审邀请与接受、交接、提案投票/平票/Lead 仲裁、阻断提案拦截、频道与摘要、v1 板自动升级；快照 v2 与客户端面板 26+17 例 | ✅ 全绿（113/113） |
| V25 | v1.9.4：评审去线化 | 评审改工单角标 `评 rev-hello`；双行成员共享列时工单槽位去重；工单宽度 14–20%；画布仅剩 Lead 树 + owner 竖线；37 客户端用例 | ✅ 客户端 37/37；预览见 [`29`](29-board-design-v19.md) |
| V24 | v1.9.3：拓扑去线化 | 同伴弧线改为摘要胶囊条；评审改直角车道；画布高度随行数 250/310px；9 人×9 单预览 | ✅ 客户端 36/36 |
| V23 | v1.9.2：密集团队拓扑 | 拓扑独占整行；Lead 组织树总线（主干+行总线+短竖线箭头）；成员两行、空闲节点右上角、评审弧线、工单宽度自适应；新增密集预览与断言 | ✅ 客户端 36/36；预览见 [`29`](29-board-design-v19.md) |
| V22 | v1.9.1：协作拓扑重构 | 工单按 owner 分列对齐、短竖线连接；Lead/成员胶囊、方向箭头、区域标签、画布 300px；新增 owner 列对齐契约测试 | ✅ 客户端 36/36；截图见 [`29`](29-board-design-v19.md) |
| V21 | v1.9：看板视觉重构（参考 refero 设计规范） | 单色 shadcn 风格：24px 卡片/18px 胶囊/发丝线/轻投影/统计块/状态 hero；深浅色由宿主 token 派生；客户端契约 35/35 | ✅ 全绿（35/35 client，全量见 test-run）；截图见 [`29`](29-board-design-v19.md) |
| V20 | v1.8：可复用工具沙箱库 | 抽出 `@local/dsh-tool-guard-kit`（零依赖、9 例）：判定表/审计/生命周期/Teams 适配器/动态策略/fail-open 语义；插件改为消费该库（适配层保持导出兼容） | ✅ 全绿（223/223：插件 214 + 库 9） |
| V19 | v1.7：原生工具沙箱（工具调用边界） | `ctx.tools.guard()` 全局守卫生效：readOnly 拒绝 write/edit/bash/terminal，allow/deny 精确匹配；工作流层策略保留；新增 tool-guard 单测 6 + plugin guard 断言；live 发现 readOnly 误禁 report、terminal_* 漏拦 → 1.7.1 修复 | ✅ 全绿（214/214）；**live 两轮验证**：write/edit/bash/terminal_* 在工具执行前被拒、read 放行、report 修复后成功、gate finalized，见 [`26`](26-v17-live.md)；live 见 [`26`](26-v17-live.md) |
| V18 | v1.6：真并行 worktree 隔离 + 工作流能力沙箱 | `worktreeIsolation: off/serial/parallel`（item 级 worktree、commit/verify 就地执行、逐项 merge、gate 校验产物在 worktree）；roles `allow`/`readOnly`；并在同一 wave 下允许重叠 scope（并行模式下由隔离保证） | ✅ 全绿（207/207）；**live 已通过**：两个并行 worktree 各自 commit/verify、逐项 merge 进 run 分支、最终合入 main，用量面板/对话展开实拍，见 [`24`](24-v16-live.md) |
| V17 | v1.5：成员对话视图（docs/18 差距 #15 收口） | `lib/transcript.js` 纯投影（真实事件形状、截断、畸形事件容错）+ member route `member.transcript` + 客户端抽屉「对话」区；新增 8 例（transcript 4 / member-route 2 / client 2） | ✅ 全绿（201/201）；live 见 [`22`](22-transcript-live.md) |
| V16 | v1.4：Wave 1 + 部分 Wave 2（roles/hooks/plan-first/stop/成员面板/角色限制/worktree/token 预算） | `docs/19` 全量实现：192→**193/193** 离线测试（新增 hooks 4、stop 2、plan 5、角色 2、token 1、worktree 3、member route 4、client +4、dashboard +1）；`lib/hooks.js`、`lib/member-route.js` 全新；`team_flow_stop`、`team_flow_plan_approval` 新工具；autoStaff 漏传 provider 修复 | ✅ 全绿（193/193）；**live 已通过**（独立 Host 真实模型：auto-staff、plan-first 提交/批准、report、review、gate、真实 token 用量、hooks 阻断、优雅关闭/中断、成员面板 GET/POST，见 [`20`](20-v14-live-run.md)） |
| V15 | 官方 Claude Code Agent Teams 对照与差距分析 | 实抓官方 agent-teams/sub-agents/hooks/tools-reference 四篇文档；22 维能力矩阵（超越/持平 13、部分 4、缺失 5）；Wave 1–3 模仿方案与验收；附带修复 autoStaff 漏传 `provider`（DSH spawn 必填） | 📄 分析报告 [`18`](18-claude-gap-analysis.md)；测试 168/168 |
| V14 | 协作噪音收敛 + 看板 v1.3.1（live 观察后修复） | `applyReport` 不再发频道提醒（保持 next_actions）；team 广播只投 run 参与者（talk/open item/开放评审邀请）；看板 route 惰性裁决并持久化；UI：频道正文 4 行可展开、提案「已截止·待裁决」、空闲排除 Lead、流程图 420px、卡标题 2 行；新增 6 例（engine 1 / tools 1 / route 1 / client 3） | ✅ 全绿（168/168）；live run 见 [`17`](17-autonomy-pr-live-run.md) §5 |
| V13 | 团队自建 + PR 标准流程 + 看板降噪（v1.3） | `lib/git.js` 单测 23 例（真实临时仓库 + bare remote：status/branch/commit/verify/push/merge/PR manual+gh 假 exec/6 条安全拒绝）；`team_flow_git` 端到端 1 例（prepare→commit→verify→push→pr→gate→merge，合并后文件落在 main）；自动组队 3 例（spawn/wake/容量 8/幂等补员）+ dashboard git 快照 2 例；看板拓扑降噪与 Git 徽章契约测试 | ✅ 全绿（162/162）；live 见 [`17`](17-autonomy-pr-live-run.md) |
| V12 | 成员自治 + 提案活性（v2.2） | 离线测试 22 例（engine 6 / tools 3 / dashboard 4 / client 补充）：成员自建项（id/scope 冲突/依赖/self-claim/open）、提案 deadline+quorum、惰性自动裁决（通过/否决/平票/无 quorum 升级）、阻断提案继续拦截、快照与客户端徽章 | ✅ 全绿（129/129）；live 见 [`15`](15-autonomy-live-run.md) |
| V11 | 对等协作 live run（3 成员 / 8 分钟 / 3 开放项） | run `run-20261101174053-1i3e`：开放队列三人自抢单、频道 8 问 6 答（不经 Lead）、p1 dod 提案 2/2 通过并自动并入 DoD、互邀评审 3 人交叉、gate 一次通过；看板实测（[`13`](13-collaboration-live-run.md) + `docs/evidence/dashboard/collab-*.png`） | ✅ 完成 |
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
