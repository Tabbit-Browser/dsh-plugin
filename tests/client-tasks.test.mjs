// TabbitClient 对两代 CLI 差异的适配测试（tests 里首次直接驱动 TabbitClient）：
// 用一个假 launcher（node 脚本）顶替 tabbit-cli，按环境变量扮演新代
// （1.13.20+：`tasks` 子命令已删、`diagnose` 带任务列表、--timeout-ms 下限
// 60 秒、finish 不接受 --keep）或旧代（有 `tasks`、`diagnose` 只回计数、
// --timeout-ms 上限 120 秒、finish 必须显式 --keep 才保留标签页），
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
const statePath = process.env.FAKE_LAUNCHER_LOG + '.state.json';
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state));
switch (argv[0]) {
  case 'diagnose':
    if (generation === 'old') console.log(JSON.stringify({ ok: true, controller: 'running', taskCount: Number(state.taskOpen) }));
    else console.log(JSON.stringify({ ok: true, controller: 'running', taskCount: Number(state.taskOpen), tasks: state.taskOpen ? [{ ...TASK, ownedPageCount: 0 }] : [] }));
    break;
  case 'tasks':
    if (generation === 'old') console.log(JSON.stringify(state.taskOpen ? [TASK] : []));
    else fail('Usage: tabbit-cli finish --task <name> [--discard] | tabs --task <name> ...');
    break;
  case 'finish': {
    const error = state.finishErrors.shift();
    saveState();
    if (error) fail(error.message, error.code);
    // 新代在调用 runtime 前校验参数；拒绝 --keep 时任务和标签页都没动。
    if (generation === 'new' && argv.includes('--keep')) {
      fail('Usage: tabbit-cli finish --task <name> [--discard] | tabs --task <name> ...', 'REQUEST_FAILED');
    }
    const keep = generation === 'old' ? argv.includes('--keep') : !argv.includes('--discard');
    const closedTabIds = keep ? [] : state.tabIds;
    state.taskOpen = false;
    if (!keep) state.tabIds = [];
    saveState();
    console.log(JSON.stringify({ finished: true, keep, closedTabIds, taskId: TASK.taskId }));
    break;
  }
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
async function fakeHome(finishErrors) {
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
  const statePath = log + '.state.json'
  await writeFile(statePath, JSON.stringify({ taskOpen: true, tabIds: [101, 102], finishErrors }))
  return {
    home,
    launcher,
    log,
    state: async () => JSON.parse(await readFile(statePath, 'utf8')),
    calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  }
}

async function withFakeLauncher(generation, run, finishErrors = []) {
  const fixture = await fakeHome(finishErrors)
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

test('finishTask retries without --keep on 1.13.20+ and closes the task while retaining its tabs (#24)', async () => {
  await withFakeLauncher('new', async (client, fixture) => {
    await client.finishTask('alpha', { keep: true })
    assert.deepEqual(await fixture.calls(), [
      ['finish', '--task', 'alpha', '--keep'],
      ['finish', '--task', 'alpha'],
    ])
    assert.equal((await fixture.state()).taskOpen, false)
    assert.deepEqual((await fixture.state()).tabIds, [101, 102])
    assert.deepEqual(await client.listTasks(), [])
  })
})

// 中间代默认保留且仍接受 --keep；旧代默认关闭，必须保留显式 flag。
for (const generation of ['old', 'transitional']) {
  test(`finishTask keeps tabs on ${generation} CLI with one explicit --keep call`, async () => {
    await withFakeLauncher(generation, async (client, fixture) => {
      await client.finishTask('alpha', { keep: true })
      assert.deepEqual(await fixture.calls(), [['finish', '--task', 'alpha', '--keep']])
      assert.equal((await fixture.state()).taskOpen, false)
      assert.deepEqual((await fixture.state()).tabIds, [101, 102])
      assert.deepEqual(await client.listTasks(), [])
    })
  })
}

for (const generation of ['old', 'transitional', 'new']) {
  for (const options of [{}, { keep: false }]) {
    test(`finishTask discards tabs on ${generation} CLI with ${JSON.stringify(options)}`, async () => {
      await withFakeLauncher(generation, async (client, fixture) => {
        await client.finishTask('alpha', options)
        assert.deepEqual(await fixture.calls(), [['finish', '--task', 'alpha', '--discard']])
        assert.equal((await fixture.state()).taskOpen, false)
        assert.deepEqual((await fixture.state()).tabIds, [])
      })
    })
  }
}

const FINISH_USAGE = 'Usage: tabbit-cli finish --task <name> [--discard] | tabs --task <name> ...'

// 只有新版 finish 的参数拒绝才允许重试：泛化为任意 REQUEST_FAILED / Usage
// 会掩盖真实故障，甚至在旧代上误用默认关闭的裸 finish。
for (const error of [
  { code: 'REQUEST_FAILED', message: 'finish failed after dispatch' },
  { code: 'TASK_TIMEOUT', message: FINISH_USAGE },
  { code: 'REQUEST_FAILED', message: 'Usage: tabbit-cli finish --task <name> [--keep]' },
  { code: 'REQUEST_FAILED', message: 'Usage: tabbit-cli nodejs --task <name>' },
]) {
  test(`finishTask does not retry unrelated errors: ${error.code} / ${error.message}`, async () => {
    await withFakeLauncher('old', async (client, fixture) => {
      await assert.rejects(client.finishTask('alpha', { keep: true }), { code: error.code, message: error.message })
      assert.deepEqual(await fixture.calls(), [['finish', '--task', 'alpha', '--keep']])
      assert.equal((await fixture.state()).taskOpen, true)
      assert.deepEqual((await fixture.state()).tabIds, [101, 102])
    }, [error])
  })
}

test('finishTask never retries a rejected --discard as a bare finish', async () => {
  await withFakeLauncher('new', async (client, fixture) => {
    await assert.rejects(client.finishTask('alpha'), { code: 'REQUEST_FAILED', message: FINISH_USAGE })
    assert.deepEqual(await fixture.calls(), [['finish', '--task', 'alpha', '--discard']])
    assert.equal((await fixture.state()).taskOpen, true)
  }, [{ code: 'REQUEST_FAILED', message: FINISH_USAGE }])
})

test('finishTask propagates a failed fallback and attempts it only once', async () => {
  await withFakeLauncher('new', async (client, fixture) => {
    await assert.rejects(client.finishTask('alpha', { keep: true }), { code: 'REQUEST_FAILED', message: FINISH_USAGE })
    assert.deepEqual(await fixture.calls(), [
      ['finish', '--task', 'alpha', '--keep'],
      ['finish', '--task', 'alpha'],
    ])
    assert.equal((await fixture.state()).taskOpen, true)
    assert.deepEqual((await fixture.state()).tabIds, [101, 102])
  }, [null, { code: 'REQUEST_FAILED', message: FINISH_USAGE }])
})

// 重试也要经过已有的幂等清理规则：任务消失、浏览器退出或 runtime 重置
// 都表示已无任务可清理；两次调用的位置都覆盖，防止嵌套 catch 漏接。
for (const error of [
  { code: 'REQUEST_FAILED', message: 'Unknown task name: alpha' },
  { code: 'BROWSER_RUNTIME_UNAVAILABLE', message: 'browser offline' },
  { code: 'TASK_WORKER_LOST', message: 'worker lost' },
]) {
  for (const fallback of [false, true]) {
    test(`finishTask tolerates ${error.code} / ${error.message} on ${fallback ? 'fallback' : 'initial call'}`, async () => {
      await withFakeLauncher('new', async (client, fixture) => {
        await client.finishTask('alpha', { keep: true })
        const calls = [['finish', '--task', 'alpha', '--keep']]
        if (fallback) calls.push(['finish', '--task', 'alpha'])
        assert.deepEqual(await fixture.calls(), calls)
      }, fallback ? [null, error] : [error])
    })
  }
}
