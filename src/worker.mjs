import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SESSION = 'orca-dsh-web'
const STORE_KEY = 'server'
const LEGACY_SERVERS_KEY = 'servers'
const DEFAULT_COMMAND = 'dsh web --no-open --port 3080'
const LOG_DIR = path.join(os.homedir(), '.cache', 'orca-dsh-web')
const LOG_PATH = path.join(LOG_DIR, 'dsh-web.log')
const URL_RE = /dsh web:\s+(https?:\/\/\S+)/
const FATAL_RE = /(?:dsh: (?:command )?not found|command not found|EADDRINUSE|address already in use|Cannot find module|ERR_MODULE_NOT_FOUND)/i

let queue = Promise.resolve()
let refreshTimer = null
let statusTimer = null

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

async function tmuxSessionExists() {
  try {
    await tmux(['has-session', '-t', SESSION])
    return true
  } catch {
    return false
  }
}

async function tmuxKill() {
  try {
    await tmux(['kill-session', '-t', SESSION])
  } catch {}
}

async function readLog() {
  try {
    return await fs.readFile(LOG_PATH, 'utf8')
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
  if (!server?.url) return false
  if (!(await tmuxSessionExists())) return false
  return isAlive(server.url)
}

async function focusedWorkspace(orca) {
  const context = await orca.host.call('workspace.readContext')
  if (!context) return null
  const result = await orca.host.call('workspace.list')
  return pickWorkspace(context, result?.workspaces ?? [])
}

async function readServer(orca) {
  const server = await orca.storage.get(STORE_KEY)
  if (server && typeof server === 'object' && !Array.isArray(server) && !server.terminalId) {
    return server
  }
  return null
}

async function writeServer(orca, server) {
  await orca.storage.set(STORE_KEY, server)
}

async function clearServer(orca) {
  try {
    await orca.storage.delete(STORE_KEY)
  } catch {}
}

async function closeLegacyTerminal(terminalId) {
  if (!terminalId) return
  try {
    await execFileAsync(
      cliCommand(),
      ['terminal', 'close', '--terminal', terminalId, '--tab', '--json'],
      { timeout: 10000 },
    )
  } catch {}
}

async function cleanupLegacy(orca) {
  const legacy = await orca.storage.get(STORE_KEY)
  if (legacy?.terminalId) {
    await closeLegacyTerminal(legacy.terminalId)
    await clearServer(orca)
  }
  const servers = await orca.storage.get(LEGACY_SERVERS_KEY)
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    for (const server of Object.values(servers)) {
      if (server?.terminalId) await closeLegacyTerminal(server.terminalId)
    }
    try {
      await orca.storage.delete(LEGACY_SERVERS_KEY)
    } catch {}
  }
}

async function setStatus(orca, tone, tooltip) {
  try {
    await orca.host.call('statusBar.update', {
      id: 'dsh-web',
      text: 'DSH Web',
      tone,
      tooltip,
    })
  } catch {}
}

async function refreshStatus(orca) {
  try {
    const workspace = await focusedWorkspace(orca)
    if (!workspace) {
      await setStatus(orca, 'neutral', 'DSH Web: нет активного проекта')
      return
    }
    if (isRemoteWorkspace(workspace)) {
      await setStatus(orca, 'neutral', 'DSH Web: tmux только на локальном хосте')
      return
    }
    const server = await readServer(orca)
    const running = server ? await serverAlive(server) : false
    await setStatus(
      orca,
      running ? 'success' : 'neutral',
      `DSH Web: ${running ? 'запущен' : 'остановлен'} (${workspace.name})`,
    )
  } catch {
    await setStatus(orca, 'neutral', 'DSH Web')
  }
}

async function waitForUrl() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const lines = stripAnsi(await readLog()).split(/\r?\n/)
    const url = parseDshUrl(lines)
    if (url) return url
    const fatal = lines.find((line) => FATAL_RE.test(line))
    if (fatal) throw fatalError(`DSH Web не запустился: ${fatal.trim()}`)
    if (!(await tmuxSessionExists())) {
      const tail = lines.filter(Boolean).slice(-3).join(' | ')
      throw fatalError(`DSH Web завершился: ${tail || `смотри tmux attach -t ${SESSION}`}`)
    }
    await sleep(500)
  }
  throw new Error(`DSH Web не напечатал URL за 120 секунд; tmux attach -t ${SESSION}`)
}

async function startServer(orca, workspace) {
  if (!(await tmuxAvailable())) throw new Error('tmux не найден; установи tmux')
  await tmuxKill()
  await fs.mkdir(LOG_DIR, { recursive: true })
  await fs.writeFile(LOG_PATH, '')
  const command = (await orca.settings.get('command')) || DEFAULT_COMMAND
  const shellCommand = `${command} 2>&1 | tee -a ${shellQuote(LOG_PATH)}`
  await tmux(['new-session', '-d', '-s', SESSION, '-c', workspace.path, shellCommand])
  let url
  try {
    url = await waitForUrl()
  } catch (error) {
    if (error.fatal) await tmuxKill()
    throw error
  }
  const server = {
    session: SESSION,
    url,
    workspaceId: workspace.id,
    hostId: workspace.hostId ?? null,
    command,
    logPath: LOG_PATH,
  }
  await writeServer(orca, server)
  return server
}

async function ensureServer(orca, workspace) {
  if (isRemoteWorkspace(workspace)) {
    throw new Error('DSH Web через tmux работает только на локальном хосте')
  }
  const saved = await readServer(orca)
  if (saved) {
    const current = parseDshUrl(stripAnsi(await readLog()).split(/\r?\n/))
    if (current && current !== saved.url && (await tmuxSessionExists()) && (await isAlive(current))) {
      const next = { ...saved, url: current }
      await writeServer(orca, next)
      return next
    }
    if (await serverAlive(saved)) return saved
  }
  await clearServer(orca)
  return startServer(orca, workspace)
}

async function openTab(url, workspace) {
  const base = ['tab', 'create', '--url', url, '--json']
  try {
    await execFileAsync(cliCommand(), [...base, '--worktree', worktreeSelector(workspace)], {
      timeout: 20000,
    })
    return
  } catch {}
  await execFileAsync(cliCommand(), [...base, '--worktree', 'active'], { timeout: 20000 })
}

async function notify(orca, body) {
  try {
    await orca.host.call('notifications.show', { title: 'DSH Web', body })
  } catch {}
}

async function openInternal(orca) {
  const workspace = await focusedWorkspace(orca)
  if (!workspace) throw new Error('Нет активного проекта Orca')
  orca.log(`dsh-web: проект ${workspace.name}`)
  const server = await ensureServer(orca, workspace)
  orca.log(`dsh-web: сервер ${new URL(server.url).origin}`)
  await openTab(server.url, workspace)
  await setStatus(orca, 'success', `DSH Web: запущен (${workspace.name})`)
  return `DSH Web открыт: ${new URL(server.url).origin}`
}

async function stopInternal(orca) {
  await tmuxKill()
  await clearServer(orca)
  const workspace = await focusedWorkspace(orca).catch(() => null)
  await setStatus(
    orca,
    'neutral',
    workspace ? `DSH Web: остановлен (${workspace.name})` : 'DSH Web: остановлен',
  )
  return 'DSH Web остановлен'
}

async function restartInternal(orca) {
  await stopInternal(orca)
  return openInternal(orca)
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
  await cleanupLegacy(orca)
  orca.commands.register('dsh-web.open', () => command(orca, () => openInternal(orca)))
  orca.commands.register('dsh-web.stop', () => command(orca, () => stopInternal(orca)))
  orca.commands.register('dsh-web.restart', () => command(orca, () => restartInternal(orca)))
  orca.panels.handle('dsh-web.open', () => command(orca, () => openInternal(orca)))
  orca.panels.handle('dsh-web.stop', () => command(orca, () => stopInternal(orca)))
  orca.panels.handle('dsh-web.restart', () => command(orca, () => restartInternal(orca)))
  orca.events.on('workspace.changed', () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      void refreshStatus(orca)
    }, 250)
  })
  statusTimer = setInterval(() => {
    void refreshStatus(orca)
  }, 30000)
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
}
