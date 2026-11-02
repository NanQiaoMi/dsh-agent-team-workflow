# 18 · 正式 Claude Code Agent Teams 对照：差距清单与模仿方案

> 调研时间：2026-11-02。来源：**官方文档实抓**（HTTP 200，Markdown 版正文）：
> [`agent-teams`](https://code.claude.com/docs/en/agent-teams.md)、[`sub-agents`](https://code.claude.com/docs/en/sub-agents.md)、
> [`hooks`](https://code.claude.com/docs/en/hooks.md)、[`tools-reference`](https://code.claude.com/docs/en/tools-reference.md)；
> 以及本仓库 [`docs/01`](01-research-claude-agent-teams.md) 已核实的论文/官方工程博客事实。
> 对照对象：本插件 v1.3.1（`packages/agent-team-workflow`）+ DSH 原生 Agent Teams 原语。
> 结论先行：**协作与治理层我们已经不落后（部分更强），差距集中在"成员个体能力/生命周期控制/UI 交互"三块。**

## 1. 官方 Agent Teams 的完整形态（事实摘要）

| 维度 | 官方实现（Claude Code v2.1.x，experimental） |
| --- | --- |
| 开关 | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，默认关闭；仅交互会话可 spawn（`-p`/SDK 不 spawn） |
| 组成 | Team Lead（主会话）+ Teammates（独立 Claude Code 实例，各自 context）+ 共享 Task list + Mailbox |
| 存储 | 团队配置 `~/.claude/teams/{session-8chars}/config.json`；任务 `~/.claude/tasks/{team}`；信箱 `inboxes/{agent}.json`（逐条校验，坏条目报错并移除） |
| 任务 | `TaskCreate/TaskGet/TaskList/TaskUpdate`；三态 pending/in_progress/completed；依赖阻塞（blocked）；**文件锁**防并发抢单；依赖完成自动解锁 |
| 消息 | `SendMessage` 直发任意成员/会话；自动投递、无需轮询；idle 时自动通知 Lead 并带最终答复 |
| 成员定义 | 可复用 subagent definition（`.claude/agents/*.md`，frontmatter：`tools`/`model`/`effort`/`disallowedTools`/`body` 等）；`tools` 受限、`model` 按 spawn prompt→定义→`CLAUDE_CODE_SUBAGENT_MODEL`→Lead 模型的顺序选择 |
| 权限 | 成员继承 Lead 的 permission mode（`dontAsk` 除外）；spawn 后只能改单个成员的 mode；权限询问冒泡到 Lead；成员不能替用户批准 |
| 计划 | Lead 在 plan mode 时 spawn 的成员先只读规划，完成后向 Lead 发 plan approval；Lead 未审查则自动批准；也可 Lead 手动 review 后批准 |
| 生命周期钩子 | `TeammateIdle`（退出码 2 → 不让它 idle）、`TaskCreated`（阻止创建）、`TaskCompleted`（阻止标记完成）；另有 `SubagentStart/Stop` 等全套 hook 生命周期 |
| UI | agent panel：上下选、Enter 看 transcript/直接对话、x 停止、Ctrl+T 任务列表；idle 行 30s 后隐藏、>3 idle 折叠；两种显示模式：in-process（任意终端）/ split panes（tmux/iTerm2，`--teammate-mode`） |
| 关闭 | 向成员发 shutdown request，成员可同意（优雅退出）或拒绝并解释；`TaskStop` 也能停成员 |
| 已知限制（官方明列） | 无 in-process teammate 会话恢复；任务状态可能滞后；关闭慢；一 session 一 team；**禁止嵌套团队**（成员不能 spawn teammate）；in-process 成员的子代理不能后台；Lead 固定不可转让；权限只能在 spawn 后改；split pane 依赖 tmux/iTerm2 |
| 成本 | 官方：research 多代理 ≈15× chat token；Agent Teams plan mode ≈7× 标准会话；建议 3–5 人、每人 5–6 任务 |

## 2. 我们现在的形态（v1.3.1，可验证）

- **15 个工具**：`plan/status/read/report/review_submit/review_respond/repair/gate/escalate` + 对等协作 `talk/work/decide/item/staff` + `git`。
- **共享任务**：DSH 原生 `team_task_*`（revision/CAS）+ 插件 backing task；依赖、认领、完成、重开都在。
- **协作**：频道（黑板 + 直投）、开放队列自抢、互邀评审、提案+投票（deadline/quorum/惰性自动裁决）、handoff、成员自建项。
- **治理**：DoD、写范围、报告证据（命令+exit_code）、评审 2 轮、findings 回应（fixed/rebut/accepted_risk）、gate 门禁、Lead 仲裁、报告落盘。
- **实时看板**：Web 插件面板（流程图/拓扑/频道/提案/事件/门禁/升级 + 抽屉），快照 route 惰性裁决、no-store。
- **团队自建**：`autoStaff` 自动 spawn/wake；**本轮实测发现并修复**：DSH `spawnTeammate` 要求显式 `provider`，插件此前漏传（live 的 wake 路径掩盖了它，真正 spawn 会报 `provider is required`）。现已加 `freshProvider`/`forkProvider` 配置默认 `spawn`/`fork`。
- **PR 流程**：`prepare/commit/verify/push/pr/review/merge`（gh 可用走 gh，否则 manual compare URL），`gitRequireVerify` 可入门禁。
- **持久性**：DSH roster 成员跨重启 durable；黑板在文件系统；历史 run 归档。

## 3. 能力矩阵（官方 vs 我们）

| # | 维度 | 官方 | 我们 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 独立 context + 共享文件系统 | ✅ | ✅（DSH 原生） | 持平 |
| 2 | 共享任务列表 + 依赖 + 并发抢单 | ✅ 文件锁 | ✅ revision CAS（更强） | **超越** |
| 3 | 成员互发消息（不经 Lead） | ✅ SendMessage | ✅ channel + 原生直投（含 inbox） | 持平 |
| 4 | 任务认领/状态 + 自动解锁 | ✅ | ✅ + 阶段/next_actions 派生 | **超越** |
| 5 | 质量门禁/评审轮次/DoD/证据 | ⚠️ 靠 hooks + 人治 | ✅ 结构化 gate + 证据校验 | **超越** |
| 6 | 提案/投票/仲裁 | ❌ 无 | ✅ deadline+quorum+惰性裁决 | **超越** |
| 7 | 成员自建工作项 | ❌ 只能 Lead 建任务 | ✅ `team_flow_item` | **超越** |
| 8 | 团队自建（Lead 只发 mission） | ✅（自动命名 spawn） | ✅ autoStaff（provider 已修） | 持平 |
| 9 | 每成员模型选择 | ✅ 4 级优先序 | ⚠️ 仅 provider 可选（`freshProvider/forkProvider`），无 per-member 映射 | **部分** |
| 10 | 成员定义复用（角色/工具/effort/body） | ✅ subagent definition | ⚠️ 只有协议注入 + 角色字符串，无角色库/工具限制 | **部分** |
| 11 | 成员工具/权限限制 | ✅ tools/disallowedTools/permissionMode | ❌ 成员拿全量工具；权限由 DSH 会话级策略管 | **缺失** |
| 12 | 计划先行 + plan approval | ✅ | ❌ 无"先交计划再开工"闸门 | **缺失** |
| 13 | 生命周期钩子（idle/task created/completed 可阻断） | ✅ | ❌ 无用户可配 hook | **缺失** |
| 14 | 优雅关闭协议 | ✅ shutdown request/response | ⚠️ 有 release/gate/interrupt，无 shutdown 请求-应答 | **部分** |
| 15 | 用户直接看/聊某个成员（panel/transcript/split） | ✅ | ❌ 看板只读；无成员 transcript/发送入口 | **缺失** |
| 16 | 后台/隔离执行（worktree、background agents） | ✅ worktree isolation、background sessions | ❌ 共享 cwd；git 分支机制有但非隔离 | **缺失** |
| 17 | 成本/token 预算与计量 | ✅ cost 文档 + 面板 | ❌ 无 token/成本字段，无预算门禁 | **缺失** |
| 18 | 跨 session / 跨机器消息 | ✅ cross-session messaging | ⚠️ 团队内 durable 成员可消息；跨 session 未接 | **部分** |
| 19 | 看板/可观测性 | ⚠️ 终端 panel | ✅ Web 实时看板 + 事件流 + 拓扑 | **超越** |
| 20 | 会话恢复 | ❌ 官方限制 | ✅ durable roster + 黑板 | **超越** |
| 21 | 嵌套团队 | ❌ 禁止 | ❌ 禁止（DSH 成员不能 spawn） | 持平 |
| 22 | 团队规模 | 建议 3–5 | roster 上限 8（含 Lead） | 持平 |

**量化差距**：22 个维度里 —— 超越/持平 13 项，部分 4 项（#9 #10 #14 #18），缺失 5 项（#11 #12 #13 #15 #16），另有 #17 计为缺失（偏工程）。真正的差距不是"协作机制"，而是**成员个体能力**（模型/工具/角色）、**生命周期钩子与关闭协议**、**用户与成员交互 UI**、**执行隔离与成本治理**。

## 4. 怎么模仿：按优先级的设计

> 所有设计都映射到 DSH 现有原语：`ctx.agentTeams.spawnTeammate({provider,...})`、`sendMessage`、`interrupt`、
> `team_task_*`、`ctx.connection.fetch` 路由 + `conversation.view` 客户端面板、`ctx.on` 生命周期、`ctx.agents` 注册表。

### Wave 1（P0，1–2 天，收益最大）

**P0-1 每成员模型 / 角色定义（对应 #9 #10）**
- 配置：`workerDefaults: { provider: "spawn" }`；`roles: { "security-reviewer": { provider: "review-fast", rolePrompt: "...", model?: "..." } }`。
- DSH 的 `spawnTeammate` 只接受 `provider` 字符串（registry 里的 provider 名），因此**模型 = 一个 provider 配置**：让用户为"快模型/强模型"各注册一个 provider，插件按 item 的 `role` 或 plan 的 `workerRoles[member]` 选择 provider。
- plan 扩展：`workers: [{name, role?}]`、`reviewers: [{name, role}]`；`team_flow_item` 支持 `role` 已有。
- 角色提示注入：`protocol.renderWorkerBrief` 追加 `roles[role].rolePrompt`；同时把 `role` 写进快照/看板卡片。
- 验收：单测断言 spawn 时 provider 按角色选择；live 用两个不同 provider 的成员跑一轮。

**P0-2 计划先行 + plan approval（对应 #12）**
- 配置 `planFirst: true`（按 item 或全局）；owner 先调 `team_flow_report {kind:"plan", plan:{steps, files, risks}}`（不实现），进入 `plan_review` 新状态；Lead 或指定 peer 用 `team_flow_plan_approve`/`reject` 决定；批准后才允许改代码与正式报告；拒绝附理由 → 回到 owner 重写。
- 状态机：item 增加 `plan` 子记录（`planText`, `planStatus: pending|approved|rejected`, `reviewer`），gate 要求"计划已批准"（若 planFirst）。
- 复刻官方语义：默认 Lead 不审则自动批准（配置 `autoApprovePlan`），或强制人工/peer 审。
- 验收：engine 单测全分支 + 一个 live 小任务演练。

**P0-3 生命周期钩子（对应 #13）**
- 配置 `hooks: { teammateIdle: [], taskCreated: [], taskCompleted: [] }`，每项 `{command|cwd|timeoutMs}`，由插件在对应事件执行（`node:child_process`，用 JSON 传事件），**退出码 2 = 阻断**（idle 不放行 / 创建回滚 / 完成回滚），stdout 作为反馈写给成员。
- 事件源：我们的工具边界天然可挂（report/review/gate/task claim），TeammateIdle 用 `ctx.on('agent/turn-end')` 或 `wait_agent` 观测；TaskCreated/Completed 在 `team_task_*` 代理点触发。
- 与官方差异：官方是 shell hook 全家桶；我们只做团队相关的 3 个事件，够用且可控。
- 验收：hook 阻断 case 的单测（临时脚本 exit 2）+ 文档示例（pre-commit 式校验）。

**P0-4 优雅关闭 + 停止（对应 #14）**
- 新工具 `team_flow_stop {member, mode:"graceful"|"interrupt", reason}`：graceful → 发 `[SHUTDOWN]` 消息并等待其回 `team_flow_stop_ack {accept|reject, reason}`（状态机记 `stopping` → `stopped`）；interrupt → 走 DSH `ctx.agentTeams.interrupt`。
- 后端权限：仅 Lead；成员可拒绝并说明，Lead 可升级为 interrupt；看板显示 stopping/stopped。
- 验收：单测 + live 演练一次 graceful shutdown。

**P0-5 成员面板（看 \ transcript + 直接发消息）（对应 #15）**
- 路由：`GET /api/agent-team-workflow.member?session=…&name=…` 返回成员名/状态/当前 item/最近 N 条频道/工具摘要（DSH 侧不暴露完整 transcript 时，用 workflow 事件 + 频道 + native task 状态拼出"工作流视图"）；`POST` 同路径接受 `{name, message}` → `ctx.agentTeams.sendMessage`。
- 客户端：成员抽屉（点拓扑节点/成员行）显示状态、当前 items、最近活动、输入框"发消息"（走 POST，1.2s 轮询刷新）；不伪造 transcript，明确标注"工作流视图"。
- 验收：路由单测（GET/POST/未知成员/权限）+ 客户端契约测试；live 给某个成员发消息并看到它接单。

### Wave 2（P1，2–3 天）

**P1-1 工具/权限沙箱（#11）**
- DSH 没有 per-agent tool allowlist 暴露给插件；可行折中：`roles[].allowedActions` 只约束**工作流工具**（如 reviewer 角色禁止 `team_flow_report` 写实现、只读角色禁止 `commit/push`），并在 unwrap 时拒绝；真正的 shell/文件权限仍由 DSH 会话策略管。文档必须写明边界，不虚称"沙箱"。

**P1-2 执行隔离 worktree（#16）**
- `gitEnabled` + 新配置 `isolation: "worktree-per-member"`：为每个成员/每个 item 建 `git worktree`（`.agentteam/worktrees/<item>`），成员在该目录工作（需要 DSH 支持 cwd 切换或成员 prompt 显式 `cd`；当前共享 cwd 下只能做**顺序隔离**：同一时刻只允许一个 item 持有 worktree，用 claim lease 串行化）；合并由 git 工具 gate 后执行。
- 这是最难的一块，因为 DSH 成员共享 cwd 是平台语义；建议先做"分支 + 串行 worktree"的诚实版本。

**P1-3 成本/预算（#17）**
- 读 DSH usage：`ctx.agents`/cost-meter 若暴露 token 计数则聚合到 item/report；否则用 `commands`/时长粗估。看板加"成本"面板；配置 `budget: {tokensPerItem, tokensPerRun}`，超预算 → gate 失败或警告。
- 先做"可观测"（显示 token/耗时）再做"强门禁"，避免拿不到数据时虚报。

**P1-4 跨 session 消息（#18）**
- DSH 有 durable roster 与多 session；若 registry 能列出其他 session 的 team 成员，加 `team_flow_talk {target:"session:<id>", ...}`（或只做"本 team 内 durable 成员"，已具备）。先调研 DSH 是否有 cross-session 投递原语，没有就不做。

### Wave 3（P2，可选）
- 成员自定义工具集（需 DSH 开放 per-agent tools；当前不可行）。
- 显示模式（split panes）→ Web 等价物是"多面板/独立窗口"，成本高收益低。
- 团队级 quota/并发上限、自动降级（官方无，非必须）。

## 5. 建议的落地顺序与验收

| 顺序 | 项 | 依赖 | 验收 |
| --- | --- | --- | --- |
| 1 | provider 修复（已完成） | — | 单测：spawn 必带 provider；2 个 harness 用例 |
| 2 | P0-1 角色/模型映射 | provider 修复 | 单测 + live（两 provider 成员） |
| 3 | P0-4 stop 协议 | 无 | 单测 + live graceful/interrupt |
| 4 | P0-2 plan approval | 无 | engine 全分支单测 + live |
| 5 | P0-3 hooks | 无 | hook-block 单测 + 文档示例 |
| 6 | P0-5 成员面板 | route/client | 路由+客户端契约测试 + live |
| 7 | P1-2 worktree 隔离 | git 工具 | 真实 git e2e（串行 worktree） |
| 8 | P1-3 成本面板 | usage 数据 | 快照字段 + 看板面板（数据缺失时显示"未采集"） |

## 6. 一句话回答"还差多少"

**协作/治理/可观测性：已超过官方 experimental 版本**（官方自己列了任务状态滞后、会话恢复、关闭慢等限制，我们分别用 CAS 任务、durable roster、结构化门禁补上了）。
**真正的差距是 5 个缺失项 + 4 个部分项**，集中在"每个成员作为独立工程实体"的能力（模型/角色/工具/权限/计划审批）、"生命周期控制"（hooks/关闭协议）、"人机交互"（成员 transcript/直聊）、"执行隔离与成本"。
按 Wave 1 的 5 项补完，就能在**交互形态**上接近正式 Claude Code 的 Agent Teams；其中 P0-1/P0-4/P0-3 的实现量最小、收益最直接。
