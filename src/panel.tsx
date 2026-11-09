import './protocol'
import {
  atom,
  Badge,
  Button,
  EmptyState,
  Heading,
  IconButton,
  plugin,
  read,
  Row,
  Separator,
  set,
  Stack,
  Text,
  type PanelContext,
} from 'orca'

type ProfileState = { name: string; running: boolean; origin: string | null }
type PanelState = { workspace: string | null; host: string | null; profiles: ProfileState[] }

const state = atom<PanelState | null>(null)
const busy = atom<string | null>(null)
const error = atom<string | null>(null)

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

async function refresh(): Promise<void> {
  try {
    set(state, (await plugin.request('dsh-web.panel.state')) as PanelState)
    set(error, null)
  } catch (failure) {
    set(error, failureMessage(failure))
  }
}

async function openProfile(profile: string): Promise<void> {
  set(busy, `open:${profile}`)
  set(error, null)
  try {
    await plugin.request('dsh-web.openProfile', { profile }, { timeoutMs: 120000 })
    await refresh()
  } catch (failure) {
    set(error, failureMessage(failure))
  } finally {
    set(busy, null)
  }
}

async function stopProfile(profile: string): Promise<void> {
  set(busy, `stop:${profile}`)
  set(error, null)
  try {
    await plugin.request('dsh-web.stopProfile', { profile }, { timeoutMs: 30000 })
    await refresh()
  } catch (failure) {
    set(error, failureMessage(failure))
  } finally {
    set(busy, null)
  }
}

async function stopAll(): Promise<void> {
  set(busy, 'stop-all')
  set(error, null)
  try {
    await plugin.request('dsh-web.stopAll', undefined, { timeoutMs: 30000 })
    await refresh()
  } catch (failure) {
    set(error, failureMessage(failure))
  } finally {
    set(busy, null)
  }
}

export function setup(_ctx: PanelContext): () => void {
  void refresh()
  const timer = setInterval(() => void refresh(), 15000)
  return () => clearInterval(timer)
}

export default function Panel() {
  const current = read(state)
  const pending = read(busy)
  const failure = read(error)
  const workspace = current?.workspace ?? null
  const profiles = current?.profiles ?? []
  const running = profiles.filter((profile) => profile.running)
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>DSH</Heading>
        <IconButton
          icon="refresh"
          label="Обновить"
          variant="ghost"
          size="sm"
          onPress={() => void refresh()}
          disabled={pending !== null}
        />
      </Row>
      {workspace ? (
        <Text muted size="xs">
          {workspace}
          {current?.host && current.host !== 'local' ? ` · ${current.host}` : ''}
        </Text>
      ) : (
        <Text muted size="xs">
          Нет активного проекта Orca
        </Text>
      )}
      {failure ? (
        <Text tone="danger" size="sm">
          {failure}
        </Text>
      ) : null}
      {!current ? (
        <Text muted size="sm">
          Загружаю профили…
        </Text>
      ) : null}
      {current && profiles.length === 0 ? (
        <EmptyState
          icon="package"
          title="Профили не найдены"
          description="Добавь каталог с package.json в $DSH_HOME/profiles."
        />
      ) : null}
      {profiles.length > 0 ? (
        <Stack gap="sm">
          {profiles.map((profile, index) => {
            const opening = pending === `open:${profile.name}`
            const stopping = pending === `stop:${profile.name}`
            return (
              <Stack key={profile.name} gap="sm">
                {index > 0 ? <Separator /> : null}
                <Row justify="between" align="center" gap="sm">
                  <Stack gap="none" align="start">
                    <Row gap="xs" align="center">
                      <Text weight="semibold">{profile.name}</Text>
                      <Badge tone={profile.running ? 'success' : 'neutral'}>
                        {profile.running ? 'запущен' : 'остановлен'}
                      </Badge>
                    </Row>
                    {profile.origin ? (
                      <Text muted size="xs" truncate>
                        {profile.origin}
                      </Text>
                    ) : null}
                  </Stack>
                  <Row gap="xs" align="center">
                    <Button
                      size="sm"
                      variant={profile.running ? 'outline' : 'solid'}
                      tone="accent"
                      icon="globe"
                      tooltip={`Открыть ${profile.name}`}
                      onPress={() => void openProfile(profile.name)}
                      disabled={!workspace || pending !== null}
                    >
                      {opening ? 'Открываю…' : 'Открыть'}
                    </Button>
                    {profile.running ? (
                      <IconButton
                        icon="stop"
                        label={stopping ? `Останавливаю ${profile.name}` : `Остановить ${profile.name}`}
                        variant="ghost"
                        tone="danger"
                        size="sm"
                        onPress={() => void stopProfile(profile.name)}
                        disabled={!workspace || pending !== null}
                      />
                    ) : null}
                  </Row>
                </Row>
              </Stack>
            )
          })}
        </Stack>
      ) : null}
      {running.length > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          icon="stop"
          onPress={() => void stopAll()}
          disabled={pending !== null}
        >
          {pending === 'stop-all' ? 'Останавливаю…' : 'Остановить все'}
        </Button>
      ) : null}
    </Stack>
  )
}
