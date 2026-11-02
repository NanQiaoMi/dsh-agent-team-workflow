# 24 · v1.6 live 验证（并行 worktree + 能力沙箱 + 用量面板）

> 状态：待执行。

计划：
1. 新建 scratch git 仓库 workspace（main + baseline + `.gitignore .agentteam/`）；
2. 临时启用 `gitEnabled/worktreeIsolation: parallel/strictScopes`，独立 Host 跑一轮：Lead plan 2 项 → worktree_add ×2 → 成员在各自 worktree 实现/commit/verify/report → 评审 → gate → 逐项 merge 进 run 分支 → 最终 merge 到 main；
3. 验证文件/分支合入、worktree 清理、看板用量面板与对话展开截图；
4. 记录命令、退出码、证据路径。
