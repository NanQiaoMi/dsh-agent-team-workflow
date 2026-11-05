# 39 · 全量功能审计与修复（v1.23.1）

> 时间：2026-11-05 21:00–21:35 CST　范围：当前仓库 v1.23.0 → v1.23.1
> 方法：离线全量测试 + 配置/schema 校验 + 安装产物核对 + 桌面 Host 日志 + 无头浏览器看板渲染 + 真实 run 观测。

## 1. 审计结论

**核心功能可用**：241/241 插件测试、9/9 沙箱库测试、看板契约 41/41；配置键全部被 schema 识别；已安装 bundle 与仓库版本一致（1.23.0）；桌面 Host 重启后无插件错误；看板渲染无 console 错误；真实 run `run-20261103133334-o62o` 完成完整自治闭环（finalized，gate pass=true，2/2 approved，W1/W2 各自 request_changes → 修复 → 复审 approve）。

审计中发现 **4 个真实问题**，本轮已全部修复：

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| 1 | `index.js` 的 `VERSION` 仍是 `1.17.0`，与 package `1.23.0` 漂移 | 启动日志与实际版本不符，排查/支持会误判 | 同步为 `1.23.1`；新增「VERSION 必须等于 package.json」回归测试 |
| 2 | 拓扑 inactive 成员名双重降透明：`.atw-node--st-inactive{opacity:.55}` 叠加 `.atw-topo-col--inactive{opacity:.74}` ≈ 0.41 | 待命成员名字几乎看不清（真实截图确认） | 列级降为 .82，列头 `opacity:1`；新增 CSS 契约断言 |
| 3 | `request_changes` 时 reviewer 调 `updateTask(reopen)` 被原生权限拒绝（只有 owner/Lead 能改任务） | backing Team task 卡在 completed，与实际重新开工的状态不一致 | `syncTaskReopen` 改以 Team Lead（membership.root）身份调用；测试 harness 现在强制 owner/Lead 规则，原集成用例成为真实回归 |
| 4 | P0 `roles.verifier` deny 了 write/edit，但 item.role=verifier 的成员也可能同时是作者 | 作者修自己声明范围内的文件会被 role 策略挡住，只能绕道 node 脚本 | profile 配置移除 verifier 的写禁令（reviewer 保留写禁令，评审独立性不受影响） |

## 2. 逐项检查记录

| 检查项 | 命令/方法 | 结果 |
|---|---|---|
| 插件单元/集成测试 | `node --test test/…（15 个文件）` | 242/242 PASS（含新增版本一致性用例） |
| 沙箱库 | `node --test packages/tool-guard-kit/test/*.test.mjs` | 9/9 PASS |
| 配置 schema | 逐键对照 `lib/config.js DEFAULT_SETTINGS` | 0 个未知键；auto*/worktree/roles 全部识别 |
| 安装产物 | `profile/121/node_modules/@local/...` | link 生效，version 1.23.0 → 本轮升 1.23.1 |
| 桌面 Host | `~/Library/Application Support/DSH Desktop/logs/dsh-2026-11-05*.log` | 12:35Z 重启后无插件错误/异常 |
| 看板渲染 | 独立 Host + headless Chrome 打开 board | `.atw-root/.atw-flow-scroll/.atw-topo-canvas` 均存在，console error = 0 |
| 交付物 | `node --check app.js/verify.mjs`、`node --test team-web-demo/verify.mjs` | exit 0 / exit 0 / 11/11 PASS |
| 真实 run | `state.json` 观测 | finalized，gate.pass=true，W1/W2 双循环通过，report.md 生成 |
| 自治链路 | 观测 request_changes → 自动唤醒作者 → 修复 → 复审 → 自动 finalize | 全链路在 3 分钟内完成 |

## 3. 遗留与限制（未修，如实记录）

1. **后台 subagent `toJSON without inject`**：出现一次，重试后成功；宿主日志无持久堆栈，未复现。属 Cordis 上下文序列化瞬时错误，不在本插件代码路径上。
2. **worktree/git 配置是全局的**：`worktreeIsolation: parallel` 在非 git 工作区会跳过 worktree（本轮 default-workspace 无 `.git`，run 正常完成、无 worktree 产物）。这是设计的降级，不是失败；如需强制隔离请只在 git 工作区开启。
3. **`docs/05` 验证矩阵停留在 v1**：最新验证以 `docs/32`–`docs/38` 与本文为准，文档债待统一。
4. **写范围强制仍是协议级**：`enforceWriteScopes` 拦 write/edit/str_replace；`bash` 重定向可绕过（docs/31 已声明）。

## 4. 验证命令与结果

```bash
# 插件全量
cd packages/agent-team-workflow && node --test test/engine.test.mjs test/collaboration.test.mjs \
  test/tools.integration.test.mjs test/plugin.test.mjs test/dashboard.test.mjs test/dashboard-route.test.mjs \
  test/client.contract.test.mjs test/git.test.mjs test/hooks.test.mjs test/member-route.test.mjs \
  test/transcript.test.mjs test/tool-guard.test.mjs test/scope-guard.test.mjs test/orchestrator.test.mjs \
  test/worktree-engine.test.mjs
# ℹ tests 242 / pass 242 / fail 0

# 沙箱库
cd packages/tool-guard-kit && node --test test/*.test.mjs   # 9/9 PASS

# 交付物
node --check team-web-demo/app.js                     # exit 0
node --check team-web-demo/verify.mjs                 # exit 0
node --test team-web-demo/verify.mjs                  # 11/11 PASS
```

## 5. 变更文件

- `packages/agent-team-workflow/index.js`（VERSION 1.23.1）
- `packages/agent-team-workflow/lib/tools.js`（syncTaskReopen 以 Lead 身份执行）
- `packages/agent-team-workflow/client.js`（inactive 拓扑双重降透明修复）
- `packages/agent-team-workflow/test/plugin.test.mjs`（版本一致性回归）
- `packages/agent-team-workflow/test/tools.integration.test.mjs`（harness 强制 owner/Lead 任务权限）
- `packages/agent-team-workflow/test/client.contract.test.mjs`（inactive 不双重降透明断言）
- `packages/agent-team-workflow/package.json`（1.23.1）
- `~/.dsh/profiles/121/cordis.patch.yml`（verifier 角色写禁令移除；仓库外配置）
