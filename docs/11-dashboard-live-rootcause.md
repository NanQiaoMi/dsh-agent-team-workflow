# 11 · 实时看板 live 验证与「View 不出现」根因

> 背景：看板实现（`docs/09`/`docs/10`）合入后，用户重启 DSH、刷新页面，View 导航里**没有出现**「团队看板」。
> 本文记录对**运行中的 DSH Desktop** 做的只读验证、根因、修复与复验步骤。

## 1. 验证方法（只读）

DSH Desktop 的 Web 入口默认只允许 Electron renderer 访问（`x-dsh-desktop-renderer` 代际令牌 + 浏览器会话 Cookie），
普通 `curl` 一律 `403 forbidden`。本次通过本机 Electron utility（Host）进程的 Inspector 与 renderer 现存的
只读凭据，对运行中的应用做了两条只读探测（凭据仅在本机临时使用，未落盘到仓库、未打印）：

1. `GET /` → 解析 `globalThis["__DSH_BOOT__"]`（客户端启动图：所有会加载的 client 模块）；
2. `GET /api/agent-team-workflow.snapshot?session=<id>` → 看板 Host 路由的真实响应。

## 2. 实测结果

| 探测 | 结果 | 结论 |
| --- | --- | --- |
| `/` 的 `__DSH_BOOT__` | 77 个 client 模块，**不含** `@local/dsh-agent-team-workflow` | ❌ 客户端半从未进入启动图，所以 `apply()` 从未执行，`conversation.view` 注册不存在，View 导航自然没有 |
| `/api/agent-team-workflow.snapshot?session=session-38f1f4ad-…` | **200**，`{ok:true, version:1, run:null, team:{me:{name:"lead",role:"lead"}, members:[lead, research-teams, dsh-api-recon, code-reviewer, impl-hello, impl-docs, rev-hello, host-snapshot, client-board]}}`，`diagnostics:{boardSource:"missing"}` | ✅ **Host 半存活且路由正确**：认证围栏、session→agent 解析、roster 读取、`no-store` 全部按契约工作；`run:null` 是因为黑板在原 cwd（`/tmp/atw-smoke`）被清理，属预期 |

即：**问题 100% 在客户端模块登记，不在看板逻辑**。

## 3. 根因

`dsh-client-modules` 在 Host 启动时扫描 Loader 行：对每个行解析其包清单，读取 `dsh.client`。

- 本机 Loader 未提供 ESM `resolveSync`，扫描器走 fallback 分支：
  `createRequire(baseUrl).resolve('<package>/package.json')`；
- 我们的 `package.json` `exports` 只导出了 `.`、`./client`、`./locale/*.json`、`./icon`，
  **没有导出 `./package.json`** → `ERR_PACKAGE_PATH_NOT_EXPORTED`；
- `locatePkgJson` 对解析失败返回 `undefined`，**静默跳过**（不报错、不日志）；`pkgMeta` 还会把这次
  `null` 结果按 `(baseUrl, loaderName)` 缓存；
- 于是 Host 半正常（`index.js` 直接按路径加载），客户端半被彻底忽略。

对照官方包：`@deepseek-ai/dsh-client-ui-trajectory`、`@deepseek-ai/dsh-experimental-client-ui-agent-team`
的 `exports` 都显式包含 `"./package.json": "./package.json"`。

复现/证明（修复前后同一命令）：

```text
# 修复前
createRequire('~/.dsh/profiles/121/package.json').resolve('@local/dsh-agent-team-workflow/package.json')
→ FAIL ERR_PACKAGE_PATH_NOT_EXPORTED

# 修复后
→ ~/Documents/.../agent-team-workflow/package.json
```

并用独立脚本复刻扫描器的 `locatePkgJson + resolveMeta` 逻辑，修复后输出：

```json
{ "platform": "web", "immediately": true,
  "inject": ["...locale","...ui-conversation","...ui-renderer","...ui-session"],
  "clientEntry": "./client.js",
  "clientPath": ".../agent-team-workflow/client.js",
  "clientExists": true }
```

## 4. 修复

`packages/agent-team-workflow/package.json`：

- `exports` 增加 `"./package.json": "./package.json"`；
- 版本 `1.0.0 → 1.0.1`（便于确认加载的是新清单）；
- `client.js`：修复 View 切换后的滚动位置（见 §5 最后一行）。

已重新安装 bundle（`application: applied`）。**必须重启 Host** 才能生效：扫描器把失败结果缓存在内存
（`pkgMeta` 的 `null`），行热重载不会清缓存；Client 侧则需要页面刷新/重启后重新拉取启动图。

## 5. 隔离实例上的完整复验（已在真实浏览器完成）

为了不干扰用户正在运行的 Desktop 代际，用同一 profile 起了一个独立 Host
（`dsh --profile 121 --port 4399 --no-open`，独立端口、独立进程），并在真实 Chromium 里驱动它：

| 检查 | 结果 |
| --- | --- |
| 启动图包含 Web 半 | ✅ 修复后 `__DSH_BOOT__.entries` 出现 `@local/dsh-agent-team-workflow`（`client.js` rev + 4 个 inject 依赖 + `immediately:true`） |
| View 导航 | ✅ 会话头部 tab 为 `对话 / 轨迹 / 团队看板`，点击后 `aria-selected=true` 且渲染 `.atw-root` |
| 认证路由（同源浏览器） | ✅ `fetch('/api/agent-team-workflow.snapshot?session=…')` → 200、`cache-control: no-store`、`{ok:true, version:1, run:null, diagnostics:{boardSource:"missing"}}` |
| 富数据渲染 | ✅ 用真实已收敛 run 的 `state.json` 作 fixture：流程图（波次卡 + `R1/2` 自循环 + 依赖箭头）、拓扑（Lead + W1/W2 节点 + 三类边图例）、事件流 9 条 + 筛选、门禁三项通过 + 报告路径、升级已裁决；截图见 `docs/evidence/dashboard/` |
| 详情抽屉 | ✅ 点击卡片后展示 owner/role/status/wave/reviewers/写范围/DoD/报告摘要 |
| 空态 | ✅ 无黑板时显示"看板为空 · 让 Lead 运行 team_flow_plan…" + 成员拓扑 |
| **滚动位置 bug** | ⚠️ 发现并修复：View 切换复用会话滚动容器，聊天滚到底（scrollTop=6093）后切到看板会"空白"（看板实际渲染在 y=-1038）。已在组件挂载时把最近的可滚动祖先 `scrollTop=0`；复验 `6093 → 0`、`boardTop=76`、可见 |

新增契约测试：`test/client.contract.test.mjs` 增加 1 例（10/10 通过），锁住"必须重置滚动容器"这一行为。

## 5b. 桌面 App 重启后的复验清单

1. Host 重启 → 重新拉取 `GET /`，`__DSH_BOOT__` 的 `entries` 应出现
   `@local/dsh-agent-team-workflow`（`url` 形如 `plugins/??@local/dsh-agent-team-workflow/client.js&rev=…`，`immediately:true`）；
2. 页面刷新 → 会话头部出现 tab 条（`data-conversation-tabs`），第二个 tab 文案为「团队看板」；
3. 点开 → Header / 流程图 / 拓扑 / 事件流 / 门禁 / 升级面板渲染；空 run 时显示空态与成员拓扑；
4. 网络面板可见 1.2s 一次的 `/api/agent-team-workflow.snapshot?session=…` 200；
5. 跑一个小 Team run → 成员状态与事件在 1–2 秒内更新，点卡片出详情抽屉。

## 6. 经验

- 自写 bundle 的 `package.json` **必须**导出 `./package.json`（即便 Host 半能跑），否则 Web 端 client 半会被静默跳过；
- 「Host 插件已 applied」不能证明「客户端半已加载」：两者是两条独立的加载链（Loader vs client 启动图）；
- 判断客户端半是否加载，最直接的是看 `__DSH_BOOT__.entries`，而不是看 View/控制台是否报错（这里是**无错误静默跳过**）。
