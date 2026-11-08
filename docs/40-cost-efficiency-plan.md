# 40 · 消耗与效率优化计划（v1.24 路线图）

> 版本：草案 v1（2026-11-09）
> 范围：`@local/dsh-agent-team-workflow` v1.23.1（主机引擎 + 看板客户端）
> 原则：**先测量后优化**；不降低评审与证据强度换取 token；每项改动都要有可回滚的开关和 A/B 验收。

## 0. 结论摘要

当前成本的主要来源不是"看板界面"，而是**模型调用轮次多 + 每轮上下文持续变长**，其次是**工具/通知 payload 重复携带全量状态**：

1. 一个 2 工作项、各一轮返工的 run，成员侧实测约 **81 次模型调用**、**0.79M 非缓存输入**、**18.7M cacheRead**、**95k 输出**（≈$0.23，另加 Lead 侧调用）；
2. `team_flow_status` 默认返回 **18.0KB**（4.5k tokens），带 `item_id` 时 **43.5KB**（约 11k tokens），而成员被要求"每一步后重读 status"；
3. 审核/唤醒消息重复携带 diff（最多 80 行）与完整 DoD，单次 review 消息 4.3KB + diff，返工通知 7.6KB；
4. 看板开启时每 **1.2s** 拉取 **47.7KB** 全量快照（≈2.3MB/min，未压缩），且快照包含完整 items/events/collaboration；
5. 自动 finalize 路径**没有采集 token usage**（实测 `state.usage=null`），预算与看板计量在自治模式下失效。

**目标**：在质量门禁不降级的前提下，把典型 2-item run 的成员 token 降 **30–40%**、轮次降 **25–35%**，看板带宽降 **80%+**；并把"消耗"变成看板上可见、可预算、可回归的指标。

## 1. 实测基线（2026-11-03/05 run）

数据来源：`~/.dsh/storages/cost-meter/ledger.json` 中该 run 的成员子会话；payload 用真实 `state.json` 调用 `buildStatus`/`buildSnapshot`/协议渲染函数测量（compact JSON 字节）。

### 1.1 成员侧 token（2 items，W1/W2 各一轮 request_changes → approve）

| 指标 | 实测 | 说明 |
|---|---:|---|
| 模型调用 | 81 次 | 3 个活跃成员会话合计 |
| 非缓存输入 | 789,201 | 平均 9.7k/次 |
| 输出 | 95,414 | 平均 1.2k/次 |
| cacheRead | 18,659,840 | 平均 230k/次，成本主项 |
| 成本 | ≈$0.23 | 不含 Lead 侧；Nov 5 收尾活动未按成员记账 |
| 活跃墙钟 | 约 1.5 天（含 1.7 天中断） | 最终 3 分钟内完成返工→复审→finalize |

> 注：这是成员侧下界；Lead 的 plan/gate/仲裁调用另计。cacheRead 高说明"每轮重放的历史上下文"比"新输入"更主导成本，**减少轮次**优先于压缩单条消息。

### 1.2 单次 payload

| 对象 | 字节 | 约 tokens | 触发频率 |
|---|---:|---:|---|
| `team_flow_status`（无参） | 18,033 | ~4.5k | 每次状态确认/每步 |
| `team_flow_status(item_id)` | 43,472 | ~10.9k | 查看单项详情 |
| 其中 items | 9,305 / 34,744 | — | — |
| 其中 collaboration | 5,279 | ~1.3k | 每次 |
| Board snapshot | 47,734 | — | 每 1.2s/打开看板 |
| Worker spawn brief | 5,654 | ~1.4k | 每成员一次性 |
| Reviewer spawn brief | 4,621 | ~1.2k | 每评审者一次性 |
| Queue brief | 3,527 | ~0.9k | 每池成员一次性 |
| `reviewRequestMessage` | 4,347 | ~1.1k | 每轮评审 + diff |
| `changesRequestedMessage` | 7,582 | ~1.9k | 每次返工 |
| `approvedMessage` | 1,583 | ~0.4k | 每次通过 |
| `buildPolicy` lead/worker/reviewer | 5,651 / 937 / 755 | — | 系统提示，每轮缓存前缀 |
| 工作树 diff（review 唤醒附加） | ≤80 行 | ~1.5–2k | 每次 reviewer 唤醒 |
| state.json | 72,319 | — | 每次状态读写 |

### 1.3 运行时效率

| 项 | 现状 |
|---|---|
| 看板轮询 | 1.2s/次，47.7KB/次 → ~2.3MB/min（未压缩）；文档隐藏时跳过 |
| 快照缓存 | 无 ETag/If-None-Match，每次重新构建/序列化 |
| watchdog | 30s 扫**全 Host 所有 Agent**，逐 team 读 state（含已 finalized 的 team 也会读一次再退出） |
| 唤醒防抖 | 仅 30s cooldown/动作，无"待处理消息/成员 running"去重 |
| 重复内容 | report 发送 reviewRequest（含 diff）后，watchdog 可能再发 AUTO_DISPATCH（再含 diff） |
| usage 采集 | 仅 `team_flow_gate` 工具路径采集；`autoFinalize` 路径不采集 → `state.usage=null` |

## 2. 消耗模型与指标

### 2.1 成本公式

```
run_cost ≈ Σ_turn ( uncached_input_tokens × P_in
                  + output_tokens        × P_out
                  + cache_read_tokens    × P_cache
                  + cache_write_tokens   × P_write )
turns ≈ Σ_member ( spawn + status_calls + work_turns + review_turns + rework_turns + wake_turns )
```

优化按杠杆排序：

1. **减少 turns**（尤其重复唤醒、重复 status、无意义复审）——直接减少 cacheRead 与 total context；
2. **减小每 turn 新增 payload**（status/消息/diff）——减少非缓存输入；
3. **减小常驻上下文**（brief/protocol/历史）——降低 cacheRead 基线与增长斜率；
4. **提升缓存命中**（静态前缀在前、动态内容在后）——降低 cache write/uncached；
5. **实时面效率**（快照/轮询/缓存）——省带宽/CPU，不影响 token 但影响使用体感与主机开销。

### 2.2 指标定义

| 指标 | 定义 | 采集方式 |
|---|---|---|
| `tokens/member/run` | 各成员 session 的 input+output+cacheRead | `sessionProjections tokenUsage`（每次 reconcile/gate 采集） |
| `calls/run` | 模型调用次数 | 同上（calls 计数） |
| `bytes/status` | status 返回 JSON 字节 | bench + 单元测试断言 |
| `bytes/brief` | spawn prompt 字节 | bench |
| `bytes/board-min` | 看板每分钟传输字节 | 客户端埋点/服务端日志 |
| `wake/duplicate` | 重复唤醒比例 | orchestrator 计数器 |
| `first-pass approve` | 首轮评审通过率 | run events |
| `gate pass` | 一次 finalize 通过率 | run events |
| `wall time` | plan→finalize 墙钟 | run state |

### 2.3 目标（A/B 验收口径）

| 指标 | 基线 | P0 | P0+P1 | P0+P1+P2 |
|---|---:|---:|---:|---:|
| calls / 2-item run | 81 | ≤68 (-16%) | ≤58 (-28%) | ≤52 (-36%) |
| uncached input / run | 0.79M | ≤0.62M (-22%) | ≤0.52M (-34%) | ≤0.46M (-42%) |
| cacheRead / run | 18.7M | ≤15.5M (-17%) | ≤12.5M (-33%) | ≤10.5M (-44%) |
| output / run | 95k | ≤90k | ≤85k | ≤85k |
| `team_flow_status` | 18.0KB | ≤6KB | ≤4KB | ≤3KB |
| `status(item_id)` | 43.5KB | ≤18KB | ≤12KB | ≤8KB |
| worker / reviewer brief | 5.7 / 4.6KB | ≤4.0 / 3.4KB | ≤3.0 / 2.6KB | ≤2.4 / 2.2KB |
| review message + diff | 4.3KB + ≤80行 | ≤3.5KB + ≤30行 | ≤2.5KB + ≤15行 | ≤2KB + 摘要 |
| board snapshot | 47.7KB/1.2s | ≤28KB/3s + ETag | ≤20KB/4s | ≤15KB/5s + delta |
| board bytes/min | ~2.3MB | ≤0.6MB (-74%) | ≤0.3MB (-87%) | ≤0.15MB (-93%) |
| 重复唤醒 | 未测量 | -50% | -80% | -90% |
| autoFinalize usage 采集 | 缺失 | 100% | 100% | 100% |

**质量护栏**（任一不达标即回滚该阶段）：

- gate pass 率不低于基线；
- 首轮 approve 率不下降（目标 ≥ 基线 +5%）；
- 返工轮次不增加；
- 不删除任何必填证据/评审字段；
- 任务是否真正完成（DoD/CI/测试）不下降。

## 3. 工作流总览

| Track | 主题 | 阶段 | 预估 |
|---|---|---|---|
| T1 | 工具输出压缩（status/read/report 视图） | P0 | 1.5d |
| T2 | 消息与调度（去重、合并、退避、事件驱动） | P0/P1 | 2d |
| T3 | 协议与上下文（brief 拆分、缓存前缀、评审分级） | P1 | 3d |
| T4 | 实时面（快照 rev/ETag/delta、轮询、UI） | P0/P2 | 2.5d |
| T5 | 计量与护栏（usage 采集、活预算、bench/CI） | P0/P1 | 1.5d |
| T6 | 模型路由与长任务归档（宿主能力允许范围内） | P2 | 2d |

## 4. 详细设计

### T1 · 工具输出压缩（P0）

**问题**：`buildStatus` 默认把 objective/AC/constraints/settings/items(含评审摘要)/collaboration 全量返回，18KB；`item_id` 详情把完整 report/reviews 展开到 43KB。成员每次状态确认都重读一遍，是新增输入的主要来源。

**设计**：

1. `team_flow_status` 增加参数：
   - `view: 'brief' | 'full'`（默认 `brief`）；
   - `since_rev?: number`：只返回 `rev > since_rev` 的 item 摘要 + 新事件；
   - `include?: ('items'|'collaboration'|'mission'|'settings'|'usage')[]`，默认 `items+collaboration-tail`。
2. `brief` 投影：
   - 只保留 `run_id/phase/rev/counts/me/next_actions` + 每 item 的 `{id,status,owner,reviewer,pending_action,rounds}`（不含 report 全文、findings 全文、DoD 全文）；
   - mission 三件套（objective/AC/constraints）与 settings 仅在成员**首次** status（或 `since_rev=0`）返回，之后省略；
   - collaboration 只返回 "发给我的未读/未答" + 最近 3 条频道消息摘要，≤1KB；
   - 目标：默认 ≤4KB；`item_id` 详情 ≤12KB（report summary ≤800B、findings claim ≤300B、evidence ≤500B/条、最多 5 条）。
3. `team_flow_read` 同样增加 `tail`（默认 3/5/10）与 `since`；`team_flow_report`/`review_submit` 的返回值只保留 `next_actions + warnings + status`，不再附完整 status。
4. 统一 payload 预算：`settings.maxToolPayloadBytes`（默认 12,000），超限字段按优先级裁剪并在 `warnings` 标注 `truncated`；bench 断言。
5. 状态修订号：每次 `writeState` 增加 `state.rev`（整数）；工具结果返回 `rev`，供 `since_rev` 与看板 delta 使用（T4 共用）。

**文件**：`lib/workflow.js`（buildStatus 投影）、`lib/tools.js`（参数/schema/返回裁剪）、`lib/config.js`（`maxToolPayloadBytes`、`statusDefaultView`）、`test/efficiency.test.mjs`（新增）、`test/tools.integration.test.mjs`（契约）。

**验收**：`status` 字节 ≤4KB（fixture 2 items/2 reviews）、详情 ≤12KB；现有 242 测试不回归；成员任务成功率不降。

### T2 · 消息与调度（P0/P1）

**问题**：一次 review 的通知路径可能发两条（report 内联 diff + watchdog 的 AUTO_DISPATCH 再带 diff）；cooldown 只看时间不看"是否 already queued/running"；watchdog 30s 全 Host 扫描。

**设计**：

1. **通知去重表**：orchestrator 维护 `pendingNotices: Map<teamId, Map<member, {itemId, action, at, messageSeq}>>`
   - 若该成员对同一 item+action 已有未消费通知（成员仍 `inactive` 且消息未读/无新状态），不重复发送；
   - 成员变为 `running` 后清除该条；
   - 发送时记录 `messageSeq`（state 已有 messageSeq），用于判断是否已被读取/回复。
2. **合并唤醒**：一个 reconcile 周期内同一成员的多条待办合并成 **一条** digest（≤1.2KB），例如"W1 返工 + W2 待审"只发一条；Lead 的收敛/仲裁/冲突通知也合并。
3. **内容分级**：
   - 首次 review 唤醒附 `git diff --stat` + 前 15 行 patch（≤2KB）；后续唤醒只发 stat + item_id（≤600B）；
   - AUTO_DISPATCH 不再重复完整 DoD/scope，改为 item_id + 短摘要；
   - `reviewRequestMessage` 的 diff 行数/字节改为设置项（`reviewDiffLines`、`reviewDiffBytes`），默认 30 行/2KB。
4. **自适应退避**：
   - watchdog 只在存在 `phase ∈ {planned,executing,reviewing}` 的 run 时扫描；finalized/aborted 直接跳过（不读 state）；
   - 每 team 单飞（`reconciling` Set），同一 team 不并发 reconcile；
   - 无状态变化（`rev` 未变）连续 N 次后间隔 30s→60s→120s→300s 封顶；状态变化立即恢复 30s；
   - 成员 `running` 时不发唤醒（避免与正在执行的轮次竞争）。
5. **事件驱动优先**：所有状态写入后（report/review/respond/finalize）立即触发一次 reconcile（已有 `triggerOrchestrator`），watchdog 只作兜底；去掉"每 30s 必扫"的固定成本。

**文件**：`lib/orchestrator.js`、`lib/protocol.js`（消息模板长度）、`lib/config.js`（`wakeBackoff`、`reviewDiffLines`、`boardNotificationDigest`）、`test/orchestrator.test.mjs`（去重/合并/退避）。

**验收**：重复唤醒 = 0（同一 item/action 在成员未消费前不重发）；2-item run 的唤醒消息数 ≤ 6；AUTO_DISPATCH 平均 ≤1KB；现有 run 不出现漏唤醒（新增测试：成员 inactive 且有待办时必被唤醒一次）。

### T3 · 协议与上下文（P1）

**问题**：spawn brief 5.7KB，重复包含 mission/AC/constraints/peer 规则/角色规则；reviewer brief 4.6KB；这些内容也出现在系统提示的 policy 中（worker 0.9KB/reviewer 0.75KB，lead 5.6KB），存在重复。

**设计**：

1. **静态/动态拆分**：
   - 系统提示注入的 `buildPolicy` 只保留**角色常驻规则**（worker/reviewer/lead 各 ≤1.2KB），并放在最前（稳定前缀，利于 prompt cache）；
   - spawn brief 只保留：`item_id/subject/DoD/writeScopes/dependencies/taskId/worktree/report 要求/下一动作`，mission 与通用规则用一行引用 `"Mission & rules: see TEAM_POLICY / team_flow_status(mission)"`；
   - 目标：worker ≤3.0KB（P1）/≤2.4KB（P2），reviewer ≤2.6KB，queue ≤1.8KB。
2. **缓存友好排序**：静态段（规则）→ 任务不变段（objective/AC/constraints）→ 动态段（item/report/状态）；避免把时间戳/run_id 放在前部破坏 cache。
3. **上下文模式**：
   - 默认 `workerContext: 'fresh'`；`fork` 仅用于明确需要 Lead 上下文的调试项，配置文档写清成本差；
   - transcript/read 输出统一 `max_chars` 设置；大报告只给路径 + 摘要，全文用 `team_flow_read` 按需分页。
4. **评审分级**（不降证据）：
   - 新增 `reviewDepth: 'light' | 'standard' | 'deep'`，按 `changedLines/files/risk` 自动建议，Lead 可覆盖；
   - `light`：必做 diff + 测试命令复跑 + DoD 核对（仍要求 evidence_checked）；`deep`：额外手动/浏览器验证；
   - 作者报告增加 **self-check 清单**（DoD 逐项、命令退出码、范围），降低首轮 F1 类返工（实测一次返工 = 多轮全上下文）。
5. **协议文案去重**：同一句话（如"reviewer 不得改作者文件"）只出现一次；核算每 brief 的重复率（bench 断言）。

**文件**：`lib/protocol.js`、`lib/config.js`、`test/efficiency.test.mjs`、`docs/06-*`/`docs/07-*`（协议文档同步）。

**验收**：brief 字节达标；首轮 approve 率不降（A/B 3 runs）；prompt 前缀稳定（同配置连续 spawn 的 prefix 相同，测试断言）。

### T4 · 实时面（快照/轮询/UI）（P0/P2）

**问题**：47.7KB 快照 × 1.2s；无条件请求/缓存；事件与协作面板全量进入快照；看板打开即持续占用主机 CPU/网络。

**设计**：

1. **快照修订号与 ETag**：`state.rev` 写入快照；route 返回 `ETag: "<session>:<rev>"`，客户端用 `If-None-Match`；未变化返回 **304**（0 body）。
2. **按需分区**：`?sections=run,team`（默认）→ 不含 events/collaboration；看板滚动到事件抽屉时再请求 `events&since=`；协作面板单独 tail 接口。
3. **delta**：`?since_rev=N` 返回 `rev + changedItems[] + eventsTail[]`，客户端合并；一次全量后后续均为小响应。
4. **轮询策略**：`boardPollMs` 默认 1.2s 保持用户预期，但：
   - 连续 3 次 304 → 退到 3s；连续 10 次 → 5s；
   - 有本地交互（点击/滚动）或收到 delta → 回到 1.2s；
   - 文档隐藏时不请求（已实现，补充测试）；
   - 抽屉打开才拉 member-route，关闭即停（当前是每 tick 拉取）。
5. **渲染效率**：按 `rev` memo 化面板；事件列表虚拟化（最多渲染 200 行 → 窗口化）；缩放/关系图不因轮询重算布局（已有 zoom，补充 memo）。
6. **服务端缓存**：route 内按 `statePath + mtime + rev` 缓存序列化结果（TTL 1s），避免每次 buildSnapshot 全量计算；gzip/压缩视 Host 连接能力。

**文件**：`lib/dashboard.js`（rev/projection）、`lib/dashboard-route.js`（ETag/304/cache）、`client.js`（轮询/合并/抽屉按需）、`test/dashboard-route.test.mjs`、`test/client.contract.test.mjs`。

**验收**：快照 ≤20KB（默认分区）、304 比例 ≥80%（稳态）、board bytes/min ≤0.3MB、看板打开 10 分钟的主机 CPU 显著下降；UI 功能/契约测试全绿。

### T5 · 计量与护栏（P0/P1）

**问题**：`autoFinalize` 路径不采集 usage（实测 null），预算只在 finalize 时检查（为时已晚）；无实时成本可见性，无法做 A/B。

**设计**：

1. **统一 usage 采集**：抽 `captureUsage(ctx, members, tokenUsage)` 到独立 helper；
   - `team_flow_gate` 与 **orchestrator autoFinalize** 都调用；
   - `state.usage = { capturedAt, members, totals, rev }`；finalize 时写入 report；
   - 每次 reconcile（watchdog）低成本采样一次（内存 projection，不写盘），用于实时预算与看板。
2. **活预算**：`tokenBudgetPerMember/PerRun` 在每次唤醒/生成前检查**已用量 + 预计下一轮**；达到 80% 发 Lead 警告；达到 100%：
   - 停止自动唤醒/自动 finalize，置 run `suspended` 标记并通知 Lead；
   - 提供 `team_flow_gate`/`team_flow_status` 的 `usage` 字段与 override 途径。
3. **计数器与埋点**：`metrics` 环形缓冲（最近 100 次）：wake 发送/去重/被忽略、status 字节、消息字节、快照字节；只在内存，finalize 时汇总进 report（不膨胀 state）。
4. **Bench + CI**：`bench/measure-payloads.mjs` 用固定 fixture（2 items/2 reviews/rework）输出上表全部字节；`test/efficiency.test.mjs` 断言预算；CI 加 `node bench/measure-payloads.mjs --check`（超限失败）。
5. **A/B 脚本**：固定 2-item/2-member/强制返工场景跑 3 次，读取 cost-meter ledger 成员 session 的 input/output/cacheRead/calls，比较基线与优化版；人工验收"质量护栏"。

**文件**：`index.js`、`lib/tools.js`、`lib/orchestrator.js`、`lib/dashboard.js`（usage 面板）、`bench/measure-payloads.mjs`、`test/efficiency.test.mjs`、CI workflow。

**验收**：autoFinalize 后 `state.usage` 非空且 totals 正确；预算超限时自动停止唤醒并通知 Lead；bench 全部在预算内。

### T6 · 模型路由与长任务归档（P2）

- 在 Host 能力允许范围内，给出 `roles.<role>.provider` 的推荐配置：routine implementer/reviewer 用更快更便宜的 provider，Lead/gate 用强模型；在文档中给出成本/质量 A/B 模板（Host 暂不支持 per-member reasoning effort，列为宿主限制）。
- 长 run 归档：events/channel/reviews 超过阈值（如 state >256KB 或 items >50）时，把旧事件/历史 round 写入 `teams/<id>/archive/*.jsonl`，state 只保留尾部；看板按需分页读取归档。
- 大 diff/大报告一律走 artifact（文件路径 + 摘要 + `team_flow_read` 分页），消息中不传全文。

## 5. 实施阶段与验收

| 阶段 | 内容 | 产出 | 验收 |
|---|---|---|---|
| M0（0.5d） | bench 基线与 fixture；usage 采集修复 | `bench/measure-payloads.mjs`、efficiency 测试骨架 | baseline 表可复现 |
| M1 = P0（1.5–2d） | T1 状态压缩 + T2 去重/分级 + T4 ETag/304 + 轮询 | v1.24.0-alpha1 | calls ≤68、status ≤6KB、board bytes/min ≤0.6MB；242 测试全绿 |
| M2 = P1（3–4d） | T3 brief 拆分/缓存前缀/评审分级 + T2 事件驱动退避 + T5 活预算 | v1.24.0-beta | calls ≤58、uncached ≤0.52M、cacheRead ≤12.5M、重复唤醒 -80%；A/B 质量护栏通过 |
| M3 = P2（4–5d） | T4 delta/分区/UI + T6 路由建议/归档 | v1.24.0 | board ≤0.15MB/min、status ≤3KB、brief ≤2.4KB；A/B 全指标达标 |
| 回滚 | 每项行为都有 config 开关（`statusView`、`wakeDedupe`、`snapshotDelta`、`liveBudget`），默认在 A/B 通过后开启 | — | 任一项导致质量下降：关闭对应开关并回滚该 PR |

## 6. A/B 与质量验证

- **固定场景**：2 items（1 个 frontend + 1 个 verifier/README），显式注入 1 条必修 finding，跑 3 次取中位数；
- **采集**：cost-meter 成员 sessions（input/output/cacheRead/calls）、wall time、review rounds、gate pass、首轮 approve 率、bench bytes；
- **通过标准**：token 指标达表 2.3 目标 + 质量护栏全部通过；否则只保留无质量风险的子项（T1/T4/T5）；
- **回归**：现有 242 本地测试 + 9 kit + 41 契约 + CI matrix 全绿；新增 efficiency/orchestrator/dashboard-route 用例；每阶段更新 `docs/05` 验证矩阵。

## 7. 风险与依赖

| 风险 | 影响 | 缓解 |
|---|---|---|
| 过度压缩 status/消息导致模型漏信息、返工增加 | 质量下降 | 保底 `view:'full'` 开关；A/B 质量护栏；关键字段永不裁（DoD/writeScopes/next_actions/exit_code） |
| 去重/退避导致漏唤醒、run 卡死 | 任务失败 | 去重只针对"已排队未消费"；watchdog 兜底 + 熔断（超过 N 分钟无进展强制唤醒 Lead）；测试覆盖"必唤醒一次" |
| 快照 delta 合并 bug 导致看板错误 | 可观测性下降 | 保留 `?full=1` 回退；rev 单调性测试；契约测试覆盖 304/delta |
| usage 投影在宿主缺失 | 预算不可用 | 采集失败显示"未知"，不影响主流程；预算功能 opt-in |
| 宿主能力限制（per-member reasoning effort、HTTP 压缩） | 达不到极限目标 | 明确列为宿主 gap，文档记录；不承诺无法控制的部分 |

## 8. 明确不做 / 宿主限制（P2 之外）

- 不做 per-member 模型/推理强度自动调节（Host 只支持 `roles.<role>.provider`）；
- 不做跨进程状态/跨 session 消息（Host 团队模型限制）；
- 不通过削减必填证据、删除评审轮次来省 token（质量底线）；
- 不引入外部 npm 依赖（保持零依赖插件）。

## 9. 首个 PR（P0-1）建议内容

1. `state.rev` + `buildStatus` 三档投影（brief/full/since），schema 更新；
2. `team_flow_status` 默认 brief，`item_id` 详情裁剪；
3. `bench/measure-payloads.mjs` + `test/efficiency.test.mjs` 字节断言（status ≤4KB）；
4. `docs/05`/`README` 更新。

预计改动：`lib/workflow.js`（+150 行）、`lib/tools.js`（±80 行）、`lib/config.js`（+3 设置）、新增 bench/test（~200 行）；风险低、可独立回滚。
