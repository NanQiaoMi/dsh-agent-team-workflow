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

**实时监控看板（Web 端）**

- Host：`lib/dashboard.js` 把黑板 + roster + 原生任务板聚合成快照；`lib/dashboard-route.js` 在 Connection 认证围栏内提供 `GET /api/agent-team-workflow.snapshot?session=<id>`（只读、`no-store`）。
- Client：`client.js` 注册 `conversation.view`「团队看板」——执行流程图（波次/依赖箭头/评审自循环）、协作拓扑、事件流、门禁、升级、详情抽屉；1.2s 轮询、页面隐藏时暂停。
- 打开方式：会话头部 View 切换 →「团队看板」。

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
| `archiveApprovedItems` | `false` | 已批准工作项详细证据沉降至冷存储（.agentteam/teams/<id>/archive/），减小热态体积 |

无 `Config` 导出（避免 schemastery 依赖）；配置在 `resolveSettings` 中收敛并夹紧范围，生效值回显在 `team_flow_status.settings`。

## 目录

```
index.js            Cordis 插件入口（inject / apply / per-Agent 安装与拆除）
lib/config.js       配置解析与默认值
lib/store.js        黑板持久化：原子写 + 进程内锁 + 路径解析
lib/workflow.js     纯状态机：计划校验、版本绑定、返修轮、门禁、next_actions（零依赖，可独立测试）
lib/protocol.js     注入文本：L1 协议、worker/reviewer 简报、通知、最终报告
lib/tools.js        17 个工具定义与执行
lib/tool-matrix.js  基于角色裁剪工具装配矩阵（Lead 17/Worker 10/Reviewer 6/Verifier 4）
lib/telemetry.js    细粒度 Token 消耗归因度量与分角色占比统计
locale/{en,zh}.json 插件管理器展示元数据
icon.svg            插件图标
cordis.patch.yml    bundle 补丁（新增一行，不覆盖原生 Team 行）
client.js           Web 端看板（conversation.view，纯 JS 动态模块，只 require('react')）
                    ⚠️ package.json 必须导出 "./package.json"，否则 Host client-modules 扫描器
                    会静默跳过本包的客户端半（看板 tab 不出现），详见 docs/11
lib/dashboard.js    看板聚合（零 import 纯函数）：waves/状态归一化/counts/截断
lib/dashboard-route.js  GET /api/agent-team-workflow.snapshot（Connection 认证 Fetch 路由）
test/               219 个离线用例（engine 26 / collaboration 25 / tools 37 / plugin 6 /
                    dashboard 33 / route 7 / client 40 / git 25 / hooks 4 / member-route 6 / transcript 4 / tool-guard 6）
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
