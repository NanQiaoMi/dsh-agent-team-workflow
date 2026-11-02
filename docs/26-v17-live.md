# 26 · v1.7 原生工具沙箱 live 验证

> 状态：**已通过（两轮）**。独立 Web Host（profile 121，端口 4399，真实模型）在默认 workspace 新建会话，
> 配置 `roles.observer.readOnly: true`，让角色为 observer 的 teammate `probe` 直接尝试被禁工具。

## 1. 第一轮（1.7.0）：发现两个真实缺陷

- ✅ 沙箱生效：`write` / `edit` / `bash` 均被拒绝，错误原文：
  `Error: tool "write" is blocked by the Agent Team tool sandbox: role "observer" is read-only (roles.observer.readOnly)`；
- ❌ **缺陷 A**：`readOnly` 把 `team_flow_report` 也禁了 → owner 无法交付报告，流程断链
  （Lead 按纪律记 blocker `esc-1` 并如实 gate fail）；
- ❌ **缺陷 B**：`terminal_*` 系列未被拦截（只精确匹配了 `terminal`）；
- 未产生任何文件写入（随后 `ls -d collab-sandbox` 退出码 1，目录不存在）。

## 2. 修正（1.7.1）

- readOnly 只禁"变更型 workflow 工具"，**report / review_submit / review_respond / talk / escalate 放行**；
- `isNativeMutatingTool` 把 `terminal_*`、`str_replace_*` 前缀一并视为 mutating。

## 3. 第二轮（1.7.1）：通过

同一场景重跑（新 run `run-20261102172215-k5s6`，item S，owner `probe`，role `observer`）：

- `write` → 拒绝；
- `edit` → 拒绝；
- `bash` → 拒绝；
- `terminal_open` / `terminal_list` → 拒绝（同一句原文，前缀修复生效）；
- `read AGENTS.md` → **允许**，真实返回前 5 行内容；
- `glob "collab-sandbox/**"` → `No files found`（拒绝无副作用）；
- `team_task_update claim task-1` → 成功（board 写 ≠ 文件写，符合 readOnly 语义）；
- `team_flow_report` → **成功**（修复 A 生效），报告 evidence 里记录了上述 8 条真实结果；
- 评审 `rev approve_with_nits` → gate **pass:true** → run **finalized**，item approved。

## 4. 证据

- 完整黑板（含 report.evidence 的拒绝原文）：`docs/evidence/live-v17/state-final.json`；
- 看板截图：`docs/evidence/dashboard/v17-sandbox-denial-live.png`
  （左：频道里 probe 的回答与拒绝原文；右：成员抽屉显示 `sandbox probe` 已批准 / observer 角色 / 对话区读取记录）。

## 5. 边界

- guard 在**工具调用边界**生效（被拒工具不执行），不是 OS 级沙箱；被放行的 `bash`/`terminal_*` 内部行为仍受
  DSH 会话权限策略约束——本轮 readOnly 已把二者一并禁用；
- 本轮只验证 `readOnly` 路径；`allow` / `deny` 精确匹配由离线测试覆盖；
- 未演示"缓存未预热 fail-open"路径（设计为放行，测试覆盖）。
