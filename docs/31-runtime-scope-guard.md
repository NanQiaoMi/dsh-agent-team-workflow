# 31 · 运行时写范围守卫（v1.16.0）

> 目标：把「写范围」从 gate 事后检查（`strictScopes`）升级为**调用时同步拒绝**，
> 并配合角色工具策略封住评审者改文件的口子。

## 1. 行为

`enforceWriteScopes: true` 时，对每个 `ctx.tools.guard` 调用（sync）：

1. 只审查**直接写文件**的原生工具：`write`、`edit`、`str_replace_*`（`bash`/`terminal` 不做字符串猜测，见限制）；
2. 取调用者的 Team membership：只有 `teammate` 受审，Lead / 非成员放行；
3. 读运行板缓存：该成员**当前活跃**（pending/running/changes_requested/in_review/escalated）工作项的 `writeScopes` 并集；
4. 无活跃工作项（典型是 reviewer）→ 拒绝写入，并提示 `reviewers never write`；
5. 解析 `arguments.file_path`（兼容 `path` / `filePath`）为相对 Team 工作目录的路径，越界（`..`）直接拒绝；
6. 路径必须精确等于 scope 或以 `scope + '/'` 开头（目录 scope 生效）；
7. 不满足 → 返回拒绝字符串，工具调用不执行。

任何内部异常、无运行板、无 membership、参数缺失 → **fail-open**，不影响正常执行。

## 2. 配置

```yaml
- id: agent-team-workflow
  config:
    enforceWriteScopes: true   # 新增，默认 false
    strictScopes: true         # gate 仍保留事后核对
    roles:
      reviewer:
        prompt: You are the independent reviewer...
        deny: [write, edit, str_replace_editor]
      observer:
        readOnly: true
```

默认值 `false`，避免旧部署升级后突然拒绝写入；P0 配置已在 profile 121 打开。

## 3. 已知限制（诚实声明）

- `bash` 仍然可以 `echo > file` 绕过路径检查；插件不做命令解析（误报代价高）。需要更强隔离只能走 worktree / 容器。
- 仅覆盖 DSH 原生文件工具；自定义 MCP 写工具需要各自接入 guard。
- 角色 `deny` 与 scope guard 是两层独立防线：前者按角色，后者按 item 写范围。

## 4. 验证

- 单测 `test/scope-guard.test.mjs`（4 例）：范围内放行、范围外拒绝、目录 scope、`..` 越界、reviewer 无写、approved item 无写、Lead/outer 放行、非写工具放行、`enforceWriteScopes:false` 全放行；
- 插件装配测试：开启时注册第二个 guard（sandbox + scope），未开启时只有一个；
- 全量套件：224/224（plugin）+ 9/9（kit）。
