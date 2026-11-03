# Agent Team Workflow Kit（DSH）

在 **DeepSeek Harness** 上落地的一套通用 Agent Team 架构 + 可安装插件。

它给 DSH 原生 Agent Teams 补上缺失的**治理层**：注入式标准工作流（plan → 并行独立执行 → 相互审阅 → 质量门禁 → 收敛）、评审轮次状态机、写范围纪律、证据强制与归档报告。

```
原生 Agent Teams（传输层）          本插件（治理层 + 对等协作层）
├─ spawn_teammate 具名成员    +    ├─ team_flow_plan    计划/波次/写范围/评审者/开放队列
├─ send_message 点对点消息     +    ├─ team_flow_status  黑板 + 每步 next_actions + 协作摘要
├─ team_task_* 共享任务板      +    ├─ team_flow_report  结构化交付 + 证据
├─ wait_agent / interrupt      +    ├─ team_flow_review_submit / _respond
└─ 共享 cwd / 文件系统         +    ├─ team_flow_gate    六类门禁 + finalize
                                    ├─ team_flow_escalate 升级与仲裁
                                    ├─ team_flow_repair   卡点修复（reopen/reassign/reset_review）
                                    ├─ team_flow_item    成员自建工作项（自建/开放队列/指派同伴）
                                    ├─ team_flow_staff   团队自建/补员（spawn/wake 缺失成员）
                                    ├─ team_flow_git     标准 PR 流程（分支/提交/验证/推送/PR/合并）
                                    ├─ team_flow_talk    成员直连频道（提问/回答/状态/反对）
                                    ├─ team_flow_work    开放队列认领/释放、评审邀请/接受、任务交接
                                    ├─ team_flow_decide  提案与投票（DoD/范围/重规划），平票升级 Lead 仲裁
                                    └─ team_flow_read    拉取频道、待认领、邀请、待投提案、未答问题
```

**这不是"Lead 逐项派活"的委派式工作流**：成员可以自己认领开放队列、**发现计划外工作时自建工作项**、
直接向同伴提问、邀请同伴评审、对 DoD/范围提案并投票（提案有截止时间与法定人数，超时惰性裁决）、
把做不完的任务交接给同伴；Lead 只负责定 mission、仲裁死锁与最终门禁。
所有协作动作都落在黑板（`state.json`）上，可在实时看板中回放。

## 目录

| 路径 | 内容 |
| --- | --- |
| [`docs/01-research-claude-agent-teams.md`](docs/01-research-claude-agent-teams.md) | Claude / Anthropic Agent Teams 与 13 篇多智能体论文调研 + 可执行设计框架（757 行，55 处引用） |
| [`docs/02-dsh-plugin-api.md`](docs/02-dsh-plugin-api.md) | DSH 插件 API 逆向侦察：工具注册、提示注入、Agent Teams 服务、生命周期、bundle 清单、陷阱（705 行） |
| [`docs/03-architecture.md`](docs/03-architecture.md) | **架构设计**：分层、角色模型、注入四层、状态机、门禁、黑板、诚实边界、ADR |
| [`docs/04-workflow-protocol.md`](docs/04-workflow-protocol.md) | **注入式工作流协议**：端到端 runbook、工具参考、数据模板、rubric、失败 playbook、反模式 |
| [`docs/05-verification.md`](docs/05-verification.md) | 验证证据：测试清单与命令、安装/激活证据、未验证项 |
| [`docs/06-review-findings.md`](docs/06-review-findings.md) | 独立 reviewer 的对抗性审阅原始记录（两轮共 24 条发现，未修改） |
| [`docs/07-review-resolution.md`](docs/07-review-resolution.md) | 逐条处理决定：修复 / 部分修复 / 不接受及理由 |
| [`docs/08-live-run.md`](docs/08-live-run.md) | **重启后的真实 live run**：4 成员 / 2 并行项 / 5 分钟跑通全流程的证据与观察 |
| [`docs/09-dashboard-design.md`](docs/09-dashboard-design.md) | **实时监控看板**设计契约：snapshot 数据契约、HTTP 路由、Client View、面板与容错 |
| [`docs/10-dashboard-verification.md`](docs/10-dashboard-verification.md) | 看板验证记录：30 例离线测试、真实黑板 dry-run、待人工确认的端到端步骤 |
| [`docs/11-dashboard-live-rootcause.md`](docs/11-dashboard-live-rootcause.md) | **「View 不出现」根因**：client 启动图静默跳过（`exports` 漏导 `./package.json`）+ live 只读验证方法 |
| [`docs/12-peer-collaboration.md`](docs/12-peer-collaboration.md) | **对等协作层设计**：channel / 开放队列 / 评审邀请 / 提案投票 / 交接、state v2、快照 v2、UI 契约 |
| [`docs/14-member-autonomy.md`](docs/14-member-autonomy.md) | **成员自治 + 提案活性**：`team_flow_item` 自建项、deadline/quorum/惰性自动裁决、快照与看板增量 |
| [`docs/16-team-autonomy-pr.md`](docs/16-team-autonomy-pr.md) | **团队自建 + PR 标准流程 + 看板降噪**：`autoStaff`/`team_flow_staff`、`team_flow_git`、拓扑与 Git 徽章 |
| [`docs/17-autonomy-pr-live-run.md`](docs/17-autonomy-pr-live-run.md) | **自治团队 live run**：自动唤醒组队、成员自建 S1、真实 handoff、p1 超时自动裁决、协作噪音观察与修复 |
| [`docs/18-claude-gap-analysis.md`](docs/18-claude-gap-analysis.md) | **对照正式 Claude Code Agent Teams 的差距清单**：22 维能力矩阵、5 个缺失项/4 个部分项、Wave 1–3 模仿方案与验收 |
| [`docs/19-wave1-features.md`](docs/19-wave1-features.md) | **v1.4 落地契约**：角色/模型映射、plan-first、生命周期 hooks、优雅关闭、成员面板路由、角色工具限制、worktree 隔离、token 预算 |
| [`docs/21-member-transcript.md`](docs/21-member-transcript.md) | **v1.5 成员对话视图**：`member.transcript` 投影（session log → user/assistant/system/tool 消息）、降级策略、安全边界 |
| [`docs/23-v16-parallel-and-sandbox.md`](docs/23-v16-parallel-and-sandbox.md) | **v1.6 并行 worktree 隔离 + 工作流能力沙箱**：off/serial/parallel、item 级 commit/verify/merge、产物门禁；roles allow/readOnly；平台边界说明 |
| [`docs/25-native-tool-sandbox.md`](docs/25-native-tool-sandbox.md) | **v1.7 原生工具沙箱**：`ctx.tools.guard()` 在工具调用前拒绝 write/edit/bash/terminal；readOnly/allow/deny 判定表、fail-open 边界 |
| [`docs/27-tool-guard-kit.md`](docs/27-tool-guard-kit.md) | **v1.8 可复用沙箱库 `@local/dsh-tool-guard-kit`**：三步抽象成零依赖库（判定/审计/生命周期/Teams 适配器），本插件改为消费该库 |
| [`docs/29-board-design-v19.md`](docs/29-board-design-v19.md) | **v1.9 看板视觉重构**：参考 refero shadcn 风格（单色/24px 卡片/18px 胶囊/发丝线/统计块），新旧截图与设计映射 |
| [`docs/13-collaboration-live-run.md`](docs/13-collaboration-live-run.md) | **对等协作 live run**：3 成员 / 3 开放项 / 8 分钟，抢单、直连问答、提案投票、互邀评审、gate 全记录 + 看板截图 |
| [`packages/agent-team-workflow/`](packages/agent-team-workflow/) | 可安装插件包（零外部依赖，纯 ESM） |

## 快速开始

### 1. 安装（DSH Desktop / dsh profile）

用 `plugin_manager` 安装本地目录（**不要**手动 `pnpm link` 或改 profile 文件）：

```text
plugin_manager(
  action: "install_bundle",
  target: "~/dsh-workspace/agentteam-kit/packages/agent-team-workflow"
)
```

`application: "applied"` 表示已挂载。**首次安装新代码后建议重启 DSH 一次**：链接目录的热重载不会替换已在运行的 JS 模块代（本机实测：修改 `index.js` 后旧模块仍生效），重启才会加载新代。

### 2. 让 Lead 用工作流

对 Lead 说：

> 用 Agent Team 工作流做这件事：……

Lead 会 `team_flow_plan` → 用返回的 spawn 简报 spawn 队友 → worker `team_flow_report` → reviewer `team_flow_review_submit` → 作者 `team_flow_review_respond` → Lead `team_flow_gate {finalize:true}` → 产出 `.agentteam/report.md`。

也可以直接要求：

> 先 `team_flow_status` 看现状；按 `next_actions` 推进。

### 3. 查看运行态

- `.agentteam/teams/<teamId>/state.json`：机器可读黑板（items / reviews / escalations / gate / events）
- `.agentteam/teams/<teamId>/report.md`：finalize 后的报告
- 每支 Team 独立目录（`teamId` = Lead 会话 id），同一 workspace 的多支 Team 互不可见
- 队友侧：`team_flow_status` 随时返回自己的作业单

## 对等协作（workflow v2）

| 场景 | 成员怎么做 |
| --- | --- |
| 开放队列 | Lead `team_flow_plan` 时给 item 标 `assignment:"open"`（并可用 `workers:[...]` 生成认领池简报）；成员 `team_flow_work {action:"claim"}` 自己领，做完照常 `team_flow_report`；做不动就 `release` 或交接 |
| 同伴提问 | `team_flow_talk {target:"<member>", kind:"question", item_id}` 直接问；被问的人 `kind:"answer", reply_to` 回。Lead 不中转 |
| 互邀评审 | 作者报告后 `team_flow_work {action:"request_review", reviewer?}`；省略 reviewer = 开放邀请，任何同伴可 `take_review` |
| 协商 DoD/范围 | `team_flow_decide {action:"propose", kind:"dod|scope|replan", ...}`，受影响成员各投一票；接受的 dod 提案自动并入 DoD；平票升级 Lead 仲裁（`resolve`） |
| 任务交接 | `team_flow_work {action:"handoff_offer", to:"<member>"}`，对方 accept 后所有权与共享任务一起转移 |
| 看板 | 会话头部 View →「团队看板」：频道、提案投票、待认领、peer↔peer 拓扑边、详情抽屉协作记录 |

## live 记录

- [`docs/08-live-run.md`](docs/08-live-run.md)：v1 委派式 live run（4 成员 / 2 并行项 / 5 分钟）；
- [`docs/13-collaboration-live-run.md`](docs/13-collaboration-live-run.md)：**v2 对等协作 live run**（3 成员 / 3 个开放项 / 8 分钟）——
  Lead 只做了 `team_flow_plan` 与 `team_flow_gate` 两次调用，其余抢单、提问/回答、提案投票、互邀评审全部由成员之间完成；
  看板截图见 `docs/evidence/dashboard/collab-*.png`。

## 实时监控看板

插件自带一个 Web 端**实时看板**（不需要另装）：会话头部 View 切换 → **"团队看板"**。

- **Header**：run id、阶段徽章、`approved/total`、最近更新时间、刷新/暂停；
- **执行流程图**：按依赖波次分列的工作项卡片（状态色条、`R{n}/{max}` 评审自循环、待评审高亮、escalation 红标），带 `blockedBy` 箭头；
- **协作拓扑**：Lead 与成员节点（running 脉冲、inactive 半透明、failed 红色、`fresh/fork` 徽章），边为「Lead→成员」「成员→自己的项」「reviewer→被审项」；
- **事件流 / 门禁 / 升级**三面板 + **详情抽屉**（DoD、报告文件与命令退出码、评审记录与 findings 处置、repair log）。

数据来自 `GET /api/agent-team-workflow.snapshot?session=<id>`（Connection 认证围栏内，只读、`no-store`），客户端 1.2 秒轮询、页面隐藏时暂停。看板不写任何状态。

## 插件配置（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `artifactsDir` | `.agentteam` | 黑板目录（相对 Team 工作目录或绝对路径） |
| `maxReviewRounds` | `2` | 每个工作项允许的评审轮次，超限自动升级 Lead |
| `maxParallelItems` | `4` | 单波次并行项上限（超出给 warning） |
| `maxItems` | `12` | 单 run 工作项上限 |
| `workerContext` | `fresh` | 成员上下文模式；`fresh` 保证独立执行 |
| `injectPolicy` | `true` | 是否向 Team 成员注入工作流协议段 |
| `writeArtifacts` | `true` | 是否落盘 state/report（关闭则纯内存，重启丢） |
| `strictScopes` | `false` | 报告文件越出写范围时是否判 gate 失败 |
| `allowScopeOverlap` | `false` | 允许同波次写范围重叠（降级为 warning） |
| `autoNotify` | `true` | report/评审后是否自动通知对方 |
| `requireReviewEvidence` | `true` | 批准型评审未声明 `evidence_checked` 时拒绝并判门禁失败 |

## 验证

```bash
cd packages/agent-team-workflow
NODE=~/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node
"$NODE" --test test/engine.test.mjs test/tools.integration.test.mjs test/plugin.test.mjs
```

224 个用例覆盖：计划校验（自审/环/写范围竞争/成员名/规模）、批准绑定报告版本、累计返修预算与 nits 早停、多 reviewer、门禁六类（含空证据、空命令、依赖未批准、评审无证据）、override/waived 与 finalize 参数回显、卡点修复、双重角色只 spawn 一次、Team 隔离、内存模式、工具权限、提示注入与拆除、真实 JSON Schema 校验。详见 [`docs/05-verification.md`](docs/05-verification.md)。

**已通过真实 live run 验证**（2026-11-01，重启后）：4 个成员、2 个并行工作项、一次升级仲裁、两轮独立评审、门禁收敛并生成报告——记录与原始证据见 [`docs/08-live-run.md`](docs/08-live-run.md)。

## 已知边界（诚实标注）

- **只读角色**无法在运行时强制（`spawn_teammate` 无 tools 参数）→ 角色约定 + 越界写检查。
- **无 hooks**：完成门禁由 Lead 在 finalize 前执行；成员仍可自行 `team_task_update(complete)` 原生任务，但 **run 收敛必须过 `team_flow_gate`**。
- **无 token 计量**：只给成本量级锚点（7×–15×）与硬上限，不伪造预算数据。
- **链接插件不能 import 宿主包**：实现保持零外部依赖（仅 `node:*`），因此没有 `Config`/schemastery 校验，配置由 `lib/config.js` 自行收敛并回显在 `team_flow_status`。
- **黑板是工作区文件**：成员若绕过工具直接改写，插件无法从技术上防伪（共享 cwd 的固有边界）；评审结论/证据请以最终答复与报告复核为准。
- **写范围检查基于自报**：插件不解析 git diff，未申报的越界写由评审与 Lead 最终 diff 复核兜底。
- **每会话固定注入成本**：15 个工具 schema + 协议段约 7–8k tokens；不用工作流的会话可用 `plugin_manager set_bundle` 关闭。

## 卸载

```text
plugin_manager(action: "remove_bundle", target: "@local/dsh-agent-team-workflow")
```

黑板文件（`.agentteam/`）由插件写入工作目录，卸载不会删除，可自行清理。

## 设计依据

- Anthropic《How we built our multi-agent research system》《Building effective agents》、Claude Code Agent Teams 官方文档；
- Cognition《Don't Build Multi-Agents》的 context-sharing / implicit-decision 两条原则；
- MetaGPT 的 SOP 注入、ChatDev 的评审环、AutoGen/CAMEL 的角色对话、MoA 的分层聚合、MAST 的失败分类；
- 详见 [`docs/01`](docs/01-research-claude-agent-teams.md)，每条结论都带来源链接与证据分级。
