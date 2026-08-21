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
        return on ? DIRECT_ON_TEXT : DIRECT_OFF_TEXT
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
