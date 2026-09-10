// 直连 Runtime Service 端点客户端（lib/runtime/endpoint.js）与 Windows 实例
// 注册表解析（lib/runtime/instances.js）的单元测试。
//
// 假服务器逐条镜像真服务端（runtime-public-server.mjs）我们依赖的行为：
//   - 首帧必须是【严格恰好三键】的 {version:1,token,generation}；
//   - 认证失败【无响应直接断开】（客户端把它识别为凭据过期）；
//   - 认证成功无回执，后续每帧一响应 {ok,value|error}。
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listAllTabs, pingEndpoint, readEndpoint } from '../lib/runtime/endpoint.js'
import { listInstancesWindows } from '../lib/runtime/instances.js'
import { fakeServiceAddress } from './platform.mjs'

const TOKEN = 'test-token-4Vf8jKxq2ZpN7RmW1cSdYbHgAeLuTiOo0'
const GENERATION = 'ABCDEF0123456789ABCDEF0123456789'

/* 监听地址按平台取（POSIX unix socket / Windows named pipe），见 platform.mjs。 */

/*
 * 起一个假 Runtime Service 公开端点。behavior 决定认证后的响应方式：
 *   respond（默认）—— 对每帧回 {ok:true,value}；
 *   error          —— 回 {ok:false,error:{code:'SERVICE_BUSY'}}；
 *   silent         —— 收帧不回（测客户端超时）。
 * onBadAuth 在认证失败断开【之前】同步调用（测凭据轮换恢复时用它改写 endpoint 文件）。
 * handler(request) 给出时优先：按请求帧内容返回整帧 {ok,value|error}（模拟按 op
 * 分派的服务端，测新代 CLI 回退路径）。
 */
async function startFakeService({ value, behavior = 'respond', token = TOKEN, onBadAuth, handler } = {}) {
  const address = fakeServiceAddress()
  const connections = []
  const server = createServer((socket) => {
    connections.push(socket)
    let buffer = ''
    let authenticated = false
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!authenticated) {
          let auth
          try { auth = JSON.parse(frame) } catch { auth = undefined }
          const ok = auth && typeof auth === 'object' && Object.keys(auth).length === 3 &&
            auth.version === 1 && auth.token === token && auth.generation === GENERATION
          if (!ok) {
            onBadAuth?.()
            socket.destroy()
            return
          }
          authenticated = true
          continue
        }
        if (handler) {
          let request
          try { request = JSON.parse(frame) } catch { request = undefined }
          socket.end(`${JSON.stringify(handler(request))}\n`)
          continue
        }
        if (behavior === 'silent') continue
        if (behavior === 'error') {
          socket.end(`${JSON.stringify({ ok: false, error: { name: 'Error', code: 'SERVICE_BUSY', message: 'Browser Runtime Service is at its task limit' } })}\n`)
          continue
        }
        socket.end(`${JSON.stringify({ ok: true, value })}\n`)
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, resolve)
  })
  return {
    address,
    close: async () => {
      for (const socket of connections) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function endpointJson(address, overrides = {}) {
  return JSON.stringify({
    version: 2,
    kind: 'browser-runtime-service',
    transport: 'unix_socket',
    address,
    token: TOKEN,
    generation: GENERATION,
    browserPid: 4242,
    ...overrides,
  })
}

async function withEndpointFile(content, run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tabbit-endpoint-'))
  const path = join(dir, 'endpoint.json')
  try {
    if (content !== undefined) await writeFile(path, content)
    await run(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const TABS_FIXTURE = {
  truncated: false,
  tabs: [
    { tabId: 11, windowId: 1, index: 0, title: '首页', url: 'https://example.com/', active: true, state: 'available', group: null },
    { tabId: 12, windowId: 1, index: 1, title: '组内页', url: 'https://example.com/b', active: false, state: 'busy', group: { groupId: 'A1B2', title: '调研' } },
  ],
}

test('listAllTabs performs auth + request over one connection and validates the shape', async () => {
  const service = await startFakeService({ value: TABS_FIXTURE })
  try {
    await withEndpointFile(endpointJson(service.address), async (path) => {
      const inventory = await listAllTabs(path)
      assert.deepEqual(inventory, TABS_FIXTURE)
    })
  } finally {
    await service.close()
  }
})

test('listAllTabs drops malformed entries and normalizes unknown states', async () => {
  const service = await startFakeService({
    value: {
      truncated: true,
      tabs: [
        { tabId: 21, url: 'https://ok.example/', state: 'weird', group: { title: '缺 groupId' } },
        { url: 'https://no-tab-id.example/' },
        'not-an-object',
      ],
    },
  })
  try {
    await withEndpointFile(endpointJson(service.address), async (path) => {
      const inventory = await listAllTabs(path)
      assert.equal(inventory.truncated, true)
      assert.equal(inventory.tabs.length, 1)
      assert.equal(inventory.tabs[0].tabId, 21)
      assert.equal(inventory.tabs[0].state, 'available')
      assert.equal(inventory.tabs[0].group, null)
    })
  } finally {
    await service.close()
  }
})

/*
 * 1.13.20+ 的服务端：unbound tabs 已删（METHOD_NOT_FOUND），清单改走同一
 * socket 上的 CLI `tabs` 子命令（{op:'cli', argv, stdin}），按 nextCursor 翻页。
 * 假服务按 argv 里的 --cursor 决定给哪一页，并记录每次 cli 帧供断言；
 * staleOnce 让第一次带游标的请求回 STALE_CURSOR（测从头重翻）。
 */
function cliTabsService(pages, { staleOnce = false, cliError } = {}) {
  const calls = []
  let staleServed = false
  const unknownOp = (op) => ({ ok: false, error: { name: 'Error', code: 'METHOD_NOT_FOUND', message: `Unknown runtime service operation: ${op}` } })
  return {
    calls,
    handler(request) {
      if (request.op !== 'cli') return unknownOp(request.op)
      calls.push(request)
      if (cliError) return { ok: false, error: cliError }
      const cursorIndex = request.argv.indexOf('--cursor')
      const cursor = cursorIndex >= 0 ? request.argv[cursorIndex + 1] : undefined
      if (cursor !== undefined && staleOnce && !staleServed) {
        staleServed = true
        return { ok: false, error: { name: 'Error', code: 'STALE_CURSOR', message: 'Tab inventory changed; restart pagination' } }
      }
      const page = pages[cursor === undefined ? 0 : Number(cursor.slice('cursor-'.length))]
      return page ? { ok: true, value: page } : { ok: false, error: { name: 'Error', code: 'INVALID_ARGUMENT', message: 'bad cursor' } }
    },
  }
}

const CLI_PAGE_1 = {
  truncated: true,
  nextCursor: 'cursor-1',
  tabs: [
    { tabId: 31, windowId: 1, index: 0, title: '第一页', url: 'https://example.com/1', active: true, state: 'available', group: null },
    { tabId: 32, windowId: 2, index: 0, title: '别的任务占着', url: 'https://example.com/2', active: false, state: 'claimed', group: { groupId: 'G1', title: '调研' } },
  ],
}
const CLI_PAGE_2 = {
  truncated: false,
  tabs: [
    { tabId: 33, windowId: 2, index: 1, title: '末页', url: 'https://example.com/3', active: false, state: 'available', group: null },
  ],
}

test('listAllTabs falls back to the CLI tabs command when the unbound op is gone (1.13.20+)', async () => {
  const fake = cliTabsService([CLI_PAGE_1, CLI_PAGE_2])
  const service = await startFakeService({ handler: fake.handler })
  try {
    await withEndpointFile(endpointJson(service.address), async (path) => {
      const inventory = await listAllTabs(path)
      // 两页拼成全量；claimed（被别的任务占有）归一为 busy，绝不能落成 available。
      assert.deepEqual(
        inventory.tabs.map((tab) => [tab.tabId, tab.state]),
        [[31, 'available'], [32, 'busy'], [33, 'available']],
      )
      assert.equal(inventory.truncated, false)
      assert.deepEqual(inventory.tabs[1].group, { groupId: 'G1', title: '调研' })

      // 每页都是 cli 帧：tabs --task <随机名> --limit 200 [--cursor]；stdin 必须是字符串。
      assert.equal(fake.calls.length, 2)
      for (const call of fake.calls) {
        assert.equal(call.stdin, '')
        assert.deepEqual(call.argv.slice(0, 2), ['tabs', '--task'])
        assert.match(call.argv[2], /^dsh-tab-inventory-[0-9a-f]{8}$/u)
        assert.deepEqual(call.argv.slice(3, 5), ['--limit', '200'])
      }
      assert.equal(fake.calls[0].argv.includes('--cursor'), false)
      assert.deepEqual(fake.calls[1].argv.slice(5), ['--cursor', 'cursor-1'])
      // 同一轮清单的各页沿用同一个任务名。
      assert.equal(fake.calls[0].argv[2], fake.calls[1].argv[2])

      // 再列一次：任务名换新（并发清单互不干扰的前提）。
      await listAllTabs(path)
      assert.equal(fake.calls.length, 4)
      assert.notEqual(fake.calls[2].argv[2], fake.calls[0].argv[2])
    })
  } finally {
    await service.close()
  }
})

test('listAllTabs restarts CLI pagination once on STALE_CURSOR', async () => {
  const fake = cliTabsService([CLI_PAGE_1, CLI_PAGE_2], { staleOnce: true })
  const service = await startFakeService({ handler: fake.handler })
  try {
    await withEndpointFile(endpointJson(service.address), async (path) => {
      const inventory = await listAllTabs(path)
      assert.deepEqual(inventory.tabs.map((tab) => tab.tabId), [31, 32, 33])
      // 第 1 页 → 第 2 页 STALE → 重来：第 1 页 → 第 2 页，共 4 次；重来用新任务名。
      assert.equal(fake.calls.length, 4)
      assert.notEqual(fake.calls[2].argv[2], fake.calls[0].argv[2])
    })
  } finally {
    await service.close()
  }
})

test('other CLI-path errors surface with their own code instead of being retried', async () => {
  const fake = cliTabsService([], { cliError: { name: 'Error', code: 'TASK_LIMIT_REACHED', message: 'Task limit of 8 reached' } })
  const service = await startFakeService({ handler: fake.handler })
  try {
    await withEndpointFile(endpointJson(service.address), async (path) => {
      await assert.rejects(listAllTabs(path), (error) => {
        assert.equal(error.name, 'TabbitCliError')
        assert.equal(error.code, 'TASK_LIMIT_REACHED')
        return true
      })
      assert.equal(fake.calls.length, 1)
    })
  } finally {
    await service.close()
  }
})

test('pingEndpoint returns running + generation', async () => {
  const service = await startFakeService({ value: { running: true, generation: GENERATION } })
  try {
    await withEndpointFile(endpointJson(service.address), async (path) => {
      assert.deepEqual(await pingEndpoint(path), { running: true, generation: GENERATION })
    })
  } finally {
    await service.close()
  }
})

test('server error frames become classified TabbitCliError values', async () => {
  const service = await startFakeService({ behavior: 'error' })
  try {
    await withEndpointFile(endpointJson(service.address), async (path) => {
      await assert.rejects(listAllTabs(path), (error) => {
        assert.equal(error.name, 'TabbitCliError')
        assert.equal(error.code, 'SERVICE_BUSY')
        assert.equal(error.kind, 'busy')
        return true
      })
    })
  } finally {
    await service.close()
  }
})

test('stale credentials recover by re-reading a rotated endpoint file', async () => {
  // 服务端只认新 token；endpoint 文件先写旧 token。首次连接在认证阶段被无响应
  // 断开，断开前（onBadAuth）文件被"浏览器"轮换成新 token——客户端的单次重试
  // 现读文件即成功。这正是真实浏览器重启窗口的时序。
  let rotatedPath
  const service = await startFakeService({
    value: TABS_FIXTURE,
    onBadAuth: () => {
      writeFileSync(rotatedPath, endpointJson(service.address))
    },
  })
  try {
    await withEndpointFile(endpointJson(service.address, { token: 'stale-old-token' }), async (path) => {
      rotatedPath = path
      const inventory = await listAllTabs(path)
      assert.deepEqual(inventory, TABS_FIXTURE)
    })
  } finally {
    await service.close()
  }
})

test('a consistently refused connection surfaces as browser-unavailable', async () => {
  const service = await startFakeService({ value: TABS_FIXTURE, token: 'other-token' })
  try {
    await withEndpointFile(endpointJson(service.address), async (path) => {
      await assert.rejects(listAllTabs(path), (error) => {
        assert.equal(error.code, 'STALE_ENDPOINT')
        assert.equal(error.kind, 'browser-unavailable')
        return true
      })
    })
  } finally {
    await service.close()
  }
})

test('missing endpoint file means the browser is offline', async () => {
  await withEndpointFile(undefined, async (path) => {
    await assert.rejects(listAllTabs(path), (error) => {
      assert.equal(error.code, 'ENDPOINT_MISSING')
      assert.equal(error.kind, 'browser-unavailable')
      return true
    })
  })
})

test('unsupported endpoint schema fails loudly instead of guessing', async () => {
  await withEndpointFile(endpointJson('/tmp/unused.sock', { version: 3 }), async (path) => {
    assert.throws(() => readEndpoint(path), (error) => {
      assert.equal(error.code, 'ENDPOINT_UNSUPPORTED')
      assert.equal(error.kind, 'protocol')
      return true
    })
  })
})

test('a silent service hits the client timeout', async () => {
  const service = await startFakeService({ behavior: 'silent' })
  try {
    await withEndpointFile(endpointJson(service.address), async (path) => {
      await assert.rejects(listAllTabs(path, { timeoutMs: 200 }), (error) => {
        assert.equal(error.code, 'CLIENT_TIMEOUT')
        assert.equal(error.kind, 'timeout')
        return true
      })
    })
  } finally {
    await service.close()
  }
})

test('listInstancesWindows parses records and mirrors the C++ validation rules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tabbit-win-registry-'))
  try {
    const cliPath = join(dir, 'tabbit-cli.exe')
    await writeFile(cliPath, 'stub')
    const onlineEndpoint = join(dir, 'endpoint-online.json')
    await writeFile(onlineEndpoint, '{}')
    const record = (overrides = {}) => JSON.stringify({
      version: 1,
      instanceId: 'AAAA0000BBBB1111',
      product: 'Tabbit Browser',
      cliPath,
      endpointPath: onlineEndpoint,
      browserPath: 'C:/apps/tabbit.exe',
      userDataDir: 'C:/users/x/AppData/Local/Tabbit Browser/User Data',
      ...overrides,
    })
    await writeFile(join(dir, 'AAAA0000BBBB1111.json'), record())
    await writeFile(
      join(dir, 'CCCC2222DDDD3333.json'),
      record({ instanceId: 'CCCC2222DDDD3333', product: '', endpointPath: join(dir, 'endpoint-absent.json') }),
    )
    // 下面四条都必须被整个跳过：schema 版本不认识 / 文件名与记录身份不一致 /
    // id 形状不合法 / cliPath 指向不存在的文件。
    await writeFile(join(dir, 'EEEE4444FFFF5555.json'), record({ instanceId: 'EEEE4444FFFF5555', version: 2 }))
    await writeFile(join(dir, 'MISMATCH00000000.json'), record())
    await writeFile(join(dir, 'lowercase-id.json'), record({ instanceId: 'lowercase-id' }))
    await writeFile(
      join(dir, '9999AAAA8888BBBB.json'),
      record({ instanceId: '9999AAAA8888BBBB', cliPath: join(dir, 'missing-cli.exe') }),
    )
    await mkdir(join(dir, 'not-a-record.json')) // 目录同名文件：读文件抛错也要被跳过

    const instances = listInstancesWindows(dir)
    assert.deepEqual(instances.map((instance) => instance.id), ['AAAA0000BBBB1111', 'CCCC2222DDDD3333'])
    assert.equal(instances[0].online, true)
    assert.equal(instances[0].appName, 'Tabbit Browser')
    assert.equal(instances[1].online, false)
    // product 为空时回退到从 cliPath 推导的文件名。
    assert.equal(instances[1].appName, 'tabbit-cli.exe')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
