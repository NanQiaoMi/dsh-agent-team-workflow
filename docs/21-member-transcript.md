# 21 · 成员对话视图（transcript）

> 目标：补齐 docs/18 差距项 #15 的最后一块——用户不只看成员的"工作流视图"，还能看到它实际的对话/工具轨迹。
> 状态：**已实现（插件 1.5.0，离线 201/201，live 见 [`22`](22-transcript-live.md)）**；Host 侧 `lib/transcript.js` + member route 扩展，客户端抽屉新增「对话」区。

## 1. 数据链路

```
GET /api/agent-team-workflow.member?session=<lead>&name=<member>
  → member.transcript = {
      available: boolean,
      messages: [{ seq, role: 'user'|'assistant'|'system'|'tool', text }],
      truncated: boolean,
      totalEvents: number,
      error: string|null
    }
```

- Host 侧可选 seam `ctx.sessionQuery.readSession(sessionId)` 读取该成员会话的原始事件；
- `lib/transcript.js#summarizeTranscript(events, {limit=40, textLimit=1200})` 把事件投影成可读消息：
  - `user/message` → role=user（text blocks）
  - `assistant/message` → role=assistant（text + `[tool] name args` 摘要）
  - `system|developer/message` → role=system
  - `tool/result` → role=tool
  - 其它事件（session/llm/*/turn/*）跳过；未知/畸形事件不抛错；
- 只取**尾部 40 条**（`truncated` 标记是否被截断），单条文本上限 1200 字符；
- Host 没有 `sessionQuery`、或读取失败时：`available:false` + `error`，UI 降级为"仅工作流视图"。

## 2. 客户端

- 成员抽屉新增「对话」区：角色小标签（user/assistant/system/tool）+ 正文（clamp 3 行）；
- `truncated` 时显示「仅显示最近 N 条」；
- 不可用/空时显示降级文案（不崩、不伪造）；
- 刷新：成员抽屉打开时随 1.2s 轮询一起刷新该 payload，因此 transcript 跟随会话增长。

## 3. 安全与边界（诚实说明）

- transcript 仅对**同 Team 成员**可见：member route 先校验 `tryMembership` + roster 中确有该成员，读取对象是 roster 成员的 session id（不是任意 session）；
- 只读投影：插件不修改会话日志，也不对外发送；
- 隐私：内容是该成员与模型/工具的原始文本摘要，**仅本地 Web GUI 可见**（路由走 Connection 鉴权、`cache-control: no-store`）；
- 不保证覆盖所有事件类型；若 Host 会话格式升级，`summarizeTranscript` 会退化为"少显示几条"而不是崩溃。

## 4. 验收

- 单元：`test/transcript.test.mjs`（真实 event 形状、截断、畸形事件、长文本 clamp）；
- 路由：member route 在 provider 可用/抛错两种情况下都返回 200 且结构稳定；
- 客户端契约：available 渲染、unavailable 降级；
- live：独立 Host 中读取真实 teammate 的会话日志（见 docs/22）。
