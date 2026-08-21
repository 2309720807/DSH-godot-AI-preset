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
        └── godot-mcp-bridge.mjs   ← 桥接插件（MCP Streamable HTTP 客户端 + 直连模式 + Web 开关，自包含）
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
- “MCP 直连”UI 依赖宿主的 `dynamicCordisRunner` 服务（`dsh web` 部署自带）；
  纯无头（headless）部署下桥接自动跳过 UI，直连模式仍默认开启并可用
  `godot_mcp_direct_mode` 工具切换。
- 如果新电脑上的 DSH 版本差异导致挂载失败，DSH 会在挂载日志中明确报告是
  哪一行、缺什么包；通常保持 DSH 版本一致即可避免。
- 导出时间：2026-08-20（预设 ID：`godot-ai-mcp`，来源机器用户根目录副本，
  文件与源逐一 SHA256 比对一致）。v2 更新于 2026-08-21：新增“MCP 直连”开关
  与 `godot_mcp_direct_mode` 工具，默认直连。
