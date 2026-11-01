# 13 · 对等协作 live run（待执行）

> 状态：**等待 DSH 重启后执行**（v2 的 Host 模块代与 12 个工具需要重启才加载）。
>
> 计划验证的协作行为（全部由成员之间直接完成，不经 Lead 中转）：
> 1. Lead `team_flow_plan` 发布 1 个委派项 + 2 个 `assignment:"open"` 开放项，并生成认领池简报；
> 2. 两名 peer 各自 `team_flow_work {action:"claim"}` 抢单（看板「待认领」lane 清空、卡片出现认领徽章）；
> 3. 依赖方用 `team_flow_talk {kind:"question"}` 直接问对方接口契约，对方 `kind:"answer"` 回复（频道出现双向对话）；
> 4. 某一方对 DoD 有异议 → `team_flow_decide {action:"propose", kind:"dod"}`，受影响 peer 投票通过，DoD 自动追加；
> 5. 完成者 `request_review` 邀请同伴 → 同伴 `take_review` → verdict；期间双方在频道讨论 finding；
> 6. 一个做不完的项走 `handoff_offer` → 同伴 `handoff_accept`，所有权与共享任务同时转移；
> 7. Lead `team_flow_gate {finalize:true}` 收敛；看板全程 1–2 秒内反映状态。
>
> 证据将包含：`.agentteam/teams/<id>/state.json` 的 channel/proposals/handoffs 片段、看板截图、
> snapshot 响应摘要。执行后替换本节。
