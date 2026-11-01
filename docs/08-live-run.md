# 08 · 重启后的真实 Live Run 记录（端到端验证）

> 目的：验证**最终代码代**在真实 DSH 运行时里能完成一次完整团队协作——不是离线模拟，也不是骨架版。
> 原始证据：[`evidence/live-run/`](evidence/live-run/)（`report.md`、`state.json`、三个交付文件）。

## 1. 环境与规模

| 项 | 值 |
| --- | --- |
| 运行时 | DSH Desktop，profile 121，重启后加载的最终插件代 |
| 团队 | Lead + 3 个 teammate（`impl-hello`、`impl-docs`、`rev-hello`） |
| 计划 | 2 个并行工作项（同一波次）：W1 实现 `hello.mjs` + 测试；W2 写 `README.md` |
| 评审关系 | W1 → `rev-hello`；W2 → `impl-hello`（双重角色：既是 W1 作者又是 W2 评审） |
| 工作目录 | 空目录 `/tmp/atw-smoke`（干净 workspace，避免污染仓库） |
| 时间 | 计划 02:54:16 → finalize 02:59:19（约 5 分钟，含一次人工仲裁） |
| 结果 | `phase=finalized`，gate `pass=true`（无 override），生成 `report.md` |

## 2. 事件时间线（`state.json` 原始事件）

| 时间 | 事件 | 成员 |
| --- | --- | --- |
| 02:54:16 | `run/planned` + `run/tasks-created`（2 个 backing task） | lead |
| 02:56:22 | `escalation/raised` esc-1：W1 DoD 命令 `node --test test/` 在本机 Node v24.21.0 下不可能 exit 0 | impl-hello |
| 02:56:44 | `item/reported` W1（含 6 条带退出码的命令与 4 条证据） | impl-hello |
| 02:56:51 | `escalation/resolved`：Lead 裁定统一用 `node --test`，禁止 shim | lead |
| 02:57:38 | `item/reported` W2（README，95 行，示例输出由真实模块跑出） | impl-docs |
| 02:58:39 | `review/submitted` W1 round 1：`approve_with_nits` | rev-hello |
| 02:58:58 | `review/submitted` W2 round 1：`approve_with_nits` | impl-hello |
| 02:59:19 | `run/finalized`：gate 通过并写 `report.md` | lead |

## 3. 这次 live run 实际验证到的能力

| 能力 | 现场证据 |
| --- | --- |
| 提示注入 | 我的 runtime context 与每个成员的系统提示出现协议段；run 建立后出现动态状态行（`phase planned/reviewing/converged/finalized`） |
| 计划与波次 | `team_flow_plan` 返回 `waves=[["W1","W2"]]` 与逐字可用的 spawn 简报（含写范围、DoD、依赖、backing task id、双重角色的评审职责） |
| 并行独立执行 | 两个 worker 同时在各自写范围内开工：W1 只写 `hello.mjs`/`test/`，W2 只写 `README.md`；`find` 复核无越界文件 |
| 原生任务板协作 | 两人都先 `team_task_get` 再 `team_task_update(claim)`（backing task 到 revision 2 变 `in_progress`），报告后引擎完成至 revision 3 |
| 结构化报告 | W1 报告含 6 条命令（每条带退出码，含一条**故意失败**的 `node --test test/` 用于说明裁定）、4 条证据、open_questions、risks、deviation |
| 升级与仲裁 | `esc-1` 由 worker 发起（blocking=false），Lead 用 `team_flow_escalate` 裁决并把理由写入黑板；裁决后 worker 继续交付，不再阻塞 |
| 自动评审指派与通知 | 报告提交后引擎自动开第 1 轮评审并 `send_message` 通知评审者；两位评审者都被唤醒 |
| 独立评审（有牙齿） | `rev-hello` 自己复跑命令、做 mutation 检查（去掉逗号 → 3/3 失败），并明确声明「批准不覆盖未满足的 DoD 第 3 条」 |
| 双重角色 | `impl-hello` 既交付 W1 又评审 W2；只 spawn 一次，worker 简报内含 review duty；实际完成了 W2 评审 |
| **nits 早停（R-19 修复的 live 证据）** | 两个 `approve_with_nits` 的 nit 都被记为 `accepted_by_reviewer`，`open_findings=0`，gate 不再因 nit 卡死——这正是复审发现的 blocker 路径 |
| 门禁 | `team_flow_gate` 预览：两项 `pass=true`、无 override、无 team failure；`finalize:true` 后才写报告与收敛 |
| 收敛与报告 | `report.md` 含 objective/AC/每项 DoD/报告/命令与退出码/评审轮次与 verdict/gate 表/audit trail；`finalizedAt` 落盘 |
| 收敛后不可变 | finalize 后所有写工具被 phase 守卫拒绝（本轮未触发，代码与离线测试覆盖） |

## 4. Lead 的独立复核（不采信成员自述）

```bash
cd /tmp/atw-smoke
PATH=<dsh-node-bin>:$PATH node --test
# ℹ tests 3 / ℹ pass 3 / ℹ fail 0   exit=0
find . -maxdepth 2 -type f -not -path './.agentteam/*'
# ./README.md  ./hello.mjs  ./test/hello.test.mjs
```

交付物与 `report.md` 记录一致；`state.json` 显示 W1/W2 `status=approved`、`reportSeq=1`、各 1 轮评审、`gate.pass=true`。

## 5. 本轮观察到的「协议真的起作用」的信号

1. **拒绝作弊**：worker 发现 DoD 命令在本机不可满足时，明确拒绝加 `test/package.json` shim 让字面命令变绿，而是升级给 Lead 裁定——这是"证据优先于断言"的直接体现。
2. **评审有牙齿**：评审者做了 mutation 测试证明套件能失败；在没有真实模型压力的情况下仍写出了带 file:line 的 nit。
3. **收敛后不漂移**：作者在收敛后发现自己交付里还有可改进点（跨写范围的测试断言），**没有**擅自修改，而是说明「会破坏 README 的 tests 3 与团队验收」，把决定权交回 Lead。
4. **双重角色可用**：同一成员既当作者又当评审，没有出现自审（W2 的评审者是 W1 作者，但 W2 的作者是另一人）。

## 6. 已知残余项（不影响本轮收敛，均为已记录 nit）

| # | 内容 | 来源 | 建议 |
| --- | --- | --- | --- |
| 1 | `hello.mjs`/README 声明的「name 原样插入、不 trim」契约没有被测试锁定（`trim()` 变异体仍 3/3 通过） | rev-hello F1（accepted） | 下一轮加 1 条断言 + 同步 README 的 tests 计数（跨写范围，需同轮协调） |
| 2 | README 的示例命令隐含"以仓库根目录为 cwd"，从其它目录执行会 MODULE_NOT_FOUND | impl-hello 的 W2 nit（accepted） | 下一轮在 README 加一行 cwd 说明 |

> 两条都因 run 已 `finalized`（设计上不可事后改写）而没有修改；要修应 `team_flow_plan {replace:true}` 开新一轮（旧 run 归档为 aborted）。

## 7. 结论与限制

- **结论**：最终代码代在本运行时完成了 计划→并行执行→相互审阅→门禁→收敛→报告 的完整闭环；复审修复的 R-19（nits 早停）与 R-01（版本绑定）在真实路径上按预期工作。
- **限制**：这是 **1 次** live 样本（2 items / 3 teammates），不是统计结论；模型遵守协议的比例、nits 触发频率等仍需多轮样本。成本上，本轮 4 个成员 × 约 5 分钟即完成，可作为 7×–15× 量级锚点的参考。
