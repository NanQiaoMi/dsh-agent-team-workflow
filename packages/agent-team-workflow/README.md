# @local/dsh-agent-team-workflow

一个 **DeepSeek Harness** 插件（bundle），把「注入式标准工作流」叠加在原生 Agent Teams 之上：
计划 → 并行独立执行 → 相互审阅 → 质量门禁 → 收敛。

- 零外部依赖（纯 ESM，只 import `node:*`），可安装为本地链接包；
- 工具与提示段落按 **Agent 作用域**安装，只对 Team 成员生效；
- 运行态落在工作目录 `.agentteam/teams/<teamId>/state.json`（黑板）+ 同目录 `report.md`（报告）；每支 Team 独立目录。

## 它提供了什么

**提示注入**（每个 Team 成员的系统提示，`team:workflow` 段）

- 六阶段协议与角色职责；
- 不变量：写范围纪律、证据优先、独立评审、消息不构成交付、升级而不是停滞、不手改黑板；
- `next_actions` 是权威作业单。

- **实时监控看板（Web 端）**：`lib/dashboard.js`（零 import 聚合）+ `lib/dashboard-route.js` + `client.js`（`conversation.view` 团队看板），包含执行波次图、协作拓扑、事件流、门禁、阶段耗时指标、模型与思考路由面板及详情抽屉（含审阅标准/复杂度元数据）。
- **场景预设（`team_flow_plan { preset }`）**：内置 `fast-fix`、`feature`、`pr-review`、`deep-audit` 四类工作流预设，自动配置返修预算、思考默认偏向、审阅深度与 DoD 严格度，并允许单工作项显式覆盖。
- **自适应思考与模型路由（`lib/thinking-router.js`）**：拦截 `agent/request` 并结合 `ctx.llm.resolveModelInfo` 与同轮 `turn` 锁定，按成员角色（Lead 规划/仲裁/协调）、工作项复杂度（`complexity` / `thinking_tier`）、返工与审阅深度自动选择思考档位与可选角色模型。
- **分级 Review 与 PR 体系（`lib/review-policy.js`）**：按修改文件与 diff 行数自动分级 `light | standard | deep` 并匹配 6 类域 Rubric（`code | security | api | docs | tests | refactor`）；支持并行多审阅者通知与乱序提交、`dod_checks` 校验、`team_flow_git { action: "pr_inspect" }` PR 风险预检与结构化 Markdown PR Review 提交。
- **事件驱动编排与动态补齐**：订阅 `agent/status` 空闲事件，单飞防重入与同成员消息合并，支持 `lazyStaffing` 与 `take_review` / `claim` 等职责变更后的增量工具动态补齐。
- **v2.1 可靠性与效率加固**：Wave 1+ 懒建 Worktree（基于最新 `runBranch` 切出）与汇报范围内安全自动提交；沉默卡死分级轻推（`maxStallNudges`）及超限升级 Lead；合后集成验证门禁（`integrationVerifyCommands`）；计划静态预检（`preflightPlan`）、工具结构化纠偏提示与主机 `hostVerified` 实测快照（支撑 `light` 审阅免重复跑慢测）；`fast-fix` 场景化工具瘦身（`presetToolPruning`）及看板/报告可靠性归因指标。

**19 个模型工具**

| 工具 | 权限 | 作用 |
| --- | --- | --- |
| `team_flow_plan` | Lead | 建 run：分解工作项、校验独立性、创建 backing 任务、算出波次、产出逐字可用的 spawn 简报 |
| `team_flow_status` | 成员 | 读黑板 + 该成员自己的 `next_actions` |
| `team_flow_report` | owner | 结构化交付（文件、命令+退出码、证据、风险、handoff_packet），自动指派评审并通知 |
| `team_flow_review_submit` | 指派 reviewer | verdict + 分级 findings + 审查证据 |
| `team_flow_review_respond` | owner | 逐条回应 finding（fixed/rebut/accepted_risk + 证据），开下一轮或升级 |
| `team_flow_gate` | Lead | 六类门禁检查；通过且 `finalize:true` 时写报告并收敛 |
| `team_flow_escalate` | 成员/Lead | 升级 blocker/冲突/范围变更/仲裁（只记录，不改 item 状态）；Lead 裁决 |
| `team_flow_repair` | Lead | 卡点修复：reopen / reassign / reset_review，必须写 reason |
| `team_flow_item` | 成员 | 自建工作项（自建/开放队列/指派同伴），自动建共享任务，与计划项同走评审与门禁 |
| `team_flow_staff` | Lead | 后续波次/掉队补员：按 item 的 owner/reviewer/开放池 spawn 或 wake，容量保护 ≤8 |
| `team_flow_git` | 成员/Lead | 标准 PR 流程：prepare 分支、commit 指定文件、verify、push、pr（gh 或 manual）、review、merge（门禁后）、worktree 隔离 |
| `team_flow_stop` | Lead/成员 | 优雅关闭：request/accept/reject/interrupt/status（成员可拒绝并说明） |
| `team_flow_plan_approval` | 成员/Lead | plan-first：提交计划、批准/拒绝（autoApprovePlan 可自动批准） |
| `team_flow_talk` | 成员 | 对等频道：向某成员或全队发消息（提问/回答/状态/反对），走原生 sendMessage 直投并写黑板 |
| `team_flow_work` | 成员 | 认领/释放开放队列项、邀请/接受评审、任务交接（offer/accept/decline） |
| `team_flow_decide` | 成员（resolve 仅 Lead） | 提案（DoD/范围/重规划/评审策略）与投票；平票升级，Lead 仲裁 |
| `team_flow_read` | 成员 | 拉取频道、提案、待认领、邀请、交接、未答问题与该 item 线程（含 handoff_packet） |
| `team_dev_lookup` | 成员/Lead | 零 grep 代码库结构速查：清单、模块、脚本命令、标准合同、任务原型模板、导出符号定位 |
| `team_dev_contract` | 成员/Lead | 标准接口合同管理：发布、读取、列表、校验导出符号（支持跨智能体无缝对接） |

**本地开发协助系统与结构库（devkit）**
- 静态结构扫描器：`bin/scan-devkit.mjs`，自动解析 `package.json`、模块入口、导出符号、测试套件与执行脚本，生成 `.agentteam/devkit/manifest.json`；
- 标准结构合同库：`.agentteam/devkit/contracts/*.json`，固化智能体间方法契约与模拟数据；
- 任务原型模板库：内置 5 大高频任务模式（`module_interface`、`core_implementation`、`integration_wiring`、`repro_bugfix`、`refactor_safe`）；
- 跨任务交接包：`team_flow_report` 支持 `handoff_packet`，唤醒后续智能体时自动注入上游合同与入口信息，彻底消除反复搜索与猜测。

**门禁**：报告存在、证据合格（非空命令+整数退出码+evidence）、依赖已批准、评审全批准且批准带 `evidence_checked`、findings 清零、写范围纪律（基于自报）、独立性与升级。

## 安装

```text
plugin_manager(action: "install_bundle", target: "<此目录绝对路径>")
```

`apply` 结果 `application: "applied"` 表示挂载成功；本地链接包首次换成新代码后建议重启一次。
卸载：`plugin_manager(action: "remove_bundle", target: "@local/dsh-agent-team-workflow")`。

## 配置（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `artifactsDir` | `.agentteam` | 黑板目录 |
| `maxReviewRounds` | `2` | 每项评审轮次上限（超限自动升级 Lead） |
| `maxParallelItems` | `4` | 单波次并行项建议上限 |
| `maxItems` | `12` | 单 run 工作项上限 |
| `workerContext` | `fresh` | 成员上下文模式 |
| `injectPolicy` | `true` | 注入协议段 |
| `writeArtifacts` | `true` | 是否落盘 |
| `strictScopes` | `false` | 越界写是否判门禁失败 |
| `allowScopeOverlap` | `false` | 允许同波次写范围重叠（warning） |
| `autoNotify` | `true` | 自动通知评审/作者 |
| `requireReviewEvidence` | `true` | 批准型评审必须声明 `evidence_checked`，否则拒绝/门禁失败 |
| `nitTolerance` | `true` | 纯挑刺评审禁止打回（强制转为 approve_with_nits 避免无谓返工） |
| `archiveApprovedItems` | `false` (`true` in patch) | 已批准工作项详细证据沉降至冷存储，减小热态体积 |
| `eventDrivenOrchestrator` | `true` | 订阅 `agent/status` 空闲事件触发零延迟编排（配自适应 watchdog） |
| `lazyStaffing` | `false` (`true` in patch) | 按需派发后续波次 worker 与待审阅 reviewer |
| `thinkingRouting` | `auto` | 思考档位路由模式：`auto \| role \| off` |
| `thinkingDefaultBias` | `low` | 无 `medium` 档位模型（如 DeepSeek）的默认实现语义偏向：`low \| high` |
| `parallelReviews` | `true` | 向多审阅者并行派发并允许乱序独立提交审阅 |
| `defaultReviewDepth` | `auto` | 默认审阅深度：`auto \| light \| standard \| deep` |
| `strictReviewRubric` | `false` | 开启后 `deep` 深度批准必须携带显式 `dod_checks` |
| `lazyWorktreeProvision` | `true` | 仅预建已解锁波次 Worktree，Wave 1+ 等上游合入后按最新 `runBranch` 懒创建 |
| `autoCommitOnReport` | `true` | 汇报时检测范围内未提交改动并安全自动提交（越界改动拦截报错） |
| `maxStallNudges` | `2` | 同一 `rev` 沉默无进展成员的最大自动轻推次数（`0` 关闭），超限升级 Lead |
| `stallNudgeDelaySeconds` | `45` | 唤醒或上次轻推后判定成员停滞的最小等待秒数 |
| `integrationVerifyCommands` | `[]` | 全量合入 `runBranch` 后、Finalize 前必须通过的集成验证命令列表 |
| `hostVerifyOnReport` | `true` | 汇报时由主机实测 `gitVerifyCommands` 并生成绑定 SHA 的 `hostVerified` 快照 |
| `presetToolPruning` | `true` | 在 `fast-fix` 等轻量预设下按协作活跃度裁剪冗余工具 Schema |

无 `Config` 导出（避免 schemastery 依赖）；配置在 `resolveSettings` 中收敛并夹紧范围，生效值回显在 `team_flow_status.settings`。

## 目录

```
index.js            Cordis 插件入口（inject / apply / per-Agent 安装、动态职责工具补齐与拆除）
lib/config.js       配置解析、默认值与场景预设（fast-fix / feature / pr-review / deep-audit）
lib/store.js        黑板持久化：原子写 + 进程内锁 + 路径解析
lib/workflow.js     纯状态机：计划校验、版本绑定、并行返修轮、门禁、next_actions
lib/protocol.js     注入文本：按角色协议、worker/reviewer 简报、Rubric 通知、最终报告
lib/thinking-router.js  agent/request 自适应思考档位/模型路由器与按 turn 锁定
lib/review-policy.js    Diff 风险分级器、6 类 Rubric 清单、DoD 校验与 PR Review Markdown 格式化
lib/orchestrator.js     事件驱动编排器、同成员摘要合并与自适应 watchdog
lib/git.js              安全 Git / Worktree / PR 检查（gitPrInspect）原语
lib/tools.js            19 个工具定义与执行
lib/tool-matrix.js      基于角色与职责的工具装配矩阵
lib/telemetry.js        细粒度 Token 消耗归因度量与分角色占比统计
client.js               Web 端看板（conversation.view，纯 JS 动态模块，只 require('react')）
lib/dashboard.js        看板聚合（零 import 纯函数）：waves/状态归一化/阶段耗时/思考路由
lib/dashboard-route.js  GET /api/agent-team-workflow.snapshot（Connection 认证 Fetch 路由）
```

## 验证

```bash
NODE=~/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node
"$NODE" --test test/engine.test.mjs test/tools.integration.test.mjs test/plugin.test.mjs
```

213 个用例：计划校验与波次、批准绑定报告版本、累计返修预算与 nits 早停、多 reviewer、门禁六类、override/waived 与 finalize 参数回显、卡点修复、双重角色只 spawn 一次、Team 隔离、内存模式、工具权限、提示注入与拆除、真实 JSON Schema 校验；对等协作（认领/释放、评审邀请与接受、交接、提案投票与平票仲裁、阻断提案、频道与摘要、v1 板升级）；看板快照 v2（协作块/截断/防御降级）、路由状态码与降级、客户端模块契约与 v1/v2 快照渲染。

## 真实运行记录

2026-11-01 重启后在空目录跑通一次完整 live run（4 成员 / 2 并行项 / 约 5 分钟，含一次升级仲裁与两轮独立评审），
记录见仓库 `docs/08-live-run.md`，原始工件在 `docs/evidence/live-run/`。

## 边界

- 无法在运行时强制只读角色、无法用 hooks 阻断原生 `complete`、无 token 计量：这些能力本包不做伪称，只用「角色约定 + 门禁检查 + 报告审计」替代。
- 黑板是唯一真源；手改 `state.json` 会导致状态机不一致。
- 详细协议见仓库 `docs/03-architecture.md`、`docs/04-workflow-protocol.md`。
