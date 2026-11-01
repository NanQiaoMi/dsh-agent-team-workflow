# 09 · 实时监控看板设计（Live Agent Team Board）

> 目标：把 Agent Team 的**真实运行态**变成一张实时看板——不是静态流程图，而是由黑板数据驱动的
> 拓扑 + 执行流 + 自循环（评审轮次）+ 事件流。所有数字都能追溯到 `.agentteam/teams/<teamId>/state.json`。
>
> 本文件是**实现契约**：host 聚合模块、HTTP 路由、client 视图三部分按此实现，互不改对方文件。

## 1. 总体结构

```
Host（Node 侧）                                  Client（Web 侧，React）
├─ lib/dashboard.js      纯函数：state→snapshot   ├─ client.js: 注册 conversation.view
├─ lib/dashboard-route.js GET /api/agent-team-workflow.snapshot
│     ├─ Connection 认证内嵌路由（owner principal）│     ├─ 轮询 snapshot（1200ms，页面隐藏时暂停）
│     ├─ session→agent→黑板读取 + roster + tasks  │     ├─ 渲染：流程图 / 协作拓扑 / 事件流 / 门禁
│     └─ JSON（no-store）                        │     └─ 详情抽屉、空态、错误态
└─ index.js：注册路由 + 客户端清单
```

数据流只有一个方向：**黑板/原生任务板 → host 聚合 → HTTP JSON → client 渲染**。看板不写任何状态。

## 2. Snapshot 契约（version 1）

`GET /api/agent-team-workflow.snapshot?session=<sessionId>` → `200 application/json`（Connection 的 exact Fetch 路由，`ctx.connection.fetch.register({ path, methods:['GET'], requestBody:'buffered', fetch })`；路径必须以 `/api/` 开头）：

```jsonc
{
  "ok": true,
  "version": 1,
  "generatedAt": "2026-11-01T03:20:00.000Z",
  "sessionId": "session-...",
  "run": null | {
    "id": "run-...", "phase": "planned|reviewing|converged|finalized|aborted",
    "objective": "...", "acceptanceCriteria": ["..."], "constraints": ["..."],
    "createdAt": "...", "updatedAt": "...", "finalizedAt": null,
    "settings": { "maxReviewRounds": 2, "maxParallelItems": 4, "strictScopes": false,
                  "requireReviewEvidence": true, "workerContext": "fresh", "autoNotify": true },
    "counts": { "total": 2, "approved": 1, "pending": 0, "inReview": 1,
                "changesRequested": 0, "escalated": 0 },
    "waves": [["W1","W2"], ["W3"]],
    "items": [{
      "id": "W1", "subject": "...", "owner": "impl", "role": "implementer",
      "status": "pending|running|in_review|changes_requested|approved|escalated",
      "wave": 1, "writeScopes": ["src/"], "blockedBy": [],
      "definitionOfDone": ["..."], "reviewers": ["rev"], "needsReview": true,
      "task": { "id": "task-2", "revision": 3, "status": "completed" } | null,
      "report": { "summary": "...", "files": ["..."], "commands": [{"command":"...","exitCode":0,"note":null}],
                  "evidence": ["..."], "risks": ["..."], "openQuestions": ["..."],
                  "deviation": null, "submittedAt": "..." } | null,
      "reviews": { "reworkRounds": 1, "submittedRounds": 2, "maxRounds": 2,
                   "pendingReviewer": null,
                   "verdicts": [{"reviewer":"rev","verdict":"approve_with_nits","round":1,"reportSeq":1}],
                   "records": [{"round":1,"reviewer":"rev","status":"submitted","verdict":"...",
                                "summary":"...","findings":[{"id":"F1","severity":"nit","file":"a.js","line":3,
                                "claim":"...","resolution":"accepted_by_reviewer"|"fixed"|"rebut"|"accepted_risk"|null}]}] },
      "openFindings": 0, "override": null
    }],
    "gate": null | { "pass": true, "evaluatedAt": "...",
                     "itemGates": [{"id":"W1","pass":true,"overridden":false,"waived":[],
                                    "failures":[],"warnings":[]}],
                     "teamFailures": [], "blockingEscalations": [] },
    "escalations": [{"id":"esc-1","kind":"conflict","subject":"...","detail":"...","blocking":false,
                     "itemId":"W1","createdBy":"impl","resolved":true,"resolution":"...",
                     "resolvedBy":"lead","resolvedAt":"..."}],
    "events": [{"at":"...","type":"run/planned|item/reported|review/submitted|escalation/raised|escalation/resolved|repair/reopen|run/finalized","actor":"...","detail":"..."}],
    "artifacts": {"root":"...","statePath":"...","reportPath":null}
  },
  "team": {
    "me": { "name": "lead", "role": "lead" },
    "members": [{"name":"impl-hello","role":"teammate","status":"running|inactive|provisioning|failed","context":"fresh|fork"}],
    "tasks":   [{"id":"task-2","revision":3,"status":"in_progress","subject":"...","ownerName":"impl-hello"}]
  },
  "diagnostics": { "boardSource": "file|memory|missing", "warnings": ["..."] }
}
```

规则：
- `run=null` 时仍然返回 `team`（没有 run 也要能看到谁在线）与 `diagnostics`。
- 时间一律 ISO 字符串；`generatedAt` 用于前端计算"x 秒前"。
- `items[].wave` = 依赖分层（无 blockedBy 为 1）。`waves` 与 items 必须自洽。
- `status` 归一化：黑板内部 `pending/running/reported/in_review/changes_requested/approved/escalated` → 对外
  `running` 仅在 `reported=false && 任务 in_progress` 时使用；`reported` 视为 `in_review`。
- 所有数组有上限（`events` 最近 200 条、`items` ≤ 64、`members` ≤ 16、`records` ≤ 12），避免响应体失控。
- 找不到 board：`run=null` + `diagnostics.boardSource="missing"`，**不是** 500。

错误语义：`400` 缺/非法 `session`；`403` 非 owner principal（Connection 层拦截）；`404` session 不存在；
`405` 非 GET；`500` 仅用于真实内部错误（响应体 `{ok:false,error}` 且不泄漏堆栈）。

## 3. Host 模块边界

| 文件 | 内容 | 约束 |
| --- | --- | --- |
| `lib/dashboard.js` | `SNAPSHOT_VERSION`、`buildSnapshot({state, team, artifacts, now, diagnostics})`、`computeWaves(items)`、`normalizeStatus`、`tailEvents` 等纯函数 | 零 import（仅可用内建）；不读文件、不碰 ctx；确定性（同输入同输出）；超限截断 |
| `lib/dashboard-route.js` | `registerDashboardRoute({ connection, ctx, store, settings })`：注册 `connection.fetch.register({ path:'/api/agent-team-workflow.snapshot', methods:['GET'], requestBody:'buffered', fetch })`；session→agent、读取黑板/roster/tasks、调用 `buildSnapshot`、返回 `Response.json` | 只用传入的 ctx/store；每条错误分支都有状态码；`cache-control: no-store`；不允许抛出到框架 |
| `index.js`（Lead 负责） | 在 apply 中 `ctx.effect(() => registerDashboardRoute(...))` | 只加 wiring，不改其它逻辑 |
| `client.js`（另一位负责） | Web 端视图 | 见 §4 |

## 4. Client 视图契约

**模块形态**（纯 JS，无需构建）：

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-agent-team-workflow',
  factory(require) {
    const React = require('react');       // 只允许 require('react')
    const h = React.createElement;
    // ... 组件
    return { inject: ['slots', 'locale'], apply(ctx) { /* 注册 */ } };
  },
});
```

**注册**：`conversation.view`（会话级全区视图，和 Trajectory 同级，通过 View 导航切换）

```js
const NS = 'agent-team-workflow';
ctx.locale.register(NS, { zh: {...}, en: {...} });        // 先注册字典
const t = ctx.locale.bind(NS);
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view',
  id: 'agent-team-workflow',
  order: 30,
  locale: NS,
  label: () => t('view.label'),
  inject: (sessionId) => ({ sessionId }),
}, DashboardView));
```

组件收到的 props：`{ sessionId, t, ...框架通用 props }`（框架还会给 `useSession` 等，按需忽略）。

**数据获取**：组件内 `useEffect` 每 1200ms `fetch('/api/agent-team-workflow.snapshot?session='+encodeURIComponent(sessionId), {credentials:'same-origin', headers:{accept:'application/json'}})`；
`document.hidden` 时暂停；`AbortController` 在卸载/切换时中止；失败保留上一次数据并显示"离线/重试"。

**布局（自上而下）**：
1. **Header**：标题、run id、phase 徽章、`approved/total` 进度、最近更新时间、刷新/暂停按钮、错误条。
2. **主体两栏**（窄屏单栏）：
   - **左：执行流程图**（SVG + HTML 卡片混合）。按 `wave` 分列；每个 item 一张卡：id、subject（截断）、owner、状态色条、评审 `R{round}/{max}`、未决 findings 数、escalation 标记；`blockedBy` 箭头连接；同 item 的评审轮次画**自循环箭头**（卡片右侧小环，标注 `R1→R2`）；待评审时卡片描边高亮并显示 pending reviewer。
   - **右：协作拓扑**。Lead 节点在顶部，成员环绕；边：Lead→成员（spawn/steer）、成员→其 item（owns）、reviewer→被审 item（reviews，虚线）。运行中成员脉冲高亮，inactive 半透明，failed 红色。显示 `fresh/fork` 徽章与成员状态。
3. **底部三面板**（可换行）：**事件流**（最近 30 条，按类型着色，可筛选 review/escalation/repair）、**门禁**（每项 pass/fail/waived + team failures + 报告路径）、**升级**（blocking 高亮、resolution）。
4. **详情抽屉**：点击 item 卡片 → 右侧抽屉显示 DoD、报告（文件/命令+退出码/证据/风险）、评审记录与 findings 处置、repair log。抽屉是组件内状态，不写 URL。

**视觉**：只用主题 token（`--dsw-alias-bg-base/layer-1/layer-2/overlay`、`border-l1/l2`、`label-primary/secondary`、
`brand-primary`、`state-success/warn/error/idle-primary`）；状态色映射：approved=success、in_review=brand、
changes_requested=warn、escalated/pending failed=error、pending=idle。样式用组件内 `<style>` 元素（类名前缀 `atw-`），
卸载即消失；**不要** `document.body`、不要 iframe、不要 require 其它 Harness 包。

**容错**：`run=null` → 空态卡片（提示"让 Lead 运行 team_flow_plan"）但仍渲染 team 拓扑；字段缺失一律用可选链 + 兜底；
组件抛错不能白屏（顶层 try/catch 渲染错误卡片）。**可见文案全部走 `t()`**（zh/en 两套）。

## 5. 文件所有权（并行开发，禁止越界）

| 负责人 | 只写这些文件 |
| --- | --- |
| host-snapshot | `lib/dashboard.js`、`test/dashboard.test.mjs` |
| client-board | `client.js`、`test/client.contract.test.mjs` |
| Lead | `lib/dashboard-route.js`、`index.js`、`package.json`、`cordis.patch.yml`、`docs/09`、`docs/10`、README |

## 6. 验收标准

1. ✅ `buildSnapshot` 单测覆盖：无 run、完整 run（2 items/依赖/评审记录/gate/escalations）、截断上限、状态归一化、waves 自洽（14 例，见 `docs/10`）。
2. ✅ 路由：GET 200 + JSON + `no-store`；400/404/405 分支；损坏黑板降级、非成员会话不抛（6 例；403 由 Connection 层拦截）。
3. ✅ `client.js`：模块格式正确、只 require('react')、注册 `conversation.view`（id/order/label/locale/inject）、无 `document.body`/iframe/其它 require；`node --check` 通过（10 例契约测试）。
4. ⏳ 端到端（需重启 + 刷新后由人工确认）：View 导航出现"团队看板"，打开即见当前 run；运行中的 team 在 1–2 秒内更新；点击 item 出详情；收敛后仍可查看报告。验证步骤见 [`10-dashboard-verification.md`](10-dashboard-verification.md) §3。
