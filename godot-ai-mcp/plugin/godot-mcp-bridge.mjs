// Godot AI MCP bridge — host-plane plugin shipped inside the `godot-ai-mcp`
// agent preset. Speaks MCP Streamable HTTP to the Godot AI editor server
// (default http://127.0.0.1:8000/mcp, provided by the Godot AI addon).
//
// Registers five session-scoped tools into the host `tools` registry:
//   godot_mcp_status        — server info, tool count, connected editor sessions
//   godot_mcp_tools         — list the MCP tools (~45 tools / 120+ ops)
//   godot_mcp_call          — call any MCP tool, optional session_id pinning
//   godot_mcp_configure     — point the bridge at a non-default endpoint
//   godot_mcp_direct_mode   — read/set the "mcp 直连" mode (default ON)
//
// "mcp 直连" direct mode (default ON):
//   - ON:  a dynamic systemPrompt section instructs the agent to connect to the
//          Godot MCP server immediately and drive the editor proactively
//          (forced direct connection for game editing).
//   - OFF: the agent only calls the Godot MCP tools when a task actually
//          requires editor/game work (on-demand).
//
// The mode is also surfaced as an "MCP 直连" toggle under the Web GUI chat
// input. This plugin publishes no service, so it sits loose in the preset
// composition without an isolate realm. For the toggle it drives the host
// `dynamicCordisRunner` service (when present): it defines one session-owned
// dynamic Plugin whose Host half keeps the mode and whose Client half renders
// the toggle in the `conversation.composer.dock` slot, then activates it
// through the runner's direct (approval-free) path and summons the browser
// half with a `cordis/request-run` event. Everything unwinds with the session.

const DEFAULT_URL = 'http://127.0.0.1:8000/mcp'
const INIT_TIMEOUT_MS = 15000
const LIST_TIMEOUT_MS = 30000
const CALL_TIMEOUT_MS = 120000

const HINT = 'The Godot AI MCP server may be down. Open a Godot project with the Godot AI addon enabled (default endpoint http://127.0.0.1:8000/mcp), or call godot_mcp_configure for another port.'

const DIRECT_SERVICE_PREFIX = 'godotDirect:'
const UI_PACKAGE_NAME = 'godot-mcp-direct-ui'
const UI_PACKAGE_PURPOSE = 'MCP 直连 toggle under the composer for the Godot AI MCP preset'

const DIRECT_ON_TEXT = `Godot MCP direct mode is ON (mcp 直连, the default). Connect to the Godot AI MCP server immediately and drive the Godot editor proactively. At the start of your work, call godot_mcp_status to verify the connection, then godot_mcp_tools when you need tool details, and use godot_mcp_call to perform game editing in Godot without waiting to be asked. Treat the Godot editor as your primary editing surface for this session. If the server is unreachable, report it and keep retrying on later steps.`

const DIRECT_OFF_TEXT = `Godot MCP direct mode is OFF (按需调用). Do not connect to or call the Godot AI MCP tools unless the current task requires Godot editor / game editing. When game editing is needed, use godot_mcp_status / godot_mcp_tools / godot_mcp_call as needed; otherwise leave the MCP bridge alone.`

// Built-in compact quick-reference of every Godot AI MCP tool (server
// v3.4.7, 45 tools): one Chinese purpose line per tool (when to call) plus
// its parameter / op interface (how to call). Appended to the direct-mode
// systemPrompt section in BOTH modes, so the agent can pick and call the
// right interface without fetching it first. godot_mcp_tools remains the
// live source of truth if the addon version drifts; regenerate this constant
// by editing godot-tools-compact.txt and running apply-compact-catalog.mjs.
const TOOLS_CATALOG_TEXT = `# Godot AI MCP 工具速查（45 个工具 · 服务器 v3.4.7）——按需调用指南
调用统一走 godot_mcp_call({tool: <工具名>, args: {...}})。
所有工具都可带可选 session_id（<project-slug>@<4hex>，必须完整 4 位 hex，如 wenming@4bef）；省略 = 当前活动会话；多会话先 session_manage(op="list") 再 session_activate 锁定。
*_manage 汇总工具统一形状 {"op": "<动词>", "params": {...}}。
节点路径用相对当前编辑场景的路径（/Main/Camera3D），资源用 res://；写操作基本可撤销；写属性前先用 node_get_properties 确认精确属性名。
工具细节以 godot_mcp_tools(verbose=true) 的实时结果为准。

## 1. session_activate — 锁定目标编辑器会话（后续调用默认发给它）
    session_id (string, 必填): 精确 id（如 wenming@4bef）或项目文件夹名等子串提示

## 2. session_manage — 列出所有连接的编辑器会话（版本/路径/播放状态等）
    op: list

## 3. editor_state — 读编辑器状态（版本/就绪/当前场景/播放状态）；写操作被拒（EDITOR_NOT_READY）后调用一次可同步缓存
    参数: 无

## 4. logs_read — 读日志：插件通信/游戏输出/编辑器报错
    source (string, 默认"plugin"): plugin|game|editor|all · count (integer, 默认50) · offset (integer) · since_run_id (string) · since_cursor (integer|null) · include_details (boolean)

## 5. editor_screenshot — 截取编辑器视口或运行游戏画面
    source (string, 默认"viewport"): viewport|viewport_2d|cinematic|game · max_resolution (integer, 默认640) · include_image (boolean, 默认true) · view_target (string, 逗号分隔节点路径) · coverage (boolean) · elevation (number) · azimuth (number) · fov (number) · user_prompt (string)

## 6. editor_reload_plugin — 重载 Godot 编辑器插件（插件托管时传输会断开，重连后重新 list 会话）
    参数: 无

## 7. editor_manage — 编辑器杂项：选中、性能监视、退出、清日志、游戏内执行 GDScript
    op: state|selection_get|selection_set|monitors_get|quit|logs_clear|game_eval
    state() · selection_get() · selection_set(paths) · monitors_get(monitors=None) · quit() · logs_clear(clear_debugger_errors=False) · game_eval(code)

## 8. scene_get_hierarchy — 读取当前场景节点树（分页，name/type/path/child count）
    depth (integer, 默认10) · offset (integer) · limit (integer, 默认100)

## 9. scene_open — 在编辑器中打开 .tscn 场景
    path (string, 必填, 如 "res://main.tscn") · force_reload (boolean, 默认false, 丢弃内存未保存修改)

## 10. scene_save — 保存当前编辑的场景到磁盘
    参数: 无

## 11. scene_manage — 场景创建/另存/已打开场景列表
    op: create|get_roots|save_as
    create(path, root_type="Node3D", root_name="") · save_as(path) · get_roots()

## 12. node_get_properties — 读节点属性（写属性前必查，确认精确属性名/类型）
    path (string, 必填, 如 "/Main/Camera3D") · fields (array<string>, 只返回这些属性名)

## 13. node_create — 新建节点（或实例化 PackedScene）
    type (string, 节点类名) · name (string) · parent_path (string, 默认""=场景根) · scene_path (string, 要实例化的 res:// 场景) · scene_file (string, 编辑器场景守卫)

## 14. node_set_property — 设置节点属性（值自动按属性类型转换）
    path (string, 必填) · property (string, 必填, 精确属性名) · value (any, 必填; Vector2/3 用 {x,y,z}，Color 用 {r,g,b,a} 或 "#ff0000"，资源用 res:// 路径) · scene_file (string)

## 15. node_find — 按名字/类型/分组搜索节点
    name (string, 子串) · type (string, 精确类名) · group (string) · offset (integer) · limit (integer, 默认100)

## 16. node_manage — 节点树操作（删除/复制/重命名/排序/重挂/分组/读子节点）
    op: add_to_group|delete|duplicate|get_children|get_groups|move|remove_from_group|rename|reparent
    get_children(path) · get_groups(path) · delete(path) · duplicate(path, name="") · rename(path, new_name) · move(path, index) · reparent(path, new_parent) · add_to_group(path, group) · remove_from_group(path, group)

## 17. project_run — 运行（播放）项目
    mode (string, 默认"main"): main|current|custom · scene (string, custom 模式必填) · autosave (boolean, 默认true)

## 18. project_manage — 项目停止运行与 project.godot 设置读写
    op: settings_get|settings_set|stop
    stop() · settings_get(key) · settings_set(key, value)

## 19. script_create — 新建 .gd 脚本文件
    path (string, 必填, res:// 路径) · content (string, GDScript 源码)

## 20. script_patch — 锚点字符串替换编辑 .gd（old_text 必须唯一，除非 replace_all）
    path (string, 必填) · old_text (string, 必填) · new_text (string, 必填, 空=删除) · replace_all (boolean, 默认false)

## 21. script_attach — 给节点挂脚本
    path (string, 必填, 节点路径) · script_path (string, 必填, res:// 路径)

## 22. script_manage — 脚本读取/卸载/大纲
    op: detach|find_symbols|read
    read(path) · detach(path) · find_symbols(path)

## 23. resource_manage — 资源搜索/读取/赋值/创建（Curve/Environment/物理形状/渐变/噪声纹理）
    op: assign|create|curve_set_points|environment_create|get_info|gradient_texture_create|load|noise_texture_create|physics_shape_autofit|search
    search(type="", path="", offset=0, limit=100) · load(path) · assign(path, property, resource_path) · get_info(type) · create(type, properties=None, path="", property="", resource_path="", overwrite=False) · curve_set_points(points, path="", property="", resource_path="") · environment_create(path="", preset="default", properties=None, sky=None, resource_path="", overwrite=False) · physics_shape_autofit(path, source_path="", shape_type="") · gradient_texture_create(stops, width=256, height=1, fill="linear", path="", property="", resource_path="", overwrite=False) · noise_texture_create(noise_type="simplex_smooth", width=512, height=512, frequency=0.01, seed=0, fractal_octaves=0, path="", property="", resource_path="", overwrite=False)

## 24. api_manage — 查 Godot ClassDB API（类属性/方法/信号/枚举/常量）
    op: get_class
    get_class(class_name, sections=None, include_inherited=False, include_inheritors=False, offset=0, limit=100) — sections: properties|methods|signals|enums|constants|inheritors 或 "all"

## 25. filesystem_manage — 项目文件系统（读/写文本、强制重导入、扫描、搜索）
    op: read_text|reimport|scan|search|write_text
    read_text(path) · write_text(path, content="") · reimport(paths) · scan() · search(name="", type="", path="", offset=0, limit=100)

## 26. client_manage — 配置各 AI 客户端接入本 MCP 服务器
    op: configure|remove|status
    status() · configure(client) · remove(client)

## 27. signal_manage — 信号连接管理（列出/连接/断开）
    op: connect|disconnect|list
    list(path, include_editor=False) · connect(path, signal, target, method) · disconnect(path, signal, target, method)

## 28. autoload_manage — 自动加载单例管理（持久化到 project.godot）
    op: add|list|remove
    list() · add(name, path, singleton=True) · remove(name)

## 29. input_map_manage — 输入映射（动作与按键绑定，持久化到 project.godot）
    op: add_action|bind_event|ensure_action|ensure_binding|list|remove_action
    list(include_builtin=False) · add_action(action, deadzone=0.5) · ensure_action(action, deadzone=0.5) · remove_action(action) · bind_event(action, event_type, keycode="", ctrl=False, alt=False, shift=False, meta=False, button=None, axis=None, axis_value=1.0) — event_type: key|mouse_button|joy_button|joy_axis · ensure_binding(action, event_type, ...)

## 30. game_manage — 运行时游戏检查与输入模拟（先 project_run，轮询 editor_state 至 game_capture_ready=true）
    op: get_node_info|get_scene_tree|get_ui_elements|input_action|input_gamepad|input_key|input_mouse|input_sequence|input_state
    get_scene_tree(depth=10, root_path="") · get_node_info(path, include_properties=True) · get_ui_elements(root_path="", include_hidden=False, include_disabled=True, max_depth=10) · input_key(key, pressed=True, echo=False) · input_mouse(event, position=None, button="left", pressed=True) — event: motion|button · input_gamepad(device=0, control="button", index=0, pressed=True, value=0.0) — control: button|axis · input_action(action, pressed=True, strength=1.0) · input_sequence(steps, settle_frames=0) — steps: [{at_frame, action, pressed, strength}] 逐帧时序输入 · input_state(actions=None)

## 31. test_run — 运行 GDScript 测试套件（res://tests/ 下 test_*.gd）
    suite (string, 只跑命名套件) · test_name (string, 名字包含此子串) · exclude_test_name (string) · verbose (boolean, 默认false)

## 32. test_manage — 重取最近一次测试结果（不重新执行）
    op: results_get
    results_get(verbose=False)

## 33. batch_execute — 按顺序批量执行编辑器子命令（出错即停，可整体回滚）
    commands (array<object>, 必填, 每项 {"command": <工具名>, "params": {...}}) · undo (boolean, 默认true)

## 34. ui_manage — UI/Control 制作（布局预设、设置文本、原子构建子树、矢量绘制）
    op: build_layout|draw_recipe|set_anchor_preset|set_text
    set_anchor_preset(path, preset, resize_mode="minsize", margin=0) · set_text(path, text) · build_layout(tree, parent_path="") — tree: {type, name?, properties?, anchor_preset?, children?} · draw_recipe(path, ops, clear_existing=True)

## 35. theme_manage — 主题（样式）制作并应用到 Control 子树
    op: apply|create|set_color|set_constant|set_font_size|set_stylebox_flat
    create(path, overwrite=False) · set_color(theme_path, class_name, name, value) · set_constant(theme_path, class_name, name, value) · set_font_size(theme_path, class_name, name, value) · set_stylebox_flat(theme_path, class_name, name, bg_color?, border_color?, border?, corners?, margins?, shadow?, anti_aliasing?) · apply(node_path, theme_path="")

## 36. animation_create — 在 AnimationPlayer 里新建动画剪辑（之后用 animation_manage 加轨道）
    player_path (string, 必填) · name (string, 必填) · length (number, 必填, 秒) · loop_mode (string, 默认"none"): none|linear|pingpong · overwrite (boolean, 默认false)

## 37. animation_manage — 动画编辑（播放器/轨道/自动播放/预设/预览）
    op: add_method_track|add_property_track|create_simple|delete|get|list|play|player_create|preset_fade|preset_pulse|preset_shake|preset_slide|set_autoplay|stop|validate
    player_create(parent_path, name="AnimationPlayer") · delete(player_path, animation_name) · validate(player_path, animation_name) · add_property_track(player_path, animation_name, track_path, keyframes, interpolation="linear") — track_path: "节点名:属性", keyframes: [{time,value,transition?}] · add_method_track(player_path, animation_name, target_node_path, keyframes) — keyframes: [{time,method,args?}] · set_autoplay(player_path, animation_name="") · play(player_path, animation_name="") · stop(player_path) · list(player_path) · get(player_path, animation_name) · create_simple(player_path, name, tweens, length=None, loop_mode="none", overwrite=False) — tweens: [{target,property,from,to,duration,delay?,transition?}] · preset_fade(player_path, target_path, mode="in", duration=0.5, animation_name="", overwrite=False) · preset_slide(player_path, target_path, direction="left", mode="in", distance=None, duration=0.4, animation_name="", overwrite=False) · preset_shake(player_path, target_path, intensity=None, duration=0.3, frequency=30.0, seed=0, animation_name="", overwrite=False) · preset_pulse(player_path, target_path, from_scale=1.0, to_scale=1.1, duration=0.4, animation_name="", overwrite=False)

## 38. material_manage — 材质制作（标准/ORM/着色器/画布材质；金属/玻璃等预设）
    op: apply_preset|apply_to_node|assign|create|get|list|set_param|set_shader_param
    create(path, type="standard", shader_path="", overwrite=False) — type: standard|orm|canvas_item|shader · set_param(path, param, value) · set_shader_param(path, param, value) · get(path) · list(root="res://", type="") · assign(node_path, resource_path="", slot="override", create_if_missing=False, type="standard") — slot: override|surface_<N>|canvas|process · apply_to_node(node_path, type="standard", params=None, slot="override", save_to="", overwrite=False) · apply_preset(preset, path="", node_path="", overrides=None) — preset: metal|glass|emissive|unlit|matte|ceramic

## 39. particle_manage — 粒子系统（GPU/CPU 2D/3D；火焰/烟雾等预设）
    op: apply_preset|create|get|restart|set_draw_pass|set_main|set_process
    create(parent_path, name="Particles", type="gpu_3d") — type: gpu_3d|gpu_2d|cpu_3d|cpu_2d · set_main(node_path, properties) — amount/lifetime/one_shot/emitting 等 · set_process(node_path, properties) — 注意 GPU 重力是 Vector3，传 {x,y,z} · set_draw_pass(node_path, pass_=1, mesh="", texture="", material="") · restart(node_path) · get(node_path) · apply_preset(parent_path, name, preset, type="gpu_3d", overrides=None) — preset: fire|smoke|spark_burst|magic_swirl|rain|explosion|lightning

## 40. camera_manage — 摄像机制作（2D/3D、跟随、阻尼、限制、预设）
    op: apply_preset|configure|create|follow_2d|get|list|set_damping_2d|set_limits_2d
    create(parent_path, name="Camera", type="2d", make_current=False) · configure(camera_path, properties) · set_limits_2d(camera_path, left?, right?, top?, bottom?, smoothed?) · set_damping_2d(camera_path, position_speed?, rotation_speed?, drag_margins?, drag_horizontal_enabled?, drag_vertical_enabled?) · follow_2d(camera_path, target_path, smoothing_speed=5.0, zero_transform=True) · get(camera_path="") · list() · apply_preset(parent_path, name, preset, type=None, make_current=True, overrides=None) — preset: topdown_2d|platformer_2d|cinematic_3d|action_3d

## 41. audio_manage — 音频（创建播放器/指定流/播放属性/试听）
    op: list|play|player_create|player_set_playback|player_set_stream|stop
    player_create(parent_path, name="AudioStreamPlayer", type="1d") — type: 1d|2d|3d · player_set_stream(player_path, stream_path) · player_set_playback(player_path, volume_db?, pitch_scale?, autoplay?, bus?) · play(player_path, from_position=0.0) · stop(player_path) · list(root="res://", include_duration=True)

## 42. tilemap_manage — TileMap/TileMapLayer 绘制（设置/填充/清除/读取格子）
    op: tilemap_clear|tilemap_get_cells|tilemap_set_cell|tilemap_set_cells_rect
    tilemap_set_cell(path, source_id, atlas_col, atlas_row, map_x, map_y) · tilemap_set_cells_rect(path, source_id, atlas_col, atlas_row, rect_x, rect_y, rect_w, rect_h) · tilemap_clear(path) · tilemap_get_cells(path)

## 43. tileset_manage — TileSet 图集检查（图块列表/图集贴图）
    op: tileset_get_atlas_image|tileset_get_atlas_tiles
    tileset_get_atlas_tiles(tileset_path, source_id) · tileset_get_atlas_image(tileset_path, source_id, max_size=0) — 返回 Base64 PNG

## 44. gridmap_manage — GridMap 3D 绘制（设置/填充/清除/读取/库列表）
    op: gridmap_clear|gridmap_fill|gridmap_get_used_cells|gridmap_list_library_items|gridmap_set_item
    gridmap_set_item(path, item, map_x, map_y, map_z, orientation=0) — item=-1 清除 · gridmap_fill(path, item, rect_x, rect_y, rect_z, rect_w, rect_h, rect_d, orientation=0) · gridmap_clear(path) · gridmap_get_used_cells(path) · gridmap_list_library_items(path)

## 45. csg_manage — CSG 布尔几何体（挖洞/隧道等）
    op: csg_create|csg_set_operation
    csg_create(parent_path, name="", shape="box", operation="union") — shape: box|sphere|cylinder|torus|polygon; operation: union|intersection|subtraction · csg_set_operation(path, operation)
`

function friendlyError(error) {
  return JSON.stringify({
    error: String((error && error.message) || error),
    hint: HINT,
  }, null, 2)
}

/** Parse an SSE body into the JSON messages it carried. */
function parseSse(text) {
  const messages = []
  let dataLines = []
  const flush = () => {
    if (dataLines.length > 0) {
      const payload = dataLines.join('\n')
      dataLines = []
      try { messages.push(JSON.parse(payload)) } catch { /* keepalive or comment */ }
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (line === '') { flush(); continue }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  flush()
  return messages
}

/**
 * Host-half source of the session's direct-mode dynamic Plugin. Runs in the
 * dynamic package sandbox: keeps the mode (default true), answers the Client
 * toggle through harness.handle, and publishes a uniquely-named root service
 * (`godotDirect:<sessionId>`) so THIS preset plugin can read the mode from its
 * dynamic systemPrompt section and godot_mcp_direct_mode tool.
 */
function buildDirectHostCode(sessionId) {
  const sid = JSON.stringify(String(sessionId))
  return `const SESSION_ID = ${sid}
const mode = { direct: true }
return {
  name: 'godot-mcp-direct',
  apply(ctx) {
    harness.handle('get-direct', () => ({ direct: mode.direct }))
    harness.handle('set-direct', (args) => {
      if (args && typeof args.direct === 'boolean') mode.direct = args.direct
      return { direct: mode.direct }
    })
    ctx.provide('godotDirect:' + SESSION_ID, {
      get: () => mode.direct,
      set: (direct) => { mode.direct = direct === true; return mode.direct },
    })
  },
}
`
}

/**
 * Client-half source: the "MCP 直连" toggle seated in the band directly under
 * the composer card (`conversation.composer.dock`). Reads the current mode on
 * mount and flips it through the Package-private `host.call` RPC.
 */
const DIRECT_CLIENT_CODE = `
function GodotDirectToggle() {
  const [direct, setDirect] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    host.call('get-direct').then((res) => {
      if (alive && res && typeof res.direct === 'boolean') setDirect(res.direct)
    }, () => {})
    return () => { alive = false }
  }, [])
  const flip = () => {
    const next = direct !== true
    setDirect(next)
    host.call('set-direct', { direct: next }).then((res) => {
      if (res && typeof res.direct === 'boolean') setDirect(res.direct)
    }, () => {})
  }
  const stateText = direct === null ? '…' : (direct === true ? '直连' : '按需')
  return React.createElement('button', {
    type: 'button',
    className: 'gmd-toggle' + (direct === true ? ' gmd-on' : ''),
    title: direct === true
      ? 'mcp 直连已开启：DSH 将强制直连 Godot MCP 插件进行游戏编辑'
      : 'mcp 直连已关闭：DSH 将按需调用 Godot MCP 插件进行游戏编辑',
    onClick: flip,
  },
    React.createElement('span', { className: 'gmd-badge' }, 'MCP'),
    React.createElement('span', null, '直连'),
    React.createElement('span', { className: 'gmd-state' }, stateText),
  )
}

return {
  name: 'godot-mcp-direct-ui',
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    ctx.effect(() => styles.insert([
      '.gmd-toggle {',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  padding: 2px 10px; border-radius: 999px;',
      '  border: 1px solid rgba(128, 128, 128, 0.45);',
      '  background: transparent; color: inherit;',
      '  font-size: 12px; line-height: 18px; cursor: pointer;',
      '}',
      '.gmd-toggle:hover { border-color: rgba(128, 128, 128, 0.85); }',
      '.gmd-toggle:focus-visible { outline: 2px solid rgba(128, 160, 255, 0.7); outline-offset: 1px; }',
      '.gmd-toggle .gmd-badge { font-weight: 700; opacity: 0.75; }',
      '.gmd-toggle .gmd-state { padding: 0 7px; border-radius: 999px; background: rgba(128, 128, 128, 0.22); }',
      '.gmd-toggle.gmd-on .gmd-state { background: rgba(46, 160, 90, 0.22); color: #2ea05a; }',
    ].join('')))
    slots.inject('conversation.composer.dock', () => slots.register(
      { name: 'conversation.composer.dock', id: 'godot-mcp-direct', order: -10, label: 'MCP 直连' },
      GodotDirectToggle,
    ))
  },
}
`

export default {
  name: 'godot-mcp-bridge',
  inject: ['tools', 'systemPrompt'],
  apply(ctx) {
    const state = {
      url: DEFAULT_URL,
      sessionId: null,
      initPromise: null,
      rpcSeq: 0,
    }

    /** Direct-mode bookkeeping for this session's UI dynamic Plugin. */
    const direct = {
      sessionId: null,
      ui: { phase: 'idle', ids: null, promise: null },
    }

    /** One JSON-RPC exchange over Streamable HTTP (JSON or SSE responses). */
    async function rpc(method, params, timeoutMs) {
      const id = ++state.rpcSeq
      const headers = {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
      }
      if (state.sessionId) headers['mcp-session-id'] = state.sessionId
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} })
      let res
      try {
        res = await fetch(state.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs || CALL_TIMEOUT_MS),
        })
      } catch (error) {
        let detail = String((error && error.message) || error)
        if (error && error.cause && error.cause.code) detail += ' (' + error.cause.code + ')'
        const wrapped = new Error(error && error.name === 'TimeoutError'
          ? 'request timed out after ' + (timeoutMs || CALL_TIMEOUT_MS) + 'ms'
          : 'cannot reach ' + state.url + ': ' + detail)
        wrapped.isConnect = true
        throw wrapped
      }
      const sid = res.headers.get('mcp-session-id')
      if (sid) state.sessionId = sid
      const contentType = res.headers.get('content-type') || ''
      const text = await res.text()
      let messages = []
      if (contentType.includes('text/event-stream')) messages = parseSse(text)
      else { try { messages = [JSON.parse(text)] } catch { messages = [] } }
      if (res.status < 200 || res.status >= 300) {
        throw new Error('HTTP ' + res.status + ' from ' + state.url + (text ? ': ' + text.slice(0, 300) : ''))
      }
      let msg = null
      for (const m of messages) if (m && m.id === id) msg = m
      if (!msg && messages.length > 0) msg = messages[messages.length - 1]
      if (!msg) throw new Error('empty response from ' + state.url + ' (HTTP ' + res.status + ')')
      if (msg.error) {
        throw new Error('MCP error ' + (msg.error.code || '') + ': ' + (msg.error.message || JSON.stringify(msg.error)))
      }
      return msg.result
    }

    /** Lazy initialize handshake, cached per connection. */
    function ensureInit() {
      if (state.initPromise) return state.initPromise
      state.initPromise = (async () => {
        const result = await rpc('initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'dsh-godot-mcp', version: '1.0.0' },
        }, INIT_TIMEOUT_MS)
        try { await rpc('notifications/initialized', null, 10000) } catch { /* notification: no response expected */ }
        return result
      })()
      state.initPromise.catch(() => { state.initPromise = null })
      return state.initPromise
    }

    async function listTools() {
      await ensureInit()
      const result = await rpc('tools/list', {}, LIST_TIMEOUT_MS)
      return (result && result.tools) || []
    }

    async function callTool(name, args) {
      await ensureInit()
      return rpc('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT_MS)
    }

    /** Drop a possibly-stale MCP session and retry once. */
    async function withFreshSessionRetry(operation) {
      try {
        return await operation()
      } catch (error) {
        if (!state.sessionId) throw error
        state.sessionId = null
        state.initPromise = null
        return await operation()
      }
    }

    const OUT = {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: String(value) }],
    }

    ctx.tools.register({
      name: 'godot_mcp_status',
      description: 'Check the Godot AI MCP server (default http://127.0.0.1:8000/mcp, provided by the Godot AI editor addon). Reports server info, MCP protocol version, tool count and the connected Godot editor sessions. Returns a friendly error hint when the server is down.',
      parameters: { type: 'object', properties: {} },
      output: OUT,
      async execute() {
        try {
          const info = await withFreshSessionRetry(async () => {
            const init = await ensureInit()
            const tools = await listTools()
            const names = new Set(tools.map((t) => t.name))
            let sessions = null
            if (names.has('session_list')) {
              try { sessions = await callTool('session_list', {}) } catch (error) { sessions = { error: String(error && error.message) } }
            } else if (names.has('session_manage')) {
              try { sessions = await callTool('session_manage', { op: 'list' }) } catch (error) { sessions = { error: String(error && error.message) } }
            }
            return {
              serverInfo: (init && init.serverInfo) || null,
              protocolVersion: (init && init.protocolVersion) || null,
              toolCount: tools.length,
              toolNames: tools.map((t) => t.name),
              sessions,
            }
          })
          return JSON.stringify(info, null, 2)
        } catch (error) {
          return JSON.stringify({
            reachable: false,
            error: String((error && error.message) || error),
            hint: HINT,
          }, null, 2)
        }
      },
    })

    ctx.tools.register({
      name: 'godot_mcp_tools',
      description: 'List the tools exposed by the Godot AI MCP server (~45 tools, 120+ ops across scene/node/script/project/game/editor/filesystem/test domains, plus <domain>_manage rollups). Use filter to search; set verbose=true to include the full inputSchema of each match.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'optional case-insensitive substring filter over tool name and description' },
          verbose: { type: 'boolean', description: "include each matching tool's full inputSchema when true" },
        },
      },
      output: OUT,
      async execute(input) {
        try {
          const tools = await withFreshSessionRetry(() => listTools())
          let list = tools
          if (typeof input.filter === 'string' && input.filter) {
            const f = input.filter.toLowerCase()
            list = tools.filter((t) => (String(t.name) + ' ' + String(t.description || '')).toLowerCase().includes(f))
          }
          const summary = list.map((t) => {
            const entry = { name: t.name, description: t.description || '' }
            const schema = t.inputSchema || {}
            if (schema.properties) entry.params = Object.keys(schema.properties)
            if (Array.isArray(schema.required)) entry.required = schema.required
            if (input.verbose) entry.inputSchema = schema
            return entry
          })
          return JSON.stringify({ matched: summary.length, total: tools.length, tools: summary }, null, 2)
        } catch (error) {
          return friendlyError(error)
        }
      },
    })

    ctx.tools.register({
      name: 'godot_mcp_call',
      description: 'Call any tool on the Godot AI MCP server and return its result. Discover names with godot_mcp_tools. Examples: scene_get_hierarchy, node_create, script_attach, project_run, filesystem_write_text, or a <domain>_manage rollup with args {op, params}. Every Godot-talking tool accepts an optional session_id argument (format <project-slug>@<4hex>) to pin one editor when several sessions are connected; pass it here as session_id.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'exact MCP tool name, e.g. scene_get_hierarchy or scene_manage' },
          args: { type: 'object', description: 'tool arguments object' },
          session_id: { type: 'string', description: 'optional Godot AI session id to pin this call to one editor' },
        },
        required: ['tool'],
      },
      output: OUT,
      async execute(input) {
        try {
          const raw = input.args
          const args = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
          if (typeof input.session_id === 'string' && input.session_id) args.session_id = input.session_id
          const result = await withFreshSessionRetry(() => callTool(String(input.tool), args))
          return JSON.stringify(result, null, 2)
        } catch (error) {
          return friendlyError(error)
        }
      },
    })

    ctx.tools.register({
      name: 'godot_mcp_configure',
      description: 'Point the bridge at a Godot AI MCP endpoint (default http://127.0.0.1:8000/mcp). Use when the server runs on a non-default port. The connection is reset and re-established on the next tool call.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'full MCP endpoint URL, e.g. http://127.0.0.1:8001/mcp' },
        },
        required: ['url'],
      },
      output: OUT,
      async execute(input) {
        const url = String(input.url)
        if (!/^https?:\/\//i.test(url)) {
          return JSON.stringify({ error: 'url must start with http:// or https://, got: ' + url }, null, 2)
        }
        state.url = url
        state.sessionId = null
        state.initPromise = null
        return 'godot MCP bridge endpoint set to ' + url + '. The connection resets on the next call.'
      },
    })

    // ── "mcp 直连" direct mode ─────────────────────────────────────────────

    /** The session's direct-mode service (undefined until the UI host half runs). */
    function directService(exec) {
      const sessionId = direct.sessionId || (exec && exec.agent && exec.agent.id)
      if (!sessionId) return undefined
      return ctx.get(DIRECT_SERVICE_PREFIX + sessionId)
    }

    /** Dynamic systemPrompt section: re-reads the mode before every model step. */
    ctx.systemPrompt.section({
      name: 'godot-mcp-direct',
      order: 60,
      text: () => {
        const service = direct.sessionId === null ? undefined : ctx.get(DIRECT_SERVICE_PREFIX + direct.sessionId)
        const on = service === undefined ? true : service.get() === true
        return (on ? DIRECT_ON_TEXT : DIRECT_OFF_TEXT) + '\n\n' + TOOLS_CATALOG_TEXT
      },
    })

    ctx.tools.register({
      name: 'godot_mcp_direct_mode',
      description: 'Read or change the Godot MCP direct-connect mode (the "mcp 直连" toggle under the chat input, default ON). When direct=true the agent must connect to the Godot MCP server immediately and drive the editor proactively; when direct=false the agent calls the Godot MCP tools only when the task needs editor/game work. Mirrors the Web GUI toggle.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"get" reads the current mode, "set" writes it (set requires direct)' },
          direct: { type: 'boolean', description: 'new mode value, only used when action is "set"' },
        },
        required: ['action'],
      },
      output: OUT,
      execute(input, exec) {
        const service = directService(exec)
        const current = service === undefined ? true : service.get() === true
        if (input.action === 'get') {
          return JSON.stringify({ direct: current, mode: current ? 'direct' : 'on-demand' }, null, 2)
        }
        if (input.action === 'set') {
          if (typeof input.direct !== 'boolean') {
            return JSON.stringify({ error: 'action "set" requires a boolean direct argument' }, null, 2)
          }
          if (service === undefined) {
            return JSON.stringify({ error: 'direct-mode service is not running yet; it activates on the next model step' }, null, 2)
          }
          service.set(input.direct)
          return JSON.stringify({ direct: input.direct, mode: input.direct ? 'direct' : 'on-demand' }, null, 2)
        }
        return JSON.stringify({ error: 'action must be "get" or "set"' }, null, 2)
      },
    })

    // ── Web GUI toggle: session-owned dynamic Plugin lifecycle ────────────

    /** Look up this session's UI plugin row in the runner snapshot. */
    function uiRow(agent) {
      const runner = ctx.get('dynamicCordisRunner')
      const ids = direct.ui.ids
      if (runner === undefined || ids === undefined) return undefined
      try {
        return runner.snapshot(agent).find((row) => row.pluginId === ids.pluginId)
      } catch { return undefined }
    }

    /** Forward the browser-summoning event. No requestId: pages answer through
     *  the direct (approval-free) path and settle the run. */
    function summonUi(agent) {
      const ids = direct.ui.ids
      if (ids === undefined) return
      ctx.emit('cordis/request-run', {
        agentId: agent.id,
        pluginId: ids.pluginId,
        packageId: ids.packageId,
        mode: 'run',
        name: UI_PACKAGE_NAME,
        purpose: UI_PACKAGE_PURPOSE,
        requiresApproval: false,
      })
    }

    /** Define + host-start the toggle Plugin once, then keep summoning the
     *  browser until a page settles the run. Re-summoning is idempotent:
     *  already-loaded pages attach and no-op, and the first page of this
     *  session (opened mid-session or after a step) loads the toggle. */
    async function ensureDirectUi(agent) {
      const runner = ctx.get('dynamicCordisRunner')
      if (runner === undefined) return
      direct.sessionId = agent.id
      if (direct.ui.phase === 'starting') return
      if (direct.ui.phase === 'ready') {
        const row = uiRow(agent)
        if (row === undefined) {
          // Removed from the panel; rebuild it.
          direct.ui.phase = 'idle'
          direct.ui.ids = null
          await ensureDirectUi(agent)
          return
        }
        if (row.activeRun === undefined || row.currentPackageId === undefined) summonUi(agent)
        return
      }
      direct.ui.phase = 'starting'
      try {
        if (direct.ui.ids === null) {
          direct.ui.ids = runner.define({
            plugin: { kind: 'new', idPrefix: 'godot' },
            sessionId: agent.id,
            name: UI_PACKAGE_NAME,
            purpose: UI_PACKAGE_PURPOSE,
            code: {
              host: buildDirectHostCode(agent.id),
              client: DIRECT_CLIENT_CODE,
            },
          })
        }
        const started = await runner.runHostHalf(agent, direct.ui.ids.pluginId, direct.ui.ids.packageId, 'run', null, false)
        if (!started.ok) throw new Error(started.message || 'host half failed to start')
        direct.ui.phase = 'ready'
        summonUi(agent)
      } catch (error) {
        direct.ui.phase = 'idle'
        try { ctx.logger.warn('[godot-mcp-bridge] direct-mode UI activation failed:', error) } catch { /* keep quiet */ }
      }
    }

    ctx.on('agent/session-start', ({ agent }) => { void ensureDirectUi(agent) })
    ctx.on('agent/pre-step', ({ agent }, next) => {
      void ensureDirectUi(agent)
      return next()
    })

    // Best-effort teardown: retract the session-owned dynamic Plugin when this
    // preset instance unwinds (an orphaned registry entry is also harmless and
    // dies with the process).
    ctx.effect(() => () => {
      const runner = ctx.get('dynamicCordisRunner')
      const ids = direct.ui.ids
      const sessionId = direct.sessionId
      if (runner === undefined || ids === null || ids === undefined || sessionId === null) return
      const agent = ctx.get('agents') && ctx.get('agents').get(sessionId)
      if (agent === undefined) return
      void runner.stop(agent, ids.pluginId).catch(() => {})
      void runner.undefine(agent, ids.pluginId).catch(() => {})
    })
  },
}
