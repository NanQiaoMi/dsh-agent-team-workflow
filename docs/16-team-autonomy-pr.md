# 16 · 团队自建 / PR 标准流程 / 看板降噪（v1.3）

> **状态：已实现（2026-11-02，插件 1.3.0 / UI 与噪音修复 1.3.1）**：`autoStaff` + `team_flow_staff`（团队自建/补员）、
> `lib/git.js`（真实 git/gh 封装）+ `team_flow_git`（分支/提交/验证/推送/PR/合并）、看板拓扑降噪与
> Git/PR 徽章；离线测试 **162/162**（含真实临时 git 仓库 + bare remote 的端到端）。live run #3 见 `docs/17`。

> 目标三条：
> 1. **团队自建**：Lead 只发 mission，插件自己把需要的成员 spawn/wake 出来（计划期 + 后续波次）；
> 2. **PR 标准流程**：分支 → 提交 → 验证 → 推送 → PR（创建/更新/评审）→ 门禁后合并，全部工具化、可审计；
> 3. **看板降噪**：拓扑/面板从"信息堆"变成"能读的图"。

## 1. 团队自建（auto staffing）

配置（`cordis.patch.yml`）：
```yaml
autoStaff: true            # 计划/补员时自动 spawn/wake 成员；false = 只返回简报
```

### 1.1 `team_flow_plan`（Lead）自动组队
- 参数新增 `auto_spawn`（默认取 `settings.autoStaff`）；
- plan 完成后对 **owner / queue pool / reviewer** 三类必要成员：
  - 不在 roster → `ctx.agentTeams.spawnTeammate(leadAgent, { name, description, prompt:[{type:'text',text}], context })`；
  - 已在 roster 且 inactive → `sendMessage` 唤醒（[RESUME] 简报摘要）；
  - 已在跑 → 跳过；
- 返回新增 `staffed: { spawned:[{name,kind}], woken:[name], skipped:[name], failed:[{name,error}] }`；
- 容量保护：当前成员数 + 待 spawn ≤ 8，超限时**不 spawn**、返回 `needs_spawn` 名单与原因（Lead 决定）；
- `autoStaff:false` 时行为与旧版一致（只给 spawn 简报）。

### 1.2 `team_flow_staff`（Lead，新工具，第 14 个）
后续波次/掉队补员：`{ items?: ["W2"], reason? }`
- 扫描给定（缺省=全部未批准）item 的 owner/reviewer 与开放队列 pool；
- 缺失 → spawn；inactive → wake；返回同 staffed 结构；
- 幂等：已在跑的成员不重复 spawn；
- 用途：wave 2 就绪后 Lead 调一次即可，无需手工复制简报。

## 2. PR 标准流程（`lib/git.js` + `team_flow_git` 工具，第 15 个）

配置：
```yaml
gitEnabled: false          # 默认关闭，显式开启才启用
gitBaseBranch: main
gitRemote: origin
gitBranchPrefix: agentteam/
gitVerifyCommands: []      # 例如 ["pnpm -r test"]；开启后 verify 可执行
gitRequireVerify: false    # gate 时要求每项 verify 通过
```

### 2.1 `lib/git.js` 契约（零依赖，node:child_process）
所有函数**不抛异常**，返回 `{ ok, ... , error }`；只用参数数组调用 git（verify 例外：配置命令经 `/bin/sh -lc`）；**禁止** force/amend/rebase/改写历史。

| 函数 | 输入 | 输出 |
| --- | --- | --- |
| `gitStatus({ cwd, exec })` | 仓库路径 | `{ ok, root, branch, clean, staged, unstaged, untracked, remote, ahead, behind }` |
| `gitEnsureBranch({ cwd, branch, base, exec })` | 目标分支、基线 | `{ ok, branch, created, switched }`；base===branch 或工作区脏 → `ok:false` |
| `gitCommit({ cwd, files, message, exec })` | 仅这些文件 | `{ ok, sha, files }`；空 files、非仓库、无变更 → `ok:false` |
| `gitVerify({ cwd, commands, timeoutMs, exec })` | 命令数组 | `{ ok, results:[{command, exitCode, outputTail}] }` |
| `gitPush({ cwd, remote, branch, exec })` | 远程/分支 | `{ ok, remote, branch, sha }`；分支===base → `ok:false`；无 force |
| `gitMerge({ cwd, branch, into, method, message, exec })` | 源/目标 | `{ ok, sha }`；into===base 之外禁止 |
| `gitRemoteInfo({ cwd, remote, exec })` | 远程名 | `{ ok, url, provider, compareUrl }` |
| `ghAvailable({ exec, env })` | — | `{ installed, authenticated, version }` |
| `gitPrCreateOrUpdate({ cwd, branch, base, title, body, remote, exec, env })` | — | `{ ok, mode:'gh'|'manual', url, number }`；无 gh/未登录 → manual + compareUrl |
| `gitPrReview({ cwd, number, verdict, body, exec, env })` | verdict 映射 | `{ ok, mode }`（approve/request-changes/comment） |
| `gitPrMerge({ cwd, number, method, exec, env })` | Lead 门禁后 | `{ ok, mode, sha }` |

### 2.2 `team_flow_git`（成员/Lead）
```jsonc
{ "action": "status|prepare|commit|verify|push|pr|review|merge",
  "item_id": "J1", "message": "…", "method": "squash|merge|no-ff" }
```
- `status`：任何成员；返回 repo 状态 + 本 run 各项 git 记录；
- `prepare`：**Lead**；建/切 **整个 run 共用**的 `agentteam/<runId>` 分支（base=`gitBaseBranch`），写 `run.git.branch/base`；工作区脏则拒绝并提示先提交/清理；
- `commit`：owner；**只 add `item.report.files`**（或显式 `files`），提交信息默认 `agentteam(<item>): <subject>`；写 `item.git.sha`；
- `verify`：owner/reviewer；跑 `gitVerifyCommands`，结果写 `item.git.verify`；
- `push`：owner；推 `run.git.branch` 到 `gitRemote`；写 `run.git.pushedAt`；
- `pr`：owner/Lead；gh 可用**且 remote 是 GitHub** → 创建/更新 PR（head=branch, base=baseBranch）并写 `run.git.pr{url,number,mode}`；否则 manual：返回 compareUrl 与"PR 需人工创建"的说明，`mode:'manual'`；
- `review`：reviewer；把 verdict 映射成 gh approve/request-changes/comment（manual 模式仅记录）；
- `merge`：**Lead only**；要求 run converged/finalized 且 run.gate.pass；gh → `gh pr merge --squash|--merge`；manual → 本地 `git merge --no-ff` 到 base；写 `run.git.mergedAt`；
- 安全：`gitEnabled:false` 时所有动作报错；永不 force-push；拒绝在 base 分支上 commit/push；拒绝合并未经门禁的 run；remote 非 GitHub 时 gh 自动降级为 manual（不会误调 gh）。
- **前提**：开启 git 流程的仓库必须把 `artifactsDir`（默认 `.agentteam/`）加入 `.gitignore`，否则黑板文件会让 `prepare` 判脏。

### 2.3 门禁/看板
- `gitRequireVerify:true` 时，gate 对该 item 增加 failure：`git verify missing/failed`；
- 快照 `run.git`：`{ branch, base, remote, branchCreated, pushedAt, pushedSha, pr:{url,number,mode,status}|null, mergedAt, mergeSha, mergedInto, mergeMode }`；
- 快照 `items[].git`：`{ sha, commits[{sha,at,message,files}], verify:{ok,at,results}|null, prReview:{verdict,at,mode}|null }`；
- 看板卡片徽章：`分支`（hover 显示名）、`已推送`、`已验证`、`PR #n`（可点外链）、`已合并`；抽屉「Git/PR」区显示明细。

## 3. 看板降噪（client.js）

1. **拓扑**：只画"参与者"节点（有 item/review/频道活动的成员 + Lead）；空闲 roster 成员折叠为灰色「空闲 N 人」节点；peer 边取 top 8（count≥2，除非参与者≤4），细线低透明度、画在 Lead 辐条之后；成员节点按名字长度自适应宽度、字号 11、不省略名字；参与者 >6 时两行网格布局。
2. **面板布局**：第一行 流程图（2fr）+ 拓扑（1.4fr）；第二行 协作频道（2fr）+ 提案与投票（1fr）；第三行 事件流 / 门禁 / 升级 三等宽；每面板 `max-height: 320px` 内部滚动、`min-height: 240px`；面板头样式统一。
3. **徽章降噪**：卡片 flags 最多显示 3 个（状态 + R + 最高优先级 flag），其余进抽屉；"自建/认领/待认领/提案中"优先级从高到低。
4. 现有 20 例契约测试保持全绿，新增 2 例（参与者过滤/空闲折叠、peer 边上限）。

## 4. 文件所有权

| 负责人 | 只写 |
| --- | --- |
| Lead | `lib/workflow.js`（item.git 字段/门禁）、`lib/tools.js`（team_flow_staff/team_flow_git/plan 自动组队）、`lib/config.js`、`index.js`、`docs/*`、`test/engine.test.mjs`、`test/collaboration.test.mjs`、`test/tools.integration.test.mjs`、`test/plugin.test.mjs` |
| host-snapshot | `lib/git.js`、`test/git.test.mjs` |
| client-board | `client.js`、`test/client.contract.test.mjs`（拓扑降噪 + git 徽章） |

> 注：`lib/dashboard.js` 的 `items[].git` 聚合由 Lead 在 `lib/git.js` 落地后自行补（host-snapshot 本轮只做 git 模块）。

## 5. 验收

1. `lib/git.js` 单测（真实临时 git 仓库 + bare remote）：status/branch/commit/verify/push/merge 全路径 + 6 条安全拒绝；
2. `team_flow_staff`/plan 自动组队：mock agentTeams 断言 spawnTeammate/sendMessage 调用与容量保护（≤8）；
3. `team_flow_git` 全动作 + 权限 + `gitEnabled:false` 拒绝 + gate 的 `gitRequireVerify`；
4. 看板降噪与 git 徽章通过契约测试；
5. **live run #3**（scratch git 仓库 + bare remote）：自建团队 → 抢单 → 成员自建项 → handoff → 1 分钟提案超时自动裁决 → 分支/提交/verify/push（gh 若未登录走 manual）→ 评审 → gate → Lead merge。
