# 20 · v1.4 live run（已完成）

> 目标：验证 v1.4 的 Wave1/Wave2 能力在真实 Host 中可用：
> roles/provider、plan-first、hooks 阻断、优雅关闭、成员面板、token 使用、gate。
>
> 结果：**通过**。在独立 Web Host（profile 121，端口 4399，真实 1.4.0 插件 + 真实模型）
> 上跑了两轮 run：第一轮走完 plan-first → report → review → gate 并捕获真实 token 用量；
> 第二轮验证 hooks 阻断与优雅关闭/中断。

## 1. 第一轮：自治团队 + plan-first + gate（run-20261102135001-t4uc）

Lead 收到用户指令后只调用了一次 `team_flow_plan`：

- **团队自建**：`staffPool=['impl-alpha']`，插件自动 spawn 出 `impl-alpha`（真实 DSH roster spawn，provider=`spawn`）；
- **开放队列认领**：`impl-alpha` 自己 `claim` item A（`collab-live-5/join.mjs`）；
- **plan-first 生效**：`impl-alpha` 提交 4 步计划 → `plan.status=pending`；其报告被门禁拒绝
  （`team_flow_report` → `WORKFLOW_PLAN_REQUIRED`），并把阻塞发到频道；Lead 用
  `team_flow_plan_approval approve` 批准（`decidedBy=lead`），报告随即通过进入评审；
- **评审 + 收敛**：Lead 作为 reviewer 提交 approve → item A approved；`team_flow_gate {finalize:true}` 通过，
  黑板 `phase` 收敛并写出 `report.md`；
- **真实 token 用量**：gate 捕获 `state.usage`（token-meter projection 真实数据）：
  - lead：input 77,782 / output 3,853 / cacheRead 874,496
  - impl-alpha：input 95,543 / output 7,616 / cacheRead 1,629,568
- 黑板证据：`.agentteam/teams/session-76536de2-219f-40bb-ae54-a62d48fd17e6/runs/run-20261102135001-t4uc.json`
  （events: `run/planned → item/claimed → plan/pending → plan/approved → item/reported → review/requested → review/submitted → run/finalized`）。

## 2. 第二轮：hooks 阻断 + 优雅关闭（run-20261102135749-0k98）

同一会话 `team_flow_plan {replace:true}` 建立短 run，然后：

- **taskCreated hook 阻断（exit 2）**：`team_flow_item` 创建 subject 含 `risky` 的项时被拒绝，原文：
  ```
  Error: taskCreated hook blocked the action: …/.dsh-probe/hooks/block-risky.sh:
  risky tasks are vetoed by the taskCreated hook
  ```
  探针项未创建（预期）；
- **优雅关闭**：`team_flow_stop request` → stop1 `pending`（频道出现 `[SHUTDOWN] requested impl-alpha: demo`）；
  随后 `team_flow_stop interrupt` → stop1 `interrupted`（`decidedAt` 记录），`status` 返回完整记录；
- 黑板证据：`.agentteam/teams/session-76536de2-…/state.json`；看板截图见 `docs/evidence/dashboard/v14-live-stop-board.png`
  （拓扑显示 Lead + impl-alpha 参与者、频道 `[SHUTDOWN]`、run 已计划）。

## 3. 成员面板（真实路由）

同一 Host 页面内直接调用：

- `GET /api/agent-team-workflow.member?session=…&name=impl-alpha` → **200**，返回
  `currentItems[{A,approved}]`、`recentActivity`（claimed → plan/pending → reported…）、`roleDefinition` 等；
- `POST` 同路径 `{name:'impl-alpha',message:'…'}` → **200** `{ok:true,delivered:true}`（消息进入成员 inbox）；
- 看板成员抽屉实测显示：角色/状态/停止状态（**已中断 interrupt demo**）/当前工作项/相关频道/发消息框。

## 4. 发现并修复的真 bug（live 才暴露）

token-meter 的 projection 值是 `{totals, last}` 嵌套结构，v1.4 初版把整个对象当平铺桶累加，
导致 `state.usage.totals` 全为 0（成员级数据正确）。已修：gate 捕获时取 `raw.totals` 平铺并重新累加，
测试用真实嵌套形状覆盖。已发布为 **1.4.1** 修复；本轮 live 跑的是修复前代码（故上文 `usage.totals` 为 0，成员级数字仍真实），下次重启即生效。

## 5. 环境与交付

- 真实 Host：独立 Web Host（profile 121，端口 4399）+ 真实模型（deepseek-v4.1-flash, reasoningEffort=low 的临时测试配置）；
- 临时 profile 配置（plugin planFirst/hooks/roles + effort 覆盖）已**全部还原**，用户配置未被保留改动；
- 插件版本 1.4.0（17 工具），离线 **193/193** 测试全绿；文档 `docs/19`（契约）、本节（live）、`docs/05` V16；
- 看板截图：`v14-plan-badges.png`（计划徽章）、`v14-live-stop-board.png`（live 停止）、`v14-member-drawer-live.png`；
- 证据归档：`docs/evidence/live-v14/` 下保存了两轮 run 的完整 state（含 usage、stops、plan）、report 与 member route 原始响应。
