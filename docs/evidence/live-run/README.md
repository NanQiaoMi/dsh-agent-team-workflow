# hello — 极简问候模块

零依赖的 Node.js ES Module：`hello.mjs` 导出 `greet(name)`，返回 `Hello, <name>!`。

仅使用 JavaScript 语言本身与 Node.js 内置能力，不引入任何外部依赖。

## 环境要求

- Node.js ≥ 20（测试使用内置 `node:test` 运行器；本仓库在 Node.js v24.21.0 上验证）
- 无需 `package.json`：`hello.mjs` 的 `.mjs` 扩展名即按 ES Module 加载
- 执行前请确认 `node` 可用：`node --version`。若本机 PATH 中不含 `node`，可使用内置运行时 `~/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node`（把该目录加入 `PATH` 后再执行下文命令）

## 用法

`greet(name)` 把 `name` 原样插入模板 `Hello, <name>!`，不做 trim、类型校验或大小写处理。

```js
import { greet } from './hello.mjs';

greet('Ada');           // 'Hello, Ada!'
greet('Ada Lovelace');  // 'Hello, Ada Lovelace!'
greet('李雷');           // 'Hello, 李雷!'
greet('');              // 'Hello, !'
```

### 可直接运行的示例

```bash
node --input-type=module -e "import { greet } from './hello.mjs'; console.log(greet('Ada'));"
```

期望输出：

```text
Hello, Ada!
```

期望退出码：`0`

也可以写成脚本 `app.mjs`：

```js
// app.mjs
import { greet } from './hello.mjs';

console.log(greet('Ada'));
```

运行：

```bash
node app.mjs
```

期望输出 `Hello, Ada!`，期望退出码 `0`。

## 运行测试

```bash
node --test
```

期望输出（关键行）：

```text
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

期望退出码：`0`。任何测试失败时退出码为 `1`。

也可以显式指定测试文件：

```bash
node --test test/hello.test.mjs
```

> 注意：在 Node.js v24.21.0 下，把目录作为位置参数（如 `node --test test/`）不会展开目录，会以 `MODULE_NOT_FOUND` 失败并返回退出码 `1`；请使用上面的 `node --test` 或显式文件路径。

## 测试覆盖

`test/hello.test.mjs` 覆盖：

- 常规输入：`greet('Ada')` → `'Hello, Ada!'`
- 空字符串：`greet('')` → `'Hello, !'`
- 含空格与非 ASCII 字符：`greet('Ada Lovelace')`、`greet('李雷')` 原样保留

## 项目结构

```text
hello.mjs            # 模块实现，导出 greet(name)
test/hello.test.mjs  # node:test 测试
README.md            # 本文件
```
