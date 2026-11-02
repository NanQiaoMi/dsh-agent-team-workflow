# 24 · v1.6 live 验证（并行 worktree + 能力沙箱 + 用量面板）

> 状态：**已通过**。独立 Web Host（profile 121，端口 4399，插件 1.6.0，真实模型）在一个
> scratch git 仓库 workspace（`atw-live-v16`，main 分支）上跑了一轮完整流程。

## 1. 环境

- workspace：`atw-live-v16`（`git init -b main`，baseline `e970eb9`，`.gitignore .agentteam/`）；
- 临时配置：`gitEnabled:true`、`worktreeIsolation:parallel`、`strictScopes:true`、
  `gitVerifyCommands:["printf verified"]`、`autoStaff:true`、`planFirst:false`；
- 该配置只用于 live 验证，结束后已还原。

## 2. 执行链路（全部由 Host 内的 Lead 代理真实调用工具）

1. `team_flow_plan`：两个 item A/B（owners `impl-1`/`impl-2`，`write_scopes:["src/"]`，reviewer `rev`）；
2. `team_flow_git {action:"prepare"}` → 建 run 分支 `agentteam/run-20261102160414-mrhp`；
3. `worktree_add` × 2 → 创建
   `.agentteam/worktrees/run-20261102160414-mrhp/A`（分支 `agentteam-wt/.../A`）
   与 `.../B`（分支 `agentteam-wt/.../B`）；
4. 成员分别在各自 worktree 内创建 `src/a.txt` / `src/b.txt`，并调用
   `team_flow_git {action:"commit", item_id}`（在 worktree 内执行）：
   - A: `9f5c6233da9c0a2fc87eb93c888a5cd2bdc18524`
   - B: `5fdacc10c55919579d377c1fea670990701b46eb`
   `verify`（`printf verified`）通过，`team_flow_report` 提交报告；
5. 评审通过 → `team_flow_gate {finalize:true}` → **pass:true**（gate 的 worktree 文件校验通过，且捕获真实 token 用量）；
6. `merge {item_id:"A"}` / `{item_id:"B"}` → worktree 分支分别合入 run 分支：
   `5b2bc7b`、`3d63599`；
7. 最终 `merge`（无 item_id）→ run 分支合入 `main`：`2475ddb`。

## 3. 结果验证（真实命令）

- `git worktree list`：主仓 + A + B 三个工作树，分支分别对应，互不干扰（`docs/evidence/live-v16/worktrees.txt`）；
- `git log --oneline main`：`2475ddb` final merge、`3d63599`/`5b2bc7b` 两个 worktree merge、两个 item commit、baseline；
- `git show main:src/a.txt` → `a`；`git show main:src/b.txt` → `b`（`main-files.txt`）；
- 看板用量面板显示真实 token（lead/impl-2/rev + 合计），采集时间 `00:06:13`（截图 `v16-usage-panel-live.png`）；
- 成员抽屉对话区可展开单条长消息（截图 `v16-transcript-expand-live.png`）。

## 4. 证据

- 完整黑板：`docs/evidence/live-v16/state-final.json`（含 item.git.worktree/worktreeBranch/worktreeMergedAt、gate、usage）；
- 看板截图：`v16-usage-panel-live.png`、`v16-transcript-expand-live.png`；
- 仓库日志/文件/工作树：`docs/evidence/live-v16/{main-log.txt,main-files.txt,worktrees.txt}`。

## 5. 诚实边界

- 本轮未单独演示 `serial` 拒绝与"gate 捕获缺失 worktree 文件"的 live 失败路径——两者由离线测试覆盖
  （`test/tools.integration.test.mjs` 的 serial guard 与 missing-file gate 用例）；
- 本轮未演示 `roles.readOnly/allow` 的 live 拒绝：这是纯工具入口校验，离线用例已覆盖，且 live 演示需要
  额外的角色配置轮次；
- 成员进程 cwd 仍由平台固定在 Lead 的 workspace（见 docs/23 §2.1）：隔离由 worktree 路径 + 分支 + 门禁共同保证。
