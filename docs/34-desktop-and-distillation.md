# 34 · 桌面集成与模型协议蒸馏（v1.19.0）

> 目标：落地「DSH 真正实现 Agent Team」计划 Phase 3 与 Phase 4 ——
> 1. 解除桌面端禁用列表（`desktopDeselectedBundles`），激活实时协作流看板；
> 2. 针对 DeepSeek-V3 / R1 核心模型蒸馏与精简协议，强化独立评审者的隔离目录知悉能力。

## 1. 桌面端集成闭环（Phase 3）

在 DSH 用户 Profile（`~/.dsh/profiles/121/package.json`）中：
- 移除了 `desktopDeselectedBundles` 中的 `@local/dsh-agent-team-workflow`，确保 DSH Desktop 启动时默认加载并挂载该工作流插件包；
- 依赖项通过 `link:` 软链直连工作区源码（`packages/agent-team-workflow`），保证插件无需反复打包重新安装，本地即时生效；
- 在 `cordis.patch.yml` 中默认激活：
  - `autoOrchestrate: true`（自驱动状态机引擎）
  - `worktreeIsolation: parallel`（物理 Worktree 并发隔离）
  - `autoWorktree: true`（规划即分配）
  - `autoMergeWorktree: true`（批准即合并）
  - `autoCleanupWorktrees: true`（终审即清理）
  - `gitEnabled: true`

## 2. DeepSeek 模型协议蒸馏（Phase 4）

针对 DeepSeek-V3 及 R1 推理模型的交互特征进行协议精简（Protocol Distillation）：

### 2.1 审查者隔离目录透传
在 Worktree 物理隔离场景下，实现代码位于专属工作树（`.agentteam/worktrees/<runId>/<itemId>`），未合并前主目录无文件。
为杜绝 Reviewer 误判「文件不存在」：
- 在 `renderReviewerBrief` 中，审查范围条目自动附带 `; worktree: <path>`；
- 在审阅指引步骤 2 明确标注：`read the actual files (in the item's worktree if worktree isolation is active)`；
- 在 `reviewRequestMessage` 自动注入 `Worktree path: <path>`；
- Orchestrator 唤醒 Reviewer 的 `[AUTO_DISPATCH]` 消息自动附带专属 Worktree 路径。

### 2.2 事件驱动唤醒消歧
- `[AUTO_DISPATCH]` 消息采用结构化方括号前缀，明确指示当前任务、关联的工作树物理路径和声明写范围；
- 模型无需人工在控制台发送指令，接收系统分发通知后即可立即领取并执行。

## 3. 全套件回归验证证据

- `@local/dsh-tool-guard-kit`: 9/9 pass
- `@local/dsh-agent-team-workflow`: 232/232 pass
- 总计 241/241 测试全部通过，0 失败。
