# 28 · v1.8 live 演示（重启后真实 Host）

> 对应用户「重启完成」后的验收：当前桌面已加载 **1.8.0**（日志 2026-11-03 13:03:17），
> 用独立 Host 回放并打开 v1.8 的沙箱 live run 黑板。

## 结果（run-20261103050514-3txx）

- 3 名参与者：`lead` + `probe`(role=observer, readOnly) + `rev`；1 个 item S；
- **工具沙箱（工具调用边界）真实生效**：
  - `write` → `Error: tool "write" is blocked: role "observer" is read-only`
  - `terminal_open` → `Error: tool "terminal_open" is blocked: role "observer" is read-only`
  - `bash` → 同样被拒；`read AGENTS.md` → 允许并返回真实内容；
  - `glob collab-sandbox/**` → `No files found`（拒绝无副作用）；
- 团队流程照常：claim backing task → report（evidence 记录 8 条真实结果）→ `rev approve_with_nits` → **gate pass:true → run finalized**；
- 评审给出 2 条真实 finding（拒绝以 exitCode -1 记录、覆盖度说明），显示互相审阅不是走过场。

## 证据

- 黑板：`docs/evidence/live-v18/state-final.json`；
- 看板截图：`docs/evidence/dashboard/v18-demo-board.png`（已收尾 1/1、参与者 3）；
- 门禁/评审截图：`docs/evidence/dashboard/v18-demo-gate.png`（S 已批准、评审 nit/minor finding、门禁通过）；
- 沙箱拒绝现场：`docs/evidence/dashboard/v18-sandbox-live.png`。
