# 17 · 团队自建 / PR 流程 live run（待执行）

> 状态：**等待 DSH 重启**（v1.3.0 的 15 个工具、autoStaff 与看板降噪需要新的 Host/Client 模块代）。

计划验证：
1. Lead 只发 mission，`team_flow_plan` **自动 spawn/wake** 出所需成员（记录 staffed.spawned/woken）；
2. 开放队列抢单 + 成员用 `team_flow_item` 自建一个计划外项；
3. 真实 `handoff`：owner 把未报告项交接给同伴并完成；
4. `timeout_minutes:1` 的提案在有人不投票时到期，惰性自动裁决（记录 autoResolved）；
5. 在一个 **scratch git 仓库 + bare remote** 上走标准 PR 流程：prepare → commit → verify → push → pr（gh 未认证时 manual）→ 交叉评审 → gate → Lead merge；
6. 看板截图：拓扑降噪（参与者/空闲折叠、peer 边收敛）、Git/PR 徽章、自建徽章、提案截止/超时徽章。

执行后替换本节。
