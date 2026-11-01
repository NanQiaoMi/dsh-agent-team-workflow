# 04 · 注入式工作流协议（SOP / Runbook）

> 这份文档是**协议正文**：Agent Team 的每个成员（Lead 与 teammate）在执行任务时遵循的操作标准。
> 其中 L1「团队宪法」的实际文本由插件的 `lib/protocol.js` 注入到每个 Team 成员的系统提示；
> L2「角色卡」与 L3「任务卡」在 `spawn_teammate` 的 prompt 里；L4「即时指令」走 `send_message`。
> 架构与设计理由见 [`03-architecture.md`](03-architecture.md)。

---

## 0. 什么时候用这套协议

**准入（四项同时成立才组队）**：

1. 任务可拆成 2+ 个互不依赖或依赖清晰的子任务；
2. 子任务之间有**独占写范围**或只读；
3. 每个子任务有可第三方验证的 DoD（能被命令/文件/引用核查）；
4. 交付价值足以覆盖多智能体的成本（量级 7×–15× 单会话）。

**不组队的降档做法**：Lead 自己串行做；或 `team_flow_plan` 只开 1 个 item 且 `needs_review=false`（仍留审计轨迹，但不开团队）。

**默认规模**：Lead + 3 个 teammate（实现 / 评审 / 验证）；上限 5。超过 5 人必须在 `team_flow_plan` 的 `constraints` 里写并行度实测理由。

---

## 1. 端到端 Runbook（Lead 视角）

### 阶段 0 · 准入与选型（不调用工具）

- 判断是否满足 §0 四项；不满足 → 降档并告知用户。
- 选定角色组合与工作项粒度：**一个工作项 = 一个独占写范围 + 一份可验收交付物 + 一个 owner + 一份 DoD**。
- 预写 DoD（可勾选）与验收命令。

### 阶段 1 · 计划（`team_flow_plan`）

Lead 调用一次，声明 objective / acceptance_criteria / constraints / items。引擎会：

- 校验：owner 唯一且非 `lead`、DoD 非空、`blocked_by` 无环、同波次写范围不重叠、自审拒绝、规模上限；
- 为每个 item 创建 **backing Team task**（带 `write_scopes`、`blocked_by`），把 item↔task 映射写入黑板；
- 计算 `waves`（可并行的波次）；
- 返回**逐字可用的 spawn 简报**：`spawn[]`（worker）与 `reviewer_spawn[]`（reviewer）。

成功判据：返回 `run_id`、`waves`、每条 spawn 的 `prompt`。失败：报错文本逐条列出违规项，改计划后重试（或 `replace: true` 归档旧 run）。

### 阶段 2 · 组队（原生 `spawn_teammate`）

- 对 `spawn[]` 中**第一波次**的每个 item，把返回的 `prompt` **原样**传给 `spawn_teammate`，`context` 用返回的 `fresh`。
- 同时（或按需）spawn `reviewer_spawn[]`：reviewer 先待命，收到评审通知后才行动。
- 不要改写简报：里面包含 DoD、写范围、backing task id、工作流步骤、禁止事项——改写会破坏一致性。

成功判据：`list_agents` 显示成员 `running/inactive`（inactive 正常，表示无回合在执行）。失败：`failed` 或 `provisioning` 卡住 → 见 §7.

### 阶段 3 · 并行执行（worker + 原生任务板）

worker 收到简报后：

1. `team_flow_status` → 读 `next_actions`；
2. `team_task_get(task_id)` → `team_task_update(claim, expected_revision)`（原生 CAS）；
3. 只在声明写范围内修改；跑真实验证命令；
4. `team_flow_report`：summary + files + commands[{command, exit_code}] + evidence + open_questions + risks（+ deviation）。

引擎：把 item 置 `in_review`、自动创建第 1 轮评审、`send_message` 通知 reviewer、完成 backing task（rework 时会 reopen）。**重新 report 会增加报告版本、使旧批准失效，但不会重置返修预算**（预算在 item 生命周期内累计，只有 Lead 的 `repair reopen` 才清零）。

两条硬规则：**存在未回应的 review finding 时，重新 report 会被拒绝**（必须先 `team_flow_review_respond`，不能用"再交一版"绕过意见）；若依赖项在报告时尚未 approved，会记录 `sequence_warnings` 并在门禁里作为 warning 呈现。

### 阶段 4 · 相互审阅（reviewer ↔ author）

reviewer：

1. `team_flow_status` → 看到指派给自己的 pending review 与 `next_actions`；
2. 读作者报告 + **真实文件**，能自己复跑的就复跑；
3. `team_flow_review_submit`：verdict（approve / approve_with_nits / request_changes / block）+ summary + findings[{id, severity, file, line, claim, suggestion}] + evidence_checked。

作者收到 `[REVIEW] ... changes_requested` 后：逐条 `team_flow_review_respond`（fixed | rebut | accepted_risk + evidence）→ 引擎开下一轮并通知 reviewer。

引擎规则：轮次 ≤ `maxReviewRounds`；blocker 被 rebut → 升级 Lead；轮次耗尽 → 升级 Lead（报告阶段触发时会同时通知 Lead）。

**批准型 verdict（approve / approve_with_nits）必须声明 `evidence_checked`**（默认 `requireReviewEvidence: true`）：工具层直接拒绝空证据批准，门禁 G3b 也会复查。

### 阶段 4.5 · 卡住时的显式修复（`team_flow_repair`，Lead only）

不要用"重开一个 run"掩盖卡点。三种修复动作都必须写 `reason`，会进 audit trail 并通知当事人：

- `reopen`：清空报告、递增报告版本（旧批准自动失效），让 owner 重做；
- `reassign`：换 owner（未批准的 item），原生 backing task 同步 reassign；
- `reset_review`：把卡住的 pending review 转给指定 reviewer（默认下一位未批准者）并通知。

### 阶段 5 · 门禁与收敛（`team_flow_gate`）

Lead 在所有 item approved 后：

1. `team_flow_gate {}` → 预览各 item 门禁与失败原因；
2. 处理：让 owner 补证据 / 让 reviewer 复审 / 对可接受残余风险用 `overrides:[{item_id, reason}]`；
3. `team_flow_gate {finalize:true}` → 全绿时收敛：`phase=finalized`，写 `report.md`，关闭 backing tasks。**若预览时用过 `overrides`，finalize 必须把同样的 overrides 再传一次**（引擎会在预览的 `next_actions` 里回显完整参数）；override 只在"通过 + finalize"时落盘。

**只有这里算完成**。未过门禁时 finalize 会抛错并列出失败项。

### 阶段 6 · 交付

- 给用户的最终答复必须逐条对应工作项 id + 证据路径（报告里有）。
- 黑板保留：`.agentteam/teams/<teamId>/state.json`（机器）、同目录 `report.md`（人）。
- 需要重跑：`team_flow_plan {replace:true}` 会归档旧 run 到 `.agentteam/runs/<runId>.json`。

---

## 2. 工具参考

| 工具 | 权限 | 关键参数 | 返回 | 典型错误 |
| --- | --- | --- | --- | --- |
| `team_flow_plan` | 仅 Lead | `objective`, `acceptance_criteria[]`, `constraints[]?`, `items[]`, `replace?` | `run_id`, `waves`, `spawn[]`, `reviewer_spawn[]`, `warnings`, `next_actions` | 计划违规（逐条列出）、`run already exists` |
| `team_flow_status` | 任何成员 | 无 | run/phase/items/reviews/escalations/team + `next_actions` | 无 run 时返回 `phase: "none"` 与指引 |
| `team_flow_report` | item owner | `item_id`, `summary`, `files[]`, `commands[{command,exit_code,note?}]`, `evidence[]?`, `open_questions[]?`, `risks[]?`, `deviation?` | item 状态、指派的 reviewer、是否已通知、scope/sequence 警告 | `belongs to "<owner>"`、`already approved`、`unresolved review findings` |
| `team_flow_review_submit` | 指派 reviewer | `item_id`, `verdict`, `summary`, `findings[]`, `evidence_checked[]` | item 状态、next_reviewer、notified | `assigned to "<other>"`、`non-approving verdict must report at least one finding`、`approving verdict must declare what you actually inspected` |
| `team_flow_review_respond` | item owner | `item_id`, `responses[{finding_id,state,evidence?,note?}]` | item 状态、下一轮、是否 escalated | `unknown or already resolved finding`、`every finding needs a response` |
| `team_flow_gate` | 仅 Lead | `finalize?`, `overrides[{item_id,reason}]?` | `pass`, `item_gates[]`, `team_failures[]`, `report_path` | finalize 未过时列出全部失败 |
| `team_flow_escalate` | 任何成员（裁决仅 Lead） | 创建：`kind`,`subject`,`detail`,`blocking?`,`item_id?`；裁决：`escalation_id`,`resolution` | `escalation_id`, `resolved`, `notified` | 未知 escalation、重复裁决 |
| `team_flow_repair` | 仅 Lead | `item_id`, `action`(reopen/reassign/reset_review), `reason`, `owner?`, `reviewer?` | item 状态、notified | 缺 reason、非法成员名 |
| `team_flow_status {item_id}` | 成员 | `item_id?` | 指定 item 时返回完整 report 与 review 记录 | 未知 item |

**与原生工具的边界**：`team_task_*` 仍是共享看板的读写（claim/complete/依赖）；`team_flow_*` 是治理层。worker 认领用原生 `team_task_update`，交付用 `team_flow_report`；**不要**用原生 `complete` 代替报告。

---

## 3. 数据模板

### 3.1 计划（`team_flow_plan` items）

```json
{
  "id": "W1",
  "subject": "实现 /v1/hello 接口",
  "owner": "impl-api",
  "role": "implementer",
  "write_scopes": ["src/api/", "test/api/"],
  "blocked_by": [],
  "definition_of_done": [
    "GET /v1/hello 返回 200 与 {message:string}",
    "新增单元测试覆盖 200 与 400 分支",
    "npm test 全绿"
  ],
  "reviewers": ["rev-api"],
  "needs_review": true,
  "evidence_optional": false
}
```

规则：`write_scopes` 是工作区相对路径；同一波次（无互相依赖的 item）不得重叠；`reviewer != owner`；`owner != "lead"`。

### 3.2 报告（`team_flow_report`）

```json
{
  "item_id": "W1",
  "summary": "新增 GET /v1/hello，参数校验与测试；npm test 全绿。",
  "files": ["src/api/hello.ts", "test/api/hello.test.ts"],
  "commands": [
    { "command": "npm test -- hello", "exit_code": 0, "note": "8 passed" },
    { "command": "npx tsc --noEmit", "exit_code": 0 }
  ],
  "evidence": ["hello.test.ts :: returns 200 for valid name", "tsc: no output"],
  "open_questions": [],
  "risks": ["并发限流未覆盖，超出本项 DoD"]
}
```

硬要求：至少一条真实命令 + 整数退出码；`files` 相对工作区；不能只写"已修复"。

### 3.3 评审（`team_flow_review_submit`）

```json
{
  "item_id": "W1",
  "verdict": "request_changes",
  "summary": "主路径正确，但 400 分支错误码与 API 约定不一致。",
  "findings": [
    { "id": "F1", "severity": "blocker", "file": "src/api/hello.ts", "line": 42, "claim": "空 name 返回 500 而非 400，与 docs/api.md §2 冲突", "suggestion": "校验前置并返回 400" },
    { "id": "F2", "severity": "nit", "file": "test/api/hello.test.ts", "line": 8, "claim": "测试名建议描述行为" }
  ],
  "evidence_checked": ["读取 src/api/hello.ts 全文", "本地复跑 npm test -- hello", "对照 docs/api.md §2"]
}
```

verdict：`approve` / `approve_with_nits` / `request_changes` / `block`。
severity：`blocker`（必须修，合并前阻断）/ `major`（应修）/ `minor`（可下轮）/ `nit`（建议）。
**非批准 verdict 至少一条 finding；每条 finding 必须能落到 file（尽量 line）+ 具体断言。**

### 3.4 返修回应（`team_flow_review_respond`）

```json
{
  "item_id": "W1",
  "responses": [
    { "finding_id": "F1", "state": "fixed", "evidence": "src/api/hello.ts:38-46 前置校验；新增测试 'returns 400 on empty name' 通过" },
    { "finding_id": "F2", "state": "fixed", "evidence": "测试名改为 'returns 200 for valid name'" }
  ]
}
```

`state`：`fixed` | `rebut` | `accepted_risk`。`rebut`/`accepted_risk` 必须写 note；**blocker 被 rebut 会自动升级 Lead**。

### 3.5 升级（`team_flow_escalate`）

```json
{ "kind": "conflict", "subject": "docs/api.md 与工单约定不一致", "detail": "api.md §2 要求 400，工单要求 404；已尝试按 api.md 实现", "blocking": true, "item_id": "W1" }
```

kind：`blocker` | `conflict` | `scope_change` | `decision` | `arbitration`。`blocking=true` 会阻止 gate 收敛，直到 Lead 用 `{"escalation_id":"esc-1","resolution":"以 api.md 为准，工单作废"}` 裁决。

---

## 4. 注入文本（三层）

### 4.1 L1 团队宪法（每个 Team 成员系统提示，摘要）

- 六阶段与角色职责（plan/staff/execute/review/respond/gate）；
- 不变量：写范围、证据优先、独立评审、消息不构成交付、升级而不是停滞、不去手改黑板；
- `next_actions` 是权威作业单；每步先 `team_flow_status`。

### 4.2 L2 角色卡（spawn 简报，摘要）

**worker 简报**包含：身份、团队使命与验收标准、item 的 subject/DoD/写范围/依赖/backing task id、独立性规则（fresh context、不派生、不越界、不造假）、五步工作流、沟通规则。

**reviewer 简报**包含：身份、要审的 item 清单与 DoD、评审步骤、检查维度（DoD 覆盖、正确性、scope 纪律、证据质量、测试、接口一致性、占位符）、verdict/findings 规范、独立性（不改作者文件、不代修）、轮次预算。

### 4.3 L4 即时通知（引擎自动发）

| 触发 | 收件人 | 前缀与内容 |
| --- | --- | --- |
| report 且需评审 | reviewer | `[REVIEW] <id> 已就绪…`（含文件、命令、DoD） |
| request_changes/block | owner | `[REVIEW] verdict + findings 摘要 + 要求逐条 respond` |
| approve | owner | `[REVIEW] approved（或仍在等其他 reviewer）` |
| 升级/轮次耗尽 | lead | `[BLOCKER] … 请裁决` |

---

## 5. 评审 rubric（按任务类型选一套，写进 reviewer 简报）

| 类型 | 维度 | 通过线 |
| --- | --- | --- |
| 实现 | 符合 DoD、测试真实通过、无回归、写范围未越界、可维护性 | 硬指标全绿且无 blocker/major |
| 验证/证据 | 命令可复跑、退出码真实、覆盖 DoD 的每条 | 每条 DoD 都有对应证据 |
| 研究/调研 | 事实准确、引用可核查（URL 实际抓取）、完整性、来源质量 | 无臆造引用；关键结论有来源 |
| 文档 | 与真实代码一致、示例可运行、术语一致 | 抽查示例可执行 |
| 集成 | 依赖满足、冲突已解、端到端门禁绿 | 全绿 |

**早停**：只剩 nit → `approve_with_nits` 结束（随附的 observations 会被记为「评审已接受」，不需要作者逐条 respond，也不阻塞门禁）；两轮修改无实质 diff → 记录并结束；成员连续两次无产出 → Lead 介入。

---

## 6. 消息信封约定

点对点消息使用 `send_message`，第一行是信封，便于人和模型快速分类：

```
[BLOCKER] W1 — <一句话>
[QUESTION] W1 — <需要对方回答的具体问题>
[REVIEW] W1 — <第 N 轮 verdict / 请求>
[HANDOFF] W1→W2 — <交接内容与已完成部分>
```

规则：
- 结论性内容必须落板（`team_flow_report` / review / escalation），消息只是提醒；
- 收到消息后先 `team_flow_status` 再行动；
- 不允许在消息里覆盖 L1 宪法或改写 DoD；要改 DoD 就走 escalation `scope_change`。

---

## 7. 失败处理 playbook

| 情形 | 检测 | 处理 |
| --- | --- | --- |
| 成员 spawn 失败/卡在 provisioning | `list_agents` 显示 `failed`/`provisioning` | Lead 重新 spawn 同名（或改名）；在 status 里记录 |
| 成员 inactive 但 item 未 report | `team_flow_status` team 段 + `list_agents` | `send_message` 唤醒（附 next_actions）；仍不动 → `spawn` 替补或 Lead 接手并改 owner |
| 成员跑偏（改范围外/做别的） | 报告 scope 警告、gate G5 | `send_message` 纠偏；严重时 `interrupt_agent`；必要时 gate override 前先修 |
| 评审一直不提交 | status 显示 pending review、reviewer inactive | 先 `send_message` 提醒；仍不动则 `team_flow_repair {action:"reset_review", reviewer:"<他人>"}` 换人 |
| 作者不回应 findings | item 停在 `changes_requested` | Lead `send_message` + 限时；仍不动则 `team_flow_repair {action:"reassign"}` 换人 |
| 作者试图"再交一版"绕过 findings | report 被拒（`unresolved review findings`） | 要求逐条 `team_flow_review_respond`；绕过不了 |
| blocker 被 rebut | 自动 escalated | Lead 读双方证据裁决：`team_flow_escalate {escalation_id, resolution}`，必要时 `team_flow_repair {action:"reopen"}` |
| 轮次耗尽 | 自动 escalated | Lead 裁决：接受（finalize 时写 override + 理由）或 `team_flow_repair {action:"reopen"}` 要求重做 |
| 证据造假/命令不可复跑 | reviewer 复跑失败 | `block` + blocker finding；Lead 抽查；不得 override 造假项（应记录为缺陷交付） |
| 黑板损坏 | 工具报 `WORKFLOW_STATE_CORRUPT` | 停止收敛；从 `.agentteam/runs/*.json` 或报告恢复；不要手改 state.json |
| artifacts 目录不可写 | 工具报错/`writeArtifacts` 关闭 | 用 `writeArtifacts:false` 内存模式继续（报告不落盘），并在最终答复说明 |
| 需要扩大范围 | worker 发现要改别的文件 | `team_flow_escalate {kind:"scope_change"}`，Lead 决定：`replace` 重排或 `reopen` 该 item |

---

## 8. 反模式（明确禁止）

1. **自审**：作者给自己 approve、或把 reviewer 写成 owner —— 计划期即拒绝。
2. **空评审**：approve 但 `evidence_checked` 为空、findings 全是"看起来不错" —— 门禁判失败/警告，Lead 抽查。
3. **用消息代替交付**：只在 `send_message` 里说"做完了" —— 没有 report 的门禁失败。
4. **先 complete 再补证据**：原生任务可以 `complete`，但 run 收敛必须过 gate；补不齐就 finalize 不了。
5. **Lead 自己下场改实现**：Lead 不写实现；要写就先改计划（owner 改成 lead 会被拒绝）——改用降档流程。
6. **多人同文件并行**：同波次写范围重叠被计划期拒绝；跨波次也要靠 blocked_by 串行。
7. **无证据的"已修复"**：`respond` 必须带 evidence；rebut 必须带 note。
8. **绕过黑板**：不要手改 `.agentteam/teams/<teamId>/state.json`。插件无法在技术上阻止共享 cwd 的成员改文件，但手改会让事件流水与状态自相矛盾，评审/Lead 复核时按"不可信"处理。

---

## 9. 审计与报告

- `state.json`：完整机器可读记录（items/reviews/escalations/events/gate）。
- `report.md`：每个 item 的 DoD、报告、命令与退出码、评审轮次与 findings 处理状态、gate 表、audit trail 尾部 40 条事件。
- 归档：`replace:true` 时旧 run 落到 `.agentteam/runs/<runId>.json`，可对比两次运行。
- 对外交付：最终答复逐条引用 item id 与证据（报告可给用户直接看）。

---

## 10. 快速检查清单（Lead 自检）

- [ ] 是否满足 §0 准入？不满足就降档。
- [ ] 每个 item 有独占写范围、可验证 DoD、唯一 owner、独立 reviewer？
- [ ] 同波次写范围不重叠？依赖成 DAG？
- [ ] spawn 简报是否原样传递（未改写）？reviewer 是否先于评审通知就位？
- [ ] 每个 report 是否至少一条真命令 + 整数退出码？
- [ ] 每条 finding 是否被 respond 覆盖（fixed/rebut/accepted_risk + evidence）？
- [ ] 批准型评审是否都写了 `evidence_checked`（查了哪些文件/复跑了什么）？
- [ ] 卡住的 item 是否用 `team_flow_repair` 显式修复（附 reason），而不是悄悄 replace？
- [ ] gate 是否在 finalize 前预览过？overrides 是否写了理由？
- [ ] 最终答复是否逐条对应 item 与证据路径？
