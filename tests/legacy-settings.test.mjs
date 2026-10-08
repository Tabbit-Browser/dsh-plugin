import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrateLegacySettings } from '../lib/core/legacy-settings.js'

test('migrates old tabbit settings once without overwriting new profile values', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tabbit-legacy-'))
  const profile = await mkdtemp(join(tmpdir(), 'tabbit-profile-'))
  await writeFile(join(home, 'settings.yaml.imported'), [
    'tabbit:',
    '  instance: ABCDEF0123456789',
    '  launcherPath: /tmp/tabbit cli',
    '  pageAccess: always',
    '  intranetFetch: never',
    '',
  ].join('\n'))
  const updates = []
  const ctx = {
    get: name => name === 'profileContext' ? { home, dir: profile } : undefined,
    root: { loader: { await: async () => {} } },
    settings: {
      describe: () => [{ ns: 'tabbit-browser', user: { pageAccess: 'never' }, revision: 7 }],
      update: async (...args) => { updates.push(args) },
    },
  }
  await migrateLegacySettings(ctx)
  await migrateLegacySettings(ctx)
  assert.deepEqual(updates, [[
    'tabbit-browser',
    { instance: 'ABCDEF0123456789', launcherPath: '/tmp/tabbit cli', intranetFetch: 'never' },
    7,
  ]])
  assert.equal(await readFile(join(profile, '.dsh-tabbit-settings-migrated'), 'utf8'), 'migrated\n')
})
