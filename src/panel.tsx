import './protocol'
import {
  atom,
  Badge,
  Button,
  Heading,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  type PanelContext,
} from 'orca'

type PanelState = {
  workspace: string | null
  host: string | null
  running: boolean
  origin: string | null
}

const state = atom<PanelState | null>(null)
const busy = atom<string | null>(null)
const error = atom<string | null>(null)

async function refresh(): Promise<void> {
  set(state, (await plugin.request('dsh-web.panel.state')) as PanelState)
}

async function run(action: string, timeoutMs = 30000): Promise<void> {
  set(busy, action)
  set(error, null)
  try {
    await plugin.request(action, undefined, { timeoutMs })
    await refresh()
  } catch (failure) {
    set(error, failure instanceof Error ? failure.message : String(failure))
  } finally {
    set(busy, null)
  }
}

export function setup(ctx: PanelContext): void {
  void refresh().catch(() => undefined)
}

export default function Panel() {
  const current = read(state)
  const pending = read(busy)
  const failure = read(error)
  const workspace = current?.workspace ?? null
  const disabled = !workspace || pending !== null
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>DSH Web</Heading>
        <Badge tone={current?.running ? 'success' : 'neutral'}>
          {current?.running ? 'запущен' : 'остановлен'}
        </Badge>
      </Row>
      {workspace ? (
        <Text muted size="xs">
          {workspace}
          {current?.host && current.host !== 'local' ? ` · ${current.host}` : ''}
        </Text>
      ) : (
        <Text muted>Нет активного проекта Orca</Text>
      )}
      {current?.origin ? <Text size="xs">{current.origin}</Text> : null}
      {failure ? <Text tone="danger">{failure}</Text> : null}
      <Button
        variant="solid"
        tone="accent"
        icon="globe"
        onPress={() => void run('dsh-web.open', 120000)}
        disabled={disabled}
      >
        Открыть вкладку
      </Button>
      <Button
        variant="outline"
        icon="refresh"
        onPress={() => void run('dsh-web.restart', 120000)}
        disabled={disabled}
      >
        Перезапустить
      </Button>
      <Button
        variant="ghost"
        tone="danger"
        icon="stop"
        onPress={() => void run('dsh-web.stop')}
        disabled={disabled}
      >
        Остановить
      </Button>
      <Button
        variant="ghost"
        icon="terminal"
        onPress={() => void run('dsh-web.terminal', 10000)}
        disabled={disabled || !current?.running}
      >
        Показать терминал
      </Button>
      <Text muted size="xs">
        {pending ? 'Выполняю…' : 'Сервер живёт в терминале Orca.'}
      </Text>
    </Stack>
  )
}
