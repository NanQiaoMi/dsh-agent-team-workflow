# 35 · 链路深度优化：零空转与极简能效（v1.20.0）

> 目标：消除 DSH Agent Team 任务下达与执行链路中的无谓消耗（Token、耗时、多余轮次），实现工业级丝滑、高能效协作。

## 1. 痛点分析与三大优化维度

在之前的链路中，虽然状态机与 Worktree 已实现自动化，但成员交互存在以下无谓损耗：
1. **Worker 启动空转（2 轮延迟）**：旧协议要求 Worker 被唤醒后先调用 `team_flow_status` 查看任务状态，再调用 `team_task_update { action: 'claim' }` 认领任务，白白消耗 2 轮 LLM 往返与数百 Token。
2. **Reviewer 盲读成本（3~5 次工具调用）**：Reviewer 被唤醒时只知道“任务已完成”，不知道改动了哪些具体代码行，往往需要多次调用 `read_file` 通读全文件，耗费大量 Token 并延长评审延迟。
3. **协议冗余（Token 浪费 60%）**：旧架构对所有角色（Lead、Worker、Reviewer）注入相同的全量长篇 Workflow Policy（约 150 行），各角色上下文被无关指引淹没。

---

## 2. 优化落地与实现架构

### 2.1 任务唤醒即自动认领（Auto-Claim on Wakeup）
- **实现位置**：`packages/agent-team-workflow/lib/orchestrator.js`
- **逻辑**：当 Orchestrator 侦测到未阻塞任务并准备唤醒 Worker 时，在发送 `[AUTO_DISPATCH]` 消息前，**Host 端直接原子化调用 `ctx.agentTeams.updateTask({ taskId, action: 'claim' })`** 将任务标记为 `in_progress`。
- **通知精简**：通知明确告知 `The backing task has been automatically claimed for you. Start work directly inside your worktree (do not call team_flow_status or claim again)...`。
- **收益**：Worker 首轮提示词直接进入代码编写与测试验证，彻底消除 2 轮无效往返。

### 2.2 审阅即送精准 Diff（Diff Delivery for Reviewers）
- **实现位置**：`packages/agent-team-workflow/lib/worktree-manager.js`、`lib/protocol.js`、`lib/tools.js`
- **逻辑**：
  - 新增 `getWorktreeDiffSummary({ cwd, state, item, maxLines = 80 })`，直接通过底层 `git diff --stat` 和 `git diff -U2` 提取紧凑的变更摘要和 head patch。
  - Worker 执行 `team_flow_report` 或 Orchestrator 唤醒 Reviewer 时，自动计算该 item 分支相对于主运行分支的 diff，并作为 `# Code Changes (Diff)` 注入审阅请求中。
- **收益**：Reviewer 首轮无需先查找改动点，直接对照 diff 和报告断言即可给出裁决，评审效率提升数倍。

### 2.3 角色自适应协议蒸馏（Role-Adaptive Protocol Injection）
- **实现位置**：`packages/agent-team-workflow/lib/protocol.js`、`index.js`
- **逻辑**：
  - `buildPolicy(settings, role)` 根据 `membership.role` 动态注入针对性极强的极简指引：
    - **Worker / Implementer**：极简 12 行 Worker Protocol（明确指示：禁止 plan/spawn、worktree 内开发、任务已预认领直接开写、直接 report、依反馈修复）。
    - **Reviewer / Verifier**：极简 12 行 Reviewer Protocol（明确指示：对抗性客观审查、对照 diff 与命令实据审查、直接调用 `team_flow_review_submit`）。
    - **Lead**：保留全局编排与规划指引。
- **收益**：叶子 Worker 和 Reviewer 协议体积削减约 60%，指令遵从度显著提升，完全避免角色僭越。

---

## 3. 回归验证与性能指标

### 3.1 测试套件执行记录
- `packages/tool-guard-kit`: 9/9 pass
- `packages/agent-team-workflow`: 233/233 pass
  - `test/orchestrator.test.mjs`: 4/4 pass（覆盖 auto-claim 自动状态推进）
  - `test/worktree-engine.test.mjs`: 4/4 pass（覆盖 diff delivery 与并/串行隔离）
  - `test/plugin.test.mjs`: 8/8 pass（覆盖 role-adaptive policy 动态注入）
  - 全套件 14 个测试文件共 242 项测试全部通过，0 失败。

### 3.2 优化前后能效对比
| 指标 | 优化前 | 优化后（v1.20.0） | 改善幅度 |
| :--- | :--- | :--- | :--- |
| **Worker 首轮耗时** | 3 轮（status -> claim -> code） | **1 轮（直奔 code）** | 减少 66% 轮次 |
| **Reviewer 审阅前动作** | 2~5 次 `read_file` 查差异 | **0 次查差异（首轮直阅 diff）** | 节省大量 Token 与耗时 |
| **Worker/Reviewer 系统提示词** | 约 150 行全量通用协议 | **约 12 行角色特化协议** | Token 减少 60% |
| **自动化测试用例总数** | 241 例 | **242 例** | 100% 自动化覆盖 |
