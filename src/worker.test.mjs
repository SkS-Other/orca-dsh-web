import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, test } from 'orca/testing'
import {
  discoverProfiles,
  idleDecision,
  isRemoteWorkspace,
  logFileFor,
  originOf,
  parseDshUrl,
  pickWorkspace,
  serverKey,
  sessionFor,
  tabsWithOrigin,
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
  assert.equal(isRemoteWorkspace({ hostId: 'local' }), false)
  assert.equal(isRemoteWorkspace({}), false)
  assert.equal(isRemoteWorkspace({ hostId: 'Dev/Win' }), true)
})

test('строит селектор workspace для CLI', () => {
  assert.equal(worktreeSelector({ id: 'identity:wt2:local:abc' }), 'identity:wt2:local:abc')
  assert.equal(worktreeSelector({ id: 'repo-id::/home/me/project' }), 'id:repo-id::/home/me/project')
})

test('ключ, сессия и лог уникальны для проекта и профиля', () => {
  assert.equal(serverKey('w1', 'web'), 'w1|web')
  assert.equal(serverKey('w1', 'unity'), 'w1|unity')
  const web = sessionFor('w1', 'web')
  const unity = sessionFor('w1', 'unity')
  const other = sessionFor('w2', 'web')
  assert.match(web, /^orca-dsh-web-[0-9a-f]{8}$/)
  assert.notEqual(web, unity)
  assert.notEqual(web, other)
  assert.equal(web, sessionFor('w1', 'web'))
  assert.notEqual(logFileFor('w1', 'web'), logFileFor('w1', 'unity'))
  assert.match(logFileFor('w1', 'web'), /dsh-web-[0-9a-f]{8}\.log$/)
})

test('сравнивает вкладки по origin, а не по токену', () => {
  const tabs = [
    { url: 'http://127.0.0.1:3080/?token=a' },
    { url: 'http://127.0.0.1:3081/?token=b' },
    { url: 'about:blank' },
  ]
  const origin = originOf('http://127.0.0.1:3080/?token=old')
  assert.equal(tabsWithOrigin(tabs, origin).length, 1)
  assert.equal(tabsWithOrigin(tabs, originOf('http://127.0.0.1:9999/')).length, 0)
  assert.equal(tabsWithOrigin(tabs, null).length, 0)
})

test('останавливает только после закрытия вкладок и не раньше грейса', () => {
  assert.deepEqual(idleDecision({ armed: false, misses: 0 }, false, 2), { armed: false, misses: 0, stop: false })
  assert.deepEqual(idleDecision({ armed: false, misses: 0 }, true, 2), { armed: true, misses: 0, stop: false })
  assert.deepEqual(idleDecision({ armed: true, misses: 0 }, false, 2), { armed: true, misses: 1, stop: false })
  assert.deepEqual(idleDecision({ armed: true, misses: 1 }, false, 2), { armed: true, misses: 2, stop: true })
  assert.deepEqual(idleDecision({ armed: true, misses: 2 }, true, 2), { armed: true, misses: 0, stop: false })
  assert.deepEqual(idleDecision({ armed: true, misses: 0 }, false, 0), { armed: true, misses: 1, stop: false })
})

test('находит профили DSH по package.json и пропускает мусор', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-profiles-'))
  try {
    for (const name of ['web', 'reverse']) {
      const dir = path.join(root, 'profiles', name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), '{}')
    }
    await mkdir(path.join(root, 'profiles', 'empty'), { recursive: true })
    await mkdir(path.join(root, 'profiles', 'bad name'), { recursive: true })
    await writeFile(path.join(root, 'profiles', 'bad name', 'package.json'), '{}')
    assert.deepEqual(await discoverProfiles(root), ['reverse', 'web'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
