# 33 · 物理 Worktree 自动化隔离体系（v1.18.0）

> 目标：落地「DSH 真正实现 Agent Team」计划 Phase 2 —— 彻底解决同 Host 多 Agent 共享物理工作目录并发写污染问题，
> 实现全自动 Worktree 供给、独立分支关联、单项批准自动合并与收敛清理。

## 1. 背景与核心问题

在单机环境（DSH Host 节点）运行多 Agent 协作时，所有 Worker 默认共享物理 `cwd`：
- 多 Worker 并发执行写任务时，极易产生未隔离的并发脏写、文件覆盖与竞态冲突；
- 过去需要 Team Lead 繁琐地手工调用 `team_flow_git worktree_add`、手动在各 worktree 之间切换和合并；
- LLM 经常遗漏 worktree 路径，导致写操作依然发生在主工作区。

## 2. 自动化架构与机制 (`WorktreeManager`)

v1.18.0 引入了全自动化的物理工作区隔离引擎（`lib/worktree-manager.js`）：

```
┌─────────────────────────────────────────────────────────────┐
│                      Team Lead / Plan                       │
│              team_flow_plan / team_flow_item                │
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
┌───────────────────────┐             ┌───────────────────────┐
│ Worktree for Worker 1 │             │ Worktree for Worker 2 │
│ .agentteam/worktrees/ │             │ .agentteam/worktrees/ │
│   <runId>/<item1>     │             │   <runId>/<item2>     │
│  branch: wt/<run>/<1> │             │  branch: wt/<run>/<2> │
└───────────┬───────────┘             └───────────┬───────────┘
            │                                     │
            │  Worker 完成并在 worktree 提交      │
            │  Reviewer 批准 (review_submit)      │
            ▼                                     ▼
┌─────────────────────────────────────────────────────────────┐
│                Auto-Merge (Squash Merge)                    │
│      自动将该 item 的 worktree 分支合入 team 运行主分支     │
│                 (state.git.branch)                          │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               │  全队收敛通过质量门禁
                               │  team_flow_gate { finalize: true }
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Auto-Cleanup Worktrees                      │
│             安全自动清理所有临时 worktree 物理目录          │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 规划期自动供给 (`autoProvisionWorktrees`)
- 在 Lead 执行 `team_flow_plan` 或 `team_flow_item` 时自动触发；
- 若当前配置 `worktreeIsolation: 'parallel'` 或 `'serial'` 且 `gitEnabled: true`：
  - 自动确保 run 分支存在（默认 `agentteam/<runId>`）；
  - 自动为每个工作项在 `.agentteam/worktrees/<runId>/<itemId>` 创建专属 worktree，并检出到独立分支 `agentteam-wt/<runId>/<itemId>`；
  - 自动将 `.agentteam/` 注入本地 `.git/info/exclude`，确保不会污染主仓库的 Git 状态；
  - 将 `worktreePath` 与 `worktreeBranch` 自动挂载至工作项的 `item.git` 元数据中。

### 2.2 派发提示词无缝融合
- Orchestrator 唤醒与派发时，消息自动附带：`Worktree: <worktreePath>`；
- Worker Brief 自动包含 `worktreeLine`，明确告知模型将所有改动限制在该 worktree 内，彻底杜绝主目录脏写。

### 2.3 审阅批准即时自动合并 (`autoMergeApprovedWorktree`)
- 当 Reviewer 调用 `team_flow_review_submit` 给出 `approve` 裁决时；
- 引擎自动将该工作项的 worktree 分支通过 squash-merge 方式合入 team run 分支；
- 记录 `worktreeMergedAt`，并沉淀审计日志 `git/worktree-merged`；
- 在 `serial` 模式下，前序工作项合并后，自动为下一个处于等待队列的工作项供给 worktree。

### 2.4 终审收敛自动清理 (`autoCleanupRunWorktrees`)
- 当全队工作完成并通过 `team_flow_gate { finalize: true }` 最终归档时；
- 自动调用 `git worktree remove` 清理所有临时工作树，释放磁盘与分支绑定；
- 标记 `worktreeRemovedAt` 与 `git/worktrees-cleaned` 事件。

### 2.5 幂等与向后兼容
- `worktreeIsolation: 'off'` 场景下自动跳过所有操作，零额外开销与副作用；
- 手动调用 `team_flow_git worktree_add`、`merge`、`worktree_remove` 具备完全幂等性，已自动处理的项直接返回成功，绝不报错。

## 3. 配置项说明

```yaml
- id: agent-team-workflow
  config:
    worktreeIsolation: parallel      # 'off' | 'serial' | 'parallel'，并发推荐 parallel
    autoWorktree: true               # 规划时自动供给 worktree（默认 true）
    autoMergeWorktree: true          # 审阅批准时自动合并到运行分支（默认 true）
    autoCleanupWorktrees: true       # 运行终审归档时自动清理（默认 true）
```

## 4. 验证测试套件

- `test/worktree-engine.test.mjs`:
  - `autoProvisionWorktrees automatically sets up parallel worktrees on plan`
  - `autoMergeApprovedWorktree squash-merges approved worktree changes and cleans up on finalize`
  - `serial worktree isolation provisions only one active worktree at a time`
  - `worktreeIsolation off skips all worktree creation cleanly`
- `test/tools.integration.test.mjs`:
  - 覆盖并发与串行完整生命周期，37/37 通过。
