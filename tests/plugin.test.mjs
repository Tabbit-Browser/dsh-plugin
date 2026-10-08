// 插件注册层的单元测试：installer/update 两个工具（经 DI 假件驱动三态与
// 会话缓存）+ core 的随包 skill provider + /tabbit-info 命令的事件落盘。
// 自 0.2.x 世代的测试改造而来。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as installer from '../lib/installer/index.js'
import { skillProvider, apply as applyCore, parseSkillDocument } from '../lib/core/index.js'

const SUPPORTED = {
  installations: [{ name: 'Tabbit', edition: 'international', channel: 'stable', version: '1.9.2' }],
  supportedInstallations: [{ name: 'Tabbit', edition: 'international', channel: 'stable', version: '1.9.2' }],
}

function mockCtx({ tabbit = {}, jobs = {} } = {}) {
  const tools = []
  return {
    tools: { register: value => { tools.push(value); return () => {} } },
    jobs,
    tabbit,
    registered: tools,
  }
}

test('exposes the cordis plugin contract and registers both tools', () => {
  assert.equal(installer.name, 'tabbit-installer')
  assert.deepEqual(installer.inject, ['tools', 'jobs', 'tabbit'])

  const ctx = mockCtx()
  installer.apply(ctx)
  assert.deepEqual(
    ctx.registered.map(tool => tool.name).sort(),
    ['tabbit_browser_install', 'tabbit_plugin_update'],
  )
  assert.ok(ctx.registered.every(tool => typeof tool.execute === 'function'))
})

test('caches a ready environment check per agent session', async () => {
  let checks = 0
  const ctx = mockCtx({
    tabbit: {
      // launcher 存在性用真实文件系统检查（existsSync）——拿本进程的 node
      // 可执行文件当"已注册的 launcher"，永远存在。
      launcherPath: () => process.execPath,
      instances: () => [{ id: 'A'.repeat(16), online: true, appName: 'Tabbit', cliPath: '', endpointPath: '' }],
    },
  })
  installer.registerInstallerTool(ctx, {
    detect: async () => {
      checks += 1
      return SUPPORTED
    },
  })
  const tool = ctx.registered[0]

  const agent = {}
  const first = await tool.execute({}, { agent })
  const second = await tool.execute({}, { agent })
  const refreshed = await tool.execute({ refresh: true }, { agent })

  assert.equal(checks, 2)
  assert.equal(first.status, 'ready')
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.match(second.message, /Reused this session's cached environment check/)
  assert.equal(refreshed.cached, false)
})

test('falls back to runtime-process detection when the instance registry is empty', async () => {
  const makeCtx = () => mockCtx({
    tabbit: { launcherPath: () => process.execPath, instances: () => [] },
  })

  const readyCtx = makeCtx()
  installer.registerInstallerTool(readyCtx, {
    detect: async () => SUPPORTED,
    detectRuntime: () => [{ pid: 301, name: 'node.exe' }],
  })
  const ready = await readyCtx.registered[0].execute({}, { agent: {} })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.runtimeProcessCount, 1)

  const restartCtx = makeCtx()
  installer.registerInstallerTool(restartCtx, {
    detect: async () => SUPPORTED,
    detectRuntime: () => [],
  })
  const restart = await restartCtx.registered[0].execute({}, { agent: {} })
  assert.equal(restart.status, 'restart-required')
  assert.match(restart.message, /Runtime Service is not reachable/)
})

test('starts one background download when no supported Tabbit is installed', async () => {
  const startCalls = []
  let jobStatus = 'running'
  const ctx = mockCtx({
    tabbit: { launcherPath: () => process.execPath, instances: () => [] },
    jobs: {
      start(options) {
        startCalls.push(options)
        return 'job-1'
      },
      get: () => ({ status: jobStatus }),
    },
  })
  installer.registerInstallerTool(ctx, {
    detect: async () => ({ installations: [], supportedInstallations: [] }),
  })
  const tool = ctx.registered[0]

  const agent = {}
  const first = await tool.execute({}, { agent })
  assert.equal(first.status, 'background')
  assert.equal(first.jobId, 'job-1')
  assert.match(first.message, /No stable Tabbit edition is installed\./)
  assert.equal(startCalls.length, 1)
  assert.equal(startCalls[0].kind, 'tabbit-installer')

  // 下载还在跑：不重复起第二单。
  const second = await tool.execute({}, { agent })
  assert.equal(second.status, 'background')
  assert.match(second.message, /already running as job-1/)
  assert.equal(startCalls.length, 1)
})

test('records a declined version through the update tool', async () => {
  const dismissed = []
  const ctx = mockCtx()
  installer.registerUpdateTool(ctx, {
    checkUpdate: async () => ({ status: 'current', currentVersion: '0.3.0' }),
    dismiss: async version => { dismissed.push(version) },
    env: {},
  })
  const tool = ctx.registered[0]

  const result = await tool.execute({ dismiss: '0.4.0' }, {})
  assert.equal(result.status, 'dismissed')
  assert.equal(result.dismissedVersion, '0.4.0')
  assert.deepEqual(dismissed, ['0.4.0'])
})

test('reports the update state and honors refresh through the update tool', async () => {
  const calls = []
  const ctx = mockCtx()
  installer.registerUpdateTool(ctx, {
    checkUpdate: async options => {
      calls.push(options)
      return {
        status: 'update-available',
        currentVersion: '0.3.0',
        latestVersion: '0.4.0',
        changelog: 'Added things.',
      }
    },
    dismiss: async () => ({}),
    env: {},
  })
  const tool = ctx.registered[0]

  const result = await tool.execute({ refresh: true }, {})
  assert.equal(result.status, 'update-available')
  assert.equal(result.latestVersion, '0.4.0')
  assert.match(result.message, /Ask the user whether to update now/)
  // hostVersion is whatever host-version.ts resolves live off the linked harness
  // checkout — assert its shape, not its exact value, so this test doesn't break
  // every time a developer points .dsh-harness at a newer checkout.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].force, true)
  assert.match(calls[0].hostVersion, /^\d+\.\d+\.\d+/)
})

test('the update tool defers to the browser for managed (preinstalled) copies', async () => {
  let checked = 0
  const ctx = mockCtx()
  installer.registerUpdateTool(ctx, {
    checkUpdate: async () => {
      checked += 1
      return { status: 'current', currentVersion: '0.3.0' }
    },
    dismiss: async () => ({}),
    env: { TABBIT_PLAYWRIGHT_INSTANCE: 'DB9322BEB5C4102A' },
  })
  const result = await ctx.registered[0].execute({ refresh: true }, {})
  assert.equal(result.status, 'browser-managed')
  assert.match(result.message, /managed by Tabbit Browser/)
  assert.equal(checked, 0)
})

test('/tabbit-info 把整份报告放进命令结果文本，不向会话日志追加任何事件', async () => {
  // 封闭性：HOME 指到空目录 → 实例注册表读不到（instances 为空、无 CLI
  // 调用），settings 里 launcherPath 再指到不存在的路径 → 结论走“未安装”
  // 分支。整个 handler 不碰真实浏览器/文件系统。
  const emptyHome = await mkdtemp(join(tmpdir(), 'tabbit-test-home-'))
  const savedHome = process.env.HOME
  process.env.HOME = emptyHome
  try {
    const commands = []
    const ctx = {
      settings: {
        register: () => ({
          get: () => ({
            instance: '',
            launcherPath: join(emptyHome, 'missing-tabbit-cli'),
            pageAccess: 'ask',
            intranetFetch: 'ask',
          }),
        }),
        get: () => undefined, // locale 未设置 → 兜底 en
      },
      skills: { registerProvider() {} },
      systemPrompt: { section() {} },
      commands: { register: definition => { commands.push(definition); return () => {} } },
      provide() {},
      on() {},
      effect(fn) { const cleanup = fn(); return () => cleanup?.() },
      inject(_names, callback) { callback(ctx) },
      logger: { info() {}, warn() {} },
    }
    applyCore(ctx)

    const info = commands.find(definition => definition.name === 'tabbit-info')
    assert.ok(info, 'tabbit-info command registered')

    // 回归守卫（issue #22）：宿主对不认识的事件类型整会话拒读，而插件没有
    // 设置 ignorable 标记的入口——handler 绝不能碰 session.append。
    const appended = []
    const session = {
      append(type, data) {
        appended.push({ type, data })
        return { type, seq: appended.length - 1 }
      },
    }
    const result = await info.handler({
      agent: { session },
      rawInput: '',
      signal: new AbortController().signal,
    })

    assert.equal(appended.length, 0)
    assert.equal(result.kind, 'success')
    assert.equal(result.sourceEventSeq, undefined)
    // 命令文本就是整份报告：首行结论（跟随用户语言），后面跟英文明细。
    assert.match(result.text, /^\u26a0\ufe0f Tabbit Browser not found/u)
    assert.match(result.text, /\ninstances: none registered/u)
    // 明细第一行是插件版本（本包 package.json）；宿主版本能读到时跟在同一行。
    const versionLine = result.text.split('\n')[2]
    assert.match(versionLine, /^plugin: dsh-tabbit \d+\.\d+\.\d+/u)
    assert.match(versionLine, / · host dsh \d+\.\d+\.\d+/u)
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
  }
})

test('DSH 0.2 Config supplies live settings and /tabbit-info reads the new locale form', async () => {
  const emptyHome = await mkdtemp(join(tmpdir(), 'tabbit-config-home-'))
  const savedHome = process.env.HOME
  process.env.HOME = emptyHome
  try {
    const values = {
      instance: '',
      launcherPath: join(emptyHome, 'missing-tabbit-cli'),
      pageAccess: 'ask',
      intranetFetch: 'ask',
    }
    const config = Object.fromEntries(Object.keys(values).map(key => [key, { get: () => values[key] }]))
    const commands = []
    let service
    const ctx = {
      settings: { describe: () => [{ ns: 'locale', value: { preference: 'zh' } }] },
      get: () => undefined,
      provide(name, value) { if (name === 'tabbit') service = value },
      effect() {},
      on() {},
      inject(_names, callback) { callback(ctx) },
      skills: { registerProvider() {} },
      systemPrompt: { section() {} },
      commands: { register: definition => { commands.push(definition) } },
      logger: { info() {}, warn() {} },
    }
    applyCore(ctx, config)
    assert.equal(service.currentSettings().pageAccess, 'ask')
    values.pageAccess = 'always'
    assert.equal(service.currentSettings().pageAccess, 'always')
    const result = await commands[0].handler({})
    assert.equal(result.kind, 'success')
    assert.match(result.text, /^⚠️ 未找到 Tabbit 浏览器/u)
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
  }
})

test('serves one bundled tabbit skill from SKILL.md frontmatter', async () => {
  // 置托管环境变量让 get() 的更新检查短路（不读缓存、不发网络请求），
  // 保证本测试确定性；用完恢复。
  const saved = process.env.TABBIT_PLAYWRIGHT_INSTANCE
  process.env.TABBIT_PLAYWRIGHT_INSTANCE = 'TESTTESTTESTTEST'
  try {
    const candidates = await skillProvider.list()
    assert.equal(candidates.length, 1)
    const candidate = candidates[0]
    // 名字与浏览器共享 skill（~/.agents/skills/tabbit）相同是刻意的：
    // dsh 同名去重让共享版（user-agents 层/rank 500）优先，本包 rank 600
    // 的副本自动成为"没装/老浏览器"时的兜底。
    assert.equal(candidate.name, 'tabbit')
    assert.equal(candidate.source, 'bundled')
    assert.equal(candidate.rank, 600)
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
    // 新版 skill 讲的是 tabbit-cli 的调用方式（persistent / nodejs --task），
    // 不再围绕 tabbit_browser 工具行文。
    assert.match(candidate.description, /Tabbit Browser/)
    assert.match(candidate.description, /never switch browser backends/)
    assert.match(candidate.resourceBase.path, /skills[\\/]tabbit[\\/]$/)

    assert.equal(await skillProvider.get({ name: 'other-skill' }), undefined)

    const skill = await skillProvider.get({ name: 'tabbit' })
    assert.match(skill.content, /^# Tabbit$/m)
    assert.match(skill.content, /## Choose invocation/)
    assert.match(skill.content, /## Persistent workspace/)
    assert.doesNotMatch(skill.content, /^---$/m)
    assert.doesNotMatch(skill.content, /Plugin update available/)
  } finally {
    if (saved === undefined) delete process.env.TABBIT_PLAYWRIGHT_INSTANCE
    else process.env.TABBIT_PLAYWRIGHT_INSTANCE = saved
  }
})

/* ── parseSkillDocument：LF/CRLF frontmatter 拆分 ── */

test('parseSkillDocument splits LF frontmatter into fields and body', () => {
  const source = '---\nname: demo\ndescription: "quoted d"\n---\n\n# Demo\nbody'
  const { fields, body } = parseSkillDocument(source)
  assert.deepEqual(fields, { name: 'demo', description: 'quoted d' })
  assert.equal(body, '\n# Demo\nbody')
})

test('parseSkillDocument tolerates CRLF frontmatter (Windows checkout / autocrlf)', () => {
  // 曾经的 bug：拆分只认 \n，CRLF checkout 下 ---\r\n 永远匹配不上开头的
  // ---\n，整份 frontmatter（含 YAML 头）原样落进 body，一起喂给了模型。
  const source = '---\r\nname: demo\r\ndescription: "quoted d"\r\n---\r\n\r\n# Demo\r\nbody'
  const { fields, body } = parseSkillDocument(source)
  assert.deepEqual(fields, { name: 'demo', description: 'quoted d' })
  assert.equal(body, '\r\n# Demo\r\nbody')
  assert.doesNotMatch(body, /^---/)
})

test('parseSkillDocument passes through content with no or unclosed frontmatter', () => {
  assert.deepEqual(parseSkillDocument('no frontmatter here'), { fields: {}, body: 'no frontmatter here' })
  assert.deepEqual(parseSkillDocument('---\nnever closed'), { fields: {}, body: '---\nnever closed' })
  assert.deepEqual(parseSkillDocument('---\r\nnever closed'), { fields: {}, body: '---\r\nnever closed' })
})
