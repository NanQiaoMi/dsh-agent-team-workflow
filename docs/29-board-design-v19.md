# 29 · 看板视觉重构（v1.9，参考 refero「Ui — clinical blueprint on frosted paper」）

> 用户提供设计参考：<https://styles.refero.design/style/0fd67ec5-7e9c-4ca9-b368-5d9c7388477a>
> （shadcn/ui 风格：单色、纸面卡片、24px 容器圆角、18px 胶囊、发丝线、极轻投影、紧凑字阶）。
> 目标：把「任务看板」从工具化表格外观升级为可读、有层次、有视觉节奏的仪表盘，同时保持深浅色主题适配。

## 1. 设计映射（参考 → 本插件）

| 参考规范 | 实现 |
| --- | --- |
| Canvas/Surface/Paper 三层表面 | `.atw-root` 用 `--atw-canvas/--atw-paper/--atw-surface`，全部取自宿主 `--dsw-alias-*` token，深色主题自动成立 |
| Card 24px 圆角 + 1px 发丝线 + 极轻投影 | `.atw-panel`/`.atw-member`/`.atw-drawer`：`border-radius:24px`、1px hairline、三层 `color-mix` 阴影 |
| 交互元素 18px 胶囊 | `.atw-btn`/`.atw-badge`/`.atw-filter`/`.atw-node`：`border-radius:18px`，按钮统一 36px 高 |
| 紧凑字阶（12/14/16/24/30） | 标题 30px/600/-0.025em；正文 14px/1.43；caption 12px/1.33、0.05em 大写 |
| Stat block（大数字+小标签） | 新增 `.atw-stats`（已批准 / 参与者 / 待处理 三块），数字 30px/600 tabular-nums |
| Pill badge（soft） | `.atw-badge` 默认 soft 填充；状态色用 `color-mix` 着色，红色仅用于错误/阻塞 |
| 唯一主操作（深色填充按钮） | 刷新 = `atw-btn--primary`（ink 填充）；暂停 = ghost；其余 outline/ghost |
| 嵌套卡片 10px | 流程图卡片、频道行、提案卡、事件行等嵌套容器统一 10px |
| 留白节奏 | 页面 padding 24/28、栅格 gap 20、卡片 padding 20、统计块 padding 14/22 |

## 2. 结构变化

- **顶部 hero**：30px 标题 + 目标摘要（2 行截断）+ 三格统计块（已批准数/参与者/待处理）+ 右侧状态徽章/进度条/按钮；
- **主栅格**：流程图 2fr + 拓扑 1.4fr；下方频道 2fr + 提案/用量；1180px 以下单列；
- **流程图**：卡片放大到 208×152（无 Git 行 132），悬停轻微上浮，待评审用 warn 内描边，选中用 brand 内描边；
- **协作拓扑**：画布改为 surface 底 + 18px 圆角；Lead 节点改为 ink 填充胶囊，成员/工作项保持 paper 胶囊；
- **频道/提案/事件**：嵌套纸面卡片，时间戳 caption 右对齐，过滤按钮为胶囊；
- **空态**：面板内空态统一为虚线圆角卡 + 居中 muted 文案；
- **抽屉**：成员/工作项抽屉 24px 圆角 + 强一点的浮层阴影，私聊输入为胶囊填充；
- **动效**：120-200ms 过渡 + 运行节点脉冲；`prefers-reduced-motion` 全部降级；
- **响应式**：720px 以下收窄 padding、标题降为 24px、统计块紧凑。

## 2.1 协作拓扑重构（v1.9.1，本轮重点）

旧布局的问题：成员和工单各自均匀散布，成员→工单项的连线横穿画布；左侧「成员/工作项」标签压在节点上；条目多时连线像一团乱麻。

新布局：
- **按负责人分列**：每个工单放在其 owner 的正下方（同 owner 的第 2 个起放到下一行，再溢出则在本列 ±4% 内错位），owner→item 连线变成短竖线；
- **Lead 反色胶囊**居中在顶部，成员按单行/双行（>6 人）均分在中间带，间距收紧并留出 15% 左右边距，节点不再被画布裁切；
- **频道/评审边**：评审边保持虚线 + 箭头，Lead 边弱化；同伴边只保留 top-8 并加权；
- **箭头标记**：新增 SVG marker，owner/review/lead 边带方向箭头，逻辑一眼可见；
- **区域标签**：「成员」「工作项 · 按负责人对齐」固定在左上方空白处（不再压住节点）；
- **画布增高到 300px**，拓扑面板独立 440px 高度带（其它面板仍 240–320px）；
- **契约测试新增**：owner 列对齐、第二行错位、所有节点 left ∈ [3,97] 不越界。

## 3. 约束保持

- 零新增依赖、零外部字体/CDN；仅 `require('react')`；
- 颜色全部来自 `--dsw-alias-*` token 与 `color-mix` 派生，client 契约测试（无硬编码 hex/rgb、token 覆盖 ≥10、键集 zh/en 对齐）全部通过；
- 既有 35 个客户端契约用例全绿（仅同步更新流程图卡片尺寸断言 126/112 → 152/132）。

## 4. 证据

- 改造前：`docs/evidence/dashboard/board-before-v2.png`
- 改造后：`docs/evidence/dashboard/board-after-final.png`、`board-after-drawer.png`
- 拓扑重构后（真实 fixture，2 成员 + 1 工单，工单对齐在 owner 下方）：`docs/evidence/dashboard/topology-v193c.png`
- 测试：`packages/agent-team-workflow` 客户端契约 35/35，全量套件见 `docs/evidence/test-run.txt`。
