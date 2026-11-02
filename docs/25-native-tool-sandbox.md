# 25 · 原生工具沙箱（v1.7）——把 ③ 做到工具调用边界

> 上一版（docs/23 §2.1）的边界是：Team spawn 契约没有 per-teammate 工具/权限字段，插件只能在
> workflow 层做能力约束。v1.7 找到并使用了 DSH 的**公开工具守卫 API**，把约束推进到
> **原生工具调用边界**：被拒绝的工具根本不会执行。

## 1. 机制

DSH `ctx.tools.guard(fn)`：同步、单调的拒绝钩子，运行在 `tools/pre-execute` waterfall 之后；
返回字符串即拒绝该次调用（`tools.js` 内部 `guardReason`）。插件在 **全局**注册一个 guard，
回调里通过 `ctx.agentTeams.tryMembership(agent)` 判断调用者身份：

- Lead / 非 Team agent / 尚未分配角色的成员 → 放行；
- `team_flow_*` workflow 工具 → 交给 `assertRoleAllowed`（workflow 层策略）；
- teammate 且其角色命中 `settings.roles[role]` 的 `allow` / `deny` / `readOnly` → 判定；
- 角色解析：`roleAssignments[member]` 优先，否则取该成员拥有的 item 的唯一 role；
- 状态读取：guard 是同步的，所以读 `store.cachedState(root)`（进程内最近一次 read/write 的状态）；
  **未预热（缓存为空）时 fail-open**，不会误杀正常工具；plan/status 等操作会预热。

## 2. 判定表

```yaml
roles:
  observer:
    readOnly: true            # 禁止原生写工具 write/edit/bash/terminal
  docs-only:
    allow: [read, grep, glob, write, edit]   # 白名单；其余原生工具一律拒绝
  auditor:
    deny: [bash, write]       # 黑名单
```

- `readOnly: true` 额外禁止 `write` / `edit` / `bash` / `terminal`（`NATIVE_MUTATING_TOOLS`）；
- `allow` 非空时：原生工具必须出现在 allow 里（对原生工具是**穷尽白名单**）；
- `deny`：精确匹配工具名；
- 拒绝文案包含角色名与配置键，例如
  `tool "write" is blocked by the Agent Team tool sandbox: role "observer" is read-only (roles.observer.readOnly)`。

## 3. 强度与边界（诚实）

- **这是工具调用边界，不是 OS 沙箱**：被 guard 拒绝的工具不会执行；但 teammate 若被允许某些工具
  （如 `bash`），其内部行为仍受 DSH 会话权限/sandbox 策略约束，插件无法在 bash 内部再细分；
- guard 是**全局注册**、按调用者过滤：不会影响 Lead 或非 Team agent；
- fail-open 设计：缓存未预热或未知角色时放行，避免插件 bug 阻断正常执行；预热后严格生效；
- 与 workflow 层 `assertRoleAllowed`、`strictScopes`、worktree 产物门禁共同构成四层约束：
  **原生工具 → workflow 工具 → 写范围 → 产物位置**。

## 4. live 发现的问题与修正（1.7.1）

第一轮 live（1.7.0）跑出两个真实缺陷，已修并加测试：

1. **readOnly 把 `team_flow_report` 也禁了**：工作流要求 owner 用 report 交付，导致 owner 链路断裂。
   修正：readOnly 只禁真正的变更型 workflow 工具（plan/work/item/git/gate/repair/staff/stop/decide/plan_approval），
   **report / review_submit / review_respond / talk / escalate 放行**（协作而非工作区变更）；
2. **`terminal_*` 系列工具没被拦**：guard 只精确匹配了 `terminal`。修正：`isNativeMutatingTool` 对
   `terminal_*` / `str_replace_*` 前缀一并视为 mutating。

## 5. 验收

- 单元：`test/tool-guard.test.mjs`（5 例覆盖判定表、fail-open、workflow 前缀放行）；
- 插件：`test/plugin.test.mjs` 断言恰好注册一个全局 guard 且非成员放行；
- live：见 [`26`](26-v17-live.md)（含上面两个缺陷的现场证据）。
