# 27 · 可复用工具沙箱库：@local/dsh-tool-guard-kit（v1.8）

> 背景：v1.7 在 agent-team-workflow 里实现了原生工具沙箱（docs/25），核心只有三步：
> `ctx.tools.guard()` 注册、`exec.agent` 身份解析、同步策略判定。本版把这三步抽成
> **独立、零依赖、可被任意 DSH Cordis 插件复用**的库。

## 1. 包结构

```
packages/tool-guard-kit/
  index.js            # 库实现（约 330 行，零依赖）
  test/kit.test.mjs   # 9 例
  README.md           # 使用文档（API/示例/语义/边界）
packages/agent-team-workflow/
  lib/tool-guard.js   # 适配层：把库绑定到 run board 状态
  index.js            # apply() 里 installToolSandbox(...)
```

## 2. API（详见包 README）

| 导出 | 作用 |
| --- | --- |
| `createToolSandbox(options)` | 纯实例：`check(exec)` / `setPolicies` / `audit(limit)` / `stats` / `policies` |
| `installToolSandbox(ctx, options)` | 用 `ctx.effect` 注册一个全局 guard，返回 `{...sandbox, dispose}` |
| `normalizePolicies(raw)` | 把对象/Map 规范化成 `Map<role,{readOnly,allow,deny}>`（忽略未知字段） |
| `isMutatingTool(name)` | write/edit/bash/terminal + `terminal_*`/`str_replace_*` 家族 |
| `createTeamSubjectResolver({ctx,stateFor,roleFromState})` | Agent Teams 适配器：Lead/非成员 → null |
| `roleFromTeamState(state,name)` | 参考角色解析（roleAssignments → 唯一 owned item role） |

关键设计：
- **fail-open 默认**：resolver/状态抛错、畸形 exec、未知角色 → 放行；`failOpen:false` 可切严格模式；
- **审计环** `audit(limit)` + `stats` + `onDeny` 观察者（异常吞掉，不影响判定）；
- **动态策略** `resolvePolicy(subject, exec)` 可覆盖静态表（供运行时策略引擎使用）；
- **生命周期**：guard 由 `ctx.effect` 持有，插件卸载/HMR 自动注销，`dispose()` 幂等。

## 3. 本插件的接入方式

`lib/tool-guard.js` 变成薄适配层：

```js
installToolSandbox(ctx, {
  policies: settings.roles,                       // 原有 roles 配置直接复用
  resolveSubject: createTeamSubjectResolver({
    ctx,
    stateFor: (exec) => {                         // 同步读 board 缓存
      const m = ctx.agentTeams.tryMembership(exec.agent)
      return m ? store.cachedState(m.root) : null
    },
  }),
  failOpen: true,
  label: 'agent-team-workflow.toolSandbox()',
})
```

`team_flow_*` 工具在适配层里显式跳过（交给 `assertRoleAllowed`），保持职责分离。

## 4. 部署注意（诚实）

- 本仓库没有 workspace 工具链，插件以相对路径 `../../tool-guard-kit/index.js` 引用该库；
  DSH 的 `@local/*` bundle 以 **link** 方式安装（指向源码目录），因此运行时相对路径有效；
- 若将来把插件单独发布/拷贝（非 link 安装），需要把 `tool-guard-kit` 作为真实依赖打包，
  或在构建时内联；这一点已写进包 README 与本节。

## 5. 验收

- 库测试：`packages/tool-guard-kit/test/kit.test.mjs` **9/9**
  （分类、规范化、三种策略、fail-open/closed、动态策略、审计边界、install/dispose、Teams 适配器）；
- 插件测试：原 214 全绿（适配层保持 `toolGuardReason` 等导出不变）；
- 合计 **223/223**（插件 214 + 库 9；`node --test test/*.test.mjs`）；
- 接线验证：通过 profile 的 `node_modules/@local/dsh-agent-team-workflow` 符号链接实际 `import` 插件入口成功
  （`plugin loaded: agent-team-workflow | apply: function`），证明相对导入 kit 在 link 安装下可解析；
  沙箱行为本身已在 v1.7 live 两轮验证（docs/26），本次为纯重构、行为不变。
