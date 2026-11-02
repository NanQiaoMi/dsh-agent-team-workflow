# 19 · v1.4 新增能力契约（Wave 1）

> 实现 docs/18 的 Wave 1 + 部分 Wave 2。状态：**已实现（插件 1.4.0，离线 193/193）**。所有新能力默认关闭、向后兼容。
> 配置项见 `lib/config.js` / `cordis.patch.yml`；快照/路由契约见本文。

## 1. 角色与模型映射（P0-1）

配置：
```yaml
freshProvider: spawn
forkProvider: fork
roles:
  security-reviewer:
    provider: review-fast          # DSH provider 名：模型由该 provider 配置决定
    prompt: You focus on auth and injection risks.
```
- `team_flow_plan` 的 `workers` 支持 `["impl"]` 或 `[{name:"impl", role:"security-reviewer"}]`；
- spawn 时 `provider = roles[role].provider ?? freshProvider`；成员简报末尾追加 `# Role: <role>\n<roles[role].prompt>`；
- owner 的 role 取 `item.role`；reviewer 的 role 取 plan 的 workers 角色或 `roles.reviewer`；
- 运行态 `state.roleAssignments: {member: role}` 记录显式 worker 角色；快照/状态透出 `item.role`。

## 2. 优雅关闭（P0-4）

引擎：`state.stops[]`、`state.stopSeq`；`STOP_STATUS: pending|accepted|rejected|interrupted`。
```jsonc
team_flow_stop { "action": "request" | "accept" | "reject" | "interrupt" | "status",
                 "member": "impl", "reason": "…" }
```
- Lead：`request`（graceful，成员可接受/拒绝）、`interrupt`（native 中断并记录 interrupted）、`status`；
- 成员：`accept` / `reject`（只处理发给自己的 pending 记录）；
- 快照 `run.collaboration.stops[]`：`{id, at, by, target, mode, status, reason, decidedAt}`（≤16）。

## 3. 生命周期 hooks（P0-3）

```yaml
hooks:
  taskCreated:   [{ command: ".agentteam/hooks/check-scope.sh", timeoutMs: 30000 }]
  taskCompleted: [{ command: "pnpm -s test" }]
  teammateIdle:  [{ command: ".agentteam/hooks/idle-check.sh" }]
```
- 事件 JSON 从 stdin 传入：`{event, item?, objective?, verdict?, reviewer?, member?}`；
- **退出码 2 = 阻断**：taskCreated 阻止建项/计划、taskCompleted 阻止 approve、teammateIdle 阻止 accept stop；
- 其它非零退出只记录不阻断；超时默认 60s（≤600s）；
- 触发点：`team_flow_plan`（每 item 建前）、`team_flow_item`、`team_flow_review_submit`（approve 前）、`team_flow_stop accept`。

## 4. Plan-first（P0-2）

```yaml
planFirst: false          # 或 plan 时 item.planFirst: true
autoApprovePlan: true     # 官方"Lead 未审则自动批准"语义
planApprover: lead        # lead | peer（peer = item 的第一个 reviewer）
```
- `item.plan = {steps[], files[], risks[], submittedAt, submittedBy, status: pending|approved|rejected, decidedAt, decidedBy, reason}`；
- 工具：`team_flow_plan_approval {action:"submit"|"approve"|"reject"|"status", item_id, plan?}`；
- 未批准 → `team_flow_report` 拒绝（`WORKFLOW_PLAN_REQUIRED`）、gate 失败、next_actions 提示；
- `autoApprovePlan: true` 时提交即 approved（`decidedBy:"auto"`），仍保留完整计划记录。

## 5. 成员面板（P0-5）

### 5.1 路由 `GET|POST /api/agent-team-workflow.member`

GET `?session=<leadSessionId>&name=<member>`（`session` 必须可解析为 live agent）：
```jsonc
{ "ok": true, "sessionId": "...", "member": { "name": "impl", "role": "implementer",
    "status": "inactive", "context": "fresh", "currentItems": [{ "id": "W1", "subject": "…", "status": "in_review" }],
    "recentActivity": [{ "at": "ISO", "type": "report/submitted", "detail": "W1" }],   // ≤12
    "channel": [{ "id": "m12", "at": "ISO", "from": "impl", "kind": "answer", "text": "…" }], // 与该成员相关 ≤12
    "stop": { "id": "stop1", "status": "pending" } | null,
    "plan": { "itemId": "W1", "status": "pending" } | null,
    "roleDefinition": { "provider": "review-fast", "prompt": "…" } | null } }
```
POST（JSON `{name, message}`，`message` 1–4000 字符）：以当前 Lead 会话身份 `ctx.agentTeams.sendMessage` 投递，返回
`{ "ok": true, "delivered": true, "member": "impl" }`；未知成员/非 team 成员/空消息 → 400/404。

### 5.2 客户端
- 点拓扑节点或成员行打开「成员」抽屉：状态、当前 items、最近活动、角色、计划/停止状态；
- 抽屉内输入框「发消息」→ POST；成功后 toast/提示并刷新；
- 流程图卡片新增「计划待批/计划已批/计划被拒」小徽章（仅 plan 存在时）；抽屉显示 plan steps/files/risks；
- 停止请求：抽屉显示 pending stop 与「接受/拒绝」按钮（仅被请求成员本会话可操作？Web 侧无成员身份，先只读展示，操作留给 CLI 成员）。

## 6. Wave 2 增量（同版本实现）

### 6.1 角色限制工作流工具（P1-1）
`roles.<name>.deny: ["team_flow_report", "team_flow_git:commit"]`：命中时工具直接拒绝，错误信息说明角色与配置位置。成员角色来自 `state.roleAssignments[member]`，缺省回退到其所有 item 的唯一 role。**这是工作流级限制，不是文件系统沙箱**；DSH 仍负责会话的真实权限。

### 6.2 串行 worktree 隔离（P1-2，实验性）
```yaml
gitEnabled: true
worktreeIsolation: true
```
`team_flow_git {action:"worktree_add"|"worktree_remove"|"worktree_list", item_id}`：
- 在 `.agentteam/worktrees/<itemId>` 创建带独立分支的工作树（`git worktree add -b agentteam-wt/<run>/<id>`），记录 `item.git.worktree/worktreeBranch`；
- 因 DSH 成员共享 cwd，**同一时刻只应有一个 item 使用 worktree**（Lead 串行化）；工具只做创建/移除/列出，不切换成员 cwd；
- 移除不带 `--force`（脏工作树会被 git 拒绝，需先提交）；已有 3 个 lib/git 测试（真实临时仓库）+ 安全断言（无 force/amend/rebase）。

### 6.3 成本/token 可观测与预算（P1-3）
- 通过可选 seam `ctx.sessionProjections.stateOf(agent.session,"tokenUsage")` 读取各成员 token 总量；Host 未提供该服务时显示"未采集"而不是假数据；
- `team_flow_gate` 快照 `state.usage`（`{capturedAt, members:{name:{uncachedInputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}, totals}`），并在 `tokenBudgetPerMember` / `tokenBudgetPerRun` > 0 时把超预算写为 gate failure；
- 快照 `run.usage` 透出，看板/状态可用；不含货币换算（价格随部署变化，不硬编码）。

### 6.4 跨 session 消息（P1-4，调研结论：平台不支持）
核查 DSH 本 build：`dsh-tool-session-query` 只提供历史检索（只读），`sendMessage` 仅接受同 Team 成员；**没有 cross-session 投递原语**。因此不实现假功能，替代路径：
- 同 Team 的 durable 成员可随时消息（已有）；
- 用户可在任意 session 内让 Lead 转发内容（人工跨 session 桥）；
- 若后续 DSH 增加 session 消息 seam，插件按 `team_flow_talk {target:"session:<id>"}` 扩展。

## 7. 版本与验收

- 插件版本 **1.4.0**；**17 个工具**（新增 `team_flow_stop`、`team_flow_plan_approval`；`team_flow_git` 增加 worktree 动作）；
- 离线测试 **193/193**：hooks 4、stop 2、plan 5、角色 2、token 预算 1、worktree 3、member 路由 4、客户端 30、dashboard 33、git 25、engine/collab/tools 其余；
- 两项新路由（snapshot + member），均 GET/POST 校验、no-store；
- 每项默认关闭（roles/hooks/planFirst/git/worktree/token 预算都需显式配置），旧行为不变。
