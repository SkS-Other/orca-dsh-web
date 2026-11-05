import { assert, test } from 'orca/testing'
import {
  hostKeyOf,
  isRemoteWorkspace,
  parseDshUrl,
  pickWorkspace,
  worktreeSelector,
} from './worker.mjs'

test('находит URL в выводе DSH', () => {
  assert.equal(
    parseDshUrl([
      'dsh: warning: 1 entry did not activate',
      'dsh web: http://127.0.0.1:3080/?token=abc',
    ]),
    'http://127.0.0.1:3080/?token=abc',
  )
  assert.equal(parseDshUrl(['dsh: warning: 1 entry did not activate', 'готово']), null)
  assert.equal(
    parseDshUrl([
      'dsh web: http://127.0.0.1:1/?token=old',
      'dsh web: http://127.0.0.1:2/?token=new',
    ]),
    'http://127.0.0.1:2/?token=new',
  )
})

test('выбирает проект по имени и ветке', () => {
  const context = { displayName: 'Проект', branch: 'main' }
  const workspaces = [
    { id: 'repo::/other', name: 'Проект', branch: 'dev' },
    { id: 'repo::/wanted', name: 'Проект', branch: 'main' },
  ]
  assert.equal(pickWorkspace(context, workspaces)?.id, 'repo::/wanted')
  assert.equal(pickWorkspace({ displayName: 'Нет', branch: '' }, workspaces), null)
  assert.equal(
    pickWorkspace({ displayName: 'Папка', branch: '' }, [
      { id: 'repo::/folder', name: 'Папка', branch: null },
    ])?.id,
    'repo::/folder',
  )
})

test('различает локальный и удалённый хост', () => {
  assert.equal(hostKeyOf({ hostId: 'local' }), 'local')
  assert.equal(hostKeyOf({}), 'local')
  assert.equal(hostKeyOf({ hostId: 'Dev/Win' }), 'Dev/Win')
  assert.equal(isRemoteWorkspace({ hostId: 'local' }), false)
  assert.equal(isRemoteWorkspace({}), false)
  assert.equal(isRemoteWorkspace({ hostId: 'Dev/Win' }), true)
})

test('строит селектор workspace для CLI', () => {
  assert.equal(worktreeSelector({ id: 'identity:wt2:local:abc' }), 'identity:wt2:local:abc')
  assert.equal(worktreeSelector({ id: 'repo-id::/home/me/project' }), 'id:repo-id::/home/me/project')
})
