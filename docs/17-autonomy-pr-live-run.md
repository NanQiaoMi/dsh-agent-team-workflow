# 17 · 自治团队 / 提案活性 live run（v1.3，已执行）

> Run：`run-20261102052850-il6f`　Phase：**finalized**（Lead gate 通过，4/4 approved）
> 时间：2026-11-02 13:28–13:38（约 10 分钟）　成员：lead + impl-hello / impl-docs / rev-hello
> 目的：验证 v1.3 的"团队自建 + 成员自治 + 提案活性 + 真实 handoff"，并观察协作噪音。

## 1. 团队自建（auto-staffing）

Lead 只调用一次 `team_flow_plan`（3 个 item：K1/K2 开放队列、K3 指派）：

- 返回 `staffed.woken = ["impl-docs","impl-hello","rev-hello"]`、`spawned = []`；
- 三名成员由插件**自动唤醒并收到 [RESUME] 简报**，无需 Lead 手工复制 spawn prompt；
- 计划里 `staffPool=["impl-hello","impl-docs","rev-hello"]` 落板，后续 `team_flow_staff` 可幂等补员。

## 2. 成员自治：自建工作项

impl-hello 在实现 K1 途中用 `team_flow_item` 自建 **S1**（`collab-live-2/example.mjs`，计划外）：

- S1 自动获得 id、写范围、DoD、backing 共享任务，owner=impl-hello 立即 claim；
- S1 走完报告 → 邀请 rev-hello 评审 → **approved**（round 1，无 findings）；
- 看板 snapshot `items[].origin="member"` + `createdBy="impl-hello"` → 客户端「自建」徽章。

## 3. 真实 handoff

rev-hello 认领 K2（测试）并写完 7 个用例后，在 report 前 `handoff_offer K2 → impl-docs`：

- impl-docs `handoff_accept`，K2 的 owner/claim 转移，rev-hello 不再触碰该文件；
- 新 owner 独立复跑 `node --test` 7/7 pass、report、邀请 impl-hello 评审 → **approved**；
- ⚠️ 已知限制：native backing task（task-8）的 owner 不会随 handoff 转移（只有 Lead 能 reassign），门禁给了一条 `backing Team task in_progress` 警告，不阻塞。

## 4. 提案活性（deadline + quorum + 惰性自动裁决）

impl-docs 对 K1 发起 **p1**（`dod`，`timeout_minutes:1`），按剧本**全程不投票**；impl-hello 投 yes：

- 到期后第一次 `team_flow_status` 触发惰性裁决：`auto-accepted after deadline (yes 1, no 0, abstain 0; quorum 1)`；
- `p1.autoResolved=true`，K1 的 DoD 自动追加「`quoteName("")` 必须返回空字符串」，评审人按更新后 DoD 复核；
- 另：看板 route 现在也会在快照时惰性裁决并持久化（v1.3.1），避免"已截止但状态仍进行中"的显示滞后。

## 5. 看板实测与协作噪音

看板实测截图：
- 降噪前（v1.3）：`docs/evidence/dashboard/v13-board-pending.png`
- 降噪后（v1.3.1 最终面板）：`docs/evidence/dashboard/v131-board-final.png`、`docs/evidence/dashboard/v131-board-collab.png`
  （频道正文 4 行 +「展开」、提案「超时自动裁决 + 已截止 + 法定 1」、事件流 `proposal/auto-resolved`、门禁 4 项通过 + K2 的 `backing Team task in_progress` 警告、流程图 520px 内滚动）

观察到并已修复的问题：

1. **协作频道消息太长**：一条问答占满面板 → v1.3.1 改为正文默认 4 行、可展开/收起；
2. **提案「已截止」但状态仍「进行中」**：route 不做惰性裁决 → v1.3.1 在快照时结算并持久化；
3. **拓扑把 Lead 算进「空闲 N 人」**（fixture 只剩 Lead 时出现「空闲 1 人」）→ v1.3.1 排除 Lead、0 不渲染；
4. **流程图面板 320px 切卡** → 第一行提高到 **520px**（v1.3.1 复测后从 420 再放大，4 张卡可整卡显示）；
5. **报告时自动发"needs a peer reviewer"提醒引发回复风暴**：本 run 中 owner 几秒后自行点名评审，导致 m5/m12/m15/m31 等过期提醒 + 10 余条互相澄清 → v1.3.1 移除该频道提醒（保留在 next_actions）；
6. **team 广播唤醒全部 8 名 roster 成员**：research-teams / dsh-api-recon / code-reviewer / client-board / host-snapshot 都被唤醒并答复过期消息 → v1.3.1 把 team 通知收敛到**本 run 参与者**（item owner/reviewer/claim/handoff/proposal 作者 + staffPool）。

## 6. 结果与遗留

- 交付物（工作区 `collab-live-2/`，全部获批）：`quote.mjs`（K1）、`quote.test.mjs` 7 用例（K2，handoff 后由 impl-docs 报告）、`README.md`（K3）、`example.mjs`（S1，成员自建）；最终验证 `node --test collab-live-2/quote.test.mjs` 7/7 pass exit 0；
- 报告：`.agentteam/teams/session-38f1f4ad-…/report.md`；
- 遗留：① K1 有 1 条 non-blocking nit（JSDoc 未记录 `quote=''`），因收敛后改实现会让 README/评审引用的 sha256 基线失配，留待下一轮连同 README 哈希一起改；② handoff 不转移 native backing task owner（仅 Lead 可 reassign）；③ git/PR 流程在本 run **未开启**（`gitEnabled:false`，且本会话工作目录不是 git 仓库），其能力由离线真实 git 仓库端到端测试覆盖（`test/git.test.mjs` 23 例 + `team_flow_git` e2e），在真实仓库会话中开启配置即可使用。
