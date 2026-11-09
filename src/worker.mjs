import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SESSION_PREFIX = 'orca-dsh-web'
const STORE_KEY = 'servers'
const LEGACY_SERVER_KEY = 'server'
const LEGACY_SERVERS_KEY = 'servers-legacy'
const LOG_DIR = path.join(os.homedir(), '.cache', 'orca-dsh-web')
const URL_RE = /dsh web:\s+(https?:\/\/\S+)/
const FATAL_RE = /(?:dsh: (?:command )?not found|command not found|EADDRINUSE|address already in use|Cannot find module|ERR_MODULE_NOT_FOUND)/i
const POLL_MS = 30000

let queue = Promise.resolve()
let refreshTimer = null
let statusTimer = null
let idle = new Map()
let refreshing = false

export function parseDshUrl(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = URL_RE.exec(lines[index])
    if (match) return match[1]
  }
  return null
}

export function pickWorkspace(context, workspaces) {
  if (!context) return null
  const sameName = workspaces.filter((workspace) => workspace.name === context.displayName)
  return sameName.find((workspace) => workspace.branch === context.branch) ?? sameName[0] ?? null
}

export function isRemoteWorkspace(workspace) {
  return Boolean(workspace?.hostId && workspace.hostId !== 'local')
}

export function worktreeSelector(workspace) {
  return workspace.id.startsWith('identity:') ? workspace.id : `id:${workspace.id}`
}

export function serverKey(workspaceId, profile) {
  return `${workspaceId}|${profile}`
}

export function sessionFor(workspaceId, profile) {
  return `${SESSION_PREFIX}-${createHash('sha1').update(`${workspaceId}|${profile}`).digest('hex').slice(0, 8)}`
}

export function logFileFor(workspaceId, profile) {
  return path.join(LOG_DIR, `dsh-${profile}-${createHash('sha1').update(workspaceId).digest('hex').slice(0, 8)}.log`)
}

export function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function tabsWithOrigin(tabs, origin) {
  if (!origin) return []
  return tabs.filter((tab) => typeof tab?.url === 'string' && originOf(tab.url) === origin)
}

/**
 * One idle-check for a server: arm only after its tab was seen, then count
 * misses and ask to stop once the grace period is over.
 */
export function idleDecision(state, hasTabs, graceTicks) {
  const next = { armed: Boolean(state?.armed), misses: Number(state?.misses ?? 0) }
  if (hasTabs) return { ...next, armed: true, misses: 0, stop: false }
  if (!next.armed) return { ...next, stop: false }
  next.misses += 1
  return { ...next, stop: graceTicks > 0 && next.misses >= graceTicks }
}

function cliCommand() {
  return process.env.ORCA_CLI_COMMAND || (process.platform === 'linux' ? 'orca-ide' : 'orca')
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function serial(task) {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fatalError(message) {
  const error = new Error(message)
  error.fatal = true
  return error
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

export function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured ? expandHome(configured) : path.join(os.homedir(), '.dsh')
}

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function discoverProfiles(home = dshHome()) {
  const root = path.join(home, 'profiles')
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !PROFILE_NAME_RE.test(entry.name)) continue
    try {
      await fs.access(path.join(root, entry.name, 'package.json'))
      names.push(entry.name)
    } catch {}
  }
  return names
}

function defaultCommand(profile) {
  return `dsh ${shellQuote(profile)} --no-open --port 0`
}

async function tmux(args, timeout = 10000) {
  return execFileAsync('tmux', args, { timeout })
}

async function tmuxAvailable() {
  try {
    await tmux(['-V'], 5000)
    return true
  } catch {
    return false
  }
}

async function tmuxSessionExists(session) {
  try {
    await tmux(['has-session', '-t', session])
    return true
  } catch {
    return false
  }
}

async function tmuxKill(session) {
  try {
    await tmux(['kill-session', '-t', session])
  } catch {}
}

async function tmuxSessions() {
  try {
    const { stdout } = await tmux(['list-sessions', '-F', '#{session_name}'])
    return String(stdout).split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

async function readLog(logPath) {
  try {
    return await fs.readFile(logPath, 'utf8')
  } catch {
    return ''
  }
}

async function isAlive(url) {
  try {
    await fetch(new URL('/', url), { method: 'HEAD', signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

async function serverAlive(server) {
  if (!server?.url || !server?.session) return false
  if (!(await tmuxSessionExists(server.session))) return false
  return isAlive(server.url)
}

async function listTabs() {
  try {
    const { stdout } = await execFileAsync(cliCommand(), ['tab', 'list', '--json'], { timeout: 15000 })
    const parsed = JSON.parse(stdout)
    return parsed?.result?.tabs ?? null
  } catch {
    return null
  }
}

async function focusedWorkspace(orca) {
  const context = await orca.host.call('workspace.readContext')
  if (!context) return null
  const result = await orca.host.call('workspace.list')
  return pickWorkspace(context, result?.workspaces ?? [])
}

async function readServers(orca) {
  const stored = await orca.storage.get(STORE_KEY)
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) return { ...stored }
  return {}
}

async function writeServers(orca, servers) {
  await orca.storage.set(STORE_KEY, servers)
}

async function adoptSession(orca, workspace, profile) {
  const session = sessionFor(workspace.id, profile)
  if (!(await tmuxSessionExists(session))) return null
  const logPath = logFileFor(workspace.id, profile)
  const url = parseDshUrl(stripAnsi(await readLog(logPath)).split(/\r?\n/))
  if (!url || !(await isAlive(url))) return null
  const servers = await readServers(orca)
  const server = {
    session,
    url,
    workspaceId: workspace.id,
    hostId: workspace.hostId ?? null,
    profile,
    command: await commandFor(orca, profile),
    logPath,
    armed: true,
  }
  servers[serverKey(workspace.id, profile)] = server
  await writeServers(orca, servers)
  return server
}

async function migrateLegacy(orca) {
  const legacy = await orca.storage.get(LEGACY_SERVER_KEY)
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    if (legacy.terminalId) {
      try {
        await execFileAsync(cliCommand(), ['terminal', 'close', '--terminal', legacy.terminalId, '--tab', '--json'], { timeout: 10000 })
      } catch {}
    } else if (legacy.url && legacy.workspaceId) {
      const servers = await readServers(orca)
      servers[serverKey(legacy.workspaceId, 'web')] = {
        ...legacy,
        profile: 'web',
        session: legacy.session ?? SESSION_PREFIX,
        logPath: legacy.logPath ?? path.join(LOG_DIR, 'dsh-web.log'),
        armed: false,
      }
      await writeServers(orca, servers)
    }
    await orca.storage.delete(LEGACY_SERVER_KEY).catch(() => {})
  }
  const old = await orca.storage.get(LEGACY_SERVERS_KEY)
  if (old && typeof old === 'object') {
    for (const server of Object.values(old)) {
      if (server?.terminalId) {
        try {
          await execFileAsync(cliCommand(), ['terminal', 'close', '--terminal', server.terminalId, '--tab', '--json'], { timeout: 10000 })
        } catch {}
      }
    }
    await orca.storage.delete(LEGACY_SERVERS_KEY).catch(() => {})
  }
}

async function setStatus(orca, text, tone, tooltip) {
  try {
    await orca.host.call('statusBar.update', { id: 'dsh-web', text, tone, tooltip })
  } catch {}
}

async function waitForUrl(logPath, session) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const lines = stripAnsi(await readLog(logPath)).split(/\r?\n/)
    const url = parseDshUrl(lines)
    if (url) return url
    const fatal = lines.find((line) => FATAL_RE.test(line))
    if (fatal) throw fatalError(`DSH Web не запустился: ${fatal.trim()}`)
    if (!(await tmuxSessionExists(session))) {
      const tail = lines.filter(Boolean).slice(-3).join(' | ')
      throw fatalError(`DSH Web завершился: ${tail || `смотри tmux attach -t ${session}`}`)
    }
    await sleep(500)
  }
  throw new Error(`DSH Web не напечатал URL за 120 секунд; tmux attach -t ${session}`)
}

async function commandFor(orca, profile) {
  if (profile === 'web') return (await orca.settings.get('command')) || defaultCommand('web')
  if (profile === 'unity') return (await orca.settings.get('unityCommand')) || defaultCommand('unity')
  return defaultCommand(profile)
}

async function startServer(orca, workspace, profile) {
  if (!(await tmuxAvailable())) throw new Error('tmux не найден; установи tmux')
  const session = sessionFor(workspace.id, profile)
  const logPath = logFileFor(workspace.id, profile)
  await tmuxKill(session)
  await fs.mkdir(LOG_DIR, { recursive: true })
  await fs.writeFile(logPath, '')
  const command = await commandFor(orca, profile)
  const shellCommand = `${command} 2>&1 | tee -a ${shellQuote(logPath)}`
  await tmux(['new-session', '-d', '-s', session, '-c', workspace.path, shellCommand])
  let url
  try {
    url = await waitForUrl(logPath, session)
  } catch (error) {
    if (error.fatal) await tmuxKill(session)
    throw error
  }
  const server = {
    session,
    url,
    workspaceId: workspace.id,
    hostId: workspace.hostId ?? null,
    profile,
    command,
    logPath,
    armed: false,
  }
  const servers = await readServers(orca)
  servers[serverKey(workspace.id, profile)] = server
  await writeServers(orca, servers)
  return server
}

async function ensureServer(orca, workspace, profile) {
  if (isRemoteWorkspace(workspace)) {
    throw new Error('DSH Web через tmux работает только на локальном хосте')
  }
  const key = serverKey(workspace.id, profile)
  const servers = await readServers(orca)
  const saved = servers[key] ?? (await adoptSession(orca, workspace, profile))
  if (saved) {
    const current = parseDshUrl(stripAnsi(await readLog(saved.logPath)).split(/\r?\n/))
    if (current && current !== saved.url && (await serverAlive({ ...saved, url: current }))) {
      const next = { ...saved, url: current }
      servers[key] = next
      await writeServers(orca, servers)
      return next
    }
    if (await serverAlive(saved)) return saved
  }
  delete servers[key]
  await writeServers(orca, servers)
  return startServer(orca, workspace, profile)
}

async function stopServer(orca, key) {
  const servers = await readServers(orca)
  const server = servers[key]
  if (!server) return false
  await tmuxKill(server.session)
  delete servers[key]
  await writeServers(orca, servers)
  idle.delete(key)
  return true
}

async function openTab(url, workspace) {
  const base = ['tab', 'create', '--url', url, '--json']
  try {
    await execFileAsync(cliCommand(), [...base, '--worktree', worktreeSelector(workspace)], { timeout: 20000 })
    return
  } catch {}
  await execFileAsync(cliCommand(), [...base, '--worktree', 'active'], { timeout: 20000 })
}

async function notify(orca, body) {
  try {
    await orca.host.call('notifications.show', { title: 'DSH Web', body })
  } catch {}
}

async function requireProfile(profile) {
  const profiles = await discoverProfiles()
  if (!profiles.includes(profile)) throw new Error(`Профиль DSH не найден: ${profile}`)
}

async function openProfile(orca, profile) {
  await requireProfile(profile)
  const workspace = await focusedWorkspace(orca)
  if (!workspace) throw new Error('Нет активного проекта Orca')
  orca.log(`dsh-web: ${profile} для проекта ${workspace.name}`)
  const server = await ensureServer(orca, workspace, profile)
  orca.log(`dsh-web: сервер ${originOf(server.url)} (${profile})`)
  await openTab(server.url, workspace)
  await refreshStatus(orca)
  return `DSH ${profile} открыт: ${originOf(server.url)}`
}

async function stopFocused(orca) {
  const workspace = await focusedWorkspace(orca).catch(() => null)
  if (!workspace) return 'Нет активного проекта Orca'
  const servers = await readServers(orca)
  let stopped = 0
  for (const [key, server] of Object.entries(servers)) {
    if (server?.workspaceId !== workspace.id) continue
    if (await stopServer(orca, key)) stopped += 1
  }
  await refreshStatus(orca)
  return stopped > 0 ? `DSH остановлен (${workspace.name}, серверов: ${stopped})` : 'DSH уже остановлен'
}

async function stopProfile(orca, profile) {
  const workspace = await focusedWorkspace(orca)
  if (!workspace) throw new Error('Нет активного проекта Orca')
  const stopped = await stopServer(orca, serverKey(workspace.id, profile))
  await refreshStatus(orca)
  return stopped ? `DSH ${profile} остановлен` : `DSH ${profile} уже остановлен`
}

async function stopAll(orca) {
  const servers = await readServers(orca)
  let stopped = 0
  for (const key of Object.keys(servers)) {
    if (await stopServer(orca, key)) stopped += 1
  }
  for (const session of await tmuxSessions()) {
    if (session === SESSION_PREFIX || session.startsWith(`${SESSION_PREFIX}-`)) {
      await tmuxKill(session)
      stopped += 1
    }
  }
  await refreshStatus(orca)
  return `DSH остановлен, серверов: ${stopped}`
}

async function panelState(orca) {
  const workspace = await focusedWorkspace(orca)
  const profiles = await discoverProfiles()
  const servers = await readServers(orca)
  const rows = []
  for (const name of profiles) {
    let server = workspace ? servers[serverKey(workspace.id, name)] : null
    if (workspace && !server) server = await adoptSession(orca, workspace, name)
    const running = Boolean(server && (await serverAlive(server)))
    rows.push({ name, running, origin: running ? originOf(server.url) : null })
  }
  return { workspace: workspace?.name ?? null, host: workspace?.hostId ?? null, profiles: rows }
}

let cachedPluginKey = null

async function pluginKey() {
  if (cachedPluginKey) return cachedPluginKey
  try {
    const { stdout } = await execFileAsync(cliCommand(), ['plugin', 'list', '--json'], { timeout: 10000 })
    const plugins = JSON.parse(stdout)?.result?.plugins ?? []
    const match =
      plugins.find((plugin) => plugin.name === 'DSH' && plugin.hasWorker) ??
      plugins.find((plugin) => plugin.name === 'DSH Web') ??
      plugins.find((plugin) => plugin.hasWorker && plugin.pluginKey === 'local.dsh-web')
    if (match?.pluginKey) {
      cachedPluginKey = match.pluginKey
      return cachedPluginKey
    }
  } catch {}
  cachedPluginKey = 'local.dsh-web'
  return cachedPluginKey
}

async function openPanel() {
  const key = await pluginKey()
  await execFileAsync(cliCommand(), ['plugin', 'open', key, '--panel', 'dsh-web', '--json'], { timeout: 10000 })
  return 'Панель DSH открыта'
}

async function sweepIdle(orca, servers) {
  const keys = Object.keys(servers)
  if (keys.length === 0) return
  const tabs = await listTabs()
  if (tabs === null) return
  const graceSeconds = Number(await orca.settings.get('stopAfterSeconds'))
  const graceTicks = Number.isFinite(graceSeconds) && graceSeconds > 0 ? Math.ceil(graceSeconds / (POLL_MS / 1000)) : 0
  for (const key of keys) {
    const server = servers[key]
    if (!server || graceTicks === 0) continue
    if (!(await serverAlive(server))) continue
    const hasTabs = tabsWithOrigin(tabs, originOf(server.url)).length > 0
    const state = idle.get(key) ?? { armed: Boolean(server.armed), misses: 0 }
    const decision = idleDecision(state, hasTabs, graceTicks)
    idle.set(key, { armed: decision.armed, misses: decision.misses })
    if (decision.armed && !server.armed) {
      server.armed = true
      servers[key] = server
      await writeServers(orca, servers)
    }
    if (decision.stop) {
      orca.log(`dsh-web: нет вкладок, останавливаю ${key}`)
      await stopServer(orca, key)
    }
  }
}

async function refreshStatus(orca) {
  if (refreshing) return
  refreshing = true
  try {
    const workspace = await focusedWorkspace(orca)
    const servers = await readServers(orca)
    if (!workspace) {
      await setStatus(orca, 'DSH', 'neutral', 'DSH: нет активного проекта')
      return
    }
    if (isRemoteWorkspace(workspace)) {
      await setStatus(orca, 'DSH', 'neutral', 'DSH: tmux только на локальном хосте')
      return
    }
    const profiles = await discoverProfiles()
    const running = []
    for (const profile of profiles) {
      const key = serverKey(workspace.id, profile)
      const server = servers[key] ?? (await adoptSession(orca, workspace, profile))
      if (server && (await serverAlive(server))) running.push(profile)
    }
    await setStatus(
      orca,
      running.length > 0 ? `DSH ${running.length}` : 'DSH',
      running.length > 0 ? 'success' : 'neutral',
      running.length > 0 ? `DSH: ${running.join(', ')} (${workspace.name})` : `DSH: профили не запущены (${workspace.name})`,
    )
    await sweepIdle(orca, servers)
  } catch {
    await setStatus(orca, 'DSH', 'neutral', 'DSH')
  } finally {
    refreshing = false
  }
}

function command(orca, task) {
  return serial(async () => {
    try {
      return await task()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      orca.log(`dsh-web: ошибка ${message}`)
      await notify(orca, message)
      throw new Error(message)
    }
  })
}

export default async function activate(orca) {
  orca.log(`dsh-web: CLI ${cliCommand()}`)
  await migrateLegacy(orca)
  orca.commands.register('dsh-web.panel', () => command(orca, () => openPanel()))
  orca.commands.register('dsh-web.open', () => command(orca, () => openProfile(orca, 'web')))
  orca.commands.register('dsh-web.openUnity', () => command(orca, () => openProfile(orca, 'unity')))
  orca.commands.register('dsh-web.stop', () => command(orca, () => stopFocused(orca)))
  orca.commands.register('dsh-web.stopAll', () => command(orca, () => stopAll(orca)))
  orca.panels.handle('dsh-web.panel.state', () => panelState(orca))
  orca.panels.handle('dsh-web.panel', () => command(orca, () => openPanel()))
  orca.panels.handle('dsh-web.openProfile', (input) => {
    const profile = input && typeof input === 'object' && typeof input.profile === 'string' ? input.profile : ''
    return command(orca, () => openProfile(orca, profile))
  })
  orca.panels.handle('dsh-web.stopProfile', (input) => {
    const profile = input && typeof input === 'object' && typeof input.profile === 'string' ? input.profile : ''
    return command(orca, () => stopProfile(orca, profile))
  })
  orca.panels.handle('dsh-web.open', () => command(orca, () => openProfile(orca, 'web')))
  orca.panels.handle('dsh-web.openUnity', () => command(orca, () => openProfile(orca, 'unity')))
  orca.panels.handle('dsh-web.stop', () => command(orca, () => stopFocused(orca)))
  orca.panels.handle('dsh-web.stopAll', () => command(orca, () => stopAll(orca)))
  orca.events.on('workspace.changed', () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      void refreshStatus(orca)
    }, 250)
  })
  statusTimer = setInterval(() => {
    void refreshStatus(orca)
  }, POLL_MS)
  statusTimer.unref?.()
  await refreshStatus(orca)
}

export function deactivate() {
  clearTimeout(refreshTimer)
  refreshTimer = null
  if (statusTimer) {
    clearInterval(statusTimer)
    statusTimer = null
  }
  idle = new Map()
}
