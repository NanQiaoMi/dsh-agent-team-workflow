# 01 · Claude / Anthropic Agent Teams 与可复用多智能体协作成果调研

> 目标读者：要设计 `agentteam-kit` 插件的人。
> 用途：给出**可核查**的事实底座 + 一张可执行的设计框架 + 对 DSH 原生原语的映射与缺口。
> 调研时间：2026-11-01。检索方式：`web_fetch` 实际抓取（HTTP 200）+ arXiv API 校验论文 ID。
> 唯一写入文件：本文件。

## 0. 阅读约定与证据分级

本文三类断言严格区分，正文中用行内标记或小节标注：

| 标记 | 含义 | 可信度来源 |
| --- | --- | --- |
| 【官方事实】 | Anthropic 官方工程博客 / Claude Code 官方文档原文所述 | 文末链接，均已抓取核对 |
| 【论文结论】 | 论文摘要或正文的实验/机制描述 | arXiv 页面链接 |
| 【推断】 | 我基于上述材料对本设计给出的判断，可能错 | 明确标注，可被推翻 |
| 【核查说明】 | 检索过程中的缺失项、冲突项、未能验证项 | 见 §6 与附录 |

三条硬性核查结论先说：

1. **Claude Code 的 Agent Teams 是 experimental、默认关闭**，需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`；官方文档明确列出会话恢复、任务状态、关闭流程等已知缺陷。【官方事实】
2. **Anthropic 官方文档中不存在名为 "delegate mode" 的独立功能条目**。我抓取了 agent-teams、sub-agents、permission-modes、agents、costs、llms.txt 索引，均未命中。最接近的机制是「plan mode + plan approval」与官方最佳实践里「Lead 不应自己抢活干、要等 teammate」的纪律。【核查说明】若 "delegate mode" 指 DSH 侧概念，需 Lead 确认，本文不臆造。
3. 多智能体的收益与成本都极大：官方内部研究评测 +90.2%，但 token 约 **15×**；Claude Code Agent Teams 计划模式下约 **7×** 标准会话。【官方事实】

### 0.1 结论速览（给设计者的 8 条，详细依据见后文）

1. **团队不是默认档**。默认单 agent 或串行 workflow；只有「可并行 +（只读 或 产物可独立校验）+ 能写出完成谓词 + 高价值」同时成立才组队（§3.4 准入矩阵）。
2. **规模默认 3 人**（1 实现 + 1 评审 + 1 验证），上限 5；每人 5–6 个任务（§1.4 官方建议）。
3. **上下文共享靠 artifact / 黑板，不靠消息**。这是 Cognition「share context」与 Anthropic「子代理产出落盘减少传话游戏」的交集（§3.1）。
4. **并行只给只读探索与可独立校验的产物**；任何并行写必须先做文件所有权分区，且作者 ≠ 评审（§4.5、§4.7）。
5. 每个任务必须有 **AC + 证据 + 写范围 + 预算**；「完成」要过门禁，不能以作者自述为准（§4.4、§5.3）。
6. **评审 ≤ 2 轮 + 枚举 verdict + P0/P1/P2 分级 + 预设 rubric**；超限走仲裁阶梯（§4.5、§4.6）。
7. **成本先报再跑**：15×（研究系统）/ 7×（Claude Code teams in plan mode）是两个可引用的锚点；开跑前给出 N× 估算（§4.8）。
8. 团队的真正价值是 **把 MAST 三类失败（系统设计 / 间错位 / 验证）变成可检测状态**，不是让单个模型变聪明（§3.2）。

---

## 1. Anthropic 官方工程资料

### 1.1 多智能体研究系统（orchestrator-worker 的工业样本）

来源：[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)【官方事实】

**架构**：Lead Researcher（主代理）规划 → 并行创建 Subagent（各自独立 context window、独立工具/提示/探索轨迹）→ 各自多轮搜索并把「压缩后的发现」回传 → Lead 综合、决定是否再派 → 全部完成后交给 CitationAgent 统一挂引用。规划本身写入 Memory，因为 context 超过 200k 会被截断，必须持久化计划。

**为什么有效（官方给出的机制解释）**：

| 机制 | 官方原文要点 |
| --- | --- |
| 压缩 | 「搜索的本质是压缩」；子代理在自己的 context 里探索，只把最重要的 token 压回给 Lead |
| 关注点分离 | 每个子代理有 distinct tools / prompts / trajectories，降低 path dependency |
| 并行 | Lead 同时起 3–5 个子代理；子代理内部并行调 3+ 个工具；复杂查询研究时间最多缩短 90% |
| 算力换性能 | BrowseComp 上三个因素解释 95% 方差，其中 **token 用量单独解释 80%**；多代理本质是「把 token 花在并行推理上」 |

**关键数字**：

| 指标 | 数值 | 备注 |
| --- | --- | --- |
| 内部研究评测提升 | **+90.2%** | Claude Opus 4 作 Lead + Sonnet 4 作 subagent vs 单 Claude Opus 4 |
| token 倍数 | chat 1× / agent ≈4× / **multi-agent ≈15×** | 官方原文 "about 15× more tokens than chats" |
| 早期失败 | 简单查询起 50 个子代理；重复劳动；互相刷屏更新 | 官方自述的失败模式 |

**给子代理写任务说明的四要素**（这是全篇最可直接抄的工程约束）：

1. **objective**（目标）
2. **output format**（输出格式）
3. **guidance on tools and sources**（工具与来源指引）
4. **clear task boundaries**（任务边界）

官方明确：任务描述不详细时，子代理会重复劳动、留缺口、或找不到必要信息（例：一个子代理查 2021 汽车芯片危机，另两个重复查 2025 供应链）。

**工作量缩放规则**（写进 prompt 的启发式）：

| 查询类型 | 建议投入 |
| --- | --- |
| 简单事实查找 | 1 个 agent，3–10 次工具调用 |
| 直接对比 | 2–4 个子代理，每个 10–15 次调用 |
| 复杂研究 | >10 个子代理，职责明确划分 |

**评估方式**（可复用为插件的 eval harness 设计）：

- **立刻用小样本开始**：一开始只有约 **20 条**真实查询，就足以看出 prompt 改动 30%→80% 的效应。
- **LLM-as-judge + rubric**：单次 LLM 调用输出 0.0–1.0 分 + pass/fail，比多裁判组合更稳定、更贴近人类判断。rubric 五维：factual accuracy / citation accuracy / completeness / source quality / tool efficiency。
- **人工评估抓自动化漏掉的**：早期 agent 偏爱 SEO 内容农场而非权威来源，靠人工测试发现，再补进 prompt 的 source-quality 启发式。
- **端状态评估**（改状态的 agent）：不看「是否走了规定步骤」，看最终状态对不对；复杂流程拆成离散 checkpoint。

**生产可靠性教训**（对插件状态机设计直接相关）：

- Agents are stateful and errors compound → 必须可断点续跑、确定性重试、周期 checkpoint。
- 需要全链路 tracing 才能 debug 非确定性行为；观测「决策模式与交互结构」而非对话内容。
- **同步执行是瓶颈**：官方当前 Lead 同步等待一批子代理，导致「Lead 无法 steer 子代理、子代理之间无法协调、一个慢子代理阻塞全局」。官方判断异步化收益值得，但会引入结果协调/状态一致/错误传播复杂度。
- **子代理产出写文件系统**，只回传轻量引用，减少「传话游戏」的信息损耗与 token 开销。

→ **对插件设计的直接约束**：任务卡必须强制四要素（目标/输出格式/工具与来源/边界）；默认并行度 3–5，必须显式给「投入缩放规则」；审阅判据优先用单裁判 rubric（5 维），不要一上来搞多裁判委员会；子代理产出落盘为 artifact，消息里只传路径与摘要；必须内置「可中断/可续跑」的执行记录。

### 1.2 Building effective agents：workflows vs agents 与五种工作流

来源：[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)【官方事实】

**定义区分**：

- **Workflow**：LLM 与工具通过**预定义代码路径**编排。
- **Agent**：LLM **动态决定**自己的流程与工具使用，自主掌控如何完成任务。

**五种工作流模式**（这是「何时不该上团队」的判据来源）：

| 模式 | 机制 | 何时用 | 对本设计的含义 |
| --- | --- | --- | --- |
| Prompt chaining | 串行拆步，中间可加程序化 gate | 任务可干净拆成固定子任务 | 最便宜的「多角色」：无需并行，只需分阶段 |
| Routing | 先分类再分发到专门流程 | 输入类别清晰、分类可靠 | 团队前先做路由：不是所有任务都配团队 |
| Parallelization | **Sectioning**（拆独立子任务并行）/ **Voting**（同一任务多次取样） | 可并行提速，或需多视角提高置信 | Voting 就是「多评审投票」的官方原语 |
| Orchestrator-workers | 中心 LLM 动态拆解、委派、综合 | 子任务**无法预先枚举**（如多文件改动） | 与团队最接近；区别是 worker 不互相对话 |
| Evaluator-optimizer | 一个生成、一个评估并反馈，循环 | **评估标准清晰**且迭代有可测收益 | 评审协议的原型：作者 ≠ 评审，判据明确 |

**官方三条原则**：simplicity（能简单就别复杂）、transparency（显式展示规划步骤）、ACI（agent-computer interface 要像 HCI 一样认真设计，含 poka-yoke、绝对路径而非相对路径等）。

**官方明确的反面条件**：多数场景优化单次 LLM 调用 + 检索 + in-context 示例就够了；agentic 系统是用延迟和成本换性能；只在**可证明**带来收益时才加复杂度。

→ **对插件设计的直接约束**：插件必须先提供「单 agent / 串行 workflow / 并行投票 / orchestrator-worker / 评审-优化」这五档，并有一个**默认选档策略**；团队只是其中两档（orchestrator-worker + evaluator-optimizer 的组合），不能作为默认路径；每一档都要有一句「不满足即降档」的判据。

### 1.3 Claude Code subagents：单会话内的委派原语

来源：[Create custom subagents](https://code.claude.com/docs/en/sub-agents)【官方事实】

| 维度 | 事实 |
| --- | --- |
| 上下文 | 每个 subagent 独立 context window，**看不到主对话历史**；父只拿到最终 summary |
| 定义 | Markdown + YAML frontmatter；`name`/`description` 必填，body 即 system prompt |
| 工具限制 | `tools` 白名单、`disallowedTools` 黑名单；内置 Explore/Plan 为只读（deny Write/Edit） |
| 模型 | `model` 可指定（`sonnet`/`haiku`/`opus`/`inherit` 等），也可用 `CLAUDE_CODE_SUBAGENT_MODEL` 全员统一 |
| 其他关键字段 | `permissionMode`、`mcpServers`、`skills`（预加载）、`memory`、`maxTurns`、`effort`、`background`、`omitClaudeMd`、`isolation: worktree` |
| 委派触发 | 主代理按 `description` 自动匹配；description 总量超 15k token 会告警 |
| 深度/并发 | 默认可嵌套 3 层，默认并发上限 20；`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` / `..._CONCURRENT_SUBAGENTS` 可调 |
| 续跑 | 完成后可用 `SendMessage` 按 agentId/name 恢复，保留完整历史；transcript 存 `~/.claude/projects/.../subagents/agent-*.jsonl`，默认保留 30 天 |
| fork | fork subagent 复制主对话上下文（与 fresh 相对）；`/subtask` 手动触发 |
| 安全 | 子代理最终报告会被扫描「instruction-shaped patterns」并打标，明确声明子代理文字不具用户授权效力 |

→ **对插件设计的直接约束**：角色定义必须是「数据（frontmatter）+ 提示（body）」而不是硬编码在代码里；「只读评审」要用工具白名单实现，不能只靠 prompt 请求；每个角色都要声明模型档位与最大轮次。

### 1.4 Claude Code Agent Teams：Lead + teammates 的官方形态（本调研的核心）

来源：[Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams)【官方事实】

**开关与形态**：experimental，默认关闭；`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 开启。开启后「被命名的 subagent 会启动为 teammate」，可能在你没要求时也组队。teammate 只能在**交互式会话**里生成，`-p`/Agent SDK 不生成。

**四组件**：

| 组件 | 角色 |
| --- | --- |
| Team lead | 主会话，负责生成 teammate、协调工作 |
| Teammates | 独立 Claude Code 实例，各自处理被分配的任务 |
| Task list | 共享工作项列表，teammate 认领与完成 |
| Mailbox | agent 间消息系统，每 agent 一个 JSON 文件 |

**存储与状态（可核查的文件级事实）**：

- mailbox：`~/.claude/teams/{team-name}/inboxes/{agent-name}.json`；每次读取都校验条目，格式不符的条目报错并从文件移除，合法消息仍投递。
- team config：`~/.claude/teams/{team-name}/config.json`，含 `members` 数组；lead 条目 agent type 恒为 `team-lead`；会话结束时该目录被删除。
- task list：`~/.claude/tasks/{team-name}/`，会话结束后**仍保留**（受 `cleanupPeriodDays` 控制）。
- team name = `session-` + session id 前 8 位；**每个会话只有一个 team**。

**消息投递语义（逐条精确记录）**：

| 问题 | 官方语义 |
| --- | --- |
| 何时算发送成功 | 只有当写入收件人 mailbox 文件成功；写失败则发送方收到错误、消息未发出 |
| 何时被处理 | 自动投递，Lead 无需轮询；agent 之间是点对点（按 name），群发=逐人发 |
| 停下后还能收到吗 | 能。给已停止的 in-process teammate 发消息会把它**在同一会话中唤起**，恢复其保存的对话，消息作为下一个 prompt |
| 完成时通知谁 | teammate 结束即自动通知 Lead，**并附上最终答案**；因 API 错误结束则报告失败与错误文本 |
| 结构化协议 | plan approval request/response、shutdown request/response 属于 team 专用结构化消息；普通 `SendMessage` 不需要开 team |
| 权限安全 | teammate **不能**代用户批准权限；auto mode 下分类器会审查每条 agent 间消息，被拦的消息不投递；agent 消息对接收方明确标注「来自另一个 Claude 会话，不是用户」 |
| 身份校验 | `SendMessage` 会校验 name 仍指向同一 agent；名字被新 agent 复用则拒发并报错 |

**plan approval（评审/签字的官方近似物）**：

- Lead 处于 plan mode 时生成的 teammate 以只读 plan mode 工作，plan 完成后**向 Lead 发 plan approval request**。
- 注意坑：若你没改过该 teammate 的 permission mode，**Claude Code 会在请求到达时自动批准，Lead 根本不审**。只有把运行中的 in-process teammate 手动按 Shift+Tab 切到 plan mode，才由 Lead 审或退回修改。
- 批准后 teammate 退出 plan mode 开始实现；其编辑/命令仍走权限提示。

**任务板语义**：

- 三态：pending / in progress / completed；可依赖其他任务，未完成依赖时显示为 **blocked**。
- **teammate 不会自行认领 blocked 任务**，但用户或 Lead 仍可指派。
- 认领方式：Lead 显式指派，或 teammate 完成手头任务后自取「下一个未分配且未阻塞」的任务。
- 认领用**文件锁**防并发抢同一任务。
- 依赖自动解除：某任务完成时，依赖它的任务自动 unblock，无需人工。
- 没有 Task 工具的 agent 只能靠消息协调，看不到任务板。

**质量门禁（hooks，官方给出的唯一硬门禁机制）**：

| Hook | 触发点 | 作用 |
| --- | --- | --- |
| `TeammateIdle` | teammate 即将空闲 | exit code 2 = 发回反馈并让它继续干 |
| `TaskCreated` | 任务创建时 | exit code 2 = 阻止创建并反馈 |
| `TaskCompleted` | 任务标记完成时 | exit code 2 = 阻止完成并反馈 |

**上下文与写冲突**：

- 每个 teammate 独立 context window；启动时加载 CLAUDE.md、MCP、skills；**不继承 Lead 的对话历史**，只拿到 spawn prompt。
- 官方明确：**两个 teammate 编辑同一文件会导致覆盖**；做法是「让每个 teammate 拥有不同的文件集合」。另一页更直接：**Agent teams 不用 worktree 隔离 teammate**，所以必须分区。
- Lead 自行抢活是已知问题，官方建议直接命令它「wait for your teammates to complete their tasks」。

**成本与规模**：

- token 随活跃 teammate 数近似线性增长；官方建议 **3–5 个 teammate 起步**；若 15 个独立任务，3 个 teammate 是好起点。
- 每个 teammate **5–6 个任务**较能保持产出。
- in-process teammate 的请求不在主对话 cache TTL 桶内，默认 5 分钟缓存；`subagentPromptCacheTtl` 可提到 1h（更贵）。
- 官方成本文档：teammates 跑 plan mode 时，agent teams 约 **7×** 标准会话 token。
- 官方给出的降本清单：teammate 用 Sonnet；团队要小；spawn prompt 要短；干完就关。

**已知限制（设计时必须当作硬约束）**：

| 限制 | 后果 |
| --- | --- |
| in-process teammate 不支持会话恢复（`/resume`、`/rewind`） | 恢复后 Lead 可能给不存在的 teammate 发消息 |
| 任务状态可能滞后（teammate 忘了标完成） | **阻塞依赖任务**；需人工/Lead 纠正 |
| 关闭慢 | teammate 要跑完当前请求/工具调用才退出 |
| 一个会话一个 team | 不能开多个命名 team，不能跨会话共享 |
| **不能嵌套 team** | teammate 不能再生成 teammate；只有 lead 管 team |
| Lead 固定 | 不能把 teammate 提升为 lead |
| 权限在 spawn 时定 | 不能按 teammate 设权限模式 |
| split pane 依赖 tmux/iTerm2 | 默认 in-process 无此问题 |

**官方推荐的团队用法（可直接作为插件的默认用例模板）**：

1. **并行 code review**：每个 reviewer 一个视角（安全/性能/测试覆盖），Lead 汇总。
2. **竞争性假设排障**：多个 teammate 各持一个假设并**互相反驳**，像科学辩论；官方称「辩论结构是关键机制」，用于对抗顺序调查的 anchoring。
3. **新模块/特性**：每人一个互不重叠的部分。
4. **跨层协调**：前端/后端/测试各一人。

→ **对插件设计的直接约束**：
- 消息必须允许「唤醒 inactive 成员」并把它当作续跑而非重启；消息投递要能区分「已入队」与「已处理」。
- 任务板必须有三态 + blocked_by + 认领互斥；且**必须显式处理「状态滞后」**（超时未标完成 → 自动检测并升级）。
- 写冲突只能靠**文件所有权分区**，不能指望运行时锁；插件应把「写范围」从建议升级为创建任务时的必填字段。
- 必须提供等价于 `TaskCompleted` 的完成门禁，否则完成的唯一依据是作者自述。
- 默认 3–5 人；超过 5 人必须有明确理由（并行度实测收益）。

### 1.5 Agent SDK 的 subagent 与「上限三件套」

来源：[Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents)【官方事实】

- 编程式定义 `AgentDefinition`：`description` / `prompt` / `tools` / `disallowedTools` / `model` / `skills` / `memory` / `mcpServers` / `maxTurns` / `background` / `omitClaudeMd` / `effort` / `permissionMode` / `autoCompactWindow`。
- 三项硬上限（这是「防团队失控」的标准答案）：**depth**（默认 3 层）、**concurrency**（默认 20 个并发 subagent）、**spend**（`maxBudgetUsd` / `max_budget_usd`；到顶会拒绝再 spawn、停掉后台 subagent、以 `error_max_budget_usd` 结束）。
- 默认后台运行（`status: "async_launched"`），父需要结果时才阻塞等待；也可在定义里 `background: true` 固定后台。
- 大规模编排的官方路径不是「更多 subagent」，而是 **Workflow**：把编排搬进脚本，运行时在对话上下文之外执行。

→ **对插件设计的直接约束**：插件必须实现「深度上限 / 并发上限 / 预算上限」三件套，且**预算不足时的行为要定义**（拒绝新任务 vs 降级 vs 停下来问 Lead）；超过 ~8 个成员应考虑改用脚本化 workflow，而不是继续加 teammate。

### 1.6 Managed Agents：状态、执行器、工具三者的解耦（架构级参考）

来源：[Scaling Managed Agents with stable interfaces](https://www.anthropic.com/engineering/managed-agents)【官方事实】

- 把 agent 虚拟化成三个可独立替换的接口：**session**（append-only 事件日志，可作为 context 对象被 `getEvents()` 按位置切片查询）、**harness**（调模型、路由工具调用的循环，无状态可崩溃重启 `wake(sessionId)`）、**sandbox**（执行环境，通过 `execute(name, input) → string` 当普通工具调）。
- 收益：容器变「cattle」，坏了当工具错误回传；推理不必等容器；p50 TTFT 降约 60%、p95 降 90%+；凭证不进沙箱（Git token 在初始化时注入 remote，MCP token 在 vault + proxy）。
- 关键洞见：**session 不是模型的 context window**；上下文管理策略属于 harness，session 只保证「持久、可被任意切片读取」。

→ **对插件设计的直接约束**：协调状态的唯一真相源必须是**持久、可回放的事件/任务记录**（本插件里就是任务板 + blackboard 文件），不能只存在于某个成员的消息里；「谁在看什么上下文」由 Lead 决定并记录；凭证/敏感信息不进成员可见范围。

---

## 2. 学术工作：每一篇只要一句核心机制 + 一个可用点

全部论文 ID 已通过 [arXiv API](https://export.arxiv.org/api/query) 校验存在（2026-11-01）。

| 工作 | 核心机制（一句） | 对本设计的可用点 | 链接 |
| --- | --- | --- | --- |
| **MetaGPT** | 把人类 **SOP 编码进 prompt 序列**，用装配线范式给 agent 分配产品经理/架构师/工程师/QA 等角色，产出结构化中间物，从而抑制「链式级联幻觉」 | 角色卡 + 阶段化 SOP + **结构化中间产物**（PRD、设计、接口、代码）就是质量门禁的载体 | [2308.00352](https://arxiv.org/abs/2308.00352) |
| **ChatDev** | 用 **chat chain** 规定「沟通什么」、communicative dehallucination 规定「怎么沟通」，多轮对话走完设计/编码/测试，测试阶段形成评审环 | 「阶段 + 每阶段的对话契约 + 测试环」可直接映射为任务 DAG + 评审环节 | [2307.07924](https://arxiv.org/abs/2307.07924) |
| **CAMEL** | **inception prompting**：用一条任务规格把两个角色（AI user / AI assistant）「启动」成可自主推进的角色扮演对话 | 角色扮演的最小实现：一段 role prompt + 一个任务规格即可；适合「研究员 vs 挑刺者」配对 | [2303.17760](https://arxiv.org/abs/2303.17760) |
| **AutoGen / AgentChat** | 可对话 agent + **conversation programming**（用自然语言或代码编排对话模式），支持 GroupChat 与 human-in-the-loop | 「对话即编排」：消息图本身就是控制流；HITL 是一等公民 | [2308.08155](https://arxiv.org/abs/2308.08155) |
| **Mixture-of-Agents (MoA)** | 分层聚合：每层多个 agent，**每个 agent 读上一层全部输出**再生成 | 黑board/聚合层的原型；适合「多份草稿 → 综合稿」 | [2406.04692](https://arxiv.org/abs/2406.04692) |
| **AgentVerse** | 团队组成可随任务**动态调整**，多 agent 协作后出现可观测的涌现社会行为 | 「招募/淘汰成员」的合法性；同时提醒涌现行为不可完全预设 | [2308.10848](https://arxiv.org/abs/2308.10848) |
| **DyLAN** | 两阶段：先用 **Agent Importance Score** 选人，再按 query 动态决定通信结构；信息无增益时早停 | 选人指标 + 早停条件 = 插件的「组队」与「收敛」判据 | [2310.02170](https://arxiv.org/abs/2310.02170) |
| **Chain-of-Agents (CoA)** | 多个 worker **顺序**处理长文分段，manager 汇总；每个 agent 只看短上下文 | 长材料场景用「链」而非「扇出」；顺序协作也能降单点上下文压力 | [2406.02818](https://arxiv.org/abs/2406.02818) |
| **Self-Refine** | 同一个 LLM 依次扮生成者/反馈者/改进者，迭代自评自改；7 类任务平均绝对提升约 20% | 最便宜的一轮自审；可作评审前的自检门 | [2303.17651](https://arxiv.org/abs/2303.17651) |
| **Reflexion** | 不更新权重，用**语言化反馈**写进 episodic memory，下一次试验据此改进（HumanEval 91% pass@1） | 失败复盘要落盘为可检索的记忆，而不是留在某个成员脑子里 | [2303.11366](https://arxiv.org/abs/2303.11366) |
| **LLM-as-a-judge (MT-Bench / Arena)** | 强 LLM 当裁判可达到与人类 80%+ 一致；同时存在 position / verbosity / self-enhancement 偏差 | 裁判可以用，但必须固定 rubric、随机化顺序、避免自己评自己 | [2306.05685](https://arxiv.org/abs/2306.05685) |
| **Multiagent Debate** | 多个实例多轮提出与辩论答案/推理，收敛到共同答案；提升事实性与推理 | 冲突场景的仲裁原语：辩论 + 收敛，而不是 Leader 拍脑袋 | [2305.14325](https://arxiv.org/abs/2305.14325) |
| **MAST** | 1600+ 条标注轨迹、7 个主流 MAS 框架，归纳 **14 种失败模式 / 3 大类**（系统设计、agent 间错位、任务验证），κ=0.88 | 失败分类学 = 插件质量门禁的检查清单来源 | [2503.13657](https://arxiv.org/abs/2503.13657) |

### 2.1 流程化：MetaGPT 与 ChatDev 的「可复用三件套」

- **角色化**：每个 agent 有明确职责边界与交付物，而不是「通用助手」。
- **SOP 注入**：把「先做什么、产出什么格式、谁验收」写进 prompt 序列，而不是让模型即兴发挥。
- **结构化中间物**：交付物是文档/接口/测试用例，可被下游与评审直接消费——这是**评审能落地**的前提。

【论文结论】MetaGPT 的动机原文是：朴素链式调用 LLM 会产生 cascading hallucinations 与逻辑不一致，SOP + 角色分工 + 中间验证可缓解。

→ **对插件设计的直接约束**：任务卡里必须有「交付物 schema」；没有结构化交付物的任务不允许进入评审阶段（否则「审阅」退化为读后感）。

### 2.2 角色扮演与对话：CAMEL / AutoGen

- CAMEL 的价值是**极低成本启动协作**：一段 inception prompt + 任务规格，两个角色就能自我推进。
- AutoGen 的价值是**把对话本身当编排层**：谁对谁说话、说到什么条件停，都由 conversation program 决定；GroupChat 提供多方讨论，human-in-the-loop 是显式模式。

→ **对插件设计的直接约束**：不要发明复杂的编排 DSL；先把「谁 → 谁、什么条件停」定义成可读的对话/消息契约，再谈状态机。

### 2.3 聚合与扩展：MoA / Chain-of-Agents

| 场景 | 用哪种 | 理由 |
| --- | --- | --- |
| 多份独立草稿要合成一份 | MoA 式分层聚合 | 后层看到前层全部输出，信息不丢 |
| 单份超长材料要读完再答 | CoA 式顺序链 | 每段独立短上下文，manager 汇总 |
| 多个独立子问题 | 扇出（orchestrator-workers） | 无相互依赖，最省协调成本 |

→ **对插件设计的直接约束**：插件要显式区分「扇出 / 链式 / 分层聚合」三种拓扑，并在任务创建时选一种，不能混着用。

### 2.4 组队与动态结构：AgentVerse / DyLAN

- AgentVerse：团队构成可以动态调整；同时报告了**负面涌现行为**（从众、退化）需要抑制。
- DyLAN：先试跑算 importance score 再选人；通信结构随 query 变化；无新信息时提前停止。

→ **对插件设计的直接约束**：「组队」应作为一次小规模试跑（pilot）后的决策，而不是拍脑袋定 5 个人；必须有「无增益即停」的早停规则。

### 2.5 审阅与验证的四种原语（成本从低到高）

| 原语 | 参与者 | 轮次 | 成本 | 弱点 | 适用 |
| --- | --- | --- | --- | --- | --- |
| Self-Refine | 1（自己） | 1–3 | 最低 | 自评偏差，可能越改越差 | 交付前自检 |
| Reflexion | 1 + 记忆 | 跨试验 | 低 | 依赖有可靠反馈信号 | 有测试/执行的场景 |
| Evaluator-optimizer | 2（作者 + 评审） | 2–3 | 中 | 评审标准模糊就退化 | 有明确 rubric 的产出 |
| LLM-as-judge（独立裁判） | 1 裁判 | 1 | 中 | position/verbosity/self-enhancement 偏差 | 批量评估、gate |
| Multiagent debate | 3–5 | 2–3 轮 | 高 | 易从众；成本线性 | 高不确定、需交叉验证的结论 |

→ **对插件设计的直接约束**：默认组合是「Self-Refine（作者自检）→ 独立 Reviewer（evaluator-optimizer）→ 仅当结论冲突或高风险时升级到 debate/judge」，不要一上来三方辩论。

---

## 3. 反方观点与失败实证：什么条件下**不该**用团队

### 3.1 Cognition《Don't Build Multi-Agents》的两个原则

来源：[Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)（Walden Yan, 2025-06-12）【论文结论｜工业界立场文章，非同行评审】

**两条原则**：

1. **Share context**：共享上下文，且共享**完整 agent trace**，不是只共享单条消息。
2. **Actions carry implicit decisions**：动作携带隐式决策；**相互冲突的隐式决策产生坏结果**。

**论证链条**：

- 「拆任务 → 子代理做 → 合并」的架构很脆弱。经典例子：Flappy Bird 克隆拆成「背景 + 鸟」两个子任务，子代理 1 做出马里奥风格背景、子代理 2 做出不像游戏素材的鸟，最后合并者收拾烂摊子。
- 更隐蔽的问题：即使把原始任务贴给每个子代理，两个子代理**互相看不见对方在做什么**，各自基于「未事先规定的假设」行动 → 风格/接口/命名不一致。
- 作者认为这两条原则重要到「应当默认排除不满足它们的架构」。
- 最省事的合规做法是**单线程线性 agent**（上下文连续）；上下文超限时，用一个**专门压缩历史动作与决策的模型**（Cognition 甚至为此微调小模型），而不是拆人。
- 对「多 agent 互相讨论达成共识」的判断：人类能高效沟通关键知识，这本身需要高级智能；2025 年的 agent 做不到比单 agent 更可靠的长期程主动对话，**决策被分散、上下文共享不充分**，因此多 agent 协作是脆弱系统。
- 文中把 2025-06 的 Claude Code 当作「刻意保守」的正面例子：它不并行跑子代理，子代理通常只被问问题、不写代码，因为子代理缺少主 agent 的上下文，并行还会产生冲突响应。

**但要注意作者的限定**：他并不否定长期可能性，且明确承认「真正的长任务 + 愿意投入」时可以用上下文压缩等方案突破；他的反对对象是**在上下文无法共享时强行并行**。

与 Anthropic 的张力：Anthropic 的研究系统明确说「子代理各有独立 context window 并压缩回传」正是其收益来源（§1.1）；而子代理产出落盘、只回传引用（§1.1 附录）实际上是在工程上**部分满足** Cognition 的 principle 1——把共享上下文从「对话历史」换成了「文件系统里的 artifact」。这是两派真正的可调和点。

→ **对插件设计的直接约束**：凡是会产生**隐式决策**的并行写操作（多人同时改代码/改配置），默认禁止；并行只允许用于**只读探索**与**产出可独立校验的 artifact**。共享上下文用「共享文件系统 + artifact 索引」实现，不指望消息传递。

### 3.2 MAST：多智能体失败的实证分类

来源：[Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)【论文结论】

- 结论先行：尽管 MAS 热度很高，**在很多流行 benchmark 上的性能增益很小**。
- 数据集：1600+ 条标注轨迹，覆盖 7 个主流 MAS 框架；先对 150 条做严格人工分析，κ=0.88。
- 分类学：**14 种失败模式，聚成 3 大类**：
  1. **系统设计问题**（角色/流程/规格定义本身有缺陷）
  2. **agent 间错位**（信息不共享、互相忽略、推理与动作不一致）
  3. **任务验证**（验证缺失、验证错误、过早终止）
- 论文的判词：这些失败需要**更精细的机制**而不是更多 agent；并给出了可复用的 LLM-as-judge 标注器。

**对本设计最重要的一条**：失败集中在「验证」与「错位」，而这两类恰好是**可以用流程/门禁/状态机大幅削弱的**，不需要更强模型。

→ **对插件设计的直接约束**：插件的价值主张不应是「让 agent 更聪明」，而应是「把 MAST 三类失败变成可检测状态」——每个任务必须有：明确 role spec（治第一类）、结构化 handoff（治第二类）、独立验证者与验收证据（治第三类）。

### 3.3 Anthropic 自己给出的反面证据

| 事实 | 出处 | 含义 |
| --- | --- | --- |
| 多智能体 ≈15× token | §1.1 | 只有高价值任务才划算 |
| 「多数 coding 任务真正可并行的部分比研究少；LLM agent 目前不擅长实时协调与委派」 | §1.1 原文 | **代码类任务默认不该上大团队** |
| 同步执行导致 Lead 无法 steer、子代理无法协调、被最慢者阻塞 | §1.1 | 团队必须有超时与替换机制 |
| 小改动会不可预测地改变子代理行为（涌现行为） | §1.1 | 不能靠「加人」修问题，必须可观测 |
| 两个 teammate 编辑同一文件 = 覆盖 | §1.4 | 写冲突是主要事故源 |
| 任务状态滞后会**阻塞依赖任务** | §1.4 限制 | 需要看门狗 |
| plan approval 默认被自动批准，Lead 并不真审 | §1.4 | 「有签字流程」不等于「签了字」 |
| 7× token（计划模式下的 teams） | [Costs](https://code.claude.com/docs/en/costs) | 成本要按人天估算 |

→ **对插件设计的直接约束**：插件的默认档位应是「单 agent 或 2–3 人小团队」；对写代码类任务，默认串行 + 单人写 + 独立评审，而非并行写。

### 3.4 决策矩阵：什么时候用团队 / 不用团队

| 条件 | 用团队 | 不用团队（单 agent 或 workflow） | 依据 |
| --- | --- | --- | --- |
| 可并行性 | 多个**互不依赖**的子问题（≥3 个方向） | 强顺序依赖 | Anthropic §1.1；Cognition §3.1 |
| 读写性质 | 只读探索、研究、评审、竞争性假设 | **并行写同一份状态** | Cognition principle 2 |
| 上下文规模 | 单窗口装不下，需分片压缩 | 一个窗口够用 | Anthropic §1.1；CoA |
| 可验证性 | 有客观判据（测试、引用、AC 清单） | 只有主观「感觉更好」 | Building effective agents；MAST |
| 任务价值 | 高价值、可付费（研究/审计/迁移） | 日常小改 | 15× 成本 |
| 收敛判据 | 能写出「完成谓词」与轮次上限 | 无法定义何时停 | DyLAN 早停；MAST 过早终止 |
| 写冲突 | 能切成**不相交文件集合** | 必须多人改同一文件 | Claude Code §1.4 分区要求 |
| 团队规模 | 3–5 人 | >5 人且无实测收益 | Claude Code 官方建议 |

→ **对插件设计的直接约束**：把这 8 行做成**组队准入检查（admission gate）**，任一行不满足就降档并记录理由；准入结论要写进任务板，作为事后复盘的证据。

---

## 4. 架构提炼：一个可执行的设计框架

### 4.1 角色模型

| 角色 | 职责 | 写权限 | 主要交付物 | 典型来源 |
| --- | --- | --- | --- | --- |
| **Lead / Orchestrator** | 准入判定、任务分解、分派、仲裁、集成、对外汇报 | 仅集成写（或完全不写） | 任务 DAG、决策日志、最终答复 | Anthropic Lead Researcher |
| **Researcher / Explorer** | 只读探索、事实核查、来源评估 | 无（只读） | 带引用的 findings | Claude Code Explore subagent |
| **Builder / Implementer** | 在**独占写范围**内实现 | 仅自己 scope | 代码/文档 + 自检证据 | 通用 worker |
| **Reviewer / Critic** | 独立评审，不得是作者 | 无（只读，只写评审意见） | verdict + 分级问题 + 证据 | evaluator-optimizer |
| **Verifier / Test-runner** | 跑门禁、产出可复现证据 | 仅产物目录 | 命令 + 退出码 + 关键输出 | Reflexion 的反馈信号 |
| **Integrator / Scribe** | 合并 artifact、维护 board 与索引 | board + 集成区 | 增量 diff、决策记录 | MoA 聚合层 |
| **Arbitrator / Judge** | 只在冲突/高风险时启动，按 rubric 裁决 | 无 | 裁决书 | multiagent debate / LLM-judge |

**角色最小集**（3 人团队）：Builder + Reviewer + Verifier，Lead 兼任 Orchestrator/Integrator/Arbitrator。

→ **约束**：角色必须是**数据**（可枚举、可校验），且每个角色声明「写权限范围 + 必填交付物 schema + 可否被委派评审」。

### 4.2 SOP / 注入机制：三层 + 四个注入点

| 层 | 内容 | 长度预算 | 注入位置 | 优先级 |
| --- | --- | --- | --- | --- |
| **L1 团队宪法** | 不可协商的全局不变量：写范围纪律、证据要求、引用要求、上报格式、禁止事项、升级路径 | ≤ 60 行 | 每个成员的 spawn prompt 开头 | 最高 |
| **L2 角色卡** | 该角色的使命、边界、可用工具、禁用工具、输出 schema、评审职责 | ≤ 40 行 | spawn prompt 中段 | 中 |
| **L3 任务卡** | 目标、AC（可勾选）、写范围、依赖、预算（工具调用数/轮次）、交付物格式 | ≤ 30 行 | `team_task_create.description`；分派消息里重述一句 | 低（可被任务覆盖） |
| **L4 即时指令** | steering、返修意见、澄清 | 越短越好 | `send_message` | 临时最高（当次任务） |

**注入点与失效模式**：

| 注入点 | 何时可见 | 失效风险 | 缓解 |
| --- | --- | --- | --- |
| `spawn_teammate.prompt` | 仅启动时 | 成员跑偏后看不到宪法 | 宪法同时落在 board 文件，要求每次交付前重读 |
| `team_task_create.description` | 认领时 | 成员可能不看就开工 | 派活消息要求先复述 AC |
| `send_message` | 步骤边界 | 与宪法冲突 | 消息里禁止覆盖 L1；冲突以 L1 为准 |
| blackboard 文件 | 随时 | 无人维护会腐烂 | 只有 Integrator/Lead 可写；版本号 + 时间戳 |

→ **约束**：三层文本都必须**可版本化、可 diff**，并且每次任务完成时校验「交付物是否满足任务卡 schema」；L1 不允许被 `send_message` 覆盖。

### 4.3 通信拓扑

| 拓扑 | 形态 | 优点 | 缺点 | 适用 |
| --- | --- | --- | --- | --- |
| **星型** | Lead ↔ 每个成员 | 控制力强、易审计、无环 | Lead 成瓶颈；成员互相不可见 | 默认；控制流与分派 |
| **全连** | 任意两成员直连 | 信息最快、适合辩论 | 消息爆炸、状态不一致、易从众 | 仅竞争性假设排障，限时 |
| **黑板（blackboard）** | 共享文件/索引，成员读写 | 上下文可共享、可回放、与 Cognition 原则兼容 | 需要所有权与格式约定 | **artifact 与决策的主通道** |
| **混合（推荐）** | 星型控制 + 黑板承载产物 + 点对点仅用于澄清 | 兼得可控与共享 | 需要约定「什么必须落板」 | 插件默认 |

**「必须落板」清单**：任务卡、artifact 路径、评审 verdict、关键决策与理由、证据（命令/输出/引用）、未决问题。

**点对点消息的使用限制**（推断，基于 Cognition 原则与 Anthropic 的 game-of-telephone 教训）：只允许两类——(a) 向作者澄清事实；(b) 评审要求补充证据。任何**结论性内容**必须落板，不允许只在消息里存在。

→ **约束**：插件要定义 board 的目录结构与文件命名（见 §5.3），并规定「消息不构成交付」。

### 4.4 任务分解与依赖

**任务粒度判据**（一个任务 = 一个可验收的原子）：

1. 一个独占的写范围（或明确只读）；
2. 一份可校验的交付物；
3. 一个负责人（owner 唯一）；
4. 能在预算内完成（建议 ≤ 20 次工具调用；官方经验：每人 5–6 个任务）；
5. AC 可被第三方验证。

**依赖建模**：

| 关系 | 表达 | 语义 |
| --- | --- | --- |
| 强顺序 | `blocked_by: [T1]` | T1 完成前 T2 不可认领 |
| 软顺序 | 消息提醒 | 允许并行，但结果需合并 |
| 互斥写 | `write_scopes` 不重叠 + 同一时刻只有一个 writer | 冲突预防 |
| 评审 | 独立任务 `REV-T1`，`blocked_by: [T1]`，owner = Reviewer | 评审本身可被追踪、可被拒收 |

**认领与 CAS**：认领必须先读最新 revision 再带 `expected_revision` 更新；失败则重读重试（避免两人抢同一任务）。任务「完成」应附带：artifact 路径、AC 勾选、证据、自检命令与退出码。

→ **约束**：任务模板必须包含 `owner_hint / write_scopes / blocked_by / ac[] / evidence[] / budget`；没有 AC 与证据字段的任务视为非法。

### 4.5 审阅协议：谁审谁、几轮、判据

**基本规则（硬性）**：

1. **作者 ≠ 评审**（同一个人自审只能算自检，不能算签核）。
2. **评审只看证据与产物**，不看作者的自我评价。
3. **每轮评审必须输出枚举 verdict**：`APPROVE` / `APPROVE_WITH_NITS` / `CHANGES_REQUESTED` / `REJECT`。
4. **问题分级**：P0 阻断（必须改）、P1 应改（本轮或下轮）、P2 建议（可记录不修）。
5. **轮次上限 2 轮**（第 1 轮 + 1 次返修）；超限升级仲裁（§4.6）。
6. **判据来自 rubric**，不来自评审个人偏好；rubric 在任务卡中预先声明。

**默认 rubric（按任务类型选一套）**：

| 任务类型 | rubric 维度 | 通过线 |
| --- | --- | --- |
| 研究/调研 | 事实准确性、引用可核查性、完整性、来源质量、工具效率（Anthropic 五维） | 无 P0 且五维均 ≥ 阈值 |
| 实现 | 符合 AC、测试通过、无回归、可维护性、写范围未越界 | 全部硬指标绿 + 无 P0/P1 |
| 评审报告 | 覆盖声明范围、每个问题有证据、分级正确、无臆造 | 无 P0 且每个 finding 可复现 |
| 集成 | 无冲突、依赖满足、端到端门禁通过 | 全部硬指标绿 |

**评审轮次的显式状态机**（插件需要补的能力，见 §5.2）：

```
TASK: pending → claimed → in_progress → submitted
      submitted → under_review ──APPROVE──→ approved → completed
                     │                          ↑
                     └─CHANGES_REQUESTED→ in_progress（round+1，≤2）
                                            └─超限→ escalated → arbitrated
```

→ **约束**：`submitted / under_review / approved / escalated` 必须成为可查询状态，而不是靠聊天记录推断；每个状态迁移都要有 owner、时间戳、证据指针。

### 4.6 收敛与仲裁

**完成谓词（全部满足才算团队完成）**：

1. 所有任务 `completed` 且 `approved`；
2. 所有 `blocked_by` 依赖已解除，无孤儿任务；
3. 所有门禁（build/test/lint/引用检查）绿，且证据可复现；
4. 无 `escalated` 未裁决项；
5. board 的决策日志与未决问题清单已更新；
6. Lead 的最终答复逐条对应任务 ID 与证据路径。

**早停（节省成本）**：

- 本轮评审只剩 P2/P3 类意见 → `APPROVE_WITH_NITS` 并结束；
- 连续两轮修改无实质差异（diff 为空或只改格式）→ 停止迭代并记录；
- 一个成员连续两次超时/无产出 → 中止该分支，缩小范围或换人。

**仲裁阶梯（从便宜到贵）**：

1. Lead 读双方 artifact + rubric 自行裁决（默认）；
2. 引入未参与的第 3 位 Reviewer，仅对分歧点裁决（避免重新全审）；
3. 高风险/高不确定 → 结构化 debate（限 2 轮）+ Lead 裁决；
4. 仍不可决或涉及价值判断 → 上报用户（human-in-the-loop），写明选项与代价。

**僵局检测**（必须做，因为 DSH 的 `wait_agent` 不会自动失败）：

- 成员长时间无状态变化 → `list_agents` 看是否 inactive；
- inactive 且任务未完成 → `send_message` 唤醒并按需 `interrupt_agent` 中止当前错误方向；
- 重复超时 → 重新分派（`team_task_update` reassign）或换人，并在 board 记录。

→ **约束**：完成谓词、早停条件、轮次上限、仲裁阶梯都必须是**可执行判定**（脚本/检查表），不能写成「需要时自行判断」。

### 4.7 隔离与写冲突控制

| 手段 | 强度 | 说明 |
| --- | --- | --- |
| 文件所有权（write scope 前缀） | 强（人工约定 + 审计） | 唯一 writer；最便宜、最可靠 |
| 任务级串行化（blocked_by） | 强 | 同一文件的两个任务强制先后 |
| 只读角色（工具白名单） | 强（若运行时支持） | Reviewer/Verifier 无写工具 |
| 独立 worktree / 分支 | 强但重 | 适合大改动；合并成本高 |
| 锁文件 | 中 | 只防并发写，不防语义冲突 |
| 事后 diff 审计 | 中 | 兜底，能发现越界但不能预防 |

**共享 cwd 的现实风险**：所有成员共享同一文件系统，编辑立即可见——这既是协作优势（黑板天然成立），也是最大事故源（A 改到 B 正在写的文件）。插件必须把「写范围」从建议改成**任务必填 + 完成时校验**（比较实际 diff 路径与声明的 scope）。

→ **约束**：默认假设「没有文件锁」；用分区与串行化代替锁；完成校验必须包含越界写检查。

### 4.8 失败模式与开销

**失败模式 → 检测 → 缓解**（按 MAST 三类组织，检测手段均为本设计可落地项）：

| 类别 | 典型症状 | 检测方式 | 缓解 |
| --- | --- | --- | --- |
| 系统设计 | 角色职责重叠、任务无 AC、预算未定义 | 任务创建时校验必填字段 | 任务模板 + 准入检查 |
| 系统设计 | 成员违反角色边界（Reviewer 改代码、Builder 改别人文件） | diff 与 write_scope 比对 | 只读工具白名单 + 越界即拒收 |
| 系统设计 | 过早终止（没做完就 complete） | 完成门禁比对 AC | `TaskCompleted` 式门禁；未勾满 AC 拒绝完成 |
| 间错位 | 信息不共享，重复劳动 | 认领前查重；board 上已知结论清单 | 强制「先读板再开工」 |
| 间错位 | 忽略他人输入/评审意见 | 返修必须逐条回应 P0/P1 | 返修模板：issue → 处理方式 → 证据 |
| 间错位 | 推理与动作不一致（说修了没改） | 证据要求：命令 + 输出 + diff | 证据可复现，评审抽查 |
| 任务验证 | 验证缺失/错误验证 | 独立 Verifier，且不得是作者 | 门禁脚本化；人工 spot check |
| 任务验证 | 评审流于形式（全 APPROVE） | 评审意见的 P 级分布统计 | 评审也接受抽查；空评审视为无效 |
| 收敛 | 无限返修 | 轮次计数 | ≤2 轮后升级 |
| 收敛 | 状态滞后、任务卡死 | 超时看门狗 | 超时 → 唤醒/重派/降级 |
| 成本 | token 爆炸 | 预算台账（成员×任务×调用数） | 深度/并发/预算三上限 |
| 事实性 | 引用错、来源差 | 引用可访问性检查 + 抽样核对 | 引用 fan-out 校验（每个 URL 必须被实际抓取过） |

**成本模型**（把官方数字变成预算公式）：

```
团队总成本 ≈ 单会话成本 × (1 + Σ 成员权重)
其中成员权重：探索/评审类 ≈ 0.5–1×，实现类 ≈ 1–2×
参考锚点：chat 1× / 单 agent 4× / 多智能体 15× / Agent Teams(plan mode) 7×
```

→ **约束**：插件必须能报出「本次团队花费 ≈ N× 单会话」的估算，并在开跑前把 N 告知用户；超过阈值需显式批准。

---

## 5. 对 DSH 的映射建议

> 本节只使用 DSH **已有**的原语建模，不臆造工具。事实来源：本会话实际可用的工具签名与系统说明。

### 5.1 DSH 原生原语（现状盘点）

| 原语 | 精确语义 | 设计含义 |
| --- | --- | --- |
| `spawn_teammate(name, description, prompt, context)` | **仅 Lead** 可调用；创建具名、durable 成员；`context` = `fresh`（不继承 Lead 历史）或 `fork`（继承 Lead 已完成回合） | 成员是长期存在的一等对象；fresh 适合独立评审，fork 适合「已看过计划的人」 |
| `send_message(target, message)` | 发给另一成员；**运行中在最近步骤边界收到**；**inactive 成员会被启动/续跑** | 同时承担 steering 与唤醒；「已发送」≠「已处理」 |
| `list_agents()` | 列出 Lead 与所有 durable 成员及可用性（inactive / provisioning / failed） | 唯一的成员状态视图；**inactive 不代表任务完成/失败** |
| `wait_agent(timeout_ms)` | 等待**本次调用开始之后**的下一个成员状态/消息/任务板变化；**不会唤醒 inactive 成员**；无其他成员在跑时立刻返回 noProgress | 事件驱动，不能当轮询器；超时后需重新 `list_agents` |
| `interrupt_agent(target)` | 打断某成员当前回合，保留其待处理收件箱 | 纠偏/止损的原语 |
| `team_task_create(subject, description, blocked_by, write_scopes)` | 创建无主任务；`write_scopes` 是**建议性**写范围 | 任务板是共享状态；写范围目前只是 advisory |
| `team_task_list(status, owner, ready, ...)` | 列出任务，含 readiness、owner、revision、blockers、写范围冲突警告 | 有 blocked_by 与 ready 语义；有冲突预警 |
| `team_task_get(task_id)` | 读最新完整任务 | 与 update 的 CAS 配套 |
| `team_task_update(task_id, expected_revision, action, ...)` | **revision CAS**；动作含 claim / release / edit / set_dependencies / complete / reopen / reassign / delete | 乐观并发；Lead 可 reassign |
| 共享 cwd / 文件系统 | 所有成员同一工作目录，编辑立即可见 | 天然的黑板；也是写冲突源 |
| 任务变更通知 | 通过 `wait_agent` 观察 | 无独立事件订阅 API |

### 5.2 已覆盖 vs 缺口

| 能力 | Claude Code Agent Teams | DSH 原生 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 具名成员 / Lead 制 | team lead + teammates | `spawn_teammate`（仅 Lead） | ✅ 完全 | — |
| 成员发现 | team config `members` | `list_agents` | ✅ 完全 | — |
| 独立上下文 | 各自 context window | 成员天然独立；fresh/fork 可选 | ✅ 完全 | — |
| 点对点消息 | mailbox JSON + 自动投递 | `send_message`（步骤边界/唤醒） | ✅ 完全 | 但**无送达回执与处理确认** |
| 共享任务板 | 三态 + blocked_by + 文件锁认领 | `team_task_*`（三态近似 + blocked_by + CAS） | 🟡 基本覆盖 | 状态只有 pending/in_progress/completed，**无 submitted/under_review/approved/escalated**；无「评审轮次」字段；CAS 替代文件锁，语义更清晰 |
| 写冲突控制 | 官方要求按文件分区（不用 worktree） | `write_scopes` 仅 advisory + 冲突警告 | 🟡 部分 | **无强制锁、无越界写校验、无 worktree 隔离** |
| 质量门禁 | hooks：TeammateIdle / TaskCreated / TaskCompleted（exit 2 阻断） | 无等价机制 | ❌ 缺失 | 任务完成纯属自述；**无完成门禁** |
| 计划批准 / 签字 | plan approval request/response（且有「默认自动批准」坑） | `send_message` 可传文本，但无结构化协议 | ❌ 缺失 | **无签字状态机、无 approve/reject 语义** |
| 角色/工具隔离 | subagent `tools` 白名单、`model`、`permissionMode` | spawn 只有 prompt，无 model/tools 参数 | ❌ 缺失 | **无法从运行时强制只读**；角色只能靠 prompt 约束 |
| 结构化消息协议 | shutdown_request、plan_approval_* | 纯文本 | ❌ 缺失 | 无法机读「请求/响应/超时」 |
| 预算与上限 | depth / concurrency / maxBudgetUsd | 无预算、无并发上限（除平台级） | ❌ 缺失 | **无成本台账、无轮次上限** |
| 收敛/仲裁 | 无内建（靠 Lead 判断） | 无内建 | ❌ 缺失 | 无投票、无 judge、无早停判定 |
| 观测/审计 | transcript 文件、agent panel | 消息 + 任务板 + 文件 | 🟡 部分 | 无执行轨迹落盘约定、无按任务归因 |
| 嵌套/多团队 | 明确禁止嵌套、一 session 一 team | 成员不能再派生（delegation depth 已到上限） | ✅ 一致 | 设计应遵循同一约束 |

**结论**：DSH 原生已覆盖「谁在、能说、能认领、能依赖」这层；**完全缺失的是「评审/签字/门禁/预算/角色强制」这层治理能力**——正是 `agentteam-kit` 应该补的。

### 5.3 插件应补的能力（按缺口优先级）

| 优先级 | 组件 | 形态（工具/文件/约定） | 解决的缺口 | 验收标准 |
| --- | --- | --- | --- | --- |
| P0 | **任务卡模板** | 约定：`team_task_create.description` 必须是固定结构（goal / ac[] / write_scopes / deps / deliverable / evidence_required / budget / role_hint） | 任务无 AC、无证据、无预算 | 创建一个缺字段的任务会被插件拒绝或标红 |
| P0 | **完成门禁** | 约定 + 检查脚本：`complete` 前必须附 artifact 路径、AC 勾选、证据（命令+退出码+输出摘要） | 无 TaskCompleted 等价物 | 缺证据的 complete 被拒；越界写被检出 |
| P0 | **角色卡库** | 文件：`roles/<role>.md`（L1 宪法片段 + L2 角色卡），由 spawn 时拼进 prompt | 无角色化 SOP 注入 | 同一角色两次 spawn 的行为一致；可 diff 版本 |
| P1 | **评审状态机** | 约定：用独立任务 `REV-<T>`（blocked_by T）+ 固定 verdict 枚举；board 记录轮次 | 无评审轮次/签字 | 每次评审有 verdict、轮次、issues；超 2 轮自动 escalated |
| P1 | **黑板与产物索引** | 目录约定：`agentteam/<run>/board.md`、`tasks/<id>.md`、`artifacts/<id>/`、`reviews/<id>/r<N>.md`、`decisions.md`、`evidence/` | 无共享上下文载体（Cognition 原则 1） | 任何成员可在不读聊天记录的情况下恢复上下文 |
| P1 | **收敛判定** | 检查脚本：完成谓词（§4.6 六条）一键校验 | 无收敛门槛 | 未满足谓词时 Lead 不能宣布完成 |
| P1 | **看门狗** | 约定 + 轮询策略：`wait_agent` 超时 → `list_agents` → 唤醒/中断/重派 | 状态滞后、成员静默 | 静默成员在 N 分钟内被发现并处理 |
| P2 | **预算台账** | board 中的表：成员 × 任务 × 估计调用数 / token 档位 | 无成本控制 | 开跑前给出 N× 估算；超阈值告警 |
| P2 | **仲裁 rubric** | 文件：`rubrics/<type>.md`（§4.5 四套） | 无判据、评审主观 | 裁决书必须引用 rubric 条目 |
| P2 | **准入检查** | 检查表：§3.4 八行 + §4.4 粒度五条 | 不该组队时组队 | 不满足则降档并记录理由 |
| P3 | **eval harness** | 脚本：20 条种子任务 + LLM-judge（5 维 rubric）+ 与单 agent 基线对比 | 无法证明团队更好 | 团队档得分显著高于基线才保留 |

**注意（不要越界设计）**：插件**不应**伪造不存在的运行时能力。三件事必须诚实标注为「约定 + 检查」，而不是「强制」：

1. 成员无法被运行时限制为只读 → 只能「角色声明 + 事后 diff 审计」；
2. 无 hooks → 完成门禁只能靠 Lead 在执行 `team_task_update(complete)` **之前**跑检查脚本；
3. 无结构化消息 → 所有协议（评审请求、返修、裁决）都用**文件 + 固定模板**承载，消息只做通知。

### 5.4 端到端 Runbook（3 人评审团队，全部使用真实原语）

**目标示例**：调研并交付一份 `docs/x.md`，要求 3 个独立视角评审后签核。

1. **准入**：Lead 按 §3.4 检查（只读为主、可并行 3 视角、有 AC、有 rubric）→ 通过。
2. **建板**：`team_task_create` 依次创建
   - `T1 研究并撰写 docs/x.md`（write_scopes: `["docs/x.md"]`，ac: …，budget: 20 calls）
   - `T2 安全/事实视角评审`（blocked_by: `["T1"]`，owner_hint: reviewer-a）
   - `T3 结构/完整性视角评审`（blocked_by: `["T1"]`，owner_hint: reviewer-b）
   - `T4 证据与引用核查`（blocked_by: `["T1"]`，owner_hint: verifier）
   - `T5 集成与终稿`（blocked_by: `["T2","T3","T4"]`）
3. **组队**：`spawn_teammate("builder", …, prompt = L1宪法 + L2 builder 角色卡 + T1 任务卡, context="fresh")`；同法 spawn `reviewer-a`、`reviewer-b`、`verifier`（后三者角色卡声明只读）。共 4 人，若需压到 3 人则合并 T3/T4。
4. **推进**：Builder `team_task_get(T1)` → `team_task_update(claim, expected_revision)` → 干活 → 自检 → `team_task_update(complete)`（附 artifact + 证据）。
5. **通知**：Builder `send_message(lead, "T1 完成，artifact: ..., 证据: ...")`；Lead `wait_agent` 收到变化。
6. **评审**：Lead `send_message(reviewer-a, "认领 T2，先读 board 与 T1 任务卡，按 rubric 输出 r1.md")`；Reviewer `claim` → 只读检查 → 写 `reviews/T1/r1.md`（verdict + P 级 issues + 证据）→ `complete`。
7. **裁决**：Lead 汇总三份 verdict：
   - 全 `APPROVE` → 直接进 T5；
   - 有 `CHANGES_REQUESTED` → `team_task_update(T1, action="reopen")`，`send_message(builder, 逐条 issue)`，round=2；
   - 第 2 轮仍有 P0 → 标记 `escalated`，走 §4.6 仲裁阶梯。
8. **收敛**：Lead 跑收敛检查脚本（六条谓词）→ 全绿后 `claim T5` → 写终稿 → `complete`。
9. **收尾**：`interrupt_agent` 或让成员自然空闲；board 的 `decisions.md` 记录「为什么这样定」与未决问题；最终答复逐条引用任务 ID 与证据路径。
10. **复盘（可选）**：把本轮失败点按 MAST 三类归档，作为下一轮 eval 样本。

**并发与等待的正确用法**（DSH 特有）：

- 派活后调用 `wait_agent`（它在调用之后才观察变化）；**不要**用循环 sleep 轮询。
- `wait_agent` 返回 noProgress 时立刻 `list_agents`：若成员都 inactive 且任务未完成 → 说明任务丢了，需要 `send_message` 唤醒或重派。
- 需要纠偏时先 `send_message`（在步骤边界生效），仍不行为再 `interrupt_agent`。

### 5.5 开放问题与风险（交给 Lead 决策）

| # | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| 1 | DSH 是否支持按成员限制工具/model？ | 决定「只读评审」能否强制 | 若不支持，插件必须把「只读」降级为角色约定 + diff 审计，并明示风险 |
| 2 | 成员能否各自用 git worktree / 分支？ | 决定大改动能否并行 | 默认不假设；写范围分区优先 |
| 3 | 成员失败/超时后的续跑语义 | 决定看门狗策略 | 以 `list_agents` + `send_message` 唤醒为主，重派为辅 |
| 4 | 是否有 task 级 token/成本数据 | 决定预算台账精度 | 无则用「调用数 × 档位」估算，并标注为估计 |
| 5 | 任务板 `complete` 是否会被 blocked_by 阻止 | 影响状态机严格性 | **实测确认**；在此之前插件自行检查依赖 |
| 6 | 团队成员上限（并发/总数） | 影响默认规模 | 默认 3，最多 5；超过需理由 |
| 7 | `write_scopes` 冲突警告的触发条件 | 影响越界检测 | 以实际 diff 路径为准，不依赖警告 |

→ **对插件设计的直接约束（本节收敛）**：插件的产品形态应是一份**治理层**——任务卡模板 + 角色卡 + 完成门禁 + 评审状态机 + 黑板约定 + 看门狗 + 预算台账；运行时能力缺口（只读强制、结构化消息、hooks）必须显式标注为「约定 + 检查」，不要假装是平台保证。

---

## 6. 引用清单（均已抓取或由官方页内链接确认）

**Anthropic 官方工程博客**

1. [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) — 2026-11-01 抓取（HTTP 200，重定向至 /research/ 同名页）
2. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) — 抓取
3. [Scaling Managed Agents with stable interfaces](https://www.anthropic.com/engineering/managed-agents) — 抓取
4. [Anthropic Cookbook: patterns / agents / basic workflows](https://platform.claude.com/cookbook/patterns-agents-basic-workflows) — 官方页内链接

**Claude Code / Agent SDK 官方文档**

5. [Orchestrate teams of Claude Code sessions（Agent Teams）](https://code.claude.com/docs/en/agent-teams) — 抓取
6. [Create custom subagents](https://code.claude.com/docs/en/sub-agents) — 抓取
7. [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents) — 抓取
8. [Run agents in parallel（五种并行方式对比）](https://code.claude.com/docs/en/agents) — 抓取
9. [Choose a permission mode](https://code.claude.com/docs/en/permission-modes) — 抓取
10. [Manage costs effectively（含 Agent team token costs）](https://code.claude.com/docs/en/costs) — 抓取
11. [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows) — 官方页内链接
12. [Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees) — 官方页内链接
13. [Hooks reference（TeammateIdle / TaskCreated / TaskCompleted）](https://code.claude.com/docs/en/hooks) — 官方页内链接
14. [Claude Code docs 索引](https://code.claude.com/docs/llms.txt) — 抓取（用于确认不存在 delegate mode 条目）

**反方与失败实证**

15. [Don't Build Multi-Agents — Cognition](https://cognition.com/blog/dont-build-multi-agents) — 抓取
16. [Why Do Multi-Agent LLM Systems Fail? (MAST)](https://arxiv.org/abs/2503.13657) — arXiv API 校验

**学术工作（arXiv）**

17. [MetaGPT](https://arxiv.org/abs/2308.00352)
18. [ChatDev](https://arxiv.org/abs/2307.07924)
19. [CAMEL](https://arxiv.org/abs/2303.17760)
20. [AutoGen](https://arxiv.org/abs/2308.08155)
21. [Mixture-of-Agents](https://arxiv.org/abs/2406.04692)
22. [AgentVerse](https://arxiv.org/abs/2308.10848)
23. [DyLAN](https://arxiv.org/abs/2310.02170)
24. [Chain of Agents](https://arxiv.org/abs/2406.02818)
25. [Self-Refine](https://arxiv.org/abs/2303.17651)
26. [Reflexion](https://arxiv.org/abs/2303.11366)
27. [Judging LLM-as-a-Judge (MT-Bench / Arena)](https://arxiv.org/abs/2306.05685)
28. [Improving Factuality and Reasoning through Multiagent Debate](https://arxiv.org/abs/2305.14325)

**代码仓库（论文/官方页给出）**

29. [MetaGPT repo](https://github.com/geekan/MetaGPT)
30. [ChatDev repo](https://github.com/OpenBMB/ChatDev)
31. [AutoGen repo](https://github.com/microsoft/autogen)
32. [CAMEL repo](https://github.com/camel-ai/camel)

---

## 附录：核查记录

| 项目 | 结果 |
| --- | --- |
| 抓取方式 | `web_fetch`；Anthropic 工程页会 301 到 `/research/...`，内容一致；Claude Code 文档为 Mintlify，追加 `.md` 可拿到全文纯文本 |
| 论文 ID | 通过 `export.arxiv.org/api/query?id_list=...` 一次校验 13 篇，均返回 entry（title/摘要/链接） |
| 未命中项 | 在 `agent-teams`、`sub-agents`、`permission-modes`、`agents`、`costs`、`llms.txt` 中检索 "delegate"，**无 "delegate mode" 独立条目**；最接近的是 plan mode / plan approval 与官方「Lead 应等待 teammate」的实践要求 |
| 未逐页抓取但由官方页内链接确认 | workflows、worktrees、hooks、Cookbook URL（均为已抓取页面的正文链接） |
| 数字一致性 | 15×（Anthropic 研究系统）、7×（Claude Code 成本页，plan mode 下 teams）、90.2%（研究系统）、80% 方差（BrowseComp）、3–5 teammates、5–6 tasks/teammate、20 并发、3 层深度 |
| 与任务书差异 | 任务书提到「delegate mode」，官方文档不存在该功能名，已在 §0 与 §1.4 标注为核查说明 |
