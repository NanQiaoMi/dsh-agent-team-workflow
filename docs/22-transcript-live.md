# 22 · 成员对话视图 live 验证（v1.5）

> 状态：**已通过**。独立 Web Host（profile 121，端口 4399，插件 1.5.0）中打开历史 live run 会话
> `session-76536de2-…`，读取 teammate `impl-alpha` 的真实会话日志。

## 1. Host 侧（member route）

```
GET /api/agent-team-workflow.member?session=session-76536de2-…&name=impl-alpha
→ 200, member.transcript = {
    available: true,
    messages: [ … 40 条 … ],
    truncated: true,
    totalEvents: 256,
    error: null
  }
```

真实内容示例（经 `lib/transcript.js` 投影）：

- `assistant`：#153 `[tool] team_flow_status "{}"`；
- `tool`：#155 返回的 workflow 状态 JSON（`run_id/phase/objective/acceptance_criteria…`）；
- `assistant`：#158 “Plan is pending Lead approval; the board says wait. I'll wait for the Lead's decision.” + `[tool] team_flow_status`；
- 其余为 `wait_agent`、`list_agents` 等工具轨迹与模型文字。

证明：**v1.5 能读取真实 teammate 的完整会话尾部 40 条并区分 user/assistant/system/tool**；`totalEvents=256`、`truncated=true` 与契约一致。

## 2. 客户端（成员抽屉「对话」区）

看板 → 点拓扑节点 `impl-alpha` → 抽屉：

- 「停止状态」显示 `已中断 interrupt demo`（v1.4 live 留下的记录）；
- 「对话 · 仅显示最近 40 条」区渲染角色徽章（助手/工具）+ `#seq` + 正文（clamp 3 行），真实展示上述工具调用与模型文字；
- 截图：`docs/evidence/dashboard/v15-member-transcript-live.png`。

## 3. 边界

- 只读：路由只读会话日志，不写入；Host 未暴露 `sessionQuery` 时返回 `available:false` 并降级（离线测试覆盖）；
- 授权：仅同 Team 成员可查（先 `tryMembership` + roster 校验）；
- 会话格式升级时投影会少显示而不是崩溃（`test/transcript.test.mjs` 的畸形事件用例）。
