# 23 · v1.6 — 真并行 worktree 隔离 + 工作流能力沙箱

> 对应 roadmap ②③，并收口两个小项（transcript 单条展开、看板 token 用量面板）。
> 状态：**已实现（插件 1.6.0，离线 207/207）**；live 见 [`24`](24-v16-live.md)。

## 1. 并行 worktree 隔离（②）

配置：
```yaml
gitEnabled: true
worktreeIsolation: parallel   # off | serial | parallel
strictScopes: true            # 报告文件必须在 writeScopes 内（否则 gate 失败）
```

### 1.1 工具语义

| action | 行为 |
| --- | --- |
| `worktree_add` | 为 item 创建 `.agentteam/worktrees/<runId>/<itemId>`（独立分支 `agentteam-wt/<runId>/<itemId>`，基于 run 分支）；记录 `item.git.worktree/worktreePath/worktreeBranch`；**返回绝对路径**；`serial` 模式拒绝第二个活跃 worktree |
| `commit` | item 有 worktree 时在 **该 worktree 内**执行（分支校验针对 worktree 分支），不再与共享 checkout 竞争 |
| `verify` | 同样在 item worktree 内跑配置的验证命令 |
| `merge {item_id}` | 把该 item 的 worktree 分支合并进 run 分支（要求 item 已批准）；逐个串行合并 |
| `merge`（无 item_id） | 原有语义：gate 通过后 run 分支 → base 分支 |
| `worktree_list` | 当前 worktrees + 每个 item 的 worktree/branch/mergedAt |

### 1.2 隔离强度

- **文件级真隔离**：每个 item 一个独立工作树，同 wave 可以重叠 writeScopes（并行模式下重叠 scope 从 error 降为 warning）；
- **brief 注入**：工人的 brief 会写明 worktree 绝对路径、分支，以及"只在该目录工作、报告路径相对 worktree、commit 用 item_id"；
- **门禁校验**：开启隔离时，gate 会检查报告里的每个文件**确实存在于该 item 的 worktree**，否则 item gate 失败（防止"报告指向共享 checkout"的伪并行）；
- **限制（诚实说明）**：teammate 的会话 cwd 仍由平台固定为 Lead 的 workspace，插件不能切换成员进程目录；隔离靠"路径 + 分支 + 门禁"保证产物隔离，**不是进程/文件系统沙箱**。成员若绕过 brief 修改共享 checkout，门禁能发现报告与 worktree 不一致，但无法阻止其原生文件写入。

## 2. 工作流能力沙箱（③）

`roles.<name>` 新增：
```yaml
roles:
  observer:
    readOnly: true                 # 禁止所有 mutating workflow 工具
  messenger:
    allow: [team_flow_status, team_flow_talk]   # 白名单（其余全部拒绝）
  auditor:
    deny: [team_flow_report, team_flow_git:commit]
```

- 拒绝发生在工具入口（错误信息包含角色与配置位置）；
- `readOnly` 禁止的工具集：plan/report/work/item/git/gate/repair/staff/stop/decide/plan_approval/review_respond/escalate/talk；允许 read/status/review_submit（评审是只读判断）；
- 与 `strictScopes` + worktree 门禁叠加，构成"能力 + 写范围 + 产物位置"三层约束。

### 2.1 平台边界（v1.7 已进一步收口，见 docs/25）

本 build 的 Agent Teams spawn 契约只有 `{name, description, prompt, context, provider, signal}`（`roster.spawnAdmitted`），**没有 per-teammate tools/permission/preset 字段**；DSH 的 permission preset 是**会话级**的。因此"用 spawn 参数注入工具集"不可行。

**但 v1.7 使用了 `ctx.tools.guard()`（公开 API）把沙箱推进到原生工具调用边界**：teammate 角色命中
`readOnly/allow/deny` 时，被禁止的原生工具（write/edit/bash/terminal 等）会在执行前被拒绝。
详见 [`25-native-tool-sandbox.md`](25-native-tool-sandbox.md)。残余边界：guard 是工具调用级而非 OS 级；
bash 内部行为仍受会话权限管辖。

## 3. 小项收口

- **transcript 单条展开**：成员抽屉对话区每条可点/Enter 展开全文，支持同时多条，展开提示"展开/收起"；
- **token 用量面板**：看板新增「用量」卡片，按成员显示 input/output/cacheRead/cacheWrite（千分位、0 正常显示），合计行 + 采集时间；无数据时明确降级，不伪造。

## 4. 验收

- 离线 **207/207**：新增并行 worktree e2e（两 item 各自 commit/verify/merge）+ serial 拒绝 + 门禁缺失文件 + readOnly/allow 角色策略；客户端 +3；
- live：见 [`24`](24-v16-live.md)。
