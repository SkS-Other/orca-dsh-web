import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

test('показывает состояние и вызывает действия', async () => {
  const calls: string[] = []
  const host = mockHost({
    requests: {
      'dsh-web.panel.state': () => ({
        workspace: 'Проект',
        host: 'local',
        running: false,
        origin: null,
      }),
      'dsh-web.open': () => {
        calls.push('open')
        return 'ok'
      },
      'dsh-web.stop': () => {
        calls.push('stop')
        return 'ok'
      },
      'dsh-web.restart': () => {
        calls.push('restart')
        return 'ok'
      },
    },
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'Проект' })?.text, 'Проект')
  assert.equal(view.find({ text: 'остановлен' })?.text, 'остановлен')
  await view.press({ text: 'Открыть вкладку' })
  await view.press({ text: 'Остановить' })
  await view.press({ text: 'Перезапустить' })
  assert.deepEqual(calls, ['open', 'stop', 'restart'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
