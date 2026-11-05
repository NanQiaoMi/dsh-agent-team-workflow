# 32 · 自驱动状态机引擎与看门狗（v1.17.0）

> 目标：落地「DSH 真正实现 Agent Team」计划 Phase 1 —— 消除对人工或 Lead 反复步进调用的依赖，
> 通过 Host 级事件驱动引擎与后台看门狗实现任务的自动流转与闭环。

## 1. 背景与核心问题

在 v1.16 之前的版本中，团队协作虽然具备完备的状态机与沙箱规则，但推进完全依赖调用者显式驱动：
- 任务依赖解除（Unblocked）时，下游 Worker 不会被自动唤醒，必须等待 Lead 人工下发指令；
- Worker 提交交付物后，Reviewer 如果处于 `inactive` 状态，容易陷入静默等待；
- 所有工作项经评审全部批准后，系统没有自主向 Lead 发起会聚收敛通知，界面与会话陷入停滞。

这造成了用户在实际使用中感觉「Agent Team 动不起来、极易卡死」的关键断层。

## 2. 核心架构与机制 (`TeamOrchestrator`)

v1.17.0 在插件中引入了 `TeamOrchestrator`（`lib/orchestrator.js`），由两套互补机制组成：

### 2.1 工具钩子即时调解（Zero-Latency Trigger）
在 `team_flow_plan`、`team_flow_report`、`team_flow_review_submit`、`team_flow_review_respond`、`team_flow_work` 工具执行完成并提交状态变更后，立即异步调用 `orchestrator.reconcile(agent)`：

1. **就绪任务自动下发（Auto-Dispatch）**：
   - 扫描状态中处于 `pending` 或 `changes_requested` 的工作项；
   - 检查其 `blockedBy` 依赖是否已全部达到 `approved` 状态；
   - 若已就绪且指定了 `owner`，当该成员处于 `inactive` 时，自动发送带有明确写范围与检查要求的 `[AUTO_DISPATCH]` 指令唤醒执行。
2. **审阅任务自动派发（Auto-Review）**：
   - 扫描已提交报告但处于待审阅状态的工作项；
   - 若指定的 `reviewer` 处于 `inactive`，自动发送 `[AUTO_DISPATCH]` 评审指令与检查要点唤醒审阅者。
3. **团队收敛自动通知（Auto-Convergence）**：
   - 检查是否所有工作项均已获得独立评审批准；
   - 一旦全部批准且尚未进入 `converged` / `finalized` 阶段，自动由评审者向 `lead` 发送 `[TEAM_CONVERGED]` 提交通知，并流转状态至 `converged`，提示运行质量门禁与归档。

### 2.2 周期性活性看门狗（Liveness Watchdog）
为防止由于网络超时、消息丢弃或异常导致的状态机假死，Orchestrator 启动了 Host 级定时器（默认 30 秒）：
- 检查当前处于活跃生命周期的 Team Lead；
- 触发调解比对；
- 内置 30 秒冷却防抖（Cooldown），防止在成员正常思考期间产生消息风暴。

## 3. 配置契约

```yaml
- id: agent-team-workflow
  config:
    autoOrchestrate: true           # 总开关，默认 true
    autoWakeUnblocked: true         # 依赖就绪时自动唤醒 Worker
    autoWakeReviewers: true         # 报告提交时自动唤醒 Reviewer
    autoNotifyConverged: true       # 全量批准时自动通知 Lead
    watchdogIntervalSeconds: 30     # 看门狗巡检周期（秒），0 为禁用
```

## 4. 验证证据

- 单元与集成测试：`test/orchestrator.test.mjs`
  - `orchestrator is a no-op when autoOrchestrate is disabled`
  - `orchestrator wakes inactive assigned workers for unblocked tasks`
  - `orchestrator wakes reviewer when worker reports and detects convergence`
  - `orchestrator watchdog starts and stops cleanly`
- 全量回归测试：
  - `@local/dsh-tool-guard-kit`: 9/9 pass
  - `@local/dsh-agent-team-workflow`: 228/228 pass（新增 4 例，总计 237 例全绿，0 失败）。
