# 22 · 成员对话视图 live 验证（v1.5）

> 状态：待执行 —— 在独立 Host（1.5.0）打开历史 live run 会话，请求 member route 的 `transcript` 字段并截图。

计划：
1. 启动独立 Host（profile 121，端口 4399），打开 `session-76536de2…`（含 impl-alpha 的历史 run）；
2. `GET /api/agent-team-workflow.member?session=…&name=impl-alpha`，断言 `member.transcript.available === true` 且含真实 message（user/assistant/tool）；
3. 打开看板 → 成员抽屉 → 「对话」区截图；
4. 记录到本节。
