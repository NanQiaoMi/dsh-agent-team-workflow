# 07 · 对抗性审阅的处理结果

独立 reviewer 的原始发现见 [`06-review-findings.md`](06-review-findings.md)（未被作者修改，保留原貌）。
本文逐条记录处理决定：**修复 / 部分修复 / 明确不接受（并说明理由与替代缓解）**，附验证方式。

审阅快照：第一轮 `2026-11-01T10:28Z`（R-01~R-18）、第二轮 `2026-11-01T10:40Z`（R-19~R-24）。修复后新增 20 个测试用例（总数 45），全绿。

| 编号 | 级别 | 处理 | 说明 |
| --- | --- | --- | --- |
| R-01 | blocker | **已修复** | 批准绑定报告版本 |
| R-02 | major | **已修复** | escalation 只记录，不再改 item 状态 |
| R-03 | major | **已修复** | 返修轮按"非批准 verdict"计 |
| R-04 | major | **已修复** | 新增 `team_flow_repair`（reopen/reassign/reset_review） |
| R-05 | major | **已修复** | 门禁校验空命令、证据缺失、评审 evidence_checked |
| R-06 | major | **部分修复 + 明确降级** | 不做 git diff 集成；文档改为"自报 + 复查" |
| R-07 | major | **已修复** | 报告前强制依赖已批准；门禁复核依赖 |
| R-08 | major | **已修复** | 黑板按 `teams/<teamId>/` 隔离 |
| R-09 | major | **已修复** | plan 走同一把锁；replace 先落新板再清理旧任务 |
| R-10 | major | **已修复** | store 增加内存态（write-through） |
| R-11 | major | **明确不接受（记录为边界）** | 见下 |
| R-12 | minor | **已修复** | override 仅 finalize 落盘；返回 `waived`；报告区分 |
| R-13 | minor | **已修复** | `status {item_id}` 返回完整 report/reviews；默认含 DoD/reviewers/task revision |
| R-14 | minor | **已修复** | plan 校验 member name 形状 |
| R-15 | minor | **已修复** | `workerContext` 真正生效 |
| R-16 | minor | **已修复** | 简报改指 `team_task_get`，status 暴露 task revision |
| R-17 | minor | **部分修复 + 记录成本** | 精简注入文本；承认每会话固定成本 |
| R-18 | nit | **已修复** | 删除未用状态、finalize 后写操作加 phase 守卫、文本上限 |

---

## 逐条处理细节

### R-01 批准不绑定版本 → 已修复

- **改法**：item 增加 `reportSeq`，每次 `team_flow_report` 自增；review 创建时记录 `reportSeq`；`lastReviewOf` / `allReviewersApproved` / `outstandingReviewers` / `unresolvedFindings` / 门禁只统计当前版本；删除 `applyReport` 里"已全部批准就自动 approve"的捷径。
- **验证**：`test/engine.test.mjs` 的 "a new report version invalidates earlier approvals"（2 reviewer 部分批准 → 重新报告 → 两位都变 outstanding、gate 失败）。
- **残留**：报告版本只保证"批准对应当前报告"，不保证 reviewer 真读了；由 R-05 的证据声明 + 抽查缓解。

### R-02 escalation 是状态后门 → 已修复

- **改法**：`team_flow_escalate` 只追加 escalation 记录；不修改任何 item 状态；resolve 也不改状态。阻断性 escalation 仍会让门禁失败（gate 的 teamFailures）。
- **验证**：`test/tools.integration.test.mjs` 的 "escalating never rewrites an approved item…"（批准后 escalate，状态仍为 approved）。

### R-03 轮次预算按 verdict 条数 → 已修复

- **改法**：新增 `reworkRounds(item)` = 当前报告版本内**非批准** verdict 数；预算与升级判断改用它。多 reviewer 的 approve 不再消耗返修预算。
- **验证**：engine "a multi-reviewer item can absorb one rework round without escalation"（1 approve + 1 request_changes → respond 不升级，第二轮批准通过）；"exhausted review rounds escalate" 仍成立。

### R-04 升级后无恢复路径 → 已修复

- **改法**：新增 Lead-only `team_flow_repair`：
  - `reopen`：清空报告 + 递增报告版本（旧批准失效）+ 关闭 pending review + 原生任务 reopen + 通知 owner；
  - `reassign`：换 owner（校验成员名、同步原生 reassign、通知新 owner）；
  - `reset_review`：把 pending review 转给指定 reviewer 并通知。
  - 全部必须写 `reason`，写入 `item.repairLog` 与 events。
- **验证**：integration "escalating never rewrites an approved item, and repair tools restore a stuck item"（reopen → pending、repair_log 记录、非 Lead 被拒、reset_review 生效）。

### R-05 门禁不校验证据 → 已修复

- **改法**：
  - G2：命令必须非空、`exit_code` 为整数、至少一条 evidence（`evidence_optional` 跳过）；
  - G3b：批准型 review 必须提供 `evidence_checked`（工具层直接拒绝 + 门禁复核，`requireReviewEvidence`）；
  - findings：`blocker` / `major` 必须带 `file`（工具层拒绝）。
- **验证**：engine "an approving review that declares no inspected evidence fails the gate"、"gate fails when a report quotes no evidence or an empty command"；integration "an approving review must declare inspected evidence"。

### R-06 写范围只查自报 → 部分修复（明确降级）

- **决定**：不引入 `git status`/`ctx.fs` 的"实际 diff 比对"。理由：非 git 工作区无法可靠求差分；成员可用 bash 写任意文件，插件无沙箱；引入后会给出"看起来强制、实际仍可绕过"的假安全感。
- **实际改动**：门禁 G5 文案与文档改成 **"基于自报 + 评审/Lead 复查"**；`strictScopes` 仍可把"自报越界"升级为失败；README/03 §9 明确写出这一残留风险。
- **验证**：文档一致性检查；`docs/03` §9 与 `docs/04` §8 已改为如实的"约定 + 检查"。

### R-07 依赖顺序不进门禁 → 已修复

- **改法**：`applyReport` 前置检查所有 `blockedBy` 已 approved 或被 override（否则报错并说明）；`evaluateGates` 增加 G5b 依赖检查。
- **验证**：engine "a dependency must be approved before a dependent item can report"、"the gate carries unapproved dependencies as a failure"。

### R-08 黑板不按 Team 隔离 → 已修复

- **改法**：状态/报告/归档路径改为 `.agentteam/teams/<teamId>/…`，`teamId` 取 Lead Session id（成员一律解析到 Lead 的 Team）。第二个顶层会话看不到、也无法 gate/replace 别人的 run。
- **验证**：`test/plugin.test.mjs` "two Teams in one workspace never share a board"（两个 root agent 的 path 不同，B 读 A 的 board 为 null）。

### R-09 plan 不走锁 / replace 顺序 → 已修复

- **改法**：`team_flow_plan` 的读-改-写整体放进 `store.lock`（与其他写路径同一把锁）；顺序改为"先创建新任务 → 落新板 → 再清理旧任务"，旧任务清理按"依赖已删"重试 4 轮；临时文件名加随机后缀。
- **验证**：integration 的 plan/replace 用例；锁由 `store.mutateState`/`store.lock` 共用，仍在同一 path 上串行。

### R-10 writeArtifacts:false 不可用 → 已修复

- **改法**：store 增加 write-through 内存态；`readState` 在关闭落盘时先读内存，文件缺失时回退内存；`writeState` 先写内存。
- **验证**：integration "writeArtifacts:false keeps the run in memory without touching the workspace"（plan 后 status 能看到 run，且不创建 `.agentteam`）。

### R-11 黑板可被成员直接改写 → 明确不接受（记录边界）

- **理由**：所有成员共享同一 cwd 且拥有 bash/fs 写入能力；任何"防篡改"（哈希链、HMAC）都需要一个成员拿不到的密钥或独立真源，而 DSH 的 session 日志才是真源、插件不能新增 event type。做"看起来能防"的校验反而会误导使用者。
- **处理**：在 `docs/03` §9 明确写为「**不提供**」的边界；建议的缓解是流程性的：评审结论/证据进入最终答复、Lead 抽查、事件流水可回溯。若需要强证据，后续可把 verdict 落到原生任务 description / native task 附件（不新增 session event type），或引入外部审计日志。
- **验证**：文档已改为如实描述（不再声称"手改会被发现"）。

### R-12 override 是全量豁免 → 已修复

- **改法**：`overrides` 只在 **finalize 且 gate.pass** 时落盘到 `item.overrideReason`；预览不落盘；门禁结果新增 `waived`（被豁免的具体 failure 列表）；`report.md` 头部区分"含 N 项 Lead 风险接受"。
- **验证**：engine override 用例返回 `waived`；integration finalize 用例报告包含 override 说明（见 `report.md` 断言）。

### R-13 status 黑板不自足 → 已修复

- **改法**：默认返回 `definition_of_done` / `reviewers` / `task {id, revision, status}` / `repair_log`；传 `item_id` 时附加完整 `report` 与 `reviews`（含 findings 与 resolution）。评审者不再需要绕道读 state 文件。
- **验证**：integration "status detail exposes the report and review records a reviewer needs"。

### R-14 不校验成员名 → 已修复

- **改法**：plan 校验 owner/reviewer 匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$` 且 owner ≠ lead；`team_flow_repair` 的 reassign/reset_review 同样校验。
- **验证**：engine "member names are validated at plan time"。

### R-15 workerContext 被硬编码 → 已修复

- **改法**：`renderWorkerBrief(..., contextMode)` 使用 `settings.workerContext`；`team_flow_plan` 的 `next_actions` 引用实际返回的 context 值；reviewer 仍固定 fresh（独立性）。
- **验证**：integration "a forked worker context is reported when the plugin is configured that way"。

### R-16 简报 refer 不存在字段 → 已修复

- **改法**：简报改为"用 `team_task_get` 取 revision，或 `team_flow_status {item_id}` 看 `task.revision`"；status 实际返回 task revision。
- **验证**：integration 的 fork 用例断言简报含 `team_task_get`；status detail 用例断言 `task.revision === 3`。

### R-17 注入成本 → 部分修复

- **改法**：协议文本补充了恢复约定但整体未膨胀（policy 约 3.4 KB）；`injectPolicy`/`writeArtifacts` 可关；`team_flow_status` 默认紧凑、详情按需。
- **保留**：7→8 个工具 schema 与每会话注入成本仍在。理由：这些是工作流的接口面，不能只在"已组队"后加载（工具必须在组队那一刻已可用）。已在 README 显式标注成本与关闭开关。
- **验证**：`docs/03` §11 成本表；`team_flow_status.settings.injectPolicy` 可回显。

### R-18 杂项 → 已修复

- 删除从未写入的 `ITEM_STATUS.REPORTED`；`RUN_PHASE.ABORTED` 在 `replace` 归档时真正写入；
- `finalize` 之后 report/submit/respond/escalate/repair 全部被 phase 守卫拒绝；
- 报告头区分 override 通过方式；
- 模型可控文本加长度上限（summary 4 KB、claim 2 KB、evidence/note 1–2 KB），避免单条撑大黑板。

---

## 未修复项与残余风险（诚实清单）

| 项 | 状态 | 影响 | 建议 |
| --- | --- | --- | --- |
| 黑板可被成员直接改写（R-11） | 不接受 | 伪造 verdict/report 可绕过工具层 | 视为流程性风险；强证据需落 native task/session 日志（后续扩展） |
| 写范围不校验实际 diff（R-06） | 部分 | 越界写未申报则门禁不可见 | 评审与 Lead 最终 diff 复核；需要时接 `ctx.fs`/git（扩展点） |
| 注入与 schema 固定成本（R-17） | 部分 | 每会话约 3–4k tokens 额外上下文 | 不需要工作流的会话可关闭 bundle（`plugin_manager set_bundle`） |
| live 团队流程未在最终代码代上跑 | 环境限制 | 真实模型行为未观测 | 重启后按 `docs/05` §5 的步骤做一次 smoke run |


---

# 第二轮复审（R-19 ~ R-24）处理

复审方式：reviewer 不采信作者自述，重新逐文件读 10:40 代码 + 用 `/tmp` 探针驱动真实 `buildTools` 复现。结论：**blocker 0 / major 1 / minor 2 / nit 3**。全部已修复。

| 编号 | 级别 | 处理 | 说明 |
| --- | --- | --- | --- |
| R-19 | major | **已修复** | 批准型 verdict 的 findings 记为「已接受观察」 |
| R-20 | minor | **已修复** | 返修预算改为 item 生命周期累计 |
| R-21 | minor | **已修复** | override 预览的下一步回显完整 finalize 参数 |
| R-22 | nit | **已修复** | `reset_review` 的 reviewer 缺省时自动选下一位 |
| R-23 | nit | **已修复** | §7.2 与 §9 的黑板说法统一 |
| R-24 | nit | **已修复** | status 区分 `rework_rounds` / `submitted_rounds`，过滤 superseded |

## R-19 `approve_with_nits` + findings 卡死 → 已修复（方案 a）

- **改法**：批准型 verdict（approve / approve_with_nits）带 findings 时，引擎在提交瞬间把每条 finding 标为 `resolution.state = 'accepted_by_reviewer'`。因此 G4 只统计**非批准** review 的未决 finding，`applyReport` 的"未决意见不得重报"守卫也不会误伤；作者不再被要求回应 nits。
- **一致性**：04「只剩 nit → approve_with_nits 早停」与 G4 不再矛盾；`approvedMessage` 语义保持"nothing further"。
- **验证**：engine "approve_with_nits accepts its observations instead of deadlocking the gate"（已批准、`unresolvedFindings=0`、gate pass、resolution=accepted_by_reviewer）。

## R-20 re-report 重置返修预算 → 已修复

- **改法**：新增 `item.reworkTotal`，每次**非批准** verdict 自增；`reworkRounds()` 直接返回该累计值（不再按 `reportSeq` 过滤）；`applyReport` 不重置；只有 Lead 的 `team_flow_repair {action:"reopen"}` 清零（显式重启）。
- **验证**：engine "re-reporting does not reset the rework budget"（两轮 report→changes→respond 后第三轮回合触发 escalated，elc=1）。

## R-21 override 预览 → finalize 陷阱 → 已修复

- **改法**：gate 的 `next_actions` 在"预览带 overrides 且通过"时回显完整参数：`team_flow_gate {finalize:true, overrides:[{"item_id":"W1","reason":"..."}]}`；同时保留"overrides 只在通过 + finalize 时落盘"的语义。
- **验证**：integration "a preview that needs overrides tells the Lead to pass them to finalize"（预览 next_actions 含 overrides/W1；不带 overrides finalize 失败；带上成功且报告含 `Lead override`）。

## R-22 `reset_review` reviewer 可选/必填不一致 → 已修复

- **改法**：缺省时取 `outstandingReviewers(item)[0] ?? item.reviewers[0]`，再走成员名校验；都没有时给出明确错误。
- **验证**：integration "reset_review defaults to the next outstanding reviewer…"（不带 reviewer 成功）。

## R-23 文档自相矛盾 → 已修复

- `docs/03` §7.2 改为"插件**无法检测**手改，见 §9"；`docs/04` 早停处补注"nits 记为评审已接受，无需 respond"。

## R-24 status 面板字段 → 已修复

- **改法**：`verdicts` 只保留 `status==='submitted'`（排除 pending/superseded，并附 `report_seq`）；`reviews` 同时回显 `rework_rounds`（门禁预算口径）与 `submitted_rounds`（全部已提交 verdict）。详细记录改用独立字段 `review_records`，不再覆盖摘要对象（修复过程中还发现并修掉了这个键冲突）。
- **验证**：integration "reset_review defaults… and status reports rework rounds"（rework_rounds=1、submitted_rounds=1、verdicts 过滤正确）。

## 复审结论（作者认同）

- 走工具路径：**不诚实 agent 无法在未真正审阅的情况下让 run 收敛**（批准版本绑定、自审拒绝、依赖前置、escalation 不改状态、证据/命令/评审证据强制）。
- 剩余两条绕过均为**显式边界**：① 成员用 fs/bash 直接改写 `state.json`（平台能力边界，插件不做伪防篡改）；② Lead 使用 per-item override（设计内风险接受，报告标注 waived/override）。两者都已写进 `docs/03` §9 与 README「已知边界」。
