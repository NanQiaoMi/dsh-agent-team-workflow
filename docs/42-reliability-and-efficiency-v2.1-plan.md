# 42 · 可靠性与效率深度优化路线图（v2.1+ 演进计划）

> 版本：交付版 v1.1（2026-11-23）  
> 状态：✅ **PR-0 ~ PR-6 已全量合入 `main`（`2c58f4c`）并通过 312/312 测试与远端 CI**  
> 基线：`main`（`82e2004`，`feature/workflow-v2-overhaul` 合入后）  
> 范围：`@local/dsh-agent-team-workflow`（编排器、Worktree 引擎、工具矩阵、审阅策略、Telemetry 与看板客户端）  
> 定位：在 v2 既有的思考路由、分级审阅与事件驱动编排之上，优先堵住**沉默卡死、基线漂移、静默丢代码、合后集成假成功**四大成功率硬伤，再压降剩余工具 Schema 开销与重复测试耗时，建立跨 Run 可靠性归因闭环。

---

## 0. 背景与现状体检基线

### 0.1 实测基线（基于 `main` `82e2004`）

- **单元测试**：`cd packages/agent-team-workflow && node --test test/*.test.mjs` 实测 **252/253 通过**，1 项失败（`test/tools.integration.test.mjs` 因硬编码了本机 `/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js` 路径，在纯 Node / CI 环境下 `ERR_MODULE_NOT_FOUND`）。
- **Payload 基准（`node bench/measure-payloads.mjs`）**：
  - `status.full`: 7,784 B / `status.detail`: 9,217 B / `status.brief.first`: 2,273 B / `status.brief.repeat`: 2,060 B / `status.unchanged`: 188 B
  - `brief.worker`: 2,486 B / `brief.reviewer`: 2,088 B / `brief.queue`: 2,242 B
  - `policy.worker`: 1,644 B / `policy.reviewer`: 1,208 B / `policy.lead`: 5,604 B
  - `tools.lead`: **23,724 B** / `tools.worker`: **14,376 B** / `tools.reviewer`: **8,365 B** / `tools.verifier`: **4,477 B**

### 0.2 代码体检定位的 6 大真实瓶颈

| 编号 | 瓶颈现象 | 精确源码位置与根因 | 影响 |
|---|---|---|---|
| **B1** | **成员沉默卡死永不自愈** | `packages/agent-team-workflow/lib/orchestrator.js` 中 `alreadySentForRev`（L70-L74）只要针对某 `state.rev` 发过一次唤醒，若成员只回纯文本未调工具或异常退回 `inactive`，编排器便永久静默 | 任务无限挂起，只能人工介入 |
| **B2** | **Wave 1+ 基线漂移 + 忘 commit 静默丢代码** | `packages/agent-team-workflow/lib/worktree-manager.js` 的 `autoProvisionWorktrees`（L78-L95）在 `team_flow_plan` 阶段一次性为**所有波次**预建 worktree，后续波次从空 `runBranch` 切出；`lib/tools.js` 的 `team_flow_report`（L1053-L1069）不检查 worktree 未提交改动；`autoMergeApprovedWorktree`（L172-L173）遇到 `nothing to commit` 时直接当作干净合入 | 上游产出丢失、或成员全部改动被静默丢弃 |
| **B3** | **缺少合后集成验证（假成功）** | `packages/agent-team-workflow/lib/orchestrator.js` 的 `autoFinalize`（L503-L580）只调用纯状态检查 `evaluateGates`，不在 `runBranch` 上跑整体集成验证 | 各自 worktree 单测通过、合并后互相破坏却被误判成功 |
| **B4** | **验证证据纯靠自报 + 轻量审阅重复跑慢测** | `lib/tools.js` `team_flow_report` 仅信赖模型填写的 `commands[].exit_code`，无主机防篡改校验；`light` 审阅者往往重复运行同一套耗时测试 | 误报风险高且拖慢整体交付墙钟 |
| **B5** | **工具 Schema 依然偏重** | `packages/agent-team-workflow/lib/tool-matrix.js` `ROLE_TOOL_MATRIX` 对所有预设与场景统一注入固定角色工具集，`tools.worker` 达 14,376 B、`tools.lead` 达 23,724 B | 在 `fast-fix` 或无协作队列场景下白耗 ~3.6k–6k tokens/轮 |
| **B6** | **缺少执行健康度闭环与测试环境耦合** | `bench/measure-payloads.mjs` 仅测静态字节，无跨 Run 成功率/卡死/冲突归因；`test/tools.integration.test.mjs` 硬编码桌面端绝对路径 | 难以量化优化收益，且脱离本机桌面端即测试失败 |

---

## 1. 目标、范围与明确不做（Non-Goals）

### 1.1 量化目标

| 指标维度 | 现状基线 | v2.1 目标值 | 核心手段 |
|---|---|---|---|
| **未提交改动静默丢弃率** | 存在静默跳过路径 | **0%** | 汇报时检测脏改动并在写范围内安全 auto-commit |
| **Wave 1+ Worktree 基线漂移** | 创建时缺失前置波次代码 | **0%** | 仅预建已解锁波次，后续波次基于最新 `runBranch` 懒创建 |
| **成员沉默卡死自动恢复率** | 0%（永久静默） | **100% 可感知与分级恢复** | `stallTracker` 分级轻推（≤2 次）+ 超限自动升级 Lead |
| **合后集成破坏拦截率** | 0%（`autoFinalize` 不验证） | **100% 阻断并报修** | `runBranch` 合后集成验证门禁 |
| **Worker 工具 Schema 体积（`fast-fix`）** | 14,376 B | **≤ 8,500 B（-40%+）** | 场景化工具按需裁剪（`presetToolPruning`） |
| **本地测试套件通过率** | 252/253（1 项路径耦合失败） | **100% 全绿（含纯 Node/CI）** | 解除 `tools.integration.test.mjs` 本机路径耦合 |

### 1.2 明确不做清单（Non-Goals）

- **不做自动停人并拉起替补成员**：轻推超限后交由 Lead 仲裁（`repair / reassign`），避免自治循环失控放大 Token 消耗。
- **不引入外部 npm 依赖**：保持纯 ESM、仅使用 Node 内置模块（`node:*`）。
- **不降低 `standard / deep` 审阅证据强度**：`hostVerified` 免重跑快通道仅用于 `light` 审阅下的同命令复跑减负，不削减高风险审阅要求。
- **不破坏现有 `state.json` 向后兼容**：所有新增持久化字段均保持可选并具备安全默认值。

---

## 2. 六大专题详细设计（Track 1 ~ Track 6）

### Track 1（P0）· 防丢代码与防基线漂移

1. **Wave 1+ 懒创建 Worktree（`ensureItemWorktree`）**
   - 修改 `lib/worktree-manager.js` 中的 `autoProvisionWorktrees`：初始仅对**当前已解锁**（`blockedBy` 全部满足或为空）的 item 创建 worktree，避免为 Wave 1+ 提前切出过时基线。
   - 新增 `ensureItemWorktree({ cwd, state, itemId, agent, store })`：当上游依赖在 `autoMergeApprovedWorktree` 合入 `runBranch` 后，由 `orchestrator.js` 在唤醒下游 item 前按需基于**最新 `runBranch`** 懒创建 worktree。
   - 保留 `settings.lazyWorktreeProvision`（默认 `true`）开关，关闭时回退全量预建行为。

2. **汇报时范围内安全自动提交（`autoCommitWorktreeIfSafe`）**
   - 在 `lib/worktree-manager.js` 新增 `autoCommitWorktreeIfSafe({ cwd, state, item })`：检测 item worktree（或声明范围）内是否存在未提交/未追踪改动。
   - 若所有改动路径均严格落在 `item.writeScopes` 内，由主机安全执行 `git add -- <files>` 与 `git commit -m "agentteam(<itemId>): auto-commit on report"`，记录 `autoCommits` 计数并产出真实 commit SHA 供后续 diff 使用。
   - 若存在任意越界改动（超出 `writeScopes`），原地拒绝 `team_flow_report` 并列出越界文件路径，要求成员自行回滚或申请变更范围。
   - 修复 `autoMergeApprovedWorktree` 对 `nothing to commit` 的处理：仅当 worktree 既无未提交脏改动且确实无相对 `runBranch` 的新提交时才允许跳过，严禁在存在未提交改动时静默跳过合并。

### Track 2（P0）· 沉默卡死分级自愈

1. **成员健康状态追踪器（`stallTracker`）**
   - 在 `lib/orchestrator.js` 维护每个 `(teamId, member, itemId, rev)` 的唤醒追踪记录，状态流转为：`woken → running → inactive_no_progress`。
   - 当成员被唤醒（`woken`）后在 `stallNudgeDelaySeconds` 后仍处于 `inactive` 且 `state.rev` 未变化（未调用 `team_flow_report` / `team_flow_review_submit` / `team_flow_review_respond` 等推进工具），判定为沉默停滞。

2. **分级轻推与超限升级**
   - **第 1~2 次轻推（`maxStallNudges` 默认 `2`）**：突破 `alreadySentForRev` 单次锁，使用 `lib/protocol.js` 的定向轻推模板唤醒成员，明确指出**当前 item ID、应调用的工具名与必填字段**，避免模型继续空转。
   - **超限升级 Lead**：当轻推次数达到 `maxStallNudges` 仍无进度变化，停止自动轻推，向 Lead 发送 `[LEAD_ARBITRATION_REQUIRED]` 通知，附带卡死成员、停滞时长与 `team_flow_repair { action: "reopen" | "reassign" }` 一键修复建议。
   - 在 run 事件流中记录 `member/stall-nudge` 与 `member/stall-escalated`，供 Track 6 统计归因。

### Track 3（P0）· 合后集成验证门禁

1. **统一集成验证执行器（`runIntegrationVerify`）**
   - 在合入最后一个 approved item 到 `runBranch` 后、进入最终交付前（同时覆盖 `orchestrator.js` 的 `autoFinalize` 与 `tools.js` 的 `team_flow_gate { finalize: true }`），执行配置的集成验证命令：
     - 优先读取 `settings.integrationVerifyCommands`；未单独配置时可按开关回退到 `settings.gitVerifyCommands`。
   - 验证在 `runBranch`（干净检出/主工作树或专用集成 worktree）上运行，完整记录每条命令的 `command`、`exitCode` 与截断输出。

2. **失败阻断与报修闭环**
   - 任意集成验证命令退出码非 0 时：
     - 阻断 `finalize`（不进入 `FINALIZED`）；
     - 将失败结果写入 `state.integrationGate` 与事件流 `gate/integration-failed`；
     - 自动通知 Lead（附失败命令与日志摘要），由 Lead 决定 `team_flow_repair` 或创建修复项。

### Track 4（P1）· 计划静态预检与工具纠偏

1. **`team_flow_plan` 静态预检**
   - 在 `lib/tools.js` 的 `team_flow_plan` 执行前增加确定性预检：
     - 检查 `writeScopes` 格式合法性（禁止空字符串、越出仓库根路径的 `..`、明显冲突的同波次全盘通配 `*`）；
     - 检查是否存在空 `definitionOfDone` 或单 item 承载过多文件/职责的过载预警；
     - 当存在高风险改动范围但未配置任何 `gitVerifyCommands` / `integrationVerifyCommands` 时返回明确 `warnings`。

2. **高频工具结构化纠偏提示**
   - 对 `team_flow_report`、`team_flow_review_submit`、`team_flow_review_respond`、`team_flow_plan` 等高频工具的参数/状态校验错误，统一返回结构化提示：`原因 + 缺失/错误字段 + 最小可复制修正示例`，避免模型反复试错白耗轮次。

### Track 5（P1）· 场景化工具瘦身与主机防篡改验证快照

1. **5A · 场景化工具按需裁剪（`presetToolPruning`）**
   - 升级 `lib/tool-matrix.js` 的 `resolveAllowedToolNames({ role, duties, settings, preset, state })`：
     - 在 `fast-fix` 预设且无开放队列/提案/合同协作时，自动收敛 Worker 的冗余协作工具（如省略 `team_flow_decide`、`team_flow_work`、`team_flow_item`、`team_dev_contract` 等非必需工具），将 `tools.worker` 从 14,376 B 压降至 **≤ 8,500 B**；
     - 若工作项中途触发提案、交接或新增协作成员，复用现有 `index.js` 的动态工具刷新机制增量补齐所需工具；
     - 保留 `settings.presetToolPruning`（默认 `true`）与 `settings.legacyAllTools` 回退开关。

2. **5B · 汇报时主机防篡改验证快照（`hostVerified`）**
   - 在 `lib/tools.js` `team_flow_report` 中，当 `settings.hostVerifyOnReport` 开启且配置了可执行的验证命令时，由主机在 item worktree 实际执行 `gitVerify` 并生成带时间戳与 commit SHA 绑定的只读快照 `item.report.hostVerified`（包含 `ok`、`sha`、`commands`、`capturedAt`）。
   - 修改 `lib/review-policy.js` 与 `lib/protocol.js`：当审阅深度为 `light` 且 `hostVerified.ok === true` 且 SHA 与当前 HEAD 一致时，审阅提示明确告知 Reviewer **可直接采信主机验证快照，免重复跑相同慢测**（`standard / deep` 仍可按 Rubric 要求抽检或执行专项验证）。

### Track 6（P2）· 可靠性与效率归因闭环 + CI 环境解耦

1. **Run 级可靠性/效率归因指标**
   - 扩展 `lib/telemetry.js`、`lib/dashboard.js`、`client.js` 与 `renderReportMarkdown`（`report.md`），聚合展示以下指标：
     - `firstPassApproveRate`（首轮审阅通过率）
     - `stallNudges` & `stallEscalations`（沉默轻推与卡死升级次数）
     - `autoCommits`（汇报自动提交兜底次数）
     - `mergeConflicts`（Worktree 合入冲突次数）
     - `toolRejections`（工具前置拦截/参数纠偏次数）
     - `integrationGateResult`（合后集成验证结果与耗时）

2. **修复 `test/tools.integration.test.mjs` 本机路径耦合**
   - 消除对 `/Applications/DSH Desktop.app/.../@deepseek-ai/dsh-tools/lib/index.js` 的硬编码依赖，改为优先解析环境变量/可选本地包，缺失时提供轻量标准桩（stub）或清晰环境适配，确保 `node --test test/*.test.mjs` 在任意纯 Node / GitHub Actions CI 环境下 100% 全绿。

---

## 3. 新增配置开关与回滚清单（`lib/config.js`）

所有 v2.1 新特性均通过 `lib/config.js` 暴露显式开关，任意项出现异常均可单独降级回退 v2.0 行为：

| 配置项 | 类型 / 默认值 | 含义 | 回滚方式 |
|---|---|---|---|
| `lazyWorktreeProvision` | `boolean` / `true` | 仅预建已解锁波次 Worktree，Wave 1+ 等上游合入后按需基于最新 `runBranch` 懒创建 | 设为 `false` 回退全量预建 |
| `autoCommitOnReport` | `boolean` / `true` | `team_flow_report` 时检测范围内未提交改动并安全自动提交（越界仍拦截） | 设为 `false` 回退不代提交 |
| `maxStallNudges` | `number` / `2` | 同一 `rev` 成员沉默无进展时允许自动轻推的最大次数，超限升级 Lead | 设为 `0` 关闭自动轻推 |
| `stallNudgeDelaySeconds` | `number` / `45` | 唤醒后判定为沉默停滞并触发轻推的最小等待秒数 | 调大或配合 `maxStallNudges: 0` 关闭 |
| `integrationVerifyCommands` | `string[]` / `[]` | 全量合并至 `runBranch` 后、Finalize 前必须通过的集成验证命令列表 | 置空且不开启回退即跳过 |
| `hostVerifyOnReport` | `boolean` / `true` | `team_flow_report` 时由主机执行验证命令生成防篡改 `hostVerified` 快照 | 设为 `false` 仅记录自报命令 |
| `presetToolPruning` | `boolean` / `true` | 按 `preset` 与团队协作活跃度进一步精简 Worker/Reviewer 冗余工具 | 设为 `false` 回退角色全集 |

---

## 4. 分阶段 Git PR 拆分与交付计划

严格遵循**单分支单主题、本地测试与 bench 门禁全绿、远端 CI 全绿后由人工拍板合并**：

| 阶段 | 分支名 | 主题 | 主要涉及文件 | 独立验收标准 |
|---|---|---|---|---|
| **PR-0** | `docs/add-v21-reliability-efficiency-plan` | 沉淀 v2.1 路线图文档 | `docs/42-reliability-and-efficiency-v2.1-plan.md` | 文档清晰完整、CI 门禁全绿 |
| **PR-1** | `feat/worktree-lazy-provision-and-autocommit` | **Track 1**：Wave 1+ 懒建 Worktree + 范围内自动 commit + 防静默丢代码 | `lib/worktree-manager.js`, `lib/orchestrator.js`, `lib/tools.js`, `lib/config.js`, `test/worktree-engine.test.mjs` | Wave 1+ 含 Wave 0 文件；未提交改动自动 commit；越界改动拦截 |
| **PR-2** | `feat/orchestrator-stall-self-healing` | **Track 2**：沉默卡死检测、分级轻推（≤2 次）与超限升级 Lead | `lib/orchestrator.js`, `lib/protocol.js`, `lib/config.js`, `test/orchestrator.test.mjs` | 成员沉默未推进 `rev` 时自动轻推 ≤2 次，超限发仲裁通知 |
| **PR-3** | `feat/post-merge-integration-gate` | **Track 3**：`runBranch` 合后集成验证门禁（双路径一致） | `lib/orchestrator.js`, `lib/tools.js`, `lib/workflow.js`, `lib/config.js`, `test/worktree-engine.test.mjs` | 各自单测过但合后失败时 100% 阻断 finalize 并通知 Lead |
| **PR-4** | `feat/plan-preflight-and-host-verify` | **Track 4 + 5B**：计划静态预检 + 工具纠偏 + 主机 `hostVerified` 快照 | `lib/tools.js`, `lib/review-policy.js`, `lib/protocol.js`, `lib/config.js`, 对应单测 | 预检拦截明显隐患；结构化纠偏生效；`light` 审阅识别 `hostVerified` |
| **PR-5** | `perf/preset-scoped-tool-pruning` | **Track 5A**：按 preset/场景动态裁剪工具 + bench 预算门禁更新 | `lib/tool-matrix.js`, `index.js`, `bench/measure-payloads.mjs`, `test/plugin.test.mjs` | `fast-fix` 下 `tools.worker ≤ 8,500 B`；动态补齐无回归 |
| **PR-6** | `feat/reliability-telemetry-and-ci-fix` | **Track 6**：可靠性归因看板/报告指标 + 修复 `tools.integration.test.mjs` 路径依赖 | `lib/telemetry.js`, `lib/dashboard.js`, `client.js`, `lib/protocol.js`, `test/tools.integration.test.mjs` | 全套 `test/*.test.mjs` 100% 全绿；看板与报告正确渲染可靠性指标 |

---

## 5. 可客观核对的验收标准与风险防御矩阵

### 5.1 终态验收标准

1. **零静默丢代码**：新增回归测试验证「Worker 改文件未 commit 直接调用 `team_flow_report`」——范围内改动自动 commit 并产生非空 diff；越界改动被明确拒绝；绝不触发静默空合并。
2. **Wave 1+ 零基线漂移**：新增回归测试验证「Wave 0 合入 `runBranch` 后解锁 Wave 1」——Wave 1 懒创建的 Worktree 直接包含 Wave 0 产出。
3. **沉默卡死 100% 可恢复**：新增回归测试模拟「成员被唤醒后未推进 `state.rev` 退回 `inactive`」——系统自动轻推 ≤2 次，仍无进展发出 `[LEAD_ARBITRATION_REQUIRED]`。
4. **合后集成破坏 100% 拦住**：新增回归测试模拟「两独立分支各自通过但合入 `runBranch` 后集成测试失败」——`autoFinalize` 与 `team_flow_gate` 均被阻断且事件/通知给出失败输出。
5. **效率量化达标**：`node bench/measure-payloads.mjs --check` 通过，且 `fast-fix` 下 `tools.worker ≤ 8,500 B`；`node --test test/*.test.mjs` 100% 全绿（含纯 Node / GitHub Actions 环境）。
6. **全开关可回滚**：逐一关闭 7 个新增开关均能无报错回退到 v2.0 行为。

### 5.2 风险评估与防御

| 潜在风险 | 影响 | 触发场景 | 防御与缓解措施 |
|---|---|---|---|
| `autoCommitOnReport` 误提交临时构建/日志文件 | 中 | Worktree 中生成了未忽略的构建产物 | 仅提交未在 `.gitignore` 中被忽略且全部位于 `writeScopes` 内的文件；越界一律拒绝提交并报错；保留 `autoCommitOnReport: false` 开关 |
| 轻推策略对慢速但仍在思考的成员误判 | 中 | 成员异步工具耗时较长 | 仅在成员状态切实回到 `inactive` 且超过 `stallNudgeDelaySeconds` 时触发轻推；`running` 状态绝不打扰 |
| 场景化裁剪误删后续需要的协作工具 | 高 | `fast-fix` 中途发起提案或交接 | 保留 `index.js` 动态工具补齐钩子与 `presetToolPruning: false` / `legacyAllTools: true` 双重回退 |
| 集成验证命令耗时过长或未配置 | 低 | 项目未设置 `integrationVerifyCommands` | 未配置时平滑跳过或由 Lead 显式决策，设合理命令超时上限并输出清晰耗时日志 |

---

## 6. v2.1 实施结果（2026-11-23）

全部 7 个 PR（#1 ~ #7）已通过 Squash Merge 合入 `main`（`2c58f4c`）：

- **PR #1**（`160a79f`）：v2.1 规划路线图（`docs/42-reliability-and-efficiency-v2.1-plan.md`）
- **PR #2**（`2b1f73e`）：Track 1 — Wave 1+ 懒创建 Worktree（`ensureItemWorktree`）、汇报时范围内安全自动提交（`autoCommitWorktreeIfSafe`）与脏工作区拒合
- **PR #3**（`cdfe3a8`）：Track 2 — 成员沉默卡死分级轻推（`maxStallNudges: 2`）与超限升级 Lead
- **PR #4**（`0fe3288`）：Track 3 — `runBranch` 合后集成验证门禁（`runIntegrationVerify`，统一覆盖 `autoFinalize` 与 `team_flow_gate`）
- **PR #6**（`d122153`）：Track 5A — `fast-fix` 场景化工具瘦身（`presetToolPruning`）
- **PR #5**（`b39ace7`）：Track 4 + 5B — `preflightPlan` 静态预检、结构化工具纠偏、主机 `hostVerified` 防篡改实测快照与 `light` 审阅免重跑快通道
- **PR #7**（`2c58f4c`）：Track 6 — Run 级可靠性归因指标（`telemetry.js` / `dashboard.js` / `protocol.js` / `client.js`）与 `tools.integration.test.mjs` 纯 Node 环境解耦

**`main`（`2c58f4c`）合后实测验证**：
- `packages/tool-guard-kit`（`node --test test/*.test.mjs`）：**9/9** 通过
- `packages/agent-team-workflow` Payload 预算门禁（`node bench/measure-payloads.mjs --check`）：**17/17** 通过，`tools.worker.fast-fix = 7,889 B`（较常规 `14,376 B` 下降 **45.1%**，预算 `8,500 B`）、`tools.reviewer.fast-fix = 5,276 B`（较常规 `8,365 B` 下降 **36.9%**，预算 `5,500 B`）
- `packages/agent-team-workflow` 全量测试（`node --test test/*.test.mjs`，全部 21 个测试套件含 `tools.integration.test.mjs`）：**312/312** 全绿通过

---

## 7. v2.2 演进规划（已对齐，分 4 个独立 PR 落地）

| 阶段 | 分支名 | 主题 | 核心设计要点 |
|---|---|---|---|
| **v2.2-PR1** | `feat/worktree-auto-presync` | 并行 Worktree 合并前自动无冲突预同步 | `autoMergeApprovedWorktree` 在直接 squash 合入失败时，若工作区干净且无实际文本冲突，自动将最新 `runBranch` 同步进 worktree 分支后再合并，免除无谓唤醒模型手动执行 `worktree_sync`；存在真实冲突才记录错误并唤醒仲裁 |
| **v2.2-PR2** | `perf/all-preset-and-lead-schema-slimming` | 全预设与 Lead 工具 Schema 瘦身 | 将 `presetToolPruning` 扩展至 `feature` / `pr-review`（无开放队列/提案/契约时按需精简）并压缩 Lead/Worker 冗余 Schema 描述文本，压降常规 `tools.worker`（目标 ≤ 11KB）与 `tools.lead`（目标 ≤ 19KB） |
| **v2.2-PR3** | `feat/adaptive-rework-and-budget-thinking` | 返工/卡死升档 + 接近预算自动降档 | 扩展 `thinking-router.js`：成员发生返工或停滞恢复时自动提升思考档位提高一次修复率；当 Run Token 消耗达到预算 `>= 80%` 时对非阻塞协调/常规轮次自动降档保底，防预算硬熔断 |
| **v2.2-PR4** | `test/v21-full-lifecycle-simulation` | v2.1 全链路端到端仿真回归测试 | 新增单文件综合仿真用例，串联懒建 Wave 1+ Worktree、范围内自动提交、沉默卡死轻推自愈、主机 `hostVerified` 快照、合后集成门禁及可靠性归因指标全链路验证 |
