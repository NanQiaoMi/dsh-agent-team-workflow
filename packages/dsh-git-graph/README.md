# @local/dsh-git-graph

> **DeepSeek Harness (DSH) Git 树图与状态可视化插件**
>
> 专为 DSH 对话界面设计的实时 Git 状态指示、未提交改动检测与拓扑提交树（DAG Graph）插件。包含 Host 侧原生 Git 状态提取与 HTTP 快照路由，以及 Client 侧对话输入框 Dock 胶囊和全屏 `conversation.view` 提交拓扑视图。

---

## 一、 功能特性

1. **对话框输入栏 Git 胶囊（`conversation.input.dock`）**：
   - 实时显示当前所在分支（如 `main`、`feature/xxx`）；
   - 动态检测工作区脏状态：未修改时呈现绿色对勾，有改动时呈现高亮圆点与改动文件计数（`● 3`）；
   - 显示超前（`↑`）/ 落后（`↓`）上游远程分支的 commit 数；
   - 点击展开弹出式卡片：快速查看当前 HEAD SHA、改动文件列表（暂存/未暂存/未跟踪）及一键复制分支与 diff 命令；
   - **Mini-Timeline 快速历史**：弹窗内嵌最近提交脉络预览，无需切出输入框即可掌握最近代码动态。

2. **对话全区 Git 树图视图（`conversation.view`）**：
   - 真正的提交有向无环图（DAG）：支持多分支泳道分配（Swimlane）、合并曲线（Bezier Curves）与分支交汇；
   - 顶部虚拟「工作区未提交改动（Uncommitted Changes）」节点：实时展示当前本地修改，与 HEAD 节点建立关联；
   - **多维度视图过滤栏**：支持「全部提交」「当前分支」「仅工作区」一键切分焦点；
   - **紧凑/标准密度切换（Density Toggle）**：支持在宽松（36px）与紧凑（26px）视距间自适应缩放；
   - **节点悬浮轻量卡片（Hover Tooltip Card）**：鼠标移动至任一提交节点即可浮层查看完整 Commit 消息、作者及相对时间；
   - 细粒度 Ref 徽章：区分 `[HEAD]`、`[local branch]`、`[remote branch]`、`[tag]`；
   - 搜索过滤栏：支持按 commit 信息、SHA 散列、作者名称快速筛选；
   - 右侧详情抽屉：提供 Staged / Unstaged / Untracked 文件手风琴折叠、路径一键复制与 `git show` / `git diff` 快捷操作。

3. **动态交互与状态动画系统（新增 / 修改 / 合并）**：
   - **新增（New Commits / Added Files）**：
     - 新节点阶梯式入场（`dsh-gg-node-enter`）与行缓动滑入（`dsh-gg-row-enter`）；
     - 轮询捕获到全新提交时触发绿色发光脉冲（`dsh-gg-new-glow`）并自动标记高亮 `NEW` 徽章；
     - 文件抽屉中新增文件显示翠绿色高亮标签（`A`）。
   - **修改（Modifications / Dirty Working Tree）**：
     - 工作区未提交改动采用菱形节点搭配琥珀色呼吸扩散光晕（`dsh-gg-aura-wave`）；
     - 当本地修改文件数变动时，Dock 徽章与统计计数器触发弹性弹跳动画（`dsh-gg-bounce-number`）；
     - 文件抽屉中修改文件显示醒目黄色标签（`M`）。
   - **合并（Merge Commits / Dual-Parent Branch Convergence）**：
     - 合并 Bezier 曲线具备动态沿路径流动的发光虚线流（`dsh-gg-dash-flow`），形象展示代码流汇入；
     - 合并提交节点拥有外层同心双环与旋转光晕（`dsh-gg-merge-ring`），附带 `MERGE` 醒目徽章；
     - 鼠标悬停在合并节点时，双亲谱系连接线自适应高亮发光，其余无关路径淡化，清晰展现合流脉络。

4. **双向 Agent 协同与提示词辅助**：
   - **模型侧工具**：注册 `git_graph_status` 与 `git_graph_inspect`，让对话模型在需要时能直接以结构化 JSON 查询 Git 状态与提交 DAG；
   - **系统提示词注入**：通过 `ctx.systemPrompt.section` 声明 Git 可视化上下文，避免模型盲目频繁运行 `git status`。

---

## 二、 架构与模块清单

```
packages/dsh-git-graph/
├── package.json           # DSH bundle 清单 (exports, dsh.bundle, dsh.client)
├── cordis.patch.yml       # Loader 补丁配置
├── icon.svg               # 矢量应用图标 (<=256KiB)
├── locale/
│   ├── zh.json            # 中文显示元数据
│   └── en.json            # 英文显示元数据
├── index.js               # Host 插件入口 (tools, systemPrompt, HTTP route)
├── lib/
│   ├── git-engine.js      # 原生 Git 执行器、DAG 拓扑生成器与状态解析
│   └── route.js           # /api/git-graph.snapshot 认证路由
├── client.js              # Client UI 插件 (conversation.input.dock, conversation.view)
├── test/
│   ├── git-engine.test.mjs    # Git 引擎与 DAG 算法单元测试
│   ├── plugin.test.mjs        # Host 插件注册与工具契约测试
│   └── client.contract.test.mjs # 客户端 Web 模块隔离与契约测试
└── README.md              # 插件说明文档
```

---

## 三、 安装与使用

### 1. 安装到当前 DSH Profile

在 DSH 会话中直接通过 `plugin_manager` 安装（支持本地链接安装）：

```js
plugin_manager({
  action: "install_bundle",
  target: "/绝对路径/packages/dsh-git-graph"
})
```

### 2. 观察生效

- **Host 侧**：执行后返回 `application: "applied"` 即 HMR 热加载生效；
- **Client 侧**：刷新 DSH 窗口或浏览器页面即可加载 `client.js`；
- **对话界面**：在聊天输入框底部 Dock 即刻可见 Git 分支图标与状态；点击上方 View 导航栏的「Git 树图」即可切换到全景提交关系树。
