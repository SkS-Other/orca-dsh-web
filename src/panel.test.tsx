import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

test('показывает профили и вызывает действия', async () => {
  const calls: string[] = []
  const running: Record<string, boolean> = { web: false, reverse: true }
  const host = mockHost({
    requests: {
      'dsh-web.panel.state': () => ({
        workspace: 'Проект',
        host: 'local',
        profiles: [
          { name: 'web', running: running.web, origin: null },
          { name: 'reverse', running: running.reverse, origin: 'http://127.0.0.1:1234' },
        ],
      }),
      'dsh-web.openProfile': ({ profile }) => {
        calls.push(`open:${profile}`)
        running[profile] = true
        return 'ok'
      },
      'dsh-web.stopProfile': ({ profile }) => {
        calls.push(`stop:${profile}`)
        running[profile] = false
        return 'ok'
      },
      'dsh-web.stopAll': () => {
        calls.push('stop:all')
        for (const key of Object.keys(running)) running[key] = false
        return 'ok'
      },
    },
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'web' }))
  assert.ok(view.find({ text: 'reverse' }))
  assert.ok(view.find({ text: 'http://127.0.0.1:1234' }))

  await view.press({ text: 'Открыть' })
  await view.press({ label: 'Остановить reverse' })
  await view.press({ text: 'Остановить все' })
  assert.deepEqual(calls, ['open:web', 'stop:reverse', 'stop:all'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
