# 38 - Multi-Worktree Cross-Sync, Conflict Healing & Escalation Arbitration (v1.23.0)

> **Version**: v1.23.0  
> **Date**: 2026-11-05  
> **Status**: Verified & Integrated

---

## 1. 目标与背景

在多智能体（Multi-Agent）高并发工作树隔离（Worktree Isolation）架构中，各个 Worker 拥有各自物理隔离的目录分支。随着项目演进，出现两个关键协同场景：
1. **多工作树交叉同步**：并行 Worker 需要从团队主运行分支（`run branch`）拉取其他已合并成员提交的最新代码，而无需离开自身的工作树目录或手动 checkout。
2. **冲突诊断与自愈**：当并发修改产生冲突时，自动化合并机制不能直接丢弃代码或破坏现场，必须进行冲突诊断、状态记录、警报通知与安全回滚；随后支持 Worker 在工作树内执行合流、人工/自动化消解并重新提交。
3. **升级仲裁看门狗（Escalation Watchdog）**：当任务因超出重做轮次或遇到无法解决的阻塞进入 `ITEM_STATUS.ESCALATED` 时，协调器主动唤醒 Team Lead 介入裁决，防止协作死锁。

---

## 2. 核心设计与实现

### 2.1 底层 Git 同步原语：`gitWorktreeSync` (`lib/git.js`)
- **零外部依赖与总量原则（Total function）**：不抛异常、不产生未捕获 Promise rejection，所有错误统一包裹为 `{ ok: false, error }`。
- **安全检查**：防注入验证 `safeRefName(fromBranch)`，禁止向自身同步。
- **冲突检测与安全隔离**：
  - 自动检测并提取未合并冲突文件列表（`diff-filter=U`）。
  - 支持 `abortOnConflict: boolean`。当指定中止时立即安全回滚（`git merge --abort`），保证工作树绝对干净；若未指定中止，则保留冲突标记留给 Worker 在工作树内消解并提交。
- **MERGE_HEAD 适配**：在 `gitCommit` 中识别 `MERGE_HEAD`，当冲突解决完成合并提交时兼容 Git 对合并期间禁止 pathspec 限制的机制。
- **Squash Merge 中止强化**：针对 Git Squash Merge 不生成 `MERGE_HEAD` 导致 `git merge --abort` 报错的问题，采用 `git checkout HEAD -- .` 确保主仓库索引和工作目录彻底恢复干净。

### 2.2 工作树管理器冲突状态与自愈：`autoMergeApprovedWorktree` (`lib/worktree-manager.js`)
- 当评审通过的工作树分支在 squash merge 到 `runBranch` 发生冲突时：
  - 自动将错误信息记录至任务黑板 `item.git.worktreeMergeError = merged.error`。
  - 记录事件流 `git/worktree-merge-conflict`。
  - 阻断后续全自动归档（`allApprovedAndMerged` 检查），防止有冲突未合入的代码被意外封包。
- 当冲突被消解并合并成功后，自动清空 `worktreeMergeError: null`，标记 `worktreeMergedAt`。

### 2.3 工具集扩展：`team_flow_git { action: "worktree_sync" }` (`lib/tools.js`)
- Worker 或 Lead 可随时在其工作树内调用：
  ```json
  {
    "action": "worktree_sync",
    "item_id": "T1",
    "abort_on_conflict": false
  }
  ```
- 返回同步结果：
  ```json
  {
    "action": "worktree_sync",
    "item_id": "T1",
    "merged": false,
    "up_to_date": false,
    "conflict": true,
    "conflicted_files": ["shared.txt"],
    "warnings": ["Merge conflict detected with agentteam/run-... in files: shared.txt"]
  }
  ```

### 2.4 自治调度器监控与报警：`orchestrator.js`
1. **冲突主动告警**：定期扫描发现已批准但存在 `worktreeMergeError` 的任务，立即向 Lead 和对应 Worker 推送告警：
   `[AUTO_DISPATCH] Task T1 "..." is APPROVED but encountered a merge conflict during auto-merge...`
   引导 Worker 执行 `worktree_sync` 进行合流解决。
2. **仲裁看门狗唤醒**：扫描 `ITEM_STATUS.ESCALATED` 任务，主动向 Team Lead 发送仲裁请求：
   `[LEAD_ARBITRATION_REQUIRED] Task T1 is ESCALATED (after N review rounds)...`
   防止任务停滞。

### 2.5 透明看板集成：`dashboard.js` & `client.js`
- **黑板快照增强**：`buildItemGit` 暴露 `worktreeMergeError`。
- **状态徽章**：若存在冲突，卡片上由正常的 `✓ 已合入 / ⎇ 物理隔离` 切换为明显的警示徽章：`⚠ 合入冲突` (`atw-badge--error`)，鼠标悬浮显示冲突详情。
- **抽屉诊断明细**：在 Git 抽屉面板中显示「合入冲突」诊断行。
- **国际化（i18n）**：中英文字典严格保持 100% 对齐。

---

## 3. 验证矩阵

| 验证项 | 测试文件 | 结果 |
|---|---|---|
| Git 合约与同步/冲突原语 | `test/git.test.mjs` | 26/26 PASS |
| 看板契约与双语字典 | `test/client.contract.test.mjs` | 41/41 PASS |
| 工作树冲突自愈与生命周期 | `test/worktree-engine.test.mjs` | 5/5 PASS |
| 仲裁唤醒与冲突通知调度 | `test/orchestrator.test.mjs` | 8/8 PASS |
| 看板快照与阶段流转 | `test/dashboard.test.mjs` | 34/34 PASS |
| 全模块测试套件 | 全部 16 个测试套件 | 250/250 PASS (100%) |
