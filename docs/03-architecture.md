# 03 · Agent Team 架构设计（Claude/Anthropic 实践 → DSH 可落地方案）

> 结论先行：**DSH 原生 Agent Teams 已经解决了「谁在、能说、能认领、能依赖」的传输层；本方案补齐缺失的「治理层」——注入式 SOP、评审状态机、质量门禁、黑板与收敛判定。**
> 实现见 [`packages/agent-team-workflow`](../packages/agent-team-workflow/)，协议正文见 [`04-workflow-protocol.md`](04-workflow-protocol.md)，调研依据见 [`01-research-claude-agent-teams.md`](01-research-claude-agent-teams.md)，API 事实见 [`02-dsh-plugin-api.md`](02-dsh-plugin-api.md)。

---

## 1. 目标与约束

### 1.1 设计目标

| # | 目标 | 可验收的判定 |
| --- | --- | --- |
| G-1 | **注入式标准工作流**：不靠模型即兴发挥，靠注入的 SOP + 工具强制 | 每个 Team 成员的系统提示里都有一段固定协议；每步都有 `next_actions` 指明动作 |
| G-2 | **多 agent 并行协作** | 计划阶段计算执行波次；同一波次的成员可同时 spawn 并各自独立推进 |
| G-3 | **相互审阅** | 作者 ≠ 评审、评审 verdict + 分级 findings + 证据；未批准不能收敛 |
| G-4 | **相互沟通** | 点对点消息 + 结构化通知（review request / changes / approval / escalation） |
| G-5 | **独立执行** | 成员 fresh context、独占写范围、各自证据；共享的是文件与黑板，不是对话 |
| G-6 | **可审计、可收敛** | 运行态落盘（state.json + report.md）；门禁未过不得 finalize |

### 1.2 现实约束（来自调研与 API 侦察，不是假设）

| 约束 | 事实来源 | 对本设计的影响 |
| --- | --- | --- |
| 团队不是默认档，多数编码任务并行度低 | Anthropic《Building effective agents》《multi-agent research system》；Cognition《Don't Build Multi-Agents》 | 插件提供**降档路径**：`needs_review=false`、单 item、Lead 直做；不做「强行组队」 |
| 多智能体成本约为单会话 4–15× | Anthropic 研究系统 15×、Claude Code Teams(plan mode) 7× | 默认 3 人最小集、每人少量 item、评审轮次上限 2，并在协议里写明成本预期 |
| 共享 cwd，无文件锁、无 worktree 隔离 | Claude Code Agent Teams 官方说明；DSH 原生同样共享 cwd | 用**写范围分区 + 波次串行化**代替锁；越界写进入门禁检查 |
| `write_scopes` 是 advisory | DSH `team_task_create` 语义 | 插件在报告与门禁两层各查一次，越界可判 warning 或 failure |
| 无法从运行时把成员限制为只读 | DSH `spawn_teammate` 无 tools/model 参数 | 「只读评审」只能作为角色约定 + 事后 diff 审计，必须**诚实标注** |
| 无 hooks，任务完成是自述 | DSH 任务板 `complete` 只校验 `in_progress` | 完成门禁只能由 Lead 在 finalize 前跑检查（本插件即该检查器） |
| 消息无回执，`send_message` 成功 ≠ 已处理 | DSH 工具说明 | 通知只作提醒；状态以黑板为准，成员被要求「收到消息后重读 status」 |
| 工作区 `link:` 插件不能 import 宿主包 | [`02`](02-dsh-plugin-api.md) 实测 | 插件实现为**零外部依赖**纯 ESM（仅 `node:*`） |
| 工具 `output.schema` 会被运行时校验 | DSH `dsh-tools` 源码 | 每个结果先序列化为 lossless JSON 再返回，避免 `ToolOutputError` |

---

## 2. 分层架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  L4  收敛与交付                                                        │
│      team_flow_gate → report.md（人类可读）+ state.json（机器可读）     │
├──────────────────────────────────────────────────────────────────────┤
│  L3  治理层（本插件的核心增量）                                          │
│      注入式 SOP · 工作项状态机 · 评审轮次 · 质量门禁 · 升级仲裁 · 黑板     │
├──────────────────────────────────────────────────────────────────────┤
│  L2  协作协议（原生 + 约定）                                             │
│      spawn_teammate · send_message · team_task_* · wait_agent · 共享 cwd │
├──────────────────────────────────────────────────────────────────────┤
│  L1  运行时（DSH 原生，插件不替换）                                       │
│      Agent 生命周期 · Session 日志 · 工具注册 · 系统提示组装 · 持久化      │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 职责划分：原生负责「传输」，插件负责「治理」

| 能力 | 归属 | 说明 |
| --- | --- | --- |
| 成员创建 / 身份 / roster | DSH 原生 | `spawn_teammate` 仅 Lead；成员是 durable 对象 |
| 消息投递 / 唤醒 / 步骤边界 steering | DSH 原生 | 插件只负责**在正确时机**发结构化通知 |
| 共享任务板 + revision CAS + blocked_by | DSH 原生 | 插件把工作项 1:1 映射为 backing task，借它的 CAS 做并发安全 |
| 共享文件系统（黑板载体） | DSH 原生 | 插件规定目录、所有权与写入方式 |
| SOP 注入（系统提示段落） | **插件** | 每个 Team 成员 scope 上注册 `team:workflow` section |
| 工作项 / 评审 / 门禁 / 仲裁状态 | **插件** | 原生任务板只有 pending/in_progress/completed，缺 review/approved/escalated |
| 独立执行约束（写范围、波次、fresh context） | **插件** | 计划期校验 + 简报注入 + 报告期检查 + 门禁复查 |
| 收敛判定与报告 | **插件** | 六类门禁 + `report.md` |

> 设计红线：插件**不**伪造运行时能力。凡是原生做不到的（只读强制、hooks、预算计量），一律标注为「约定 + 检查」并在门禁里做可验证的替代（见 §9）。

---

## 3. 角色模型

### 3.1 角色是数据，不是提示词风格

| 角色 | 职责 | 写权限 | 必填交付物 | 评审关系 |
| --- | --- | --- | --- | --- |
| `lead` | 准入、分解、分派、仲裁、集成、对外汇报 | 不写实现（只写黑板与最终交付） | 计划、门禁结果、终稿 | 不参与自审，只做裁决 |
| `implementer` | 在独占写范围内实现 | 仅自己的 `write_scopes` | 报告 + 文件 + 命令/退出码 + 证据 | 必须被 `reviewer` 审 |
| `verifier` | 独立验证，产出可复现证据 | 仅产物目录 | 命令、退出码、关键输出 | 可与其他 reviewer 并行 |
| `researcher` | 只读探索、事实核查 | 无（或极窄） | 带引用的 findings | 必须被审（证据可核查） |
| `architect` | 方案与权衡 | 设计文档范围 | 决策记录 + 备选对比 | 必须被审 |
| `writer` | 文档撰写 | 文档范围 | 文档 + 可运行示例 | 必须被审 |
| `reviewer` | 独立对抗性评审 | **只写评审意见，不改作者文件** | verdict + 分级 findings + 审查证据 | 作者 ≠ 评审 |

**最小集（默认）**：`lead` + `implementer` + `reviewer` + `verifier`，共 3 个 teammate；超过 5 人必须有并行度实测理由（调研 §3.4 决策矩阵）。

### 3.2 角色如何被"注入"

角色不是靠一句「你是评审」生效，而是三处一致：

1. **spawn 简报**（`renderWorkerBrief` / `renderReviewerBrief`）：使命、DoD、写范围、工作流步骤、沟通规则、禁止事项；
2. **系统提示协议段**（`team:workflow`）：所有成员共同的不变量（独立性、证据、沟通、升级）；
3. **工具强制**（`team_flow_*`）：角色越权会被拒绝（只有 owner 能 report/respond，只有被指派的 reviewer 能 submit，只有 Lead 能 plan/gate）。

---

## 4. 注入式工作流（四层注入 + 四个注入点）

| 层 | 内容 | 注入点 | 实现 | 失效风险与缓解 |
| --- | --- | --- | --- | --- |
| L1 团队宪法 | 不可协商的不变量：写范围、证据、独立评审、升级、禁止改板 | 每个 Team 成员系统提示 | `systemPrompt.section('team:workflow')` | 模型可能忽略 → `next_actions` 每步重申 + 门禁检查 |
| L2 角色卡 | 该角色使命/边界/交付物 schema | spawn 简报 | `renderWorkerBrief` / `renderReviewerBrief` | 跑偏 → Lead 可 `send_message` steering，仍不行 `interrupt_agent` |
| L3 任务卡 | 目标/DoD/写范围/依赖/backing task id | spawn 简报 + backing task description | `team_flow_plan` 生成 | 成员不看就开工 → 简报第一步要求 `team_flow_status` |
| L4 即时指令 | 返修、澄清、升级 | `send_message` + 结构化通知 | `reviewRequestMessage` 等 | 消息被忽略 → 状态在黑板，`next_actions` 会再次指向 |

注入的**唯一真源**是黑板 `state.json`：任何"下一步做什么"都从 `team_flow_status().next_actions` 推导，而不是从对话历史推断。这直接对应 Cognition 的「不要靠传话共享上下文」原则。

---

## 5. 状态机

### 5.1 运行（run）阶段

```
planned ──(首个 report)──► reviewing ──(全部 approved)──► converged ──(gate pass + finalize)──► finalized
   │                           ▲                                  ▲
   └──(gate 未过/被替换)── aborted                     escalated 项需 Lead 仲裁
```

### 5.2 工作项（item）状态

```
pending ─claim/开工─► running ─report─► reported ─(需评审)─► in_review
                                            │                   │
                                            │ approve           ├─request_changes─► changes_requested
                                            │                   │                        │
                                            └─(无需评审)─► approved ◄──respond+再评审──┘
                                                                  │
                                                          轮次耗尽/rebut blocker
                                                                  ▼
                                                              escalated ──► approved(override)
```

### 5.3 评审轮次与「批准绑定版本」

**核心不变量：verdict 绑定到它审阅的那一版报告。** 每次 `team_flow_report` 递增 `reportSeq`；review 记录创建时的 `reportSeq`；`lastReviewOf` / `allReviewersApproved` / `outstandingReviewers` / 门禁只统计**当前版本**的 verdict。因此：

- 作者重新提交一版报告，**旧批准立即失效**，所有 reviewer 必须重审新版本——不存在"批准结论被继承"的捷径；
- 想重新提交，必须先逐条回应未决 finding（否则 report 被拒）；
- 多 reviewer 时逐位批准，全部到位才算 approved。

**轮次预算按「返修轮」计，且在 item 生命周期内累计**：`reworkTotal` = 该 item 历史上非批准 verdict 的数量（其他 reviewer 的 approve 不消耗预算；**重新 report 不会清零**，只有 Lead 的显式 `repair reopen` 会重置）。`maxReviewRounds`（默认 2，1–5）耗尽后**自动升级 Lead 仲裁**；blocker 被 `rebut` 直接升级；同一 item 不会重复生成仲裁 escalation。

**批准型 verdict 的 findings 是「已接受的观察」**：`approve` / `approve_with_nits` 附带 finding 时，引擎把它们标记为 `accepted_by_reviewer`，不要求作者回应、也不进 G4 门禁——这样"只剩 nit → 早停"与门禁不会互相矛盾。

### 5.4 状态迁移的授权规则（工具层强制）

| 动作 | 谁可以 | 拒绝时的错误 |
| --- | --- | --- |
| `team_flow_plan` / `team_flow_gate` | 仅 Lead | `is Lead-only` |
| `team_flow_report` / `team_flow_review_respond` | 仅该 item 的 owner | `belongs to "<owner>"` |
| `team_flow_review_submit` | 仅当前指派 reviewer | `assigned to "<reviewer>", not "<me>"` |
| `team_flow_escalate`（创建） | 任何成员；**只记录，不改 item 状态** | — |
| `team_flow_escalate`（裁决） | 仅 Lead | `Lead-only` |
| `team_flow_repair`（reopen / reassign / reset_review） | 仅 Lead，必须写 reason | `Lead-only`、`every repair needs a reason` |

---

## 6. 质量门禁（Gate）

`team_flow_gate` 对每个 item 计算，全部通过且无阻断性升级，才允许 `finalize`：

| 门禁 | 判定 | 失败含义 |
| --- | --- | --- |
| **G1 报告存在** | `report` 非空 | 没交付就想过门 |
| **G2 证据合格** | 至少 1 条**非空命令**、所有 `exit_code` 为整数、并至少引用 1 条 evidence（`evidence_optional` 项跳过证据要求） | 只断言未验证，或空命令占位 |
| **G3 评审批准** | 所有声明 reviewer 最新 verdict ∈ {approve, approve_with_nits} | 未签核 / 有未决改动 |
| **G3b 评审证据** | 批准型评审必须声明 `evidence_checked`（`requireReviewEvidence`，默认开） | 橡皮图章式批准 |
| **G4 findings 清零** | 无未响应的**非批准** finding（批准型 verdict 的 observation 记为 `accepted_by_reviewer`） | 返修意见被忽略 |
| **G5 写范围纪律** | 报告文件 ⊆ 声明 scope；`strictScopes=true` 时越界即失败，否则 warning（**基于自报，见 §9**） | 越界改别人文件 |
| **G5b 依赖顺序** | 所有 `blocked_by` 已 approved（或被 Lead override 接受） | 在未完成依赖上构建 |
| **G6 独立性与升级** | reviewer ≠ owner；reviewer 为 fresh context（fork 则 warning）；无未解决 blocking escalation | 自审 / 绕过升级 |

`overrides` 只在 **finalize 且整体通过**时写入黑板；被接受项返回 `waived` 列表并在报告中单独标注"含 N 项 Lead 风险接受"，不会被伪装成全绿。预览式 `gate`（`finalize:false`）不落盘 override。

Override 只豁免"已在 failures 中列出的具体项"，不会把 item 变成免检；`pass` 与 `waived` 同时返回，报告头部区分通过方式。

---

## 7. 黑板与持久化

### 7.1 目录布局（相对 Team 工作目录）

```
.agentteam/
└── teams/<teamId>/                 # teamId = Lead Session id（每支 Team 独立黑板）
    ├── state.json                  # 唯一真源：phase/items/reviews/escalations/events/gate
    ├── report.md                   # finalize 生成的人类可读报告
    └── runs/<oldRunId>.json        # replace 归档的旧 run（phase=aborted）
```

**按 Team 隔离**：同一个 workspace 里的第二个顶层会话是另一支 Team，它的黑板落在自己的 `teams/<teamId>/`，既读不到也不能 gate/replace 别人的 run。

### 7.2 写入纪律

| 规则 | 实现 |
| --- | --- |
| 只有一个 owner 能改某个 item | 工具层按 `membership.name` 校验 |
| 所有写路径串行 | `withLock(absoluteStatePath)` + read-modify-write（不是缓存对象就地改） |
| 原子落盘 | 临时文件 + `rename` |
| 损坏可诊断 | JSON 解析失败抛 `WORKFLOW_STATE_CORRUPT` 并给路径 |
| 成员 cwd 可能不同 | 一律用 **Lead 的 cwd** 推导 artifact 路径（`membership.root.session`） |
| 成员不手改黑板 | L1 明文禁止；插件**无法检测**手改，见 §9 的边界说明 |

### 7.3 为什么用文件而不是 session 事件

DSH 的 session 投影与事件类型属于运行时契约，插件**不应**新增 session event type（侦察文档 §F.4）。文件黑板满足：跨进程可读、成员可直接用 `read`/`grep`、可归档、可 diff，且不依赖内部 API。

---

## 8. 独立执行与写冲突控制

| 手段 | 强度 | 本插件做法 |
| --- | --- | --- |
| 独立上下文 | 强 | 默认 `context: "fresh"`；评审者同样 fresh（避免被作者上下文污染） |
| 写范围分区 | 强（约定 + 双重检查） | 计划期校验同波次不重叠；报告期提示越界；门禁期判定 |
| 波次串行化 | 强 | DAG 计算 `waves`；`blocked_by` 同时落到原生任务板 |
| 任务级 CAS | 强 | backing task 的 `claim/complete` 走原生 revision CAS |
| 事后审计 | 中 | 报告声明文件 + gate 的 scope 检查 |
| ❌ 文件锁 / worktree / 只读白名单 | 不可用 | 不假装支持；文档与门禁都标注为「约定 + 检查」 |

---

## 8.5 对等协作层（workflow v2）

v1 的协调全部经过 Lead（委派式）。v2 加了一层**成员之间的直接协作协议**，目标是与 Claude Agent Teams 的
"peer 互相沟通、共同推进"对齐，而不只是"Lead 派活、成员回报"。

| 机制 | 黑板字段 | 工具 | 规则 |
| --- | --- | --- | --- |
| 对等频道 | `channel[]`（≤200，kind/refs/replyTo） | `team_flow_talk` | 成员直投（原生 `sendMessage`）+ 落板；Lead 不中转 |
| 开放队列 | `items[].assignment="open"` + `claim` | `team_flow_work {action:"claim"/"release"}` | 无主项谁认领谁做；认领同时 claim 原生任务；未报告可释放 |
| 互邀评审 | `reviewRequests[]` + `pendingReviewer` | `team_flow_work {action:"request_review"/"take_review"}` | 报告后可指名邀请或开放邀请；只有被邀请者能提交 verdict |
| 议题协商 | `proposals[]`（kind/status/votes/tally） | `team_flow_decide {propose/vote/withdraw/resolve}` | 受影响成员各一票；`dod` 通过自动并入 DoD；平票升级 Lead 仲裁 |
| 任务交接 | `items[].handoffs[]` | `team_flow_work {action:"handoff_offer/accept/decline"}` | 接受后 owner/claim/共享任务一起转移 |

协作与门禁的关系（仍然强制，不被"协作"绕过）：
- 开放队列的 item 被认领后与委派 item 走**完全相同**的报告/评审/门禁路径；
- 未裁决的阻断提案（`dod`/`scope`/`replan`，含 escalated）会**拒绝 approve 并让 gate 失败**，直到成员投票或 Lead 仲裁；
- 开放邀请/指名邀请都必须由 owner 之外的成员接受，自审仍被禁止；
- 所有协作动作写 `events` + `channel`，看板可回放"谁在什么时候和谁协商了什么"。

## 9. 诚实边界：哪些是「强制」，哪些只是「约定 + 检查」

| 能力 | 本插件提供 | 强度 | 残留风险 |
| --- | --- | --- | --- |
| 状态机迁移（report/review/gate） | 工具层拒绝非法调用 | **强制**（使用工具时） | 成员可绕过工具直接改文件 → 状态机下次校验会发现不一致，但需要 Lead 处置 |
| 评审签核 | verdict 枚举 + findings（blocker/major 必须带 file）+ 批准型必须提供 `evidence_checked` | **强制**（工具层拒绝 + 门禁复核） | 评审可以敷衍；能强制"声明查了什么"和"问题落到文件"，无法证明"真读了" |
| 写范围 | 计划期互斥校验 + 门禁期检查 | **约定 + 检查（基于自报）** | 插件**不解析 git diff / 不 stat 未申报文件**；成员用 bash 改范围外文件且不申报时，门禁发现不了。依靠评审抽查与 Lead 最终 diff 复核（见 §9 残留风险） |
| 只读角色 | 角色卡 + 门禁 | **约定 + 检查** | 运行时无法禁止 reviewer 写文件 |
| 完成门禁 | 六类 + 依赖顺序检查 + finalize 前置 | **强制**（必须走 gate） | 成员可以自行 `team_task_update(complete)` 原生任务；但 **run 的 finalize 必须过 gate**，那是收敛的唯一出口；有未决 finding 时重新 report 会被拒 |
| 黑板防篡改 | 无（工作区普通文件） | **不提供** | 成员若绕过工具直接改写 state 文件，插件无法证明其真实性（共享 cwd 的固有边界，与 Claude Code Teams 相同）。缓解：评审结论与报告进入最终答复、Lead 抽查、事件流水可回溯；不要把它当独立证据源 |
| 预算/成本 | 文档给出估算口径与规模建议 | **约定** | 无 token 计量；不假装有 |
| 消息送达 | 通知 + 状态回读要求 | **弱** | 无回执；以黑板状态为准 |

> 一句话：**「收敛」是强制的，「过程」是可审计的。** 任何人都可以让过程难看，但没人能在门禁未过时宣布 run 完成。

---

## 10. 失败模式与对策（对应 MAST 三类）

| MAST 类别 | 症状 | 本方案的检测 | 对策 |
| --- | --- | --- | --- |
| 系统设计 | 任务无 DoD / 角色越界 / 过早完成 | 计划期必填校验；报告期 scope 提示；门禁 G1/G2/G5 | 直接拒绝非法计划；gate 拒绝收敛 |
| 系统设计 | 自审 | 计划期 `reviewer != owner` 硬校验；gate G6 | 计划拒绝；gate 失败 |
| 间错位 | 信息不同步、重复劳动 | 黑板 + `next_actions`；spawn 简报要求先 `team_flow_status` | 单一状态源 |
| 间错位 | 评审意见被忽略 | `respond` 必须逐条覆盖 finding id；有未决 finding 时禁止重新 report | 未覆盖/试图绕过直接报错 |
| 间错位 | 说修了没改 | 证据字段（命令/退出码/证据）+ reviewer 复核 | gate G2 + 评审追问 |
| 任务验证 | 验证缺失 | 独立 verifier/item + G2 | gate 失败 |
| 任务验证 | 评审流于形式（空批准） | 工具层拒绝无 `evidence_checked` 的批准 → 门禁 G3b | 直接拒绝 + Lead 抽查 |
| 收敛 | 无限返修 | `reworkRounds` 计数 + 自动 escalated（同 item 去重） | 强制 Lead 仲裁；`team_flow_repair` 提供 reopen/reassign/reset_review 恢复路径 |
| 收敛 | 批准被"继承"到新版本 | verdict 绑定 `reportSeq` | 新报告自动失效旧批准，必须重审 |
| 收敛 | 成员用 escalation 翻转 item 状态 | escalation 只记录、不改状态 | 门禁只看 item 真实状态与 blocking escalation |
| 收敛 | 绕过工具手改黑板 | 无技术拦截 | 标注为边界；最终答复与报告复核 + 事件流水抽查 |
| 收敛 | 状态卡死、静默成员 | `team_flow_status` 的 team 状态 + Lead 侧 `list_agents`/`wait_agent` | 唤醒 / `interrupt_agent` / reassign |
| 成本 | token 爆炸 | 规模默认 3 人、轮次上限、item 上限 | 计划期拒绝超限，并在文档给出 7×/15× 锚点 |

---

## 11. 成本与规模

| 参数 | 默认 | 上限 | 理由 |
| --- | --- | --- | --- |
| teammate 数 | 3（1 实现 + 1 评审 + 1 验证） | 5 | 调研 §3.4；DSH 面板 8 成员含 Lead |
| 每 run 工作项 | ≤ 4 | 12（配置） | 每人 1–2 项，控制上下文与成本 |
| 每项评审轮次 | 2 | 5（配置） | 超限升级，不烧 token 返修 |
| 并发波次宽度 | 4 | 8 | 超过需理由 |
| 成本锚点 | 单会话 1×；单 agent 4×；多智能体 15×；Agent Teams(plan mode) 7× | — | 开跑前让用户知道量级（文档 + 协议文本） |

> 插件不伪造 token 计量。需要精确成本时用 DSH 会话成本/用量视图；本插件只给量级锚点与硬上限。

---

## 11.1 双重角色（既写又审）

一个成员可以同时「拥有工作项」和「评审别人的工作项」——这是 3 人最小集能凑出交叉审阅的原因。实现约束：

- `team_flow_plan` 对**同一个名字只产出一份 spawn 简报**（worker 简报里附带 review duty 段落），避免了 `spawn_teammate` 名字冲突；
- Lead 若作为 reviewer，不产生额外 spawn；
- 交叉评审（A 审 B、B 审 A）是允许且推荐的，但同一 item 内仍禁止自审；
- 双重角色的成员若在 self-review 边界上出错，Lead 用 `team_flow_repair {action:"reset_review", reviewer:"<其他成员>"}` 纠正。

## 12. 与 Claude/Anthropic Agent Teams 的能力对照

| 能力 | Claude Code Agent Teams | 本方案（DSH） |
| --- | --- | --- |
| Lead + 具名 teammates | ✅ | ✅ DSH 原生 |
| 独立上下文 | ✅ | ✅ fresh/fork |
| 点对点消息 | ✅ mailbox | ✅ `send_message`（无回执） |
| 共享任务板 + 依赖 | ✅ | ✅ 原生 + 本插件工作项状态机 |
| 完成门禁（hooks） | ✅ TaskCompleted hook | 🟡 本插件 gate（finalize 前强制） |
| 计划批准 | ✅ plan approval（官方默认自动批准） | 🟡 计划由 Lead 生成并校验，无人工批准环节 |
| 工具/model 按成员限制 | ✅ | ❌ 原生不支持 → 角色约定 + 审计 |
| worktree 隔离 | ❌（官方要求文件分区） | ❌ → 写范围分区 + 波次 |
| 轮次上限 / 早停 | 约定 | ✅ 引擎强制 + 自动升级 |
| 预算上限 | ✅ maxBudgetUsd 等 | ❌ → 文档锚点 + 规模上限 |

---

## 13. 扩展点（未实现，留给后续）

1. ✅ **实时监控看板（已实现）**：`lib/dashboard.js` 聚合快照 + `GET /api/agent-team-workflow.snapshot`（Connection 认证围栏）+ `client.js` 的 `conversation.view` "团队看板"（执行流程图 / 协作拓扑 / 自循环 / 事件流 / 门禁 / 升级 / 详情抽屉）。设计见 [`09-dashboard-design.md`](09-dashboard-design.md)，验证见 [`10-dashboard-verification.md`](10-dashboard-verification.md)。
2. **预算计量**：接入 `ctx.tokenMeter`/会话统计，在 gate 里加成本门禁。
3. **worktree 工人**：用 `ctx.worktrees` 给大改动提供真隔离（DSH 已有 `worktrees` 服务），届时 `write_scopes` 升级为分支级隔离。
4. **rubric 文件化**：把 §4.5 的四套 rubric 变成可版本化文件，评审按 rubric id 打分。
5. **eval harness**：20 条种子任务 + 与单 agent 基线对比，用于证明「团队档确实更好」。

---

## 14. 设计决策记录（ADR 摘要）

| 决策 | 选择 | 被否方案 | 理由 |
| --- | --- | --- | --- |
| 与原生关系 | 叠加治理层，不替换 | 自己实现 spawn/message | 原生已解决传输且是运行时契约；重复实现会随版本碎裂 |
| 状态载体 | 工作区 JSON 黑板 | session event / storage domain | event type 属运行时契约；storage domain 的 schema 依赖 zod，链接插件不可用 |
| 插件依赖 | 零外部依赖 | 用 schemastery/defineTool | 工作区 `link:` 包无法 import 宿主包（实测） |
| 工具注册范围 | per-Agent（仅 Team 成员） | 全局注册 | 非团队成员（普通 subagent）不应看到治理工具，省 token、避免误用 |
| 评审触发 | report 时自动指派 + 通知 | 人工再派 REV 任务 | 少一步无人值守的断点；轮次与状态由引擎维护，仍可在 board 上追溯 |
| 评审者上下文 | 默认 fresh | fork 作者 | 独立性；fork 会被 gate 标 warning |
| 幻觉防护 | 证据字段 + gate | 只靠提示词 | MAST 显示"验证缺失"是最常见失败类 |
| 批准有效性 | verdict 绑定 report 版本（`reportSeq`） | 只按 reviewer 取最后一条 | 否则"旧批准"会静默批准新产物（对抗性审阅 R-01） |
| 返修预算 | 按非批准 verdict 计（reworkRounds） | 按所有 verdict 计 | 多 reviewer 时按条数计会"首轮就超限"（R-03） |
| 黑板隔离 | `.agentteam/teams/<teamId>/` | 单一 `state.json` | 同 workspace 第二支 Team 会互相覆盖/篡改（R-08） |
| 恢复能力 | Lead-only `team_flow_repair`（必须写理由） | 只靠 override | 卡住的 review/成员没有恢复路径（R-04） |
