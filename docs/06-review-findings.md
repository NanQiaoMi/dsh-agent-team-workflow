# 06 · 对抗性审阅发现（独立 reviewer）

**审阅基线**：`packages/agent-team-workflow` @ 2026-11-01T10:28+08:00（`index.js c273b277`、`lib/workflow.js 3d959705`、`lib/store.js 36dc6abf`、`lib/tools.js bffdf6b5`、`lib/protocol.js 715b4d2d`、`package.json 24744175`）；文档 01–05 同快照。方法是逐文件通读 + 对照本机 DSH 安装目录源码 + `/tmp` 一次性脚本驱动真实工具适配器复现（脚本不写入工作区）。

## 结论摘要

1. **不诚实的 owner 可以让 run 收敛，而最终产物没有被完整审阅**：批准结论没有绑定到 report 版本（R-01，blocker，已用真实 `buildTools` 适配器复现，且不需要 Lead override）。
2. 身份与权限本身可靠（见「已核查未发现问题」）；真正的治理弱点在别处：轮次预算按 verdict 计数（R-03）、升级后没有恢复路径（R-04）、`team_flow_escalate` 是任意成员可触发的 item 状态后门（R-02）。
3. Gate 的「强制」大多只是形状校验：评审证据、真实 diff、依赖顺序、黑板完整性都不进判定（R-05/R-06/R-07/R-11）；03 §9、04 §8、`protocol.js` 的多处「强制」声明与实现不符。
4. 持久化/并发有两处真实缺口：`team_flow_plan` 不走 store 锁（R-09）；`writeArtifacts:false` 实际不可用（R-10）。
5. 测试 `25/25` 全绿，但上述路径均无用例覆盖；全绿不等于正确。

| 严重度 | 数量 | 编号 |
| --- | --- | --- |
| blocker | 1 | R-01 |
| major | 10 | R-02 ~ R-11 |
| minor | 6 | R-12 ~ R-17 |
| nit | 1 | R-18 |

---

### R-01 [blocker] `lib/workflow.js:380`（配合 :271-311）— 批准结论不绑定 report 版本，最终产物可在无复审的情况下收敛

**问题**：`applyReport` 只把 *pending* review 置 `superseded`（:373-375）；历史 `approve` 永不失效。`allReviewersApproved`/`outstandingReviewers` 只看每个 reviewer 的最后一条记录（:271-311），不比较 verdict 与当前 `item.report` 的先后。两条路径可达：
- **A（零新评审收敛）**：rev 批准 v1 → owner 自己调 `team_flow_escalate{blocking:true,item_id}`（任意成员可把 item 状态翻成 escalated，见 R-02）→ `team_flow_report` 交 v2（换文件、换命令）→ `applyReport` 因 `allReviewersApproved` 为真直接把 item 置 approved（:380-383）→ Lead 裁决 escalation → `team_flow_gate{finalize:true}` **pass=true / finalized=true**，report.md 写的是 v2，而 v2 没有任何 verdict。
- **B（多 reviewer 部分审阅）**：reviewers=[rev1,rev2]；rev1 批准 v1 → owner 在 rev2 pending 时 re-report v2 → rev2 批准 v2 → item approved、gate pass=true；rev1 的批准被计为对 v2 的批准（reviews 实际为 `rev1:approve, rev2:superseded, rev2:approve`）。

**真实失败场景**：`/tmp/atw-repro.mjs` A/B 段（真实 `buildTools`+临时 workspace）。A 段输出：`report v2 -> status=approved reviewer=null`、`finalize -> pass=true finalized=true`、`converged content files=['src/rewritten.js']`。B 段 `/tmp/atw-gateB.mjs` 输出 `pass=true failures=[]`，`final files=['src/a.js','src/bad.js']`。
**建议修复**：item 增加 `reportSeq`，report 时递增并把所有历史 verdict 标记 stale；`allReviewersApproved`/`outstandingReviewers`/`evaluateGates` 只统计 `review.reportSeq === item.reportSeq` 的 verdict；删除 `applyReport` 的 auto-approve 捷径（:380-383），统一重开评审。
**如何验证**：engine 单测：approve → （escalate → report v2）后 `outstandingReviewers(item).length === 1`，且 gate 必须因 pending review 失败；当前实现会 pass。

### R-02 [major] `lib/tools.js:959` — `team_flow_escalate` 是任何成员对任意 item 的状态后门

**问题**：任何成员（teammate 也可以）对任意 `item_id` 传 `blocking:true`，就把该 item 置为 `ESCALATED`；不校验 owner、不校验当前状态（甚至 `approved` 也能翻）、resolve 后也不恢复。它不在 03 §5.4 的迁移授权表里，却是 R-01 路径 A 的放大器，也可用来 DoS 同伴的 item。
**真实失败场景**：repro A 段第一步：`item status after escalation = escalated`（此前 approved）；随后同一 item 被 re-report 并自动 approve。另：repro C 末行重复 report 产生第二条 escalation（`escalations=2`）。
**建议修复**：escalate 只追加 escalation 记录，不改 `item.status`；需要暂停时新增显式 action（仅 owner/Lead、限定状态白名单），resolve 时由派生状态恢复。
**如何验证**：integration test：teammate 对已批准 item 调 escalate 后断言 `item.status === 'approved'`；或跑 repro A 第一步。

### R-03 [major] `lib/workflow.js:309-311, 384, 512` — 轮次预算按“verdict 条数”计，多 reviewer 项第一次返修就超限

**问题**：`submittedRounds()` 统计所有 `status==='submitted'` 的 review（每个 reviewer 每条 verdict 各算 1），而 03:137 / 01:487 / 04 阶段 4 定义“一轮 = 作者 report + 一个 verdict / 第 1 轮 + 1 次返修”。`reviewers ≥ 2` 时，首轮全部批准已消耗完默认预算 2；第二个 reviewer 的第一次 `request_changes` 在 respond 时立即触发 escalated（:512-524）。
**真实失败场景**：repro C：rev1 approve(1) + rev2 request_changes(2) → author 修复并 respond → `escalated=true`、gate `review not approved by: rev2`；04:263 指示 Lead“reopen 后重新 report”，但 re-report 再次命中 :384-394 生成**第二条** escalation（repro C 末行）。多 reviewer 项因此无法承受任何返修。
**建议修复**：引入 `reviewRound`（每次 report 后重置的返修轮）与 verdict 计数分离，预算只按 reviewRound 计；超限时若同一 item 已有未解决 arbitration 则复用而不是新建。
**如何验证**：engine 单测（2 reviewers、max=2）：rev1 approve、rev2 request_changes、respond 后期望 `escalated===false && nextReview.round===2`。

### R-04 [major] `lib/workflow.js:702` + 全工具集 — 升级后没有 reopen/reassign/reset 路径，“仲裁”实际只能 override

**问题**：`next_actions`（:701-702）明确让 Lead“either reopen the item or record a gate override”，但 7 个工具里没有 reopen/reassign/reset-round；04 §7 多处“reopen 后重新 report”“改计划需重跑”不可执行。reviewer 未 spawn/失败/名字拼错时 pending review 永久挂起，无 reassign；轮次耗尽后 re-report 只会再 escalate（R-03）。
**真实失败场景**：repro C 中 escalation 被 Lead resolve 后 item 仍 `escalated`，gate 永远失败；唯一出路是 per-item override（R-12），而它同时豁免报告/证据/评审全部检查。`team_flow_plan` 的名字拼错即形成死 run（R-14）。
**建议修复**：新增 Lead-only repair 动作（reopen item / reset review round / reassign owner|reviewer，写 event 与原因）；或至少把 04 §7 的恢复步骤改成“用 override 并在报告中记录”，删掉不存在的 reopen 指令。
**如何验证**：`grep -c "name: 'team_flow_"` 只有 7 个；断言 next_actions 中出现的 `reopen` 无对应工具；复现 C 后尝试修复（当前无 API）。

### R-05 [major] `lib/workflow.js:589-645` — Gate 不检查评审证据，“签核”用一个空数组即可通过

**问题**：`evaluateGates` 对 review 只做 reviewer≠owner 与 fork warning，从不读 `review.evidenceChecked`、`finding.file/line`；G2 只要求 commands 非空且 `exitCode` 为整数——`{command:"", exit_code:0}` 也算合格。03:217“门禁要求 `evidence_checked` 非空、findings 命名到 file:line”、04:274“空评审…门禁判失败/警告”、`protocol.js:40`“Approving without evidence is a gate failure”三处声明均不成立。
**真实失败场景**：repro I：report `files:[]`、`commands:[{command:"",exit_code:0}]`、`evidence:[]` + review `evidence_checked:[]` → `gate pass=true finalized=true`。这是文档承诺的强制项缺失，不是“评审可以敷衍”的已知残余风险。
**建议修复**：G2 校验 command.trim() 非空且 report.evidence 非空（evidenceOptional 例外）；approve/approve_with_nits 要求 `evidenceChecked.length>0`；finding 要求 file 非空（blocker/major 要求 line）。同时更正上述三处文档/注入文本。
**如何验证**：engine 单测 approve with `evidenceChecked:[]` → gate fail；repro I 断言 `pass===false`。

### R-06 [major] `lib/workflow.js:612-622` — 写范围纪律只检查“自报 files”，不校验实际改动

**问题**：`outside` 只遍历 `item.report.files`（owner 自己填的数组），不 stat、不比对 git diff/工作区实际变更；`strictScopes` 默认 false（`config.js:30`）→ 即使自报越界也只是 warning。01:554 的硬要求“完成时校验（比较实际 diff 路径与声明 scope）”未实现；03:216 声称绕过工具改文件会被后续校验发现也不成立。
**真实失败场景**：worker 用 bash 改了 `src/other/` 或在 scope 外新建文件，但 `report.files` 只填 scope 内路径 → outside 为空 → G5 通过（repro E 的 report 只填 `src/a.js` 时即如此）。
**建议修复**：report 时（或 gate 时）用 `ctx.fs`/`git status` 求实际变更集合与 `writeScopes` 比对，未声明变更即 fail；至少把 `strictScopes` 默认改 true；文档如实降级为“自报 + Lead 抽查”。
**如何验证**：临时 workspace 在 report 前手写一个 scope 外文件、report 不列它 → 断言 gate fail（当前 pass）。

### R-07 [major] `lib/workflow.js:396` + `:630-634` — 依赖顺序既不进状态机也不进门禁

**问题**：`applyReport` 不检查 `item.blockedBy` 是否 approved；item gate 没有依赖项；只有 report 之后的 `syncTaskComplete` 尝试 native claim，失败降级为 warning（`tools.js:84-102`）。05:186 声称“完成顺序必须由治理层自己保证（本包用 DAG + gate）”，不成立。
**真实失败场景**：repro E：W2(blocked_by W1) 在 W1 尚未开工时 report → in_review → rev 批准 → `gate: W2 pass=true`，`sync_warnings=["backing Team task task-2 not synchronized: TEAM_TASK_BLOCKED"]`。若 W1 之后以不同接口实现，run 仍可收敛，W2 的验收建立在旧契约上。
**建议修复**：`applyReport` 前置 `blockedBy.every(id => findItem(id).status === APPROVED)`；native claim 失败升级为 item gate failure；gate 增加依赖检查。
**如何验证**：复现 E 断言 report W2 抛错或 gate W2 fail。

### R-08 [major] `lib/store.js:61-83` — 黑板只按 cwd 定位，不按 Team 隔离

**问题**：state 路径 = `workingDir(root)/artifactsDir/state.json`，与 `teamId`/root agent 无关；`tryMembership()` 对任何顶层 Session 返回 `role:'lead'`（`roster.js:63-90`），因此同一 workspace 的第二个普通会话也是 Lead，可以读/override/finalize/replace 第一个 Team 的 run；注入的 `team:workflow-state` context 还会把别的 run 摘要读进无关会话（`store.js:112-119`、`index.js:88-95`）。
**真实失败场景**：repro G：两个 lead agent 的 `statePath` 完全相同。Session B 对 A 的 run 调 `team_flow_gate{finalize}`（B 是 lead → `requireLead` 通过）或 `plan{replace}`（删掉 A 的 backing tasks）。用户同时开两个会话即触发。
**建议修复**：state 按 teamId 分目录/文件名，读改时校验 `state.teamId === membership.root.id`；不匹配时明确报错；`team:workflow-state` 只在同一 team 时展示。
**如何验证**：fake ctx 两个 root agent 断言 statePath 不同；或重启后两会话 live 复现。

### R-09 [major] `lib/tools.js:258,330`（及 :262-277）— plan/replace 不走 store 锁，replace 清理顺序不可靠

**问题**：`team_flow_plan` 直接 `readState → (await createTask…) → writeState`，未用 `mutateState/withLock`；而其它成员的 report/review 都在锁内做 read-modify-write（`store.js:147-158`）。plan 的 `writeState` 可与它们交错：report 已读旧 state → plan 写新 run → report 把旧 state 写回，导致新 run 丢失/黑板与 native tasks 不一致。`writeState` 临时名 `${pid}.${Date.now()}.tmp`（`store.js:134`）在并发同毫秒下可能同名。另：replace 先删旧 tasks（:266-277）再建新 tasks，创建失败时旧 `state.json` 保留但 backing tasks 已删；删除按 items 数组倒序，真实 board 拒绝删除仍有 dependents 的 blocker（`task-board.js:200-205`），items 非拓扑序时留下僵尸 task。
**真实失败场景**：Lead 在 worker 正在 report 时 `plan{replace:true}`（04 阶段 6 明确允许重跑）→ worker 的 report 静默丢失，或旧 run 状态覆盖新 state。
**建议修复**：plan 的全部 state 读写放进 `store.mutateState`；旧 task 清理放到新 state 落盘之后（失败可重试）；按 waves 逆序删除。
**如何验证**：并发脚本（20 次 report 与 plan replace 同时触发）断言新 run items 不丢失；注意 fake harness 不复现 dependents 守卫，需真机或按 `task-board.js` 语义补 fake。

### R-10 [major] `lib/store.js:126-131` — `writeArtifacts:false` 不可用：plan 之后所有工具都看不到 run

**问题**：`writeArtifacts=false` 时 `writeState` 只更新 prompt summary、不写文件；而 `readState` 只读文件（:90-97）。所以 plan 返回 run_id 后，status 返回 `run_id:null, phase:"none"`，report 报 “no workflow run exists yet”。04:264 把它当“artifacts 不可写时的内存模式”兜底，实际是半死状态；prompt context 仍显示 run 存在（summary 已缓存），自相矛盾。
**真实失败场景**：repro H：`plan run_id=run-…` → `status run_id=null phase=none` → `report error=no workflow run exists yet`。
**建议修复**：store 增加内存 state Map，`readState` 先查内存、`mutateState` 写内存（`writeArtifacts` 只控制是否落盘）；或删除该配置项并在文档写“workspace 必须可写”。
**如何验证**：integration test 用 `resolveSettings({writeArtifacts:false})` 跑完整流程；repro H 断言 status.run_id===plan.run_id。

### R-11 [major] `lib/store.js:90-110` — 黑板无完整性校验，任何成员可直接伪造评审/阶段

**问题**：`state.json` 是普通工作区文件，`readState` 只校验 `runId` 是字符串，随后完全信任 items/reviews/phase；无 hash/签名/append-only，gate 也不复核。任何 teammate 用 fs/bash 写入一条 `{reviewer:'rev',verdict:'approve'}` + 一份 report，gate 即通过——这是 R-01 之外另一条“零审阅收敛”路径，且不需要 reviewer 参与。03:216 / 04 §8#8 声称“手改 state.json 会造成状态机不一致、后续工具会报错”，不成立。
**真实失败场景**：worker 直接改 `.agentteam/state.json`（路径公开在 `team_flow_status.artifacts.state_path`）→ 伪造 approve/report → Lead 跑 gate → pass；审计 events 也可被一并改写。
**建议修复**：至少给 state 增加 Lead 写入的 HMAC/事件哈希链并在 gate 前校验；更符合 DSH 设计（02 §F.1 会话日志是唯一真源）的做法是把 verdict 落到 native task description/session log，state 只作缓存；文档如实标注“黑板可被成员改写，不是独立证据”。
**如何验证**：fake store 写一份伪造 approve 的 state.json，调 gate 观察 pass（当前 pass 即证明）；作为 tamper 测试固化。

### R-12 [minor] `lib/workflow.js:636` + `lib/tools.js:835-839` — override 是 per-item 全量豁免，且预览调用也会永久落盘

**问题**：`pass = failures.length===0 || override!==null`，override 可让“无 report/无评审/未决 finding”的 item 通过（repro F：`pass=true`，failures 仍列 no report/no command/review not approved）；工具返回只有 `pass:true`，被豁免项只出现在 gate 明细；`finalize:false` 时也把 reason 写进 `item.overrideReason`。报告固定打印 “All required gates passed”（`protocol.js:332`），与表格中的 no+failures 并存。
**真实失败场景**：Lead 预览 gate 时误传 overrides → item 永久带 override，后续 sub-check 持续被豁免；用户看到的报告头部是“全部通过”。
**建议修复**：override 仅豁免显式列出的 failure 并在结果中返回 `waived` 列表；`pass` 之外增加 `overridden_items`；overrides 仅在 finalize 时落盘；报告头部区分“含 N 项 Lead 风险接受”。
**如何验证**：repro F 断言 `item_gates[0].waived` 存在；当前输出已记录。

### R-13 [minor] `lib/workflow.js:739-767` — status 黑板不自足：缺 DoD/声明的 reviewer/report 明细

**问题**：items 只回传 id/subject/owner/role/status/task_id/write_scopes/blocked_by/reported/reviews/open_findings/report_summary/override；没有 definition_of_done、reviewers、report.files/commands/evidence/risks。reviewer 的 next_actions 说“inspect the reported files and evidence”却拿不到这些字段；`autoNotify:false`（`config.js:34`）时 reviewer 收不到 reviewRequestMessage，只能绕过工作流工具直接读 state.json（路径在 artifacts 里）或工作区文件。01:638 宣称“任何成员可在不读聊天记录的情况下恢复上下文”，工具面不成立。
**真实失败场景**：关闭 autoNotify 或通知丢失：reviewer 调 `team_flow_status` 后不知道作者改了哪些文件、跑了什么命令、DoD 是什么（DoD 只在 spawn brief 里）。
**建议修复**：status 增加 item.definition_of_done / item.reviewers / report 明细（或提供 `team_flow_get item` 工具）。
**如何验证**：repro J 输出 item keys（无 definition_of_done/reviewers/report）；断言补齐。

### R-14 [minor] `lib/workflow.js:227,242-249` — 计划期不校验 owner/reviewer 是否是可 spawn 的成员名

**问题**：只校验非空/非 lead/不重复；真实 spawn 要求 lower-kebab-case 且非 “lead”（`roster.js:404-405`）。`owner:"Alice_1"` 或 `reviewer:"Rev A"` 会被 plan 接受，随后 spawn_teammate 抛 `TEAM_INVALID_MEMBER_NAME`；reviewer 拼错/未 spawn 时 run 卡死（R-04），无修复路径；`reviewer:'lead'` 只 warning。
**真实失败场景**：模型写 `owner:"Impl_1"`（常见）→ plan 成功 → 全队无法 spawn → 只能 `plan{replace}` 重来并丢失全部进度。
**建议修复**：plan 校验 owner/reviewers 匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` 且 ≠ 'lead'（至少 owner）；reviewer 为 'lead' 升为 error，或要求至少 1 个非 lead reviewer。
**如何验证**：engine 单测 `plan(owner:'Impl_1')` 期望 error；当前返回无 error。

### R-15 [minor] `lib/protocol.js:115,161` — `workerContext` 配置被 spawn 简报硬编码覆盖

**问题**：`buildPolicy`/plan next_actions 让 Lead 使用 `settings.workerContext`（`protocol.js:38`、`tools.js:342`），但 `renderWorkerBrief`/`renderReviewerBrief` 一律返回 `context:'fresh'`；配置 `workerContext:'fork'` 时 plan 返回的 `spawn[].context` 与 next_actions/policy 指令矛盾，gate 的 fork warning（`workflow.js:626`）也永远不会对 configured reviewer 触发。
**真实失败场景**：`cordis.patch.yml` 配 `workerContext: fork` 想复用 Lead 上下文 → 实际仍 fresh；或 Lead 按 next_actions 传 fork 而简报自称 fresh，行为不一致。
**建议修复**：`brief.context = settings.workerContext`（reviewer 可单列配置），plan.next_actions 引用 `brief.context`。
**如何验证**：`resolveSettings({workerContext:'fork'})` 下断言 `plan.spawn[0].context==='fork'` 且 next_actions 一致。

### R-16 [minor] `lib/protocol.js:91` — worker 简报让“从 team_flow_status 拿 task revision”，status 从不返回 revision

**问题**：简报说 claim backing task “using the revision from team_flow_status”，但 `buildStatus` 的 item 只有 `task_id`，没有 task revision（repro J keys）；worker 只能再调 `team_task_get/list`。`protocol.js:39` 的“claim with the current revision”同样没给来源。
**真实失败场景**：模型按简报用错 revision → `TEAM_TASK_STALE_REVISION`/参数错误，多浪费一步；在长回合里增加放弃概率。
**建议修复**：简报改为“先 team_task_get(task_id) 取 revision”；或 status item 增加 `task_revision`。
**如何验证**：repro J 输出无 revision；grep 简报文本。

### R-17 [minor] `index.js:39-51` + `lib/protocol.js:31-51` — 每个顶层会话固定承担 ~3.3k token 注入成本，且与原生 team 工具重复

**问题**：`tryMembership(root)` 对任何顶层会话返回 lead（`roster.js:89`），所以每个普通会话都装 7 把工具 + `team:workflow` 段。实测：policy 3360 B；7 个工具 name+description+parameters 合计 8878 B；worker brief 2298 B / reviewer brief 2026 B。按 ~3.5 B/token 约 3.3k tokens/成员/请求，即便该会话从不组队；内容与原生 team policy（同 order 600 段）大量重复（claim/CAS/消息纪律）。
**真实失败场景**：日常单 agent 会话也带工作流宪法与 7 个工具定义，增加成本与误用面（模型可能对不存在的 run 调 `team_flow_plan`，得到 “no run exists”）。
**建议修复**：把工具/段落安装延迟到“本 Team 首次 spawn 或 run 存在时”；给工具加 `deferLoading: true`；把 policy 压到 1 KB 内并与原生 team policy 去重。
**如何验证**：按本文件字节数复测；对比未装插件 profile 的 system prompt/tool schema 长度。

### R-18 [nit] `lib/workflow.js:14-32` / `lib/protocol.js:332` — 未使用状态、finalize 后仍可改板、报告措辞

**问题**：`ITEM_STATUS.REPORTED`、`RUN_PHASE.ABORTED` 从未被写入（03 §5.1/5.2 却画出 aborted/reported 状态）；finalize 后 `escalate`/`review_respond` 仍可改黑板（无 phase guard）；override 导致 gate pass 时报告仍打印 “All required gates passed”；report.summary/finding.claim 无 MAX_TEXT 上限（只有 events 截断），state.json 可被单条超长 finding 撑大。
**真实失败场景**：状态图与实现不一致误导 Lead/读者；finalize 后的新 escalation 让“已收敛”报告与状态不符。
**建议修复**：删除/实现未用状态；finalize 后工具加 phase 守卫；报告头区分 override；对 report/finding 文本设上限。
**如何验证**：grep 无 REPORTED/ABORTED 写入点；finalize 后调 escalate 观察 state 变化。

---

## 已核查未发现问题的项

- **身份与权限**：所有工具只从 `exec.agent` + `ctx.agentTeams.membership()` 取调用者，没有可传 caller 的参数；`requireLead` 用 `membership.role`；report/respond 用 owner 名、submit 用 `pending.reviewer` 名，均为 roster 真值；`'lead'` 被 spawn 保留（`roster.js:404`），未发现同名冒充。Lead-only 工具对 teammate 确实拒绝（工具测试覆盖）。✓
- **并发（mutateState 覆盖的路径）**：report/review/respond/gate/escalate-resolve 的 read-modify-write 在 per-path promise 锁内串行，`writeState` 同目录 tmp+rename；两个成员同时 report/review 不会丢更新。✓（plan 例外见 R-09）
- **DSH API 契约**：7 个 output schema 通过 dsh-tools 真实 `assertSupportedJsonSchema`；`execute` 返回 JSON 归一化值；per-Agent 安装/拆除与官方 `tool-agent-team` 范式一致；`agent/created|disposed` payload、`systemPrompt.section/context` 与 TEAM_POLICY/TEAM_IDENTITY order、`workingDirectory.get/defaultDirectory`、`sendMessage{target,content,signal}`、`createTask/updateTask/getTask`（含 deleted tombstone、claim taskReady、complete/reopen 前置）逐项核对一致；零外部 import（仅 `node:fs/promises`、`node:path`）。✓
- **bundle 清单**：`cordis.patch.yml` 纯 insert、`dsh.bundle.patch`、locale meta 形状正确；审阅期间作者补了 `files` 的 `lib/*.js`（上一快照缺失，已修复）。✓
- **测试**：`NODE=…/node; "$NODE" --test test/engine.test.mjs test/tools.integration.test.mjs test/plugin.test.mjs` → `tests 25 / pass 25 / fail 0`。测试绿不代表无缺陷：R-01/03/04/06/07/08/10/11 均无用例。
- **spawn 简报自包含性**：worker/reviewer 简报含身份、使命/AC、DoD、scope、依赖、任务 id、步骤与沟通规则，fresh context 基本可独立开工；仅 R-16（revision 来源）为实际缺口。

## 未能验证/需作者确认

1. **最终代码代的 live 行为**：05 §5 已声明未验证；我观察到本会话可用的是骨架代 `team_workflow_info` 而非 7 个正式工具（与 05 §5 “link 包不参与 HMR”一致）。我未被允许重启，无法确认真实模型是否遵守注入协议、是否触发 R-01 等路径——离线复现只证明机制可达，不证明模型会走到。
2. **R-08 真实两会话**：用源码 + 路径计算 + fake agents 证明；未用两个 live Session 实测（需新会话/重启）。
3. **R-09 交错时序**：由源码推理 + fake（未构造真实并发写文件的竞争窗口）；建议作者用 20 轮并发脚本确认。
4. **`TeamTaskId` 字符串 id 兼容性**：只读源码（branding 恒等 + 内部按字符串查找），未 live 调用 `getTask/updateTask`。
5. **R-09 后半（dependents 守卫导致僵尸 task）**：只读 `task-board.js:200-205`，fake harness 不复现该守卫，未在真实 board 上跑 replace。
6. **R-10 真实不可写目录**：用 fake ctx 复现；未在只读 workspace 实测。
7. **文档 03/04/05 在审阅期间仍在写**（mtime 10:19–10:27）；本文件按 10:28 快照的章节/行号引用，作者后续改动可能已修复部分条目。
8. **评审独立性属组织问题**：同模型扮演的两个 teammate 无法被插件证明“真独立”；按设计边界理解，不计入缺陷。
9. **R-11 威胁模型**：按“不诚实 agent 会使用 fs/bash”假设；若产品明确假设成员只走工具，请作者确认并把该假设写进文档。
10. **动态成员中途退出**（reviewer 被 dispose）后的 gate/next_actions 行为：只做静态推理（`memberByName` 缺失时无 warning），未实测。
