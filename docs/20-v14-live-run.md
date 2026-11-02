# 20 · v1.4 live run

> Run 目标：验证 v1.4 的 Wave1/Wave2 能力在真实 Host 中可用：
> roles/provider、plan-first、hooks、优雅关闭、成员面板、token 预算、worktree 隔离。
>
> 状态：**v1.4.0 已安装；Host 侧已在独立 Web Host 验证加载**，桌面会话等待重启后跑完整 live run。

## 1. 已完成的加载验证（独立 Host，profile 121，端口 4399）

- 独立 Host 启动后插件为 **1.4.0**（`index.js VERSION` 由 profile link 加载；桌面进程仍停留在 1.3.1，见 §3）；
- **新 Host 路由可用**：页面内 `GET /api/agent-team-workflow.member?session=…&name=lead` → **200**
  （该路由 v1.4 才存在，证明 Host 侧新版已生效）；
- **新客户端 UI 可用**：同一 Host 的「团队看板」渲染出 v1.4 新增的
  **「计划待批」/「计划已批」** 卡片徽章（`docs/evidence/dashboard/v14-plan-badges.png`）；
- 快照 v1.4 新字段按契约出现：`items[].plan`（pending/approved）、`run.collaboration.stops[]`、`run.usage`。

## 2. 待执行的完整 live run（重启桌面后）

1. 配置临时开启 `roles`、`planFirst`、`hooks`、`gitEnabled+worktreeIsolation`（或单独轮次）；
2. Lead 发 mission → `team_flow_plan` 自动组队（provider 按 role 选择）；
3. 成员 `team_flow_plan_approval` 提交计划 → Lead 批准（autoApprovePlan=false 分支）；
4. 一次 hooks 阻断演示（taskCreated exit 2 → 计划被拒绝、无状态写入）；
5. `team_flow_stop` 优雅关闭：request → 成员 reject（附理由）→ Lead interrupt；
6. 成员面板：GET 视图 + POST 直发消息（真实投递到成员 inbox）；
7. scratch git 仓库：worktree_add/commit/verify/push → gate → merge；
8. gate 捕获 token 使用（真实 tokenUsage 或"未采集"）；
9. 截图：计划徽章、成员抽屉、停止记录、token 面板/字段。

## 2b. 独立 Host 的 UI 驱动尝试（未计入 live 证据）

在独立 Host 中新建会话并发送「用 team_flow_plan 建立 v1.4 验证 run」的指令，期望由该 Host 内的 Lead 代理完成真实 run。实际观察：
- 该代理花了约 5 分钟阅读 docs/配置并反复确认当前 profile，期间没有调用任何 `team_flow_*` 工具；
- 超时后仍未建立黑板（`.agentteam/teams/<new-session>/` 不存在）；
- 结论：**这次尝试不作为 live 证据**，只是证明了 1.4 的 Host/Client 已加载（§1）。完整 live run 仍应在重启后的桌面会话里做——那里的 Lead 有完整上下文，能按 `docs/20 §2` 的步骤执行。

## 3. 环境事实

- 桌面 App 进程启动于 17:10，日志显示仍为 **1.3.1**（插件管理器在 21:14 触发了一次 reconcile，但没有重启进程，故模块代未变）；
- 独立 Host（21:18 启动）已加载 1.4.0 并验证新路由/新 UI；
- 因此：**需要重启 DSH Desktop** 才能让当前会话获得 17 个工具与 v1.4 行为。
