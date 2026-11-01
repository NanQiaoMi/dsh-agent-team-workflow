# 14 · 成员自治与提案活性（workflow v2.2）

> 目标：把"对等协作"补成**真正的 Agent Team**——成员不仅能协作，还能在任务过程中**自己发现并新增工作项**；
> 提案不会因为某个成员沉默而永久卡死；交接路径进入 live 验证。
>
> **状态：已实现（2026-11-02，插件 1.2.0）**：`team_flow_item`（成员自建项）、提案 deadline/quorum/惰性自动裁决、
> `proposalTimeoutMinutes` 配置；离线测试 129/129（engine/collaboration/tools/dashboard/client 新增 22 例）。
> live run #2（成员自建项 + 真实 handoff + 短超时自动裁决）见 `docs/15`。

## 1. 成员自建工作项（`team_flow_item`）

任何成员都能新建工作项（不必回到 Lead 重新规划）：

```jsonc
team_flow_item {
  "action": "create",
  "subject": "为 join 增加 separator 省略场景的示例",     // 必填
  "role": "implementer",                                 // 可选
  "write_scopes": ["collab-live/example.mjs"],           // 必填 ≥1
  "definition_of_done": ["example.mjs 可运行且输出与 README 一致"],  // 必填 ≥1
  "owner": "self" | "open" | "<member>",                 // 默认 "self"
  "blocked_by": ["J1"],                                  // 可选，必须已存在
  "needs_review": true,                                  // 默认 true
  "reviewers": ["impl-docs"]                             // 可选；空 = 报告后自行邀请
}
```

规则（引擎强制）：
1. id 自动分配为 `S1`/`S2`…（不与计划项冲突）；
2. 新建项的写范围若与**同一波次**已有项重叠 → 拒绝（`allowScopeOverlap` 配置可放宽为警告）；
3. `owner:"self"` 立即写入 owner + claim，并创建/认领 backing 共享任务；`owner:"open"` 进入开放队列；指定成员则通知对方；
4. `blocked_by` 必须引用已有项；被依赖项未批准时不能报告（与计划项相同）；
5. 自建项与计划项**走同一套报告/评审/门禁**——自治不等于绕过验收；`origin:"member"`、`createdBy` 落在黑板上；
6. Lead 也能用该工具补项；Lead 仍可用 `team_flow_repair` 处理卡点。

## 2. 提案活性（deadline + quorum + 惰性自动裁决）

新增配置项（`cordis.patch.yml` 可覆盖）：

```yaml
proposalTimeoutMinutes: 15   # 默认 15；0 = 不超时（旧行为）
```

- 每个提案在 `propose` 时写入 `deadline = now + timeout`（工具可传 `timeout_minutes` 覆盖，1–1440，便于演示/紧急议题）；
- **法定人数 quorum = ceil(affected / 2)，至少 1**；
- 惰性裁决（无定时器，纯函数、可复现）：在 `team_flow_status` / `team_flow_read` / `team_flow_gate` / 任何投票入口先执行
  `settleExpiredProposals(state, now, settings)`：
  - 未到期 → 不动；
  - 到期且 `tally.total >= quorum`：yes>no → accepted，no>yes → rejected，平票 → escalated（+ blocking escalation）；
  - 到期但未达 quorum → escalated（"deadline passed without quorum"），阻断类提案同时阻止 approve/gate，等 Lead `decide {action:"resolve"}`；
  - 自动裁决写入 `proposals[].autoResolved = true`、`resolution` 说明，并写事件与频道系统消息；
- 全队级提案同样适用：不再因为某个成员沉默而永久 open。

## 3. 交接（已有实现）进入 live 验证

`handoff_offer → handoff_accept` 转移 owner + claim + backing 任务；live run 必须真实触发一次。

## 4. 状态/快照/看板增量

state（v2 兼容，旧板升级补默认值）：
- `items[]`：`origin: "plan"|"member"`（默认 plan）、`createdBy: null|<member>`；
- `proposals[]`：`deadline: ISO|null`、`autoResolved: boolean`（默认 false）、`quorum: integer`；
- `settings.proposalTimeoutMinutes`。

快照（`SNAPSHOT_VERSION` 保持 2，只加字段）：
- `run.items[]`：`origin`、`createdBy`；
- `run.collaboration.proposals[]`：`deadline`、`autoResolved`、`quorum`。

看板：
- 流程图卡片：`origin === "member"` 显示「自建」徽章（title 含 createdBy）；
- 提案面板：显示 `截止 …`（相对时间）/「已超时自动裁决」徽章与 quorum 说明。

## 5. 文件所有权

| 负责人 | 只写 |
| --- | --- |
| Lead | `lib/workflow.js`、`lib/tools.js`、`lib/protocol.js`、`lib/config.js`、`index.js`、`docs/*`、`test/engine.test.mjs`、`test/collaboration.test.mjs`、`test/tools.integration.test.mjs`、`test/plugin.test.mjs` |
| host-snapshot | `lib/dashboard.js`、`test/dashboard.test.mjs` |
| client-board | `client.js`、`test/client.contract.test.mjs` |

## 6. 验收

1. 引擎：`createItem` 全路径（id 生成/重叠拒绝/依赖校验/self-claim/open/他人 owner/审批计数）；`settleExpiredProposals`（未到期不动、达 quorum 通过/否决、平票升级、无 quorum 升级、blocking 拦截 approve 与 gate、autoResolved 标记）；
2. 工具：`team_flow_item` 真实 schema + 创建后共享任务存在；`team_flow_decide propose` 带 deadline；`team_flow_status` 触发惰性裁决；
3. 看板：快照含 origin/createdBy/deadline/autoResolved/quorum；client 渲染「自建」「截止/超时」徽章，zh/en 键对齐；
4. live run #2：成员在协作中**自建一个新工作项并完成**；一次真实 handoff；一个短超时提案在有人不投票时自动裁决；最终 gate 通过。
