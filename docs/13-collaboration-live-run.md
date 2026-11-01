# 13 · 对等协作 live run 记录（workflow v2）

> Run：`run-20261101174053-1i3e`　Phase：**finalized**（Lead gate 通过，3/3 approved）
> 时间：2026-11-01 17:40:53 → 17:49:10（约 8 分钟）　成员：lead + impl-hello / impl-docs / rev-hello
> 目的：验证 v2 对等协作层在**真实 Team** 中可用——开放队列抢单、成员直连问答、提案投票、
> 互邀评审、以及"协作不能绕过门禁"。

## 1. 场景与结果

Lead 只发布 mission + **3 个 `assignment:"open"` 工作项**（不指派 owner）：

| 项 | 内容 | 认领人 | 评审人 | 结果 |
| --- | --- | --- | --- | --- |
| J1 | `collab-live/join.mjs`（`joinNames(names, separator = ', ')`） | impl-hello | impl-docs | approved（approve，无 findings） |
| J2 | `collab-live/join.test.mjs`（node:test 10 例） | rev-hello | impl-hello | approved（approve，无 findings） |
| J3 | `collab-live/README.md` | impl-docs | rev-hello | approved（approve_with_nits，1 条 non-blocking nit） |

产物（工作区 `collab-live/`，评审后 hash 无漂移）：`join.mjs`、`join.test.mjs`（10/10 pass，exit 0）、`README.md`。
最终报告：`.agentteam/teams/session-38f1f4ad-…/report.md`。

## 2. 真实发生的协作动作（全部可在黑板/频道回放）

1. **开放队列抢单**：三条 `claim` 消息（m1/m2/m4），三个 owner 均由成员自己认领，Lead 未指派；
2. **成员直连问答（不经 Lead）**：
   - impl-docs m3 → impl-hello：「J1 的签名/默认 separator/空数组行为？」→ m6 给出**实测契约**（默认 `', '`、`[] → ""`、不 trim、无入参校验、非数组抛原生 TypeError）；
   - rev-hello m5 → impl-hello：同类提问 → m7 逐条给实测值；测试据此写断言，而非猜测。
3. **提案 + 投票（同伴共识修改 DoD）**：impl-docs 发起 **p1**（`dod` on J1：「`joinNames([])` 必须返回空字符串」）→ impl-docs yes + impl-hello yes → **accepted（yes 2 / no 0 / abstain 0，affected 2）**，J1 的 DoD 自动追加该条；随后 impl-docs 按更新后的 DoD 出 verdict；
4. **互邀评审（非 Lead 指派）**：三个 owner 各自 `request_review` 指定同伴（J1→impl-docs、J2→impl-hello、J3→rev-hello），对方 `take_review` 后独立复核并提交 evidence-backed verdict；
5. **评审讨论**：频道出现 8 条 question / 6 条 answer / 2 条 ack / 1 条 proposal / 4 条 status；rev-hello 把「仓库根裸跑 `node --test` 会扫描其它子项目」的实测事实发给 README 作者，README 采纳限定路径命令；
6. **门禁仍强制**：p1 未裁决前 J1 的 approve 会被拒绝（v2 阻断提案规则）；全部 approved 后 Lead `team_flow_gate {finalize:true}` 一次通过，报告落盘。

黑板统计：channel 22 条、events 19 条、proposals 1（accepted）、peer DM 边 6 条（impl-docs↔impl-hello 5、rev-hello↔impl-hello 5、rev-hello↔impl-docs 4）。

## 3. 看板实测

在独立 Web Host（同一 profile）中加载该 run 的黑板并打开「团队看板」：

- 顶部：`run-20261101174053-1i3e / 已收尾 / 已批准 3/3`；
- 执行流程图：J1/J2/J3 三张卡片均显示「已批准 + 认领 impl-hello/rev-hello/impl-docs + R1/2」；
- **协作频道**（22 条，带 question/answer/ack/proposal/status 徽章与 from→to、item chip）；
- **提案与投票**：p1「已完成/已通过」，投票条 同意 2 / 反对 0 / 弃权 0 · 受影响 2 人・已投 2 票，resolution 原文；
- 事件流出现 `proposal/opened → proposal/voted ×2 → proposal/resolved`、`review/requested/submitted`、`run/finalized`；
- 门禁面板 J1/J2/J3 全通过。

截图：
- `docs/evidence/dashboard/collab-board-overview.png`（流程图 + 认领徽章 + 拓扑）
- `docs/evidence/dashboard/collab-channel-proposals.png`（协作频道 + 提案投票 + 事件流 + 门禁）

## 4. 观察与遗留

- **协作确实由成员驱动**：Lead 全程只做了 1 次 `team_flow_plan` + 1 次 `team_flow_gate`，其余 6 类动作都由成员之间完成；
- **评审独立性良好**：评审人与作者不重合、且没有同对互评闭环（impl-hello→J2、impl-docs→J1、rev-hello→J3）；
- **诚信行为**：impl-hello 评审 J2 时做了变异测试（3 个变异全部被测试捕获），并主动纠正了自己 harness 里 `local out=$(cmd); code=$?` 取错退出码的问题；
- **1 条 non-blocking nit 未修**：rev-hello 指出 README 对非字符串元素（`joinNames([123])`）措辞不严谨，判 approve_with_nits；作者按"评审后不改冻结产物"纪律未改。如需修订，Lead 应重开 J3 走一轮完整评审；
- **命令陷阱**：本工作区根目录裸跑 `node --test` 会扫描其它子项目测试，验收命令统一用 `node --test collab-live/join.test.mjs`；
- **handoff 未在 live run 触发**（本轮 3 项各自由 owner 完成）：交接路径已由 `test/collaboration.test.mjs` 与 `test/tools.integration.test.mjs` 的 handoff 用例覆盖（offer/accept/decline + 任务转移）。下一轮可专门跑一个交接场景。
