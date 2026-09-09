// TabbitClient 对两代 CLI 差异的适配测试（tests 里首次直接驱动 TabbitClient）：
// 用一个假 launcher（node 脚本）顶替 tabbit-cli，按环境变量扮演新代
// （1.13.20+：`tasks` 子命令已删、`diagnose` 带任务列表、--timeout-ms 下限
// 60 秒）或旧代（有 `tasks`、`diagnose` 只回计数、--timeout-ms 上限 120 秒），
// 并把每次收到的 argv 记进日志供断言。注册表放在临时 HOME 下，只登记这一个
// 实例，cliPath 指向假 launcher 本身。
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TabbitClient } from '../lib/runtime/client.js'

const FAKE_LAUNCHER = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.readFileSync(0);
fs.appendFileSync(process.env.FAKE_LAUNCHER_LOG, JSON.stringify(argv) + '\\n');
const generation = process.env.FAKE_LAUNCHER_GENERATION;
const fail = (message, code) => {
  process.stderr.write(JSON.stringify({ ok: false, error: { name: 'Error', ...(code ? { code } : {}), message } }) + '\\n');
  process.exit(70);
};
const TASK = { taskId: 'task-1', taskName: 'alpha', quarantined: false, idle: true, activeRequestId: null, queuedCount: 0, receiptCount: 1 };
switch (argv[0]) {
  case 'diagnose':
    if (generation === 'old') console.log(JSON.stringify({ ok: true, controller: 'running', taskCount: 1 }));
    else console.log(JSON.stringify({ ok: true, controller: 'running', taskCount: 1, tasks: [{ ...TASK, ownedPageCount: 0 }] }));
    break;
  case 'tasks':
    if (generation === 'old') console.log(JSON.stringify([TASK]));
    else fail('Usage: tabbit-cli finish --task <name> [--discard] | tabs --task <name> ...');
    break;
  case 'nodejs': {
    const timeoutMs = Number(argv[argv.indexOf('--timeout-ms') + 1]);
    if (generation === 'old' && (timeoutMs <= 0 || timeoutMs > 120000)) fail('timeoutMs must be positive and at most 120000');
    if (generation !== 'old' && (timeoutMs < 60000 || timeoutMs > 180000)) fail('--timeout-ms must be from 60000 through 180000');
    console.log(JSON.stringify({ status: 'succeeded', result: { value: 42 }, task: { taskId: 'task-2', taskName: argv[2], reused: false } }));
    break;
  }
  default:
    fail('Usage: ...');
}
`

/* 临时 HOME：假 launcher + 只登记它一个实例的注册表 + argv 日志。 */
async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tabbit-client-'))
  const launcher = join(home, 'tabbit-cli')
  await writeFile(launcher, FAKE_LAUNCHER)
  await chmod(launcher, 0o755)
  const registry = join(home, '.local', 'share', 'tabbit-playwright', 'instances')
  await mkdir(registry, { recursive: true })
  await writeFile(
    join(registry, 'AAAA0000BBBB1111.instance'),
    `# tabbit-playwright instance managed by Tabbit Browser\n${launcher}\n${join(home, 'endpoint.json')}\n`,
  )
  const log = join(home, 'argv.log')
  await writeFile(log, '')
  return {
    home,
    launcher,
    log,
    calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  }
}

async function withFakeLauncher(generation, run) {
  const fixture = await fakeHome()
  const saved = { HOME: process.env.HOME, LOG: process.env.FAKE_LAUNCHER_LOG, GENERATION: process.env.FAKE_LAUNCHER_GENERATION }
  process.env.HOME = fixture.home
  process.env.FAKE_LAUNCHER_LOG = fixture.log
  process.env.FAKE_LAUNCHER_GENERATION = generation
  try {
    await run(new TabbitClient({ launcherPath: fixture.launcher }), fixture)
  } finally {
    for (const [key, value] of [['HOME', saved.HOME], ['FAKE_LAUNCHER_LOG', saved.LOG], ['FAKE_LAUNCHER_GENERATION', saved.GENERATION]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(fixture.home, { recursive: true, force: true })
  }
}

test('listTasks reads the task list from diagnose on 1.13.20+ (no tasks subcommand)', async () => {
  await withFakeLauncher('new', async (client, fixture) => {
    const tasks = await client.listTasks()
    assert.deepEqual(tasks.map((task) => task.taskName), ['alpha'])
    assert.equal(tasks[0].idle, true)
    // 新代一次 diagnose 就够，绝不再碰已删除的 tasks 子命令。
    assert.deepEqual(await fixture.calls(), [['diagnose']])
  })
})

test('listTasks falls back to the tasks subcommand on browsers whose diagnose has no task list', async () => {
  await withFakeLauncher('old', async (client, fixture) => {
    const tasks = await client.listTasks()
    assert.deepEqual(tasks.map((task) => task.taskName), ['alpha'])
    assert.deepEqual(await fixture.calls(), [['diagnose'], ['tasks']])
  })
})

/* 三种请求超时在 argv 里实际落成的 --timeout-ms：抬到 60 秒、压到 120 秒、缺省 120 秒。 */
async function observedTimeouts(client, fixture) {
  const sent = []
  for (const timeoutMs of [15_000, 500_000, undefined]) {
    const outcome = await client.evaluate({ task: 'probe', code: 'return 42', ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
    assert.equal(outcome.status, 'succeeded')
    assert.equal(outcome.result.value, 42)
  }
  for (const argv of await fixture.calls()) {
    if (argv[0] !== 'nodejs') continue
    sent.push(Number(argv[argv.indexOf('--timeout-ms') + 1]))
  }
  return sent
}

test('evaluate clamps --timeout-ms into [60000, 120000], which 1.13.23+ accepts', async () => {
  await withFakeLauncher('new', async (client, fixture) => {
    assert.deepEqual(await observedTimeouts(client, fixture), [60_000, 120_000, 120_000])
  })
})

test('the same clamped range is still accepted by older browsers', async () => {
  await withFakeLauncher('old', async (client, fixture) => {
    assert.deepEqual(await observedTimeouts(client, fixture), [60_000, 120_000, 120_000])
  })
})
