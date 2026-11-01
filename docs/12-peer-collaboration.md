# 12 · 对等协作层（Peer Collaboration）设计

> 现状问题：v1 的工作流是**委派式**——Lead 规划、分配 owner/reviewer、worker 执行后回报，所有协调都经过 Lead。
> 这不是 Claude Agent Teams 那类"成员之间相互协作"：peer 不能互相对话、不能自己认领工作、不能协商
> DoD/范围、不能直接跟 reviewer 讨论问题、不能交接任务。
>
> 本设计在 v1 之上加一层**对等协作协议**：成员直接沟通、抢单/认领、互邀评审、议题讨论、提案投票、任务交接，
> Lead 从"派活的"变成"定任务与仲裁的"。所有协作动作都落在黑板上，看板可视化。
>
> **状态：已实现（2026-11-02）**。`WORKFLOW_VERSION = 2`、`SNAPSHOT_VERSION = 2`；12 个工具、看板 v2 面板；
> 离线测试 113/113（其中协作相关 39 例 + 快照 26 例 + 客户端 17 例）。live 协作 run 记录见 `docs/13`。

## 1. 设计原则

1. **成员之间直连**：peer 消息由成员直接发给成员（原生 `agentTeams.sendMessage`），Lead 不中转；
2. **黑板即协议**：每个协作动作都写进 `state.json`（channel/proposals/claims/handoffs），可审计、可回放；
3. **自组织 + 有边界**：开放队列可自领，但写范围/DoD/评审结论仍受门禁约束；
4. **Lead 只做三件事**：定 mission 与开放队列、仲裁死锁/冲突、最终 gate；
5. **向后兼容**：v1 黑板读取时自动升级到 v2（补空字段），旧 run 仍可查看/收敛。

## 2. 状态 schema v2（`WORKFLOW_VERSION = 2`）

在 v1 基础上新增（全部可选、缺省即 v1 行为）：

```jsonc
{
  "version": 2,
  "channel": [{
    "id": "m3", "at": "ISO", "from": "impl-a", "to": "team" | "<member>",
    "kind": "note|question|answer|proposal|objection|handoff|ack|status",
    "text": "…",                                   // ≤ 4000 字
    "replyTo": "m2" | null,
    "refs": { "itemId": "W1", "findingId": "F1", "proposalId": "p1" } // 可缺省
  }],
  "proposals": [{
    "id": "p1", "at": "ISO", "by": "impl-a",
    "kind": "dod|scope|replan|review_policy|handoff",
    "itemId": "W1" | null,                          // null = 全队议题
    "text": "…",                                    // ≤ 4000 字
    "status": "open|accepted|rejected|withdrawn|escalated",
    "votes": [{ "by": "rev-b", "at": "ISO", "vote": "yes|no|abstain", "comment": "…" }],
    "resolvedAt": "ISO" | null, "resolution": "…" | null
  }],
  "items": [{
    "assignment": "lead|open",                      // open = 开放队列，谁先认领谁做
    "claim": null | { "by": "impl-a", "at": "ISO", "leaseMinutes": 30 | null, "note": "…" },
    "reviewRequests": [{ "by": "impl-a", "at": "ISO", "reviewer": "rev-b" | null,
                         "status": "open|accepted|declined", "respondedAt": null, "response": null }],
    "handoffs": [{ "by": "impl-a", "at": "ISO", "to": "impl-b", "reason": "…",
                   "status": "offered|accepted|declined", "respondedAt": null }]
  }]
}
```

约定：
- `channel` 最多 200 条（FIFO），`text` 超长截断并加省略号；`to:"team"` 为广播；
- 提案参与人（affected）：`itemId` 存在 → 该 item 的 owner + reviewers；否则全队成员（含 Lead）；
- **提案裁决**：所有 affected 投完票后自动裁决——`yes > no` → accepted，`no > yes` → rejected，平票 → escalated
  （写一条 blocking escalation 交 Lead 仲裁）；`kind in (dod,scope,replan)` 且未裁决 = **阻断项批准**（提交 approve 会被拒，
  gate 也记 failure）；
- 认领：`assignment === "open"` 且 `owner == null` 且 `status === "pending"` 才可认领；认领同时 claim 原生任务并写 claim 记录；
- 评审邀请：作者在**提交报告后**可指名或开放邀请评审；被指名的 reviewer 通过 `take_review` 接受；
- 交接：owner 可把未报告项 `handoff` 给同伴，对方接受后 owner/claim 转移并重新通知。

## 3. 新工具（4 个，与 v1 的 8 个并存 → 共 12 个）

### 3.1 `team_flow_talk` —— 成员直连沟通

```jsonc
{ "target": "team" | "<member name>",        // 必填
  "kind": "note|question|answer|proposal|objection|ack|handoff|status",  // 默认 note
  "text": "…",                               // 必填，≤4000
  "item_id": "W1", "finding_id": "F1", "reply_to": "m2" } // 均为可选
```
行为：写 channel → `sendMessage` 直投目标（team = 广播给其他成员）→ 返回 `{ message_id, delivered_to[], failed?[] }`。
peer 之间的问答不经过 Lead；Lead 也能收到广播。

### 3.2 `team_flow_work` —— 认领/评审/交接

```jsonc
{ "action": "claim|release|request_review|take_review|handoff_offer|handoff_accept|handoff_decline",
  "item_id": "W1",
  "reviewer": "<member>" | null,             // request_review 用；null = 开放邀请
  "to": "<member>",                          // handoff_* 用
  "reason": "…", "note": "…", "lease_minutes": 30 }
```
规则：
- `claim`：仅开放队列可认领；已被认领/已报告则报错；
- `release`：owner 本人可释放（未报告前），释放后回到开放队列；
- `request_review`：仅 owner 且已提交报告；设置 `pendingReviewer`，通知目标；
- `take_review`：任何非 owner 成员可接受（开放邀请或指名给自己）；
- `handoff_offer`：owner 且未报告；`handoff_accept` 仅被邀请者；接受后转移 owner/claim。

### 3.3 `team_flow_decide` —— 提案与投票

```jsonc
{ "action": "propose|vote|withdraw",
  "kind": "dod|scope|replan|review_policy|handoff",  // propose 用
  "item_id": "W1", "text": "…", "proposal_id": "p1",
  "vote": "yes|no|abstain", "comment": "…" }
```
规则：任何成员可提案；affected 成员各一票（可改票）；提案人可撤回；裁决自动写 channel 系统消息。

### 3.4 `team_flow_read` —— 拉取协作上下文

```jsonc
{ "item_id": "W1", "limit": 30 }   // 都可选
```
返回：`{ channel:[…tail], proposals:[…], open_queue:[itemId…], my_review_requests:[…], my_handoffs:[…], item_thread:[…] }`。
成员开工前应先读；`team_flow_status` 也会给出协作摘要与下一步建议。

## 4. 协议/提示注入变化（`lib/protocol.js`）

| 角色 | 新增职责 |
| --- | --- |
| Lead | 发布 mission + **开放队列**（不必逐项指派）；只在平票/冲突/跨项阻塞时仲裁；维护提案是否收敛；不做 peer 之间的传话筒 |
| Worker | 先 `team_flow_read` 再开工；优先 `claim` 开放项；遇到接口/契约问题**直接问 peer**（`talk` + `question`）、回答别人的 `question`；DoD/范围有异议走 `decide.propose` 并投票；完成后可指名邀请评审；被交接时明确接受/拒绝 |
| Reviewer | 与作者在 channel/thread 中讨论 finding（`talk` reply/answer），再提交 verdict；对影响自己的提案投票 |

`renderWorkerBrief` / `renderReviewerBrief` / `buildPolicy` 都要加"对等协作"小节，并给出工具名与典型调用序列。

## 5. 看板快照 v2（`lib/dashboard.js`）

`run` 新增：

```jsonc
"collaboration": {
  "channel": [{ "id","at","from","to","kind","text","itemId","findingId","proposalId","replyTo" }], // ≤60
  "proposals": [{ "id","at","by","kind","itemId","text","status",
                  "votes":[{"by","vote","comment","at"}],
                  "tally":{ "yes","no","abstain","affected","total" },
                  "resolvedAt","resolution" }],
  "openQueue": ["W3"],
  "pendingReviews": [{ "itemId","requestedBy","reviewer","at" }],
  "handoffs": [{ "itemId","by","to","reason","status","at" }],
  "edges": [{ "from":"impl-a","to":"rev-b","count":3,"kinds":["question","answer"] }]
}
```

`items[]` 新增：`assignment`、`claim`、`reviewRequests`、`handoffs`、`thread`（该 item 的 channel 条目 ≤20）、
`openProposals`（阻断中的提案数）。
`activity`（可选）：每人 `{posts,claims,reviews,votes}`，供拓扑加权。

## 6. 看板 UI（`client.js`）

1. **协作频道**面板：消息流（按时间倒序/正序切换，kind 徽章，from→to，item 引用可点跳详情），筛选 chip：
   全部/提问/回答/提案/交接/状态；
2. **提案与投票**面板：每条提案显示 kind、status、投票条（yes/no/abstain 计数与投票人）、resolution；
3. 流程图：新增「待认领」lane（open queue）+ 卡片上的 claim 徽章与 pending reviewer 标记；
4. 协作拓扑：新增 **peer↔peer 实线/虚线边**（消息条数加权，来自 `collaboration.edges`），Lead 边降权；
5. 详情抽屉：新增「协作记录」区（thread + reviewRequests + proposals + handoffs）；
6. 全部文案走 `t()`（zh/en 键集对齐）。

## 7. 文件所有权（并行开发）

| 负责人 | 只写 |
| --- | --- |
| Lead | `lib/workflow.js`、`lib/tools.js`、`lib/protocol.js`、`lib/config.js`、`index.js`、`docs/*`、`test/engine.test.mjs`、`test/tools.integration.test.mjs`、`test/plugin.test.mjs` |
| collab-host | `lib/dashboard.js`、`test/dashboard.test.mjs` |
| collab-client | `client.js`、`test/client.contract.test.mjs` |

## 8. 验收标准

1. `WORKFLOW_VERSION === 2`，v1 黑板读取自动升级；v2 字段缺省时行为等同 v1；
2. 引擎：claim/release/request_review/take_review/handoff/propose/vote/talk 全路径单测（含错误分支：非开放项认领、非 owner 释放、
   非 affected 投票、重复投票改票、平票升级、撤回、阻断提案拦截 approve）；
3. 工具：4 个新工具真实走 JSON Schema 校验 + 消息直投（mock `sendMessage` 断言 target/content）；
4. 看板：快照含 `collaboration` 全字段、蒸馏 edges 正确；客户端渲染新面板且 zh/en 文案齐全；
5. 文档：README / docs/03 / docs/04 / docs/09 / 05 更新；`docs/13` 记录一次**真实协作 run**（peer 问答、投票、交接、评审讨论）。

实现后的口径确认：
- `ensureCollaboration` 在写入/读取时补齐 v2 字段（v1 板自动升级，行为不变）；
- 指名邀请会立即开一轮 pending review（只有被邀请者可提交）；开放邀请在 `take_review` 后才开轮；
- 开放队列 item 报告时若还没有 reviewer，则不自动开轮，而是写一条"需要评审邀请"的频道消息；
- 未裁决的阻断提案（dod/scope/replan，含 escalated）拒绝 approve 并让 gate 失败；Lead 用 `team_flow_decide {action:"resolve"}` 仲裁并同步解决关联 escalation。
