# 10 · 实时看板验证记录

> 对象：`packages/agent-team-workflow` 的看板增量（`lib/dashboard.js`、`lib/dashboard-route.js`、`client.js`）。
> 设计契约见 [`09-dashboard-design.md`](09-dashboard-design.md)；本文只记录**实际执行过**的验证与尚未验证的部分。

## 1. 实现了什么

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `lib/dashboard.js`（655 行） | 纯函数聚合：`state.json` + roster + native tasks → 快照（waves、状态归一化、counts、评审记录、截断、防御式降级） | **零 import** |
| `lib/dashboard-route.js` | `GET /api/agent-team-workflow.snapshot?session=`，注册在 Connection 认证 Fetch 围栏内；session→agent→黑板读取；400/404/405/500 分支；`cache-control: no-store` | 只 import `./dashboard.js` |
| `client.js`（2031 行） | Web 端 `conversation.view`（"团队看板"）：执行流程图（波次/依赖箭头/评审自循环）、协作拓扑、事件流、门禁、升级、详情抽屉、空态/错误态、1.2s 轮询（隐藏暂停） | 只 `require('react')` |

## 2. 已完成的验证（全部真实执行）

### 2.1 离线测试

```bash
cd agentteam-kit/packages/agent-team-workflow
NODE=~/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node
"$NODE" --test test/engine.test.mjs test/tools.integration.test.mjs test/plugin.test.mjs \
                 test/dashboard.test.mjs test/dashboard-route.test.mjs test/client.contract.test.mjs
```

实测：**74 tests / 74 pass / 0 fail**。

| 套件 | 用例 | 覆盖 |
| --- | --- | --- |
| `engine.test.mjs` | 26 | 工作流状态机（既有） |
| `tools.integration.test.mjs` | 14 | 8 个工具（既有） |
| `plugin.test.mjs` | 5 | 装配 + 新增断言「恰好注册一条 `/api/agent-team-workflow.snapshot` GET 路由」 |
| `dashboard.test.mjs` | 14 | run=null、waves/依赖、依赖环降级、状态归一化矩阵、评审记录与 openFindings、counts 一致性、截断（300 events / 65 items / 超长 detail）、gate/escalations 透传、事件升序、畸形输入不抛、确定性 |
| `dashboard-route.test.mjs` | 6 | 路由注册形态（`/api/` exact + GET）、200 快照字段、400/404/405、无黑板时仍返回 roster、非成员 session 不报错、损坏黑板降级为 warning 而不是 500 |
| `client.contract.test.mjs` | 9 | 模块外壳/工厂、只 require('react')、注册字面量（slot/id/order/label/inject）、禁构造（无 `document.body`/iframe/外部 require）、无硬编码色值、zh/en 字典键集一致、`t()` key 全覆盖、`conversation.view` 注册形状、空态可渲染（含错误边界与内联样式） |

### 2.2 真实黑板 dry-run（不依赖浏览器）

把 live run 的真实 `state.json`（`run-20261101025416-dt5p`，2 items、gate pass、esc-1 resolved）直接喂给 `buildSnapshot`：

- 响应体 **24.8 KB**；`waves=[["W1","W2"]]`、`gate.pass=true`、`esc-1 resolvedBy=lead`、9 条事件升序、artifacts 三路径齐全；
- 逐字段对照 `09` §2 核对 **run 态与 run=null 态**，字段名/嵌套结构全部一致。

### 2.3 静态检查

- `node --check`：`lib/dashboard.js`、`lib/dashboard-route.js`、`client.js`、全部测试文件 → 通过；
- `package.json`：`exports["./client"]`、`files` 含 `client.js`、`dsh.client = {platform:"web", immediately:true, inject:[ui-conversation, client-locale]}` 均合法 JSON；
- `plugin_manager install_bundle` → `application: applied`，bundle 行 active。

## 3. 尚未验证（需要一次重启 + 刷新）

Host 模块代需要重启才加载（HMR 不替换 linked 插件模块），Client 模块需要页面刷新。步骤：

1. **重启 DSH**（Host 半加载 `lib/dashboard-route.js` 并在 Connection 上注册路由）；
2. 打开本会话（cwd 为 `/tmp/atw-smoke`，黑板里有已收敛的 hello run）；
3. 会话头部 **View 切换 → "团队看板"**；
4. 期望：
   - Header 显示 `run-20261101025416-dt5p`、`finalized`、`2/2`；
   - 流程图两列（同波次 W1/W2），两张卡片 approved 绿，评审 `R1/2` 自循环标记，依赖/评审连线可见；
   - 拓扑显示 Lead + 3 个成员（impl-hello / impl-docs / rev-hello）与角色/状态；
   - 事件流出现 `run/planned → escalation/raised → escalation/resolved → item/reported ×2 → review/submitted ×2 → run/finalized`；
   - 门禁面板两项 pass、无 override；升级面板显示 esc-1 已解决与裁决文本；
   - 状态栏"更新于 x 秒前"在跳动（轮询生效），切到其它标签页时间停止增长（隐藏暂停）。
5. **实时性验证**：开着看板，让 Lead 开一个小 run（`team_flow_plan`）并 spawn 成员——成员 `running` 状态与 `item/reported`、`review/submitted` 事件应在 1–2 秒内反映到看板（无需手动刷新）。

若看板显示"离线"：先确认页面已刷新（Client 模块是启动时加载的），再确认 Host 已重启（路由未注册时请求返回 404）。浏览器控制台的网络面板可直接看到 `/api/agent-team-workflow.snapshot?session=...` 的请求与状态码，这是最快的定位手段。

## 4. 已知取舍与限制

| 项 | 现状 | 说明 |
| --- | --- | --- |
| 刷新机制 | 1.2s 轮询（无 SSE） | 实现简单、可断线重试；页面隐藏时暂停，避免空耗。要真正推送可后续接 Connection 的流式通道 |
| 数据来源 | 黑板文件 + 原生 roster/tasks | 看板**只读**，不写任何状态；不展示成员间消息历史（DSH 未提供消息历史查询 API） |
| `openFindings` 口径 | 所有评审记录中未处置 finding 数 | 正常流程与 gate 一致；`repair reopen` 后旧版本未决 finding 也会计入（提示"有历史尾巴"，不影响 gate） |
| 多 Team | 看板绑定当前 View 的 session 所属 Team | 每支 Team 独立黑板；别的 Team 需切到那个会话的 View |
| 成员状态 | 来自原生 roster | `inactive` 只表示无回合在执行，不代表完成/失败（与原生语义一致） |
