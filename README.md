# DSH Godot AI MCP — Agent 预设备份包

这是 DeepSeek Harness（DSH）的 **`Godot AI MCP`** Agent 预设的完整备份，可直接安装到新电脑。

## 内容

```
DSH Godot AI MCP/
├── README.md                      ← 本说明
└── godot-ai-mcp/                  ← 预设本体（安装时整体复制这个文件夹）
    ├── agent.cordis.yml           ← 预设组合（基于 PTC 模式 + Godot MCP 桥接行）
    ├── preset.yml                 ← 显示名与描述（设置里显示为 "Godot AI MCP"）
    └── plugin/
        └── godot-mcp-bridge.mjs   ← 桥接插件（MCP Streamable HTTP 客户端 + 直连模式 + Web 开关 + 内置 45 工具速查，自包含）
```

## 在新电脑上安装

1. **安装 DeepSeek Harness（DSH）**，版本与本预设导出时一致或更新的版本。
   （预设里的 `@deepseek-ai/dsh-*` 包行由 DSH 部署自身提供，不在本包内。）

2. **复制预设文件夹**到用户根目录的 agent 预设目录：

   - Windows：把 `godot-ai-mcp` 整个文件夹复制到
     `%USERPROFILE%\.dsh\.agent-presets\godot-ai-mcp`
   - macOS / Linux：复制到
     `~/.dsh/.agent-presets/godot-ai-mcp`

   即最终应存在文件：`…\.dsh\.agent-presets\godot-ai-mcp\agent.cordis.yml`

3. **重启 DSH**，新建会话时在 **设置 → Agent 预设** 中选择
   **"Godot AI MCP"** 即可。

4. **连接 Godot 编辑器**：打开一个安装了 Godot AI 插件的 Godot 4.5+ 项目，
   插件会在 `http://127.0.0.1:8000/mcp` 启动 MCP 服务器。然后即可使用：

   | 工具 | 用途 |
   |---|---|
   | `godot_mcp_status` | 服务器信息、工具数、已连接的编辑器会话 |
   | `godot_mcp_tools` | 列出 ~45 个 MCP 工具（支持 filter / verbose） |
   | `godot_mcp_call` | 调用任意工具（scene/node/script/project/game/... 领域），支持 `session_id` 钉定编辑器 |
   | `godot_mcp_configure` | 服务器不在默认端口时切换端点 URL |
   | `godot_mcp_direct_mode` | 读取/修改“MCP 直连”模式（与输入框下方的开关同步） |

## 内置 45 工具速查（系统提示自动注入）

桥接插件把 Godot AI MCP 服务器的**全部 45 个工具及调用接口**以精简速查表
内置（`TOOLS_CATALOG_TEXT` 常量），并在每步模型请求前注入系统提示。每个工具
都包含：

- **什么时候用** —— 一行中文用途说明；
- **怎么调用** —— 参数名、类型、必填/默认值、关键枚举值；`*_manage` 汇总
  工具列出全部 `op` 取值与操作签名。

速查表顶部还有通用约定：统一走 `godot_mcp_call({tool, args})` 调用、
`session_id` 格式（`<project-slug>@<4hex>`，如 `wenming@4bef`，须完整 4 位
hex）、`{op, params}` 调用形状、节点路径（相对当前编辑场景，如 `/Main/Camera3D`）
与资源路径（`res://`）约定等。

要点：

- **两种直连模式下都会注入**：直连开启时 agent 立即主动调用；关闭时 agent
  也能按需直接调用，无需先查工具列表。
- 与**工作目录无关**：预设从固定路径加载，桥接行按组合文件自身目录解析，
  在任何目录新建 `Godot AI MCP` 会话都生效。
- 速查表基于导出时的服务器版本（v3.4.7 · 45 工具）；若 addon 升级导致工具
  变化，以 `godot_mcp_tools` 的实时结果为准。

## “MCP 直连”开关

使用该预设的会话在 **聊天输入框下方** 会显示一个 **“MCP 直连”** 开关：

- **默认开启（直连）**：DSH 会强制立即连接 Godot MCP 服务器，并主动驱动
  Godot 编辑器进行游戏编辑（每步开始先 `godot_mcp_status` 确认连接，再按需
  `godot_mcp_tools` / `godot_mcp_call`）。
- **关闭（按需）**：DSH 仅在当前任务确实需要 Godot 编辑器/游戏编辑时才调用
  MCP 工具，其余任务不碰 MCP 桥接。

开关状态由桥接插件动态注入的 systemPrompt 段落实时读取，因此切换后**下一步**
模型请求即生效，无需重启会话。模型也可通过 `godot_mcp_direct_mode` 工具读取或
修改同一状态。

> 提示：该开关由会话所属的动态 Cordis 插件渲染（DSH 客户端插件的设计如此）。
> 若手动刷新页面后开关暂时消失，让会话继续运行一步（发一条消息）即可重新出现；
> 也可在侧边栏 Cordis 面板中对该插件重新点击运行。

## 备注

- 该预设基于 PTC 模式（标准模式全部能力 + Code Mode SDK）复制而来。
- 桥接插件完全自包含在 `plugin/godot-mcp-bridge.mjs`，使用 Node 内置 `fetch`，
  不依赖任何外部程序；DSH 自身运行于 Node 18+，无需额外环境。
- 内置的 45 工具速查表（精简版，约 13.8 KB）随桥接插件注入系统提示，两种直连
  模式均生效。如需修改目录内容：编辑 `godot-tools-compact.txt` 后运行
  `apply-compact-catalog.mjs` 即可重新生成并同步两处预设（这两个辅助脚本位于
  导出工作区 `F:\software\Godot agent\`，不随本备份包分发；完整 schema 抓取
  与自动生成脚本为 `fetch-godot-tools.mjs` / `gen-godot-catalog.mjs`）。
- “MCP 直连”UI 依赖宿主的 `dynamicCordisRunner` 服务（`dsh web` 部署自带）；
  纯无头（headless）部署下桥接自动跳过 UI，直连模式仍默认开启并可用
  `godot_mcp_direct_mode` 工具切换。
- 如果新电脑上的 DSH 版本差异导致挂载失败，DSH 会在挂载日志中明确报告是
  哪一行、缺什么包；通常保持 DSH 版本一致即可避免。
- **源码直跑模式（tsx）的已知坑**：若用 `一键启动.bat` 这类方式以
  `node --import tsx/esm apps/cli/src/bin.ts web` 直跑 DSH 源码，PTC 的
  `run_code` 代码执行器可能报
  `code run failed (worker-exit): worker error: WebAssembly.Module(): unknown type form …`
  ——这是 DSH 运行环境的问题（worker 加载 `src/worker.ts` 时经过 Node 内置
  amaro-WASM 类型剥离引擎，其 WASM 模块在 worker 线程中会间歇损坏），与预设无关。
  修复方法：将 `packages/code-runtime/code-runtime-worker-thread/src/index.ts`
  中的 `WORKER_PATH` 固定为
  `fileURLToPath(new URL('../lib/worker.cjs', import.meta.url))`（本机源码已修复，
  整体复制部署目录即可自带），或改用构建版 DSH（不跑源码）则完全不受影响。
- 导出时间：2026-08-20（预设 ID：`godot-ai-mcp`，来源机器用户根目录副本，
  文件与源逐一 SHA256 比对一致）。v2 更新于 2026-08-21：新增“MCP 直连”开关
  与 `godot_mcp_direct_mode` 工具，默认直连。v3 更新于 2026-08-21：内置全部
  45 个 Godot AI MCP 工具速查（精简版：用途 + 调用接口），两种直连模式均
  自动注入；备份内三个预设文件与源逐一 SHA256 比对一致。
