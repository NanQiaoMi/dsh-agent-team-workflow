# 06 · 对抗性审阅发现（独立 reviewer，最终复审版）

**审阅基线**：原始发现 R-01~R-18 针对 `2026-11-01T10:28` 快照（已交给作者，处理记录见 [`07-review-resolution.md`](07-review-resolution.md)）。作者在 10:33–10:42 做了大幅修复，本文件是**不采信自述的独立复审**：重新逐文件通读 10:40 代码（`index.js c273b277`、`lib/tools.js d33f51c3`、`lib/workflow.js a3ecfd33`、`lib/store.js 308631eb`、`lib/protocol.js a66bce7c`、`package.json 24744175`）+ 对照 DSH 安装目录源码 + 运行 `node --test`（41/41 通过）+ `/tmp` 一次性脚本驱动真实 `buildTools` 适配器复现。R 编号沿用原编号（07 的引用仍然有效），新增问题从 R-19 起。

## 结论摘要

1. **原 blocker R-01 已修复且经独立复现确认**：批准与 `reportSeq` 绑定；approved 后 re-report 被拒，`team_flow_repair reopen` 后重报只开新评审，gate 因 `review not approved by: rev` 失败；多 reviewer 下旧批准不再继承。
2. R-02、R-03（核心语义）、R-04、R-05、R-07、R-08、R-09、R-10、R-12、R-13、R-14、R-15、R-16、R-18 共 15 项复核为**已修复**（证据见下表）。
3. **仍存在的真实缺陷 6 项**：R-19（major，`approve_with_nits` 带 nits 的常见收尾路径卡死）、R-20（minor，re-report 可重置返修预算、绕过自动升级）、R-21（minor，override 预览后按 next_actions finalize 必失败），及 3 个 nit。
4. R-06（写范围只查自报）、R-11（黑板可被成员直接改写）、R-17（固定注入成本）作者明确降级/不接受，**复核同意其理由**，但必须作为边界写进最终交付（03 §9、README 已如实标注）。
5. **最终判断**：「不诚实 agent 能否在没被真正审阅的情况下让 run 收敛？」——**走工具路径：不能**（批准版本绑定、自审拒绝、依赖前置、escalation 不再改状态、证据/命令形状强制）。**剩余绕过只有两条**：直接改写 `state.json`（R-11，平台边界，无法用插件自证）或 Lead 行使 per-item override（设计上的显式风险接受，报告会标 `waived`/`overridden`）。二者都已从"隐形默认路径"降级为"文档声明的例外"。

| 严重度 | 数量 | 编号 |
| --- | --- | --- |
| blocker | 0 | — |
| major | 1 | R-19 |
| minor | 2 | R-20、R-21 |
| nit | 3 | R-22、R-23、R-24 |
| 已复核修复 | 15 | R-01~R-05、R-07~R-10、R-12~R-16、R-18 |
| 明确接受的边界 | 3 | R-06、R-11、R-17 |

## R-01~R-18 复核状态

| 编号 | 原级别 | 复核 | 独立证据（代码/探针） |
| --- | --- | --- | --- |
| R-01 批准不绑定报告版本 | blocker | ✅ 修复 | `reportSeq` 绑定 workflow.js:275-329、:417；探针 `/tmp/atw-final.mjs` A/B：re-report 只开新一轮、旧批准 invalidated |
| R-02 escalate 改 item 状态 | major | ✅ 修复 | 探针 E：对已 approved 项 escalate 后 `item.status='approved'`；tools.js 的 escalate 只追加记录 |
| R-03 轮次按 verdict 计数 | major | ✅ 核心修复（残留 R-20） | `reworkRounds` workflow.js:340-349；多 reviewer 不再提前升级（探针 C 未升级） |
| R-04 无恢复路径 | major | ✅ 修复 | `team_flow_repair`（tools.js:1082-1220）；探针 A（reopen）/D（reset_review）生效，Lead-only |
| R-05 门禁不校验证据 | major | ✅ 修复 | 探针 I：空命令/无 evidence 现在门禁失败；批准无 `evidence_checked` 工具层即拒（tools.js:700-706） |
| R-06 写范围只查自报 | major | ↔ 降级 | docs/03:229 已如实写"不解析 git diff、不 stat 未申报文件"；01 §4.7 原始硬要求未实现 |
| R-07 依赖顺序不进门禁 | major | ✅ 修复 | 探针 `/tmp/atw-dep.mjs`：依赖未批准时 report 抛 `WORKFLOW_DEPENDENCY_NOT_APPROVED`；gate G5b workflow.js:666-669 |
| R-08 黑板不按 Team 隔离 | major | ✅ 修复 | 探针 G：两 root 路径 `.agentteam/teams/<sessionId>/state.json` 不同；store.js `teamIdOf/statePath` |
| R-09 plan 不走锁 | major | ✅ 修复 | plan 整体在 `store.lock`（tools.js:281）；旧任务清理在新板落盘后（tools.js:346） |
| R-10 writeArtifacts:false 不可用 | major | ✅ 修复 | store.js write-through 内存态；探针 H：status 能看到 run、report 成功 |
| R-11 黑板可被成员改写 | major | ↔ 不接受（边界） | readState 仍信任文件（store.js:113-130）；docs/03:232 已改为「不提供」防篡改 |
| R-12 override 全量豁免 | minor | ✅ 基本修复（残留 R-21） | 探针 H：返回 `waived` 列表；仅 `finalize+pass` 时落盘（tools.js:929-933）；报告头区分 override |
| R-13 status 不自足 | minor | ✅ 修复 | status 默认含 DoD/reviewers/task revision/repair_log；`{item_id}` 附完整 report/reviews（workflow.js:840-863） |
| R-14 不校验成员名 | minor | ✅ 修复 | workflow.js:228、:245 校验 owner/reviewer 形状；repair 同样校验（tools.js:68-73） |
| R-15 workerContext 硬编码 | minor | ✅ 修复 | `renderWorkerBrief(..., contextMode)` protocol.js:68、:124；plan next_actions 引用实际值 |
| R-16 简报指不存在的 revision | minor | ✅ 修复 | 简报改指 `team_task_get` / `team_flow_status {item_id}`（protocol.js:94）；status 回 task revision |
| R-17 固定注入成本 | minor | ↔ 部分 | 实测 policy 3360 B、8 工具 schema 9918 B（≈3.7k tokens/会话）；README:99 已标注成本与关闭开关 |
| R-18 未用状态/事后可改 | nit | ✅ 修复 | REPORTED 已删；ABORTED 在 replace 归档时写入；finalize 后 report/submit/respond/escalate/repair 有 phase 守卫；文本 clip 上限 |

## 仍存在的问题

### R-19 [major] `lib/workflow.js:503-507`（配合 :688-689、:790、:795-815）— `approve_with_nits` 带 finding 时 item 已批准但门禁失败，且无人被指派回应

**问题**：批准型 verdict（含 `approve_with_nits`）直接置 `APPROVED`（:503-507），不再开后续评审；`evaluateGates` 仍把未决 finding 判失败（:688-689）；`nextActions` 对 Lead 输出 "All items are approved → finalize"（:790），对 owner 没有任何动作（:795-815）；作者收到的是 "approved … nothing further"（protocol.js:237），不提示 respond。文档 04:245 的"只剩 nit → approve_with_nits 结束（早停）"与门禁 G4 自相矛盾。
**真实失败场景**：`/tmp/atw-final2.mjs` §2：`item status=approved`、`unresolved findings=1`、`gate pass=false ["1 unresolved review finding(s)"]`、author `next_actions=["No action is assigned…"]`、消息文本无 respond 指令。这是 nits 收尾的最常见路径，Lead 会持续收到 "finalize" 指令并持续失败，必须手工介入；模型可能就此把 run 卡死或错误 override。
**建议修复**：二选一——(a) 批准型 verdict 的 findings 记为"已接受 nits"，G4 只统计**非批准** review 的未决 finding（与 04:245 早停一致）；(b) 保持 G4 严格，但 item approved 且有当前版本未决 finding 时，`nextActions` 给 owner 输出 `team_flow_review_respond` 动作，并在 `approvedMessage` 里写"仍有 nits 需 respond"。
**如何验证**：engine 测试 approve_with_nits + nit finding → 方案 a 期望 gate pass，方案 b 期望 author next_actions 含 `review_respond`；当前两者皆否（探针 §2）。

### R-20 [minor] `lib/workflow.js:340-349, 417, 443-461` — 作者可用 re-report 重置返修预算，绕过"轮次耗尽自动升级"

**问题**：`reworkRounds` 只统计**当前 `reportSeq`** 的非批准 verdict（:340-349），而每次 report 使 `reportSeq++`（:417）并重开评审；`applyReport` 已不再检查预算（:443-461）。作者在每次 respond 后重新 report（合法动作，会 supersede pending review），rework 计数永远回到 0，永远不会 escalate。03:143 的"超限自动升级、不允许静默循环"因此不成立。
**真实失败场景**：`/tmp/atw-final.mjs` C 段（10:40 代码）：3 轮"report → request_changes → respond"后 `escalations=0`、`reportSeq=3`，无限循环不升级，只消耗 token。
**建议修复**：把返修计数绑定到 item 生命周期（累加 repair/rework 记录），或禁止存在 pending review 时 re-report（必须先 respond 让同一版本完成复审）。
**如何验证**：C 段循环 5 次断言 `escalations>=1`；当前为 0。

### R-21 [minor] `lib/tools.js:904-933, 980` — 带 overrides 的 gate 预览返回 pass，但按 next_actions finalize（不带 overrides）必然失败

**问题**：`overrides` 仅在 `finalize && gate.pass` 时落盘生效（:929-933）；预览时只回 `pass:true` 和 `waived`，而 `next_actions` 固定为 "Call team_flow_gate {finalize:true} …"（:980），不含"重复传入相同 overrides"。模型照做则 gate 重新计算（无 overrides）→ 失败。
**真实失败场景**：`/tmp/atw-final2.mjs` §1：preview `pass=true, waived=[4 项]`、next 指令无 overrides；`finalize:true`（无 overrides）→ "the gate did not pass"；再带 overrides 才成功。模型可能在两步之间来回打转或放弃收敛。
**建议修复**：预览阶段把 overrides 落盘为 pending（finalize 时复用），或 `next_actions` 明确回显 `{overrides:[…]}`，或区分 `pass_preview` 与 `pass_final`。
**如何验证**：§1 脚本；断言 preview.next_actions 含 overrides 或 finalize 不带参数即可通过。

### R-22 [nit] `lib/tools.js:1092` vs `:1139` — `reset_review` 的 `reviewer` 描述为可选，实现必填

**问题**：工具 schema 写"defaults to the next outstanding reviewer"，代码 `assertMemberName(args.reviewer)`（:1139）在缺省时报 `reviewer "" is not a spawnable member name`；docs/04 工具表也标 `reviewer?` 可选。
**建议修复**：缺省时取 `W.outstandingReviewers(item)[0] ?? item.reviewer[0]`，或把 schema/文档改为必填。
**如何验证**：`/tmp/atw-final.mjs` D 段（不带 reviewer → 报错）；修好后不带 reviewer 应成功或给出明确必填错误。

### R-23 [nit] `docs/03-architecture.md:202` vs `:232` — 同一文档对"手改黑板能否被发现"结论相反

**问题**：§7.2 仍写"手改会在下次状态机校验时产生不一致"（:202），与 §9 的"黑板防篡改：不提供"（:232）矛盾；R-11 的修复只改了后者。另 04:245 的 nit 早停与 G4 冲突（并入 R-19）。
**建议修复**：把 §7.2 该句改为"手改不会被检测，见 §9"，并在 04 早停处补"nit findings 需 respond 或由 Lead 接受"。
**如何验证**：grep 两处矛盾句；文档评审。

### R-24 [nit] `lib/workflow.js:830-855` — status 的 `verdicts` 包含 superseded 记录（verdict=null），`rounds_used` 用提交数而非返修轮

**问题**：`verdicts` 仅过滤 `status!=='pending'`（:851），superseded review 会以 `verdict:null` 混入面板；`rounds_used` 仍是 `submittedRounds`（:847，含批准），与门禁使用的 `reworkRounds` 语义不同，Lead 无法从 status 判断真实返修轮。
**建议修复**：过滤 superseded；同时回显 `rework_rounds` 与 `submitted_rounds` 两个字段并注明含义。
**如何验证**：构造 superseded 记录后读 status；对比 gate 使用的 `reworkRounds`。

## 已核查未发现问题的项（复审确认）

- **身份与权限**：所有工具只从 `exec.agent` + `ctx.agentTeams.membership()` 取调用者，无可传 caller 的参数；`requireLead` 用 `membership.role`；report/respond 用 owner 名、submit 用 `pending.reviewer` 名；`'lead'` 被 spawn 保留。新增 `team_flow_repair` 同样 Lead-only。✓
- **并发（mutateState 覆盖的路径）**：report/review/respond/gate/escalate/repair 均在 per-path promise 锁内 read-modify-write；plan 现在也走同一把 `store.lock`（tools.js:281）；tmp+rename 同目录且文件名含随机后缀。✓
- **DSH API 契约**：8 个 output schema 通过真实 `assertSupportedJsonSchema`（integration test）；execute 返回 JSON 归一化值；per-Agent 安装/拆除与官方 `tool-agent-team` 范式一致；`agent/created|disposed` payload、`systemPrompt.section/context` 与 order、`workingDirectory.get/defaultDirectory`、`sendMessage{target,content,signal}`、`createTask/updateTask/getTask`（含 deleted tombstone、claim taskReady、complete/reopen 前置）逐项一致；零外部 import（仅 `node:fs/promises`、`node:path`）。✓
- **bundle 清单**：`cordis.patch.yml` 纯 insert、`dsh.bundle.patch`、locale meta 形状正确；`files` 含 `lib/*.js`。✓
- **测试**：`NODE=…/node; "$NODE" --test test/engine.test.mjs test/tools.integration.test.mjs test/plugin.test.mjs` → `tests 41 / pass 41 / fail 0`；新增断言覆盖了 R-01/02/03/04/05/07/08/10/12/13/14/15/16。✓
- **spawn 简报自包含性**：worker/reviewer 简报含身份、使命/AC、DoD、scope、依赖、task id/revision 来源、步骤与沟通规则；双重角色成员只产出一份 brief（03 §11.1）。✓

## 未能验证/需作者确认

1. **live 代际**：仍未重启；本会话可见的是骨架代 `team_workflow_info`（05 §5 已声明 V7 未验证、link 包不参与 HMR）。复审结论来自代码 + 离线探针，真实模型行为未观测。
2. **R-19/R-20/R-21 的真实模型触发频率**：机制由探针证明可达；模型是否真的踩（nits 收尾、反复 re-report、override 两步）需 live run 统计。
3. **R-09 的并发交错**：代码路径已复核（同一 path 的锁），但未构造真实并发写文件的竞争窗口实测（fake harness 无法复现 FS 竞态）。
4. **双重角色 reviewer 的调度时序**：03 §11.1 仅保证"只 spawn 一次"；若该成员工作项在后续波次而其评审项在前一波次，review 可能等不到成员被 spawn（静态推理，未实测）。
5. **41 个测试的独立性**：新增用例由作者与实现同源编写；我用独立探针复核了 A/B/C/E/F/G/H/I/依赖场景，其余（repair 权限、Team 隔离、内存模式）以源码 + 用例阅读为准。
6. **`TeamTaskId` 字符串 id 兼容性**：只读源码（branding 恒等 + 内部字符串查找），未 live 调用。
7. **文档 03/04/05/07 在 10:40–10:42 仍有改动**；本文件按 10:40 代码 + 10:42 文档引用，作者后续改动可能已修复 R-19~R-24 中的部分项。
8. **评审独立性属组织问题**：同模型扮演的两个 teammate 无法由插件证明"真独立"；按设计边界理解，不计入缺陷。
