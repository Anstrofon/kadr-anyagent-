// Embedded AI agent session: a PTY running a CLI agent (Claude Code, opencode,
// or any MCP-compatible tool) inside the editor's terminal panel, wired to the
// live project through a local HTTP bridge (main ⇄ renderer eval) that the MCP
// stdio server (mcp-bridge.cjs, spawned by the agent) talks to.
//
// Agent profiles
// --------------
// The editor ships with built-in profiles for known CLIs (Claude Code,
// opencode) and a 'custom' escape hatch. The active profile is chosen by:
//   1. KADR_AGENT env var ('claude' | 'opencode' | 'custom')
//   2. userData/agent-env.json → { "agent": "..." }
//   3. falls back to auto-detection (first installed CLI wins)
//
// Per-agent overrides live in userData/agent-env.json:
//   { "agent": "claude", "command": "/path/to/claude", "args": [...],
//     "env": { "HTTPS_PROXY": "..." } }
// If you proxy the agent CLI, exclude localhost (NO_PROXY) so the kadr MCP
// bridge is reached directly.
//
// Extra MCP servers for the embedded session only (media search, etc.) go in
// userData/agent-mcp.json (legacy: claude-mcp.json is also read):
//   { "mcpServers": { name: { command, args, env } } }
// Merged into the generated --mcp-config; "kadr" itself wins on name clash.
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { IPty } from 'node-pty'

// ---------------------------------------------------------------------------
// System hint injected into agent sessions that support it
// ---------------------------------------------------------------------------

const SYSTEM_HINT =
  'You are embedded inside Kadr, a video editor, and were opened from its UI. ' +
  'The MCP server "kadr" is connected to the LIVE project the user is editing right now: ' +
  'kadr_state reads it, kadr_eval changes it, kadr_export renders it, kadr_transcribe does ' +
  'speech-to-text, kadr_fragment_create makes Remotion compositions (animations, dynamic ' +
  'captions, motion graphics) that live as clips on the timeline — after creating one, edit ' +
  'its TSX entry file directly: the user sees your changes live in the preview, no rendering. ' +
  'Treat user requests as being about this project unless told otherwise. ' +
  'Imported media file paths are in kadr_state assets — you may read those files ' +
  'directly; the system ffmpeg/ffprobe are available for media work. ' +
  'If other MCP tools can fetch or download media (stock search etc.), files they save ' +
  'can go straight into this project: import via kadr_eval (probeMedia → addAsset → ' +
  'insertClipFromAsset) or copy them into a fragment folder for use inside Remotion ' +
  'compositions. ' +
  'Kadr\'s skills compose: load kadr-editor, plus kadr-music when there is music, kadr-motion ' +
  'for titles/captions/fragments and kadr-3d for 3D — whichever this project needs. Before a ' +
  'bigger build, ask about style, rhythm, amount of text and sound, and show a plan; never ' +
  'export unless asked.'

// ---------------------------------------------------------------------------
// Agent profile system
// ---------------------------------------------------------------------------

/**
 * An agent profile describes how to launch and configure one kind of CLI.
 *
 * `buildArgs` receives the path to the generated MCP config and the system
 * hint, and returns the full argv for the CLI process. The MCP config file
 * follows the Claude/MCP-standard format:
 *   { "mcpServers": { "kadr": { "command", "args" } } }
 *
 * `sessionMarkers` lists environment variables the CLI injects into child
 * processes — they are stripped so the embedded session does not think it is
 * nested inside a parent session.
 *
 * `skillsDir` is where the CLI discovers skill files (e.g. ~/.claude/skills).
 * When set, Kadr syncs its own skills there on startup.
 */
interface AgentProfile {
  /** Short id for logs and config ('claude', 'opencode', 'custom') */
  id: string
  /** Human-readable label shown in error messages */
  label: string
  /** Default command name to look up on PATH */
  defaultCommand: string
  /** Build the CLI argv from the MCP config path and system hint */
  buildArgs: (mcpConfigPath: string, systemHint: string) => string[]
  /** Environment variables to strip before spawning (prevent nested-session) */
  sessionMarkers: string[]
  /** Directory where the CLI discovers skill files; null = no skill sync */
  skillsDir: string | null
}

const PROFILES: Record<string, AgentProfile> = {
  agy: {
    id: 'agy',
    label: 'Antigravity CLI (agy)',
    defaultCommand: 'agy',
    buildArgs: (_mcpCfg, _hint) => [],
    sessionMarkers: [
      'ANTIGRAVITY_AGENT',
      'ANTIGRAVITY_SESSION',
      'AGY_SESSION'
    ],
    skillsDir: join(process.env.HOME || '', '.gemini', 'antigravity', 'skills')
  },

  claude: {
    id: 'claude',
    label: 'Claude Code',
    defaultCommand: 'claude',
    buildArgs: (mcpCfg, hint) => [
      '--mcp-config', mcpCfg,
      '--append-system-prompt', hint
    ],
    sessionMarkers: [
      'CLAUDECODE',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_CODE_BRIDGE_SESSION_ID',
      'CLAUDE_BRIDGE_SESSION',
      'CLAUDE_PID',
      'CLAUDE_EFFORT'
    ],
    skillsDir: join(process.env.HOME || '', '.claude', 'skills')
  },

  opencode: {
    id: 'opencode',
    label: 'opencode',
    defaultCommand: 'opencode',
    buildArgs: (_mcpCfg, _hint) => [],
    sessionMarkers: [],
    skillsDir: null
  },

  custom: {
    id: 'custom',
    label: 'Custom Agent',
    defaultCommand: 'agent',
    buildArgs: (mcpCfg, _hint) => [
      '--mcp-config', mcpCfg
    ],
    sessionMarkers: [],
    skillsDir: null
  }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface Session {
  pty: IPty
  port: number
}

let session: Session | null = null
/** bumped by every open/close request; a spawn whose generation is stale is abandoned */
let sessionGen = 0
/** open/close are serialized through this chain — see openSession */
let sessionChain: Promise<unknown> = Promise.resolve()

// ---------------------------------------------------------------------------
// Stale session cleanup
// ---------------------------------------------------------------------------

/**
 * Kill leftovers of previous editor sessions: any process whose cmdline
 * references paths only Kadr-spawned helpers use — the embedded agent
 * tree (generated kadr-mcp.json / mcp-bridge script) and export/proxy/
 * reverse/transcribe workers (ffmpeg on kadr temp or cache paths, the
 * whisper runner). All of them inherit Chromium's listening sockets —
 * a survivor of a hard close holds the CDP port and blocks the next
 * launch. Outside-editor processes never reference these paths.
 * (Running two editor instances at once is not supported: the second
 * sweeps the first's helpers.)
 */
export async function sweepStaleSessions(): Promise<number> {
  const marks = [
    join(app.getPath('userData'), 'kadr-mcp.json'),
    join(app.getAppPath(), 'electron', 'mcp-bridge.cjs'),
    join(tmpdir(), 'kadr-export'), // raw encoder + muxer temp files
    join(app.getPath('userData'), 'proxies'),
    join(app.getPath('userData'), 'reversed'),
    join(app.getPath('userData'), 'decoded'),
    join(app.getPath('userData'), 'fragment-renders'),
    join(app.getAppPath(), 'scripts', 'transcribe.py'),
    join(app.getAppPath(), 'scripts', 'ttsqc_run.py')
  ]
  let entries: string[]
  try { entries = await fs.readdir('/proc') } catch { return 0 } // non-Linux
  const statOf = async (pid: number) => {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ') // state ppid pgrp …
    return { ppid: Number(f[1]), pgrp: Number(f[2]) }
  }
  // never touch ourselves, our ancestors (shell that launched us may mention
  // these paths in its cmdline), or anything sharing their process groups
  const safePids = new Set<number>()
  const safeGroups = new Set<number>()
  let cur = process.pid
  for (let i = 0; i < 20 && cur > 1; i++) {
    safePids.add(cur)
    try {
      const s = await statOf(cur)
      safeGroups.add(s.pgrp)
      cur = s.ppid
    } catch { break }
  }
  const groups = new Set<number>()
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue
    const pid = Number(ent)
    if (safePids.has(pid)) continue
    let cmd = ''
    try { cmd = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8') } catch { continue }
    if (!marks.some((m) => cmd.includes(m))) continue
    let pgid = pid
    try {
      const g = (await statOf(pid)).pgrp
      if (g > 1) pgid = g
    } catch { /* keep pid */ }
    if (safeGroups.has(pgid)) continue
    groups.add(pgid)
  }
  let killed = 0
  for (const g of groups) {
    try { process.kill(-g, 'SIGKILL'); killed++ } catch {
      try { process.kill(g, 'SIGKILL'); killed++ } catch { /* raced away */ }
    }
  }
  if (killed) console.log(`[agent] swept ${killed} stale session group(s)`)
  return killed
}

// ---------------------------------------------------------------------------
// HTTP bridge: POST /eval from mcp-bridge.cjs into the renderer
// ---------------------------------------------------------------------------

/** JS evaluated in the page (async function body) → JSON result. */
async function evalInPage(win: BrowserWindow, code: string): Promise<string> {
  const wrapped = `(async () => {
    try {
      const r = await (async () => { ${code}\n })()
      return JSON.stringify({ ok: r === undefined ? null : r })
    } catch (e) {
      return JSON.stringify({ error: String((e && (e.stack || e.message)) || e) })
    }
  })()`
  return win.webContents.executeJavaScript(wrapped, true)
}

/**
 * Local bridge: POST /eval {code} from mcp-bridge.cjs into the renderer.
 *
 * /eval is arbitrary JS in the page, and the page holds window.kadr (file
 * writes, pty spawn) — so the socket needs a door, not just an address.
 * Anything running on this machine can reach 127.0.0.1, and a WEB PAGE can
 * too: a fetch() with a simple content type is sent cross-origin without the
 * browser asking permission first, and the reply being unreadable does not
 * stop the code from running. A fragment previewed from the workspace vite
 * server is such a page. Two cheap locks close that:
 *   • a per-session secret in a custom header — a custom header forces the
 *     browser to ask permission first (preflight), which this server answers
 *     with 404, so a page cannot even send the request;
 *   • rejecting anything that carries an Origin at all — only browsers set
 *     it, and the only legitimate client here is a node process.
 * The health check (GET /) stays open: mcp-bridge only needs *a* reply.
 */
let editorBridge: { server: Server; port: number; token: string } | null = null

function getBridgeFilePath(): string {
  const home = process.env.HOME || app.getPath('home')
  return join(home, '.kadr', 'editor-bridge.json')
}

async function writeBridgeFile(port: number, token: string) {
  try {
    const filePath = getBridgeFilePath()
    await fs.mkdir(join(filePath, '..'), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify({
      port,
      token,
      pid: process.pid,
      updatedAt: new Date().toISOString()
    }, null, 2), { mode: 0o600 })
  } catch (err) {
    console.warn('[agent] failed to write editor-bridge.json:', err)
  }
}

async function removeBridgeFile() {
  try {
    await fs.unlink(getBridgeFilePath())
  } catch { /* ignore */ }
}

function startBridge(
  getWin: () => BrowserWindow | null
): Promise<{ server: Server; port: number; token: string }> {
  const token = randomBytes(24).toString('hex')
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, pid: process.pid }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/eval') {
        res.writeHead(404).end()
        return
      }
      if (req.headers.origin !== undefined || req.headers['x-kadr-token'] !== token) {
        res.writeHead(403).end()
        return
      }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', async () => {
        try {
          const win = getWin()
          if (!win || win.isDestroyed()) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'editor window is not available' }))
            return
          }
          const { code } = JSON.parse(body)
          const out = await evalInPage(win, String(code))
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(out)
        } catch (err) {
          res
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: String(err) }))
        }
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        await writeBridgeFile(port, token)
        resolve({ server, port, token })
      } else {
        reject(new Error('bridge listen failed'))
      }
    })
  })
}

/** Get or initialize the persistent editor HTTP bridge */
export async function ensureEditorBridge(
  getWin: () => BrowserWindow | null
): Promise<{ server: Server; port: number; token: string }> {
  if (editorBridge) return editorBridge
  editorBridge = await startBridge(getWin)
  return editorBridge
}

export function closeEditorBridge() {
  if (!editorBridge) return
  editorBridge.server.close()
  editorBridge = null
  void removeBridgeFile()
}

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', `command -v ${cmd}`], (err, stdout) => {
      resolve(err ? null : stdout.trim() || null)
    })
  })
}

// ---------------------------------------------------------------------------
// Agent config & profile resolution
// ---------------------------------------------------------------------------

interface AgentConfig {
  /** Profile id: 'claude' | 'opencode' | 'custom' */
  agent?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * Read the user's agent configuration. Checks (in order):
 *   1. userData/agent-env.json    (new canonical location)
 *   2. userData/claude-env.json   (backward compatibility)
 */
async function userConfig(): Promise<AgentConfig> {
  for (const name of ['agent-env.json', 'claude-env.json']) {
    try {
      const p = join(app.getPath('userData'), name)
      return JSON.parse(await fs.readFile(p, 'utf8'))
    } catch { /* try next */ }
  }
  return {}
}

async function saveUserConfig(cfg: AgentConfig): Promise<void> {
  const p = join(app.getPath('userData'), 'agent-env.json')
  await fs.writeFile(p, JSON.stringify(cfg, null, 2))
}

async function findExecutable(cmd: string): Promise<string | null> {
  if (cmd.includes('/')) {
    try {
      await fs.access(cmd, 1 /* X_OK */)
      return cmd
    } catch {
      return null
    }
  }

  if (cmd === 'agy' || cmd === 'antigravity') {
    const candidates = [
      'agy',
      '/usr/bin/agy',
      '/usr/local/bin/agy',
      join(process.env.HOME || '', '.gemini/antigravity-cli/bin/agy'),
      join(process.env.HOME || '', '.local/bin/agy')
    ]
    for (const c of candidates) {
      if (c.includes('/')) {
        try {
          await fs.access(c, 1 /* X_OK */)
          return c
        } catch { /* continue */ }
      } else {
        const found = await which(c)
        if (found) return found
      }
    }
  }

  if (cmd === 'opencode' || cmd === 'opencode-cli') {
    const candidates = [
      'opencode',
      'opencode-cli',
      '/usr/lib/opencode-desktop/opencode-cli',
      '/usr/local/bin/opencode',
      join(process.env.HOME || '', '.local/bin/opencode')
    ]
    for (const c of candidates) {
      if (c.includes('/')) {
        try {
          await fs.access(c, 1 /* X_OK */)
          return c
        } catch { /* continue */ }
      } else {
        const found = await which(c)
        if (found) return found
      }
    }
  }

  return which(cmd)
}

/**
 * Resolve which profile to use. Priority:
 *   1. KADR_AGENT env var
 *   2. agent-env.json → agent field
 *   3. KADR_CLAUDE_CMD env var (legacy — implies 'claude')
 *   4. Auto-detect: opencode first, then claude
 */
async function resolveProfile(cfg: AgentConfig): Promise<{ profile: AgentProfile; bin: string }> {
  const agentId = process.env.KADR_AGENT || cfg.agent

  if (agentId && PROFILES[agentId]) {
    const profile = PROFILES[agentId]
    const cmdName = cfg.command || profile.defaultCommand
    const bin = (await findExecutable(cmdName)) ?? cmdName
    return { profile, bin }
  }

  // Legacy env var support
  if (process.env.KADR_CLAUDE_CMD || cfg.command) {
    const cmdName = process.env.KADR_CLAUDE_CMD || cfg.command || 'opencode'
    const profile = PROFILES[cfg.agent ?? 'opencode'] ?? PROFILES.opencode
    const bin = (await findExecutable(cmdName)) ?? cmdName
    return { profile, bin }
  }

  // Auto-detect: try opencode first, then claude, then agy
  for (const id of ['opencode', 'claude', 'agy']) {
    const profile = PROFILES[id]
    const bin = await findExecutable(profile.defaultCommand)
    if (bin) return { profile, bin }
  }

  // Default to opencode candidate if available
  const opencodeBin = await findExecutable('opencode')
  if (opencodeBin) return { profile: PROFILES.opencode, bin: opencodeBin }

  return { profile: PROFILES.opencode, bin: 'opencode' }
}

/**
 * The environment the panel's session runs in: ours, minus the markers of the
 * session that happened to launch the editor (prevents nested-session
 * detection), plus whatever the user put in agent-env.json (their own
 * overrides always win).
 */
function sessionEnv(markers: string[], extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const key of markers) delete env[key]
  return { ...env, ...extra }
}

// ---------------------------------------------------------------------------
// Session spawn & kill
// ---------------------------------------------------------------------------

async function spawnSession(
  win: BrowserWindow,
  cols: number,
  rows: number,
  cwd: string | null
): Promise<{ ok: boolean; port?: number; error?: string }> {
  killSession() // a reopen without a close in between
  const cfg = await userConfig()
  const { profile, bin } = await resolveProfile(cfg)

  let bridge: { server: Server; port: number; token: string }
  try {
    bridge = await ensureEditorBridge(() => win)
  } catch (err) {
    return { ok: false, error: `bridge: ${String(err)}` }
  }

  // per-session MCP config: the agent merges it with any user-defined servers
  let extraServers: Record<string, unknown> = {}
  // read from both new and legacy config locations
  for (const name of ['agent-mcp.json', 'claude-mcp.json']) {
    try {
      const raw = await fs.readFile(join(app.getPath('userData'), name), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.mcpServers === 'object') {
        extraServers = { ...parsed.mcpServers, ...extraServers }
      }
    } catch { /* optional file */ }
  }
  // KADR_MCP_PORT: when set, the MCP bridge also listens on this HTTP port
  // for external clients (Antigravity, opencode, etc). '0' = auto-assign.
  const mcpHttpPort = process.env.KADR_MCP_PORT
  const bridgeArgs = [
    join(app.getAppPath(), 'electron', 'mcp-bridge.cjs'),
    String(bridge.port),
    bridge.token,
    ...(mcpHttpPort != null ? ['--http-port', mcpHttpPort] : [])
  ]
  const mcpCfgPath = join(app.getPath('userData'), 'kadr-mcp.json')
  await fs.writeFile(
    mcpCfgPath,
    JSON.stringify({
      mcpServers: {
        ...extraServers,
        kadr: {
          command: 'node',
          args: bridgeArgs
        }
      }
    }, null, 1)
  )

  const isAgy = profile.id === 'agy' || (cfg.command && /(^|[/\\])agy$/.test(cfg.command))
  const defaultArgs = isAgy ? [] : profile.buildArgs(mcpCfgPath, SYSTEM_HINT)
  const args = cfg.args ?? defaultArgs
  let dir = cwd || app.getPath('home')
  try { await fs.access(dir) } catch { dir = app.getPath('home') }

  try {
    // lazy import: node-pty is native — a load failure must not break the app
    const pty = await import('node-pty')
    // Watchdog wrapper: the agent runs exec'd in the pty foreground (same pid
    // as the wrapper, TUI unaffected); a background subshell nukes the whole
    // process group if this Electron process dies hard — otherwise a busy
    // agent tree survives holding inherited Chromium sockets (CDP port)
    // and blocks the next launch.
    const wrapper =
      `(while kill -0 ${process.pid} 2>/dev/null; do sleep 3; done; ` +
      `kill -HUP -$$ 2>/dev/null; sleep 2; kill -9 -$$ 2>/dev/null) & exec "$0" "$@"`
    const p = pty.spawn('/bin/bash', ['-c', wrapper, bin, ...args], {
      name: 'xterm-256color',
      cols: Math.max(20, cols),
      rows: Math.max(5, rows),
      cwd: dir,
      env: sessionEnv(profile.sessionMarkers, cfg.env)
    })
    // publish BEFORE wiring the handlers: data emitted between spawn and the
    // assignment would otherwise be dropped by the identity guard below
    const mine: Session = { pty: p, port: bridge.port }
    session = mine
    // both handlers are keyed to THIS session: a pty that outlived its panel
    // (a kill that lost a race, say) must never paint into the live terminal
    p.onData((data) => {
      if (session === mine) win.webContents.send('claude:data', data)
    })
    p.onExit(({ exitCode }) => {
      // only announce deaths of the CURRENT session: deliberate closes
      // (panel toggle, StrictMode remount) drop `session` before killing
      if (session === mine) {
        win.webContents.send('claude:exit', exitCode)
        session = null
      }
    })
    console.log(`[agent] spawned ${profile.label} (${bin}) on bridge port ${bridge.port}`)
    return { ok: true, port: bridge.port }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

function killSession() {
  if (!session) return
  const s = session
  session = null
  // HUP the whole process group (agent + its MCP server children), then
  // escalate: a busy tree that shrugs off SIGHUP must not outlive the panel
  const pid = s.pty.pid
  try { process.kill(-pid, 'SIGHUP') } catch { try { s.pty.kill() } catch { /* dead */ } }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }, 1500)
}

/**
 * Open and close run ONE AT A TIME, and every request takes a generation.
 *
 * `spawnSession` is async (config read, `which`, the node-pty import) while a
 * close is instant, so a close that overtook an in-flight open used to find
 * `session` still null, do nothing, and let the pending spawn install itself
 * afterwards — an orphaned agent nobody could reach or kill. React StrictMode
 * turned that race into the norm: it mounts AgentPanel twice in dev
 * (mount → cleanup → mount), so every panel open spawned two ptys, both
 * writing into the same 'claude:data' channel — two interleaved sessions in
 * one terminal (issue #11). A fast open→close leaked one the same way in any
 * build. Serializing fixes the leak; the generation also lets a spawn that has
 * already been superseded be skipped instead of started and killed.
 */
function openSession(
  win: BrowserWindow,
  cols: number,
  rows: number,
  cwd: string | null
): Promise<{ ok: boolean; port?: number; error?: string }> {
  const gen = ++sessionGen
  const job = sessionChain.then(() =>
    gen === sessionGen
      ? spawnSession(win, cols, rows, cwd)
      : { ok: false, error: 'superseded' }
  )
  sessionChain = job.catch(() => undefined)
  return job
}

function closeSession(): Promise<void> {
  sessionGen++ // abandon anything still in flight
  const job = sessionChain.then(killSession)
  sessionChain = job.catch(() => undefined)
  return job
}

// ---------------------------------------------------------------------------
// Skill synchronization
// ---------------------------------------------------------------------------

/** the line every skill Kadr writes carries — only such folders are ever removed */
const SKILL_MARK = '<!-- managed by Kadr'

/**
 * Keep Kadr's agent skills fresh in the user's skills directory — the
 * embedded agent discovers them from its skills dir. They are COMPOSABLE:
 * kadr-editor is the base (LOOK/ACT/VERIFY, the interface, fragments, voice),
 * kadr-music, kadr-motion and kadr-3d carry the rules of particular kinds of
 * work, and a project loads the ones it needs — a plain cut none of them, a
 * product film to a song all three. Scoped by their descriptions to sessions
 * where the kadr_* tools exist, so they stay dormant in unrelated sessions
 * and never collide with a separately installed remotion skill.
 *
 * Written only when the content changed. A kadr-* folder whose SKILL.md
 * carries Kadr's mark but is no longer shipped is removed; a folder without
 * the mark is the user's own and is never touched.
 *
 * Syncs to ALL profiles that declare a skillsDir (currently only Claude Code
 * uses ~/.claude/skills; other CLIs may support skills in the future).
 */
async function syncSkills(): Promise<void> {
  const srcDir = join(app.getAppPath(), 'electron', 'skills')
  // collect all unique skill directories from profiles
  const roots = new Set<string>()
  for (const p of Object.values(PROFILES)) {
    if (p.skillsDir) roots.add(p.skillsDir)
  }
  for (const root of roots) {
    try {
      const shipped = new Set<string>()
      for (const file of (await fs.readdir(srcDir)).filter((f) => f.endsWith('.md')).sort()) {
        const src = await fs.readFile(join(srcDir, file), 'utf8')
        const name = src.match(/^---\n[\s\S]*?^name:\s*([a-z0-9-]+)\s*$/m)?.[1]
        if (!name || !src.includes(SKILL_MARK)) {
          console.warn(`[agent] skill ${file}: no name in its front matter or no managed mark — skipped`)
          continue
        }
        shipped.add(name)
        const dir = join(root, name)
        const dst = join(dir, 'SKILL.md')
        const cur = await fs.readFile(dst, 'utf8').catch(() => null)
        if (cur === src) continue
        await fs.mkdir(dir, { recursive: true })
        const tmp = `${dst}.part-${process.pid}`
        await fs.writeFile(tmp, src)
        await fs.rename(tmp, dst)
      }
      if (!shipped.size) continue // nothing read: never take this as "remove everything"
      for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!d.isDirectory() || !d.name.startsWith('kadr-') || shipped.has(d.name)) continue
        const md = await fs.readFile(join(root, d.name, 'SKILL.md'), 'utf8').catch(() => '')
        if (md.includes(SKILL_MARK)) await fs.rm(join(root, d.name), { recursive: true, force: true })
      }
    } catch (err) {
      console.warn(`[agent] skill sync to ${root} failed:`, err)
    }
  }
}

/**
 * Automatically register Kadr in Antigravity's global MCP configuration (~/.gemini/config/mcp_config.json)
 * so that both Antigravity CLI (agy) and the desktop assistant can communicate with the active editor.
 */
async function syncAntigravityMcp(): Promise<void> {
  try {
    const home = process.env.HOME || app.getPath('home')
    const configDir = join(home, '.gemini', 'config')
    const configPath = join(configDir, 'mcp_config.json')
    let cfg: { mcpServers?: Record<string, unknown> } = {}
    try {
      cfg = JSON.parse(await fs.readFile(configPath, 'utf8'))
    } catch {
      // file might not exist yet
    }
    cfg.mcpServers = cfg.mcpServers || {}
    const bridgeScript = join(app.getAppPath(), 'electron', 'mcp-bridge.cjs')
    cfg.mcpServers.kadr = {
      command: 'node',
      args: [bridgeScript],
      disabled: false
    }
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8')
  } catch (err) {
    console.warn('[agent] failed to sync Antigravity MCP config:', err)
  }
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

/**
 * Register the agent IPC handlers. The IPC channel names stay 'claude:*' for
 * backward compatibility with the preload script — the preload bridges them
 * to window.kadr.claudeOpen/claudeInput/etc. A future cleanup can rename
 * them to 'agent:*' in both preload.ts and here simultaneously.
 */
export function registerAgentIpc(getWin: () => BrowserWindow | null) {
  void sweepStaleSessions() // leftovers from a hard-killed previous run
  void syncSkills()
  void syncAntigravityMcp()
  void ensureEditorBridge(getWin)
  ipcMain.handle('claude:open', (_e, cols: number, rows: number, cwd: string | null) => {
    const win = getWin()
    if (!win) return { ok: false, error: 'no window' }
    return openSession(win, cols, rows, cwd)
  })
  ipcMain.on('claude:input', (_e, data: string) => session?.pty.write(data))
  ipcMain.on('claude:resize', (_e, cols: number, rows: number) => {
    try { session?.pty.resize(Math.max(20, cols), Math.max(5, rows)) } catch { /* dying */ }
  })
  ipcMain.handle('claude:close', () => closeSession())
  ipcMain.handle('agent:get-config', async () => {
    const cfg = await userConfig()
    return {
      agent: cfg.agent || 'opencode',
      command: cfg.command || '',
      args: cfg.args || [],
      env: cfg.env || {}
    }
  })
  ipcMain.handle('agent:set-config', async (_e, cfg: AgentConfig) => {
    try {
      await saveUserConfig(cfg)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  app.on('before-quit', () => {
    void closeSession()
    closeEditorBridge()
  })
}

// Legacy export name for backward compatibility
export const registerClaudeIpc = registerAgentIpc
