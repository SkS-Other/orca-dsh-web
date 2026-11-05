import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const STORE_KEY = 'servers'
const LEGACY_KEY = 'server'
const DEFAULT_COMMAND = 'dsh web --no-open --port 3080'
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

export function hostKeyOf(workspace) {
  return workspace?.hostId || 'local'
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

function serial(task) {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function isAlive(url) {
  try {
    await fetch(new URL('/', url), { method: 'HEAD', signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

async function terminalAlive(orca, server) {
  try {
    const { lines } = await orca.host.call('terminal.read', {
      terminalId: server.terminalId,
      maxLines: 200,
    })
    if (lines.length < 2) return true
    const first = lines.find((line) => line.trim())
    const last = [...lines].reverse().find((line) => line.trim())
    if (!first || !last) return true
    const command = server.command || 'dsh web'
    const at = first.indexOf(command)
    const prompt = at > 0 ? first.slice(0, at).trimEnd() : ''
    return !(prompt && last.startsWith(prompt))
  } catch {
    return false
  }
}

async function serverAlive(orca, server) {
  if (!server?.url) return false
  if (!(await terminalAlive(orca, server))) return false
  if (!isRemoteWorkspace(server)) return isAlive(server.url)
  return true
}

async function focusedWorkspace(orca) {
  const context = await orca.host.call('workspace.readContext')
  if (!context) return null
  const result = await orca.host.call('workspace.list')
  return pickWorkspace(context, result?.workspaces ?? [])
}

async function readServers(orca) {
  const stored = await orca.storage.get(STORE_KEY)
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    try {
      if ((await orca.storage.get(LEGACY_KEY)) !== null) await orca.storage.delete(LEGACY_KEY)
    } catch {}
    return stored
  }
  const legacy = await orca.storage.get(LEGACY_KEY)
  if (legacy?.terminalId && legacy?.url) {
    const servers = { [hostKeyOf(legacy)]: legacy }
    await orca.storage.set(STORE_KEY, servers)
    try {
      await orca.storage.delete(LEGACY_KEY)
    } catch {}
    return servers
  }
  return {}
}

async function writeServers(orca, servers) {
  await orca.storage.set(STORE_KEY, servers)
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
    const servers = await readServers(orca)
    const server = servers[hostKeyOf(workspace)]
    const running = server ? await serverAlive(orca, server) : false
    const where = isRemoteWorkspace(workspace) ? ` (${workspace.hostId})` : ''
    await setStatus(
      orca,
      running ? 'success' : 'neutral',
      `DSH Web: ${running ? 'запущен' : 'остановлен'}${where}`,
    )
  } catch {
    await setStatus(orca, 'neutral', 'DSH Web')
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fatalError(message) {
  const error = new Error(message)
  error.fatal = true
  return error
}

async function waitForUrl(orca, terminalId) {
  let readFailures = 0
  for (let attempt = 0; attempt < 240; attempt += 1) {
    let lines = []
    try {
      ;({ lines } = await orca.host.call('terminal.read', { terminalId, maxLines: 400 }))
      readFailures = 0
    } catch {
      readFailures += 1
      if (readFailures >= 20) throw fatalError('Терминал DSH Web закрылся до запуска сервера')
      await sleep(500)
      continue
    }
    const url = parseDshUrl(lines)
    if (url) return url
    const fatal = lines.find((line) => FATAL_RE.test(line))
    if (fatal) throw fatalError(`DSH Web не запустился: ${fatal.trim()}`)
    await sleep(500)
  }
  throw new Error('DSH Web не напечатал URL за 120 секунд; проверь терминал «DSH Web»')
}

async function ensureServer(orca, workspace) {
  const hostKey = hostKeyOf(workspace)
  const servers = await readServers(orca)
  const saved = servers[hostKey]
  if (saved?.terminalId) {
    try {
      const { lines } = await orca.host.call('terminal.read', {
        terminalId: saved.terminalId,
        maxLines: 400,
      })
      const current = parseDshUrl(lines)
      if (current && current !== saved.url) {
        const next = { ...saved, url: current }
        servers[hostKey] = next
        await writeServers(orca, servers)
        return next
      }
    } catch {}
  }
  if (saved && (await serverAlive(orca, saved))) return saved
  if (saved?.terminalId) await closeTerminal(saved.terminalId, saved.hostId)
  delete servers[hostKey]
  await writeServers(orca, servers)

  const command = (await orca.settings.get('command')) || DEFAULT_COMMAND
  const { terminalId } = await orca.host.call('terminal.create', {
    workspaceId: workspace.id,
    title: 'DSH Web',
    command,
  })
  let url
  try {
    url = await waitForUrl(orca, terminalId)
  } catch (error) {
    if (error.fatal) await closeTerminal(terminalId, workspace.hostId)
    throw error
  }
  const server = {
    terminalId,
    url,
    workspaceId: workspace.id,
    hostId: workspace.hostId ?? null,
    command,
  }
  servers[hostKey] = server
  await writeServers(orca, servers)
  return server
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

async function closeTerminal(terminalId, hostId) {
  const base = ['terminal', 'close', '--terminal', terminalId, '--tab', '--json']
  try {
    await execFileAsync(cliCommand(), base, { timeout: 10000 })
    return
  } catch {}
  if (hostId && hostId !== 'local') {
    try {
      await execFileAsync(cliCommand(), [...base, '--environment', hostId], { timeout: 10000 })
    } catch {}
  }
}

async function notify(orca, body) {
  try {
    await orca.host.call('notifications.show', { title: 'DSH Web', body })
  } catch {}
}

async function openInternal(orca) {
  const workspace = await focusedWorkspace(orca)
  if (!workspace) throw new Error('Нет активного проекта Orca')
  const where = isRemoteWorkspace(workspace) ? ` (${workspace.hostId})` : ''
  orca.log(`dsh-web: проект ${workspace.name}${where}`)
  const server = await ensureServer(orca, workspace)
  orca.log(`dsh-web: сервер ${new URL(server.url).origin}`)
  await openTab(server.url, workspace)
  await setStatus(orca, 'success', `DSH Web: запущен (${workspace.name})`)
  return `DSH Web открыт: ${new URL(server.url).origin}`
}

async function stopInternal(orca) {
  const workspace = await focusedWorkspace(orca)
  if (!workspace) throw new Error('Нет активного проекта Orca')
  const hostKey = hostKeyOf(workspace)
  const servers = await readServers(orca)
  const server = servers[hostKey]
  if (!server) {
    await setStatus(orca, 'neutral', `DSH Web: остановлен (${workspace.name})`)
    return 'DSH Web уже остановлен'
  }
  try {
    await orca.host.call('terminal.sendText', {
      terminalId: server.terminalId,
      text: '\u0003',
      enter: false,
    })
  } catch {}
  await sleep(500)
  await closeTerminal(server.terminalId, server.hostId)
  delete servers[hostKey]
  await writeServers(orca, servers)
  await setStatus(orca, 'neutral', `DSH Web: остановлен (${workspace.name})`)
  return 'DSH Web остановлен'
}

async function restartInternal(orca) {
  await stopInternal(orca)
  return openInternal(orca)
}

let cachedPluginKey = null

async function pluginKey() {
  if (cachedPluginKey) return cachedPluginKey
  try {
    const { stdout } = await execFileAsync(cliCommand(), ['plugin', 'list', '--json'], {
      timeout: 10000,
    })
    const plugins = JSON.parse(stdout)?.result?.plugins ?? []
    const match =
      plugins.find((plugin) => plugin.name === 'DSH Web' && plugin.hasWorker) ??
      plugins.find((plugin) => plugin.name === 'DSH Web')
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
  await execFileAsync(cliCommand(), ['plugin', 'open', key, '--panel', 'dsh-web', '--json'], {
    timeout: 10000,
  })
  return 'Панель DSH Web открыта'
}

async function showTerminal(orca) {
  const workspace = await focusedWorkspace(orca)
  if (!workspace) throw new Error('Нет активного проекта Orca')
  const servers = await readServers(orca)
  const server = servers[hostKeyOf(workspace)]
  if (!server?.terminalId) throw new Error('DSH Web не запущен')
  await execFileAsync(
    cliCommand(),
    ['terminal', 'switch', '--terminal', server.terminalId, '--json'],
    { timeout: 10000 },
  )
  return 'Терминал DSH Web открыт'
}

async function panelState(orca) {
  const workspace = await focusedWorkspace(orca)
  if (!workspace) {
    return { workspace: null, host: null, running: false, origin: null }
  }
  const servers = await readServers(orca)
  const server = servers[hostKeyOf(workspace)]
  const running = server ? await serverAlive(orca, server) : false
  return {
    workspace: workspace.name,
    host: workspace.hostId ?? 'local',
    running,
    origin: server?.url ? new URL(server.url).origin : null,
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
  orca.commands.register('dsh-web.panel', () => command(orca, () => openPanel()))
  orca.commands.register('dsh-web.open', () => command(orca, () => openInternal(orca)))
  orca.commands.register('dsh-web.stop', () => command(orca, () => stopInternal(orca)))
  orca.commands.register('dsh-web.restart', () => command(orca, () => restartInternal(orca)))
  orca.panels.handle('dsh-web.panel', () => command(orca, () => openPanel()))
  orca.panels.handle('dsh-web.open', () => command(orca, () => openInternal(orca)))
  orca.panels.handle('dsh-web.stop', () => command(orca, () => stopInternal(orca)))
  orca.panels.handle('dsh-web.restart', () => command(orca, () => restartInternal(orca)))
  orca.panels.handle('dsh-web.terminal', () => command(orca, () => showTerminal(orca)))
  orca.panels.handle('dsh-web.panel.state', () => panelState(orca))
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
