// @ 提及候选合并（roster：任务页 + 用户标签页）、用户标签页提取分支、
// tabbit_browser 工具 list_tabs/list_tasks 分支的单元测试。
// 路由处理器用假 req/res + 假 ctx 驱动；工具用 plugin.test.mjs 同款 mock ctx。
import assert from 'node:assert/strict'
import test from 'node:test'

import * as mentions from '../lib/mentions/index.js'
import * as toolBrowser from '../lib/tool-browser/index.js'
import { FETCH_TASK_NAME } from '../lib/core/index.js'
import { TabbitCliError } from '../lib/runtime/errors.js'

const INVENTORY = {
  truncated: false,
  tabs: [
    { tabId: 30, windowId: 2, index: 0, title: '后开窗口页', url: 'https://w2.example/', active: false, state: 'available', group: null },
    { tabId: 11, windowId: 1, index: 0, title: '文档', url: 'https://docs.example/a', active: false, state: 'available', group: { groupId: 'G1', title: '调研' } },
    { tabId: 12, windowId: 1, index: 1, title: '活跃页', url: 'https://active.example/', active: true, state: 'available', group: null },
    { tabId: 13, windowId: 1, index: 2, title: '代理占用页', url: 'https://busy.example/', active: false, state: 'busy', group: null },
    { tabId: 14, windowId: 1, index: 3, title: 'New Tab', url: 'https://product.example/newtab', active: false, state: 'available', group: null },
    { tabId: 15, windowId: 1, index: 4, title: '', url: 'about:blank', active: false, state: 'available', group: null },
    { tabId: 16, windowId: 1, index: 5, title: '扩展查看器', url: 'chrome-extension://abc/viewer.html', active: false, state: 'available', group: null },
    { tabId: 17, windowId: 1, index: 6, title: 'Extensions', url: 'chrome://extensions/', active: false, state: 'available', group: null },
  ],
}

/*
 * 收集路由注册 + agent/pre-step 钩子的假 ctx；handlers 闭包引用外层 ctx
 * （tabbit 字段）。返回 { routes, preStep }：preStep 是 apply() 注册的
 * 瀑布处理器本体，测试直接拿假 (payload, next) 调用它，不依赖真实 agent。
 */
function mentionCtx(tabbit) {
  const routes = new Map()
  let preStep
  const ctx = {
    tabbit,
    on(event, handler) {
      assert.equal(event, 'agent/pre-step')
      preStep = handler
    },
    inject(deps, cb) {
      assert.deepEqual(deps, ['webServer'])
      cb({ webServer: { register: (route) => routes.set(route.path, route.handler) } })
    },
  }
  mentions.apply(ctx)
  return { routes, preStep }
}

/* 一条最小可用的用户消息（agent/pre-step 测试用）。 */
function userMessage(text) {
  return { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/* 常见调用形状：next() 直接放行给定的 messages。 */
function enterWith(messages) {
  return async () => ({ kind: 'enter', messages })
}

/* 假 IncomingMessage：headers/url/method + async 可迭代的请求体。 */
function fakeReq({ url, method = 'GET', body }) {
  return {
    headers: { host: '127.0.0.1:3199' },
    url,
    method,
    socket: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

/* 假 ServerResponse：捕获 status + JSON body。 */
function fakeRes() {
  const captured = { status: 0, body: undefined }
  return {
    captured,
    writeHead(status) {
      captured.status = status
    },
    end(text) {
      try {
        captured.body = JSON.parse(text)
      } catch {
        captured.body = text
      }
    },
  }
}

test('roster merges task pages first, then filtered/sorted user tabs', async () => {
  const evaluated = []
  const { routes } = mentionCtx({
    sessionTasks: () => ['t1'],
    instances: () => [{ id: 'A'.repeat(16), online: true }],
    client: () => ({
      listTasks: async () => [{ taskName: 't1' }],
      evaluate: async (request) => {
        evaluated.push(request.task)
        return { status: 'succeeded', result: { value: [{ index: 0, url: 'https://task.example/', title: '任务页A' }] } }
      },
    }),
    listAllTabs: async () => INVENTORY,
  })
  const res = fakeRes()
  await routes.get('/tabbit/mention/tabs')(fakeReq({ url: '/tabbit/mention/tabs?session=s1' }), res)

  assert.equal(res.captured.status, 200)
  const tabs = res.captured.body.tabs
  assert.deepEqual(evaluated, ['t1'])
  // 顺序：任务页在前；用户标签页 active 最前，其余按 windowId、index。
  // busy / newtab / about:blank / chrome-extension / chrome 均被滤掉
  // （非 http(s) 页无法重取，候选必须能兑现内容）。
  assert.deepEqual(
    tabs.map((tab) => [tab.kind, tab.url]),
    [
      ['task-page', 'https://task.example/'],
      ['user-tab', 'https://active.example/'],
      ['user-tab', 'https://docs.example/a'],
      ['user-tab', 'https://w2.example/'],
    ],
  )
  const doc = tabs.find((tab) => tab.url === 'https://docs.example/a')
  assert.equal(doc.tabId, 11)
  assert.equal(doc.group, '调研')
  assert.equal(tabs[1].active, true)
  assert.equal(res.captured.body.note, undefined)
})

test('roster degrades to task pages only when the inventory is unavailable', async () => {
  const { routes } = mentionCtx({
    sessionTasks: () => [],
    instances: () => [],
    client: () => ({ listTasks: async () => [], evaluate: async () => ({ status: 'failed' }) }),
    listAllTabs: async () => {
      throw new TabbitCliError({ kind: 'browser-unavailable', code: 'ENDPOINT_MISSING', message: 'offline' })
    },
  })
  const res = fakeRes()
  await routes.get('/tabbit/mention/tabs')(fakeReq({ url: '/tabbit/mention/tabs?session=s1' }), res)
  assert.equal(res.captured.status, 200)
  assert.deepEqual(res.captured.body.tabs, [])
  assert.match(res.captured.body.note, /user tabs unavailable/)
})

test('extract with userTab stashes the body and closes its fetch task', async () => {
  const calls = { evaluate: [], finished: 0 }
  const { routes } = mentionCtx({
    withFetchTask: async (run) => {
      try {
        return await run({ evaluate: async (request) => {
          calls.evaluate.push(request)
          return {
            status: 'succeeded',
            result: { value: { url: 'https://docs.example/a', title: '文档', text: '正文内容', truncated: false } },
          }
        } })
      } finally {
        calls.finished += 1
      }
    },
  })
  const res = fakeRes()
  await routes.get('/tabbit/mention/extract')(
    fakeReq({
      url: '/tabbit/mention/extract',
      method: 'POST',
      body: JSON.stringify({ url: 'https://docs.example/a', userTab: true }),
    }),
    res,
  )

  assert.equal(res.captured.status, 200)
  assert.equal(res.captured.body.refetched, true)
  assert.equal(res.captured.body.title, '文档')
  // 正文不再回给前端——只回一个一次性 token，气泡里不会直接堆全文。
  assert.equal(res.captured.body.text, undefined)
  assert.equal(typeof res.captured.body.token, 'string')
  assert.ok(res.captured.body.token.length > 0)
  assert.equal(calls.evaluate.length, 1)
  assert.equal(calls.evaluate[0].task, FETCH_TASK_NAME)
  assert.equal(calls.evaluate[0].readOnly, true)
  assert.match(calls.evaluate[0].code, /docs\.example/)
  assert.equal(calls.finished, 1)
})

test('extract with userTab rejects non-http(s) urls upfront', async () => {
  const { routes } = mentionCtx({})
  const res = fakeRes()
  await routes.get('/tabbit/mention/extract')(
    fakeReq({
      url: '/tabbit/mention/extract',
      method: 'POST',
      body: JSON.stringify({ url: 'chrome-extension://abc/viewer.html', userTab: true }),
    }),
    res,
  )
  assert.equal(res.captured.status, 400)
  assert.match(res.captured.body.error, /cannot be re-fetched/)
})

test('extract without userTab still requires a task', async () => {
  const { routes } = mentionCtx({})
  const res = fakeRes()
  await routes.get('/tabbit/mention/extract')(
    fakeReq({ url: '/tabbit/mention/extract', method: 'POST', body: JSON.stringify({ url: 'https://x.example/' }) }),
    res,
  )
  assert.equal(res.captured.status, 400)
})

/* ── agent/pre-step：token → 折叠上下文消息 ── */

test('pre-step expands a tabbit-tab marker into a clean mention plus a collapsed context message', async () => {
  const { routes, preStep } = mentionCtx({
    client: () => ({
      listTasks: async () => [{ taskName: 't1' }],
      evaluate: async () => ({
        status: 'succeeded',
        result: { value: { url: 'https://docs.example/a', title: '文档', text: '完整正文', truncated: false } },
      }),
    }),
  })
  const extractRes = fakeRes()
  await routes.get('/tabbit/mention/extract')(
    fakeReq({
      url: '/tabbit/mention/extract',
      method: 'POST',
      body: JSON.stringify({ task: 't1', url: 'https://docs.example/a', index: 0 }),
    }),
    extractRes,
  )
  const { token } = extractRes.captured.body

  const sent = userMessage(`总结一下 @[文档](tabbit-tab:${token})`)
  const decision = await preStep({}, enterWith([sent]))

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  // 直发消息里的标记被替换成干净的 "@标题"，看不出 token 痕迹。
  assert.equal(decision.messages[0].content[0].text, '总结一下 @文档')
  assert.equal(decision.messages[0].source.kind, 'user')
  // 紧跟着的是一条折叠的上下文消息，正文完整、source 不是 'user'。
  const context = decision.messages[1]
  assert.equal(context.source.kind, 'plugin')
  assert.equal(context.source.plugin, 'dsh-tabbit')
  assert.equal(context.source.form, 'notice')
  assert.match(context.content[0].text, /<browser-tab url="https:\/\/docs\.example\/a" title="文档">/)
  assert.match(context.content[0].text, /完整正文/)
})

test('pre-step quotes a multi-word title so the host chip decorator keeps it as one chip', async () => {
  // 回归用例：宿主的转录装饰正则 /(^|\s)(\/[\w-]+|@"[^"\n]+"|@[^\s]+)/ 在裸
  // @标题 上一遇到空白就断——之前直接吐 `@Example Domain` 时，气泡里只有
  // "Example" 被框进 chip，"Domain" 漏在外面。加引号后 @"..." 整体算一个
  // token，宿主才会把整个标题当一个引用来渲染。
  const { routes, preStep } = mentionCtx({
    client: () => ({
      listTasks: async () => [{ taskName: 't1' }],
      evaluate: async () => ({
        status: 'succeeded',
        result: {
          value: { url: 'https://example.com/', title: 'Example Domain', text: '正文', truncated: false },
        },
      }),
    }),
  })
  const extractRes = fakeRes()
  await routes.get('/tabbit/mention/extract')(
    fakeReq({
      url: '/tabbit/mention/extract',
      method: 'POST',
      body: JSON.stringify({ task: 't1', url: 'https://example.com/', index: 0 }),
    }),
    extractRes,
  )
  const { token } = extractRes.captured.body

  const sent = userMessage(`@[Example Domain](tabbit-tab:${token}) 总结一下这个页面`)
  const decision = await preStep({}, enterWith([sent]))
  assert.equal(decision.messages[0].content[0].text, '@"Example Domain" 总结一下这个页面')
})

test('pre-step swaps slashes in a quoted title so the host display logic keeps the whole title', async () => {
  // 宿主对 @"..." 的展示逻辑会按 / 或 \ 分段只取最后一段（抄的是文件路径
  // 展示），标题里的斜杠必须换成形近全角符号，否则 "GitHub - foo/bar" 这类
  // 标题会被裁到只剩 "bar"。
  const { preStep } = mentionCtx({})
  const sent = userMessage('看看 @[GitHub - foo/bar](tabbit-tab:missing)')
  const decision = await preStep({}, enterWith([sent]))
  assert.equal(decision.messages[0].content[0].text, '看看 @"GitHub - foo／bar"')
})

test('pre-step falls back to a clean mention when the token is unknown or already consumed', async () => {
  const { preStep } = mentionCtx({})
  const sent = userMessage('看看 @[旧标题](tabbit-tab:does-not-exist)')
  const decision = await preStep({}, enterWith([sent]))
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].content[0].text, '看看 @旧标题')
})

test('pre-step leaves messages without a tabbit-tab marker untouched', async () => {
  const { preStep } = mentionCtx({})
  const sent = userMessage('普通消息，没有提及标签页')
  const decision = await preStep({}, enterWith([sent]))
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0], sent)
})

test('pre-step passes a rejected decision through unchanged', async () => {
  const { preStep } = mentionCtx({})
  const decision = await preStep({}, async () => ({ kind: 'reject' }))
  assert.deepEqual(decision, { kind: 'reject' })
})

/* ── tabbit_browser 工具的 list_tabs 分支 ── */

function toolCtx(tabbit) {
  const tools = []
  const ctx = { tools: { register: (tool) => tools.push(tool) }, tabbit }
  toolBrowser.apply(ctx)
  return tools[0]
}

test('tabbit_browser list_tabs returns a compact inventory without touching tasks', async () => {
  const tool = toolCtx({
    listAllTabs: async () => ({
      truncated: false,
      tabs: [
        {
          tabId: 7,
          windowId: 1,
          index: 0,
          title: 'T'.repeat(200),
          url: `https://long.example/${'p'.repeat(400)}`,
          active: true,
          state: 'available',
          group: { groupId: 'G9', title: '组名' },
        },
      ],
    }),
  })
  const value = await tool.execute({ list_tabs: true }, { agent: { id: 'session-xyz' } })
  assert.equal(value.status, 'succeeded')
  assert.equal(value.task, undefined)
  assert.equal(value.tabCount, 1)
  assert.equal(value.tabs.length, 1)
  assert.equal(value.tabs[0].tabId, 7)
  assert.equal(value.tabs[0].title.length, 80)
  assert.equal(value.tabs[0].url.length, 160)
  assert.equal(value.tabs[0].group, '组名')
})

test('tabbit_browser list_tabs filters by substring and caps the list at 100', async () => {
  const tabs = Array.from({ length: 130 }, (_, order) => ({
    tabId: order,
    windowId: 1,
    index: order,
    title: order % 2 === 0 ? `豆瓣读书 ${order}` : `其它页面 ${order}`,
    url: `https://site.example/${order}`,
    active: false,
    state: 'available',
    group: null,
  }))
  const tool = toolCtx({ listAllTabs: async () => ({ truncated: false, tabs }) })

  const filtered = await tool.execute({ list_tabs: true, tabs_filter: '豆瓣' }, { agent: { id: 's' } })
  assert.equal(filtered.tabCount, 130)
  assert.equal(filtered.matchedCount, 65)
  assert.equal(filtered.tabs.length, 65)
  assert.ok(filtered.tabs.every((tab) => tab.title.includes('豆瓣')))
  assert.equal(filtered.listTruncated, undefined)

  const capped = await tool.execute({ list_tabs: true }, { agent: { id: 's' } })
  assert.equal(capped.tabCount, 130)
  assert.equal(capped.tabs.length, 100)
  assert.equal(capped.listTruncated, true)
  // 总数字段必须排在列表前面——渲染截断时先保住总数（JSON 按键插入序输出）。
  assert.ok(Object.keys(capped).indexOf('tabCount') < Object.keys(capped).indexOf('tabs'))
})

test('tabbit_browser list_tabs surfaces offline as a friendly failed result', async () => {
  const tool = toolCtx({
    listAllTabs: async () => {
      throw new TabbitCliError({ kind: 'browser-unavailable', code: 'ENDPOINT_MISSING', message: 'not running' })
    },
  })
  const value = await tool.execute({ list_tabs: true }, { agent: { id: 'session-xyz' } })
  assert.equal(value.status, 'failed')
  assert.equal(value.errorCode, 'ENDPOINT_MISSING')
  assert.match(value.error, /retry shortly/)
})

test('tabbit_browser without code and without list_tabs fails with a clear error', async () => {
  const tool = toolCtx({})
  const value = await tool.execute({}, { agent: { id: 'session-xyz' } })
  assert.equal(value.status, 'failed')
  assert.equal(value.errorCode, 'MISSING_CODE')
})

/* ── tabbit_browser 工具的 list_tasks 分支 ── */

test("tabbit_browser list_tasks reports this session's open tasks and its default", async () => {
  // 故意不给 client/listAllTabs：分支若不慎落到求值或 list_tabs 路径会直接
  // 抛"不是函数"，这就是对"零副作用"契约最直接的回归检查。
  const tool = toolCtx({
    sessionTasks: () => ['research-dsh-ab12', 'scratch-dsh-ab12'],
    currentDefaultTask: () => 'research-dsh-ab12',
  })
  const value = await tool.execute({ list_tasks: true }, { agent: { id: 'session-ab12' } })
  assert.equal(value.status, 'succeeded')
  assert.equal(value.taskCount, 2)
  assert.equal(value.defaultTask, 'research-dsh-ab12')
  assert.deepEqual(value.tasks, [
    { task: 'research-dsh-ab12', isDefault: true },
    { task: 'scratch-dsh-ab12', isDefault: false },
  ])
})

test('tabbit_browser list_tasks reports an empty session with no default task', async () => {
  const tool = toolCtx({ sessionTasks: () => [], currentDefaultTask: () => undefined })
  const value = await tool.execute({ list_tasks: true }, { agent: { id: 'session-ab12' } })
  assert.equal(value.status, 'succeeded')
  assert.equal(value.taskCount, 0)
  assert.equal(value.defaultTask, undefined)
  assert.deepEqual(value.tasks, [])
})

test('tabbit_browser list_tasks ignores code/task/finish', async () => {
  const tool = toolCtx({
    sessionTasks: () => ['solo-dsh-ab12'],
    currentDefaultTask: () => 'solo-dsh-ab12',
  })
  const value = await tool.execute(
    { list_tasks: true, code: 'return 1', task: 'other', finish: true },
    { agent: { id: 'session-ab12' } },
  )
  assert.equal(value.status, 'succeeded')
  assert.equal(value.taskCount, 1)
})

test('tabbit_browser list_tabs takes precedence when both list_tabs and list_tasks are set', async () => {
  const tool = toolCtx({
    listAllTabs: async () => ({ truncated: false, tabs: [] }),
    // 不给 sessionTasks/currentDefaultTask：list_tasks 分支若被误触会直接
    // 抛"不是函数"，证明 list_tabs 分支确实先一步返回。
  })
  const value = await tool.execute({ list_tabs: true, list_tasks: true }, { agent: { id: 'session-ab12' } })
  assert.equal(value.status, 'succeeded')
  assert.equal(value.tabCount, 0)
  assert.equal(value.tasks, undefined)
})

/* ── tabbit_browser 工具：claim_tabs 对已存在的任务走独立 claim 子命令 ── */

test('tabbit_browser claim_tabs on a task already in this session claims via the standalone command, not creation-time', async () => {
  const claimCalls = []
  const evaluateCalls = []
  const tool = toolCtx({
    sessionTasks: () => ['existing-task'],
    rememberSessionTask: () => {},
    client: () => ({
      claimTabs: async (task, tabIds) => {
        claimCalls.push({ task, tabIds })
        return { groupId: 'G1', ownedPageCount: 3 }
      },
      evaluate: async (request) => {
        evaluateCalls.push(request)
        return {
          status: 'succeeded',
          result: { value: 'ok' },
          task: { taskId: 't1', taskName: 'existing-task', reused: true },
          taskWasReset: false,
          notes: [],
        }
      },
      resolvedInstanceId: () => 'INSTANCE1',
    }),
  })
  const value = await tool.execute(
    { task: 'existing-task', code: 'return 1;', claim_tabs: [17, 18] },
    { agent: { id: 's1' } },
  )
  assert.equal(value.status, 'succeeded')
  assert.equal(value.claimedTabCount, 2)
  assert.equal(value.ownedPageCount, 3)
  assert.equal(claimCalls.length, 1)
  assert.deepEqual(claimCalls[0], { task: 'existing-task', tabIds: [17, 18] })
  // evaluate 不该再收到 claim_tabs——已经走独立命令处理过了，重复带上只会
  // 在服务端撞见 reused=true 触发 CLAIM_REQUIRES_NEW_TASK。
  assert.equal(evaluateCalls.length, 1)
  assert.equal(evaluateCalls[0].claimTabs, undefined)
})

test('tabbit_browser claim_tabs failure on an existing task is a soft error; evaluation still runs', async () => {
  const tool = toolCtx({
    sessionTasks: () => ['existing-task'],
    rememberSessionTask: () => {},
    client: () => ({
      claimTabs: async () => {
        throw new TabbitCliError({ kind: 'tab-claim', code: 'TAB_OWNERSHIP_CONFLICT', message: 'tab 17 is owned by another task' })
      },
      evaluate: async () => ({
        status: 'succeeded',
        result: { value: 'ok' },
        task: { taskId: 't1', taskName: 'existing-task', reused: true },
        taskWasReset: false,
        notes: [],
      }),
      resolvedInstanceId: () => 'INSTANCE1',
    }),
  })
  const value = await tool.execute(
    { task: 'existing-task', code: 'return 1;', claim_tabs: [17] },
    { agent: { id: 's1' } },
  )
  assert.equal(value.status, 'succeeded')
  assert.equal(value.value, 'ok')
  assert.equal(value.claimError, 'tab 17 is owned by another task')
  assert.equal(value.claimedTabCount, undefined)
})

test('tabbit_browser claim_tabs on a brand-new task keeps the existing creation-time path unchanged', async () => {
  const claimCalls = []
  const evaluateCalls = []
  const tool = toolCtx({
    sessionTasks: () => [], // 会话里从没见过这个任务名 → 走老的创建时 --claim-tab 路径
    rememberSessionTask: () => {},
    client: () => ({
      claimTabs: async (task, tabIds) => {
        claimCalls.push({ task, tabIds })
        return {}
      },
      evaluate: async (request) => {
        evaluateCalls.push(request)
        return {
          status: 'succeeded',
          result: { value: 'ok' },
          task: { taskId: 't1', taskName: 'fresh-task', reused: false, claimedTabCount: 1 },
          taskWasReset: false,
          notes: [],
        }
      },
      resolvedInstanceId: () => 'INSTANCE1',
    }),
  })
  const value = await tool.execute({ task: 'fresh-task', code: 'return 1;', claim_tabs: [17] }, { agent: { id: 's1' } })
  assert.equal(value.status, 'succeeded')
  // 独立 claim 子命令完全没被调用——创建时 claim 才是正确路径。
  assert.equal(claimCalls.length, 0)
  assert.equal(evaluateCalls.length, 1)
  assert.deepEqual(evaluateCalls[0].claimTabs, [17])
  assert.equal(value.claimedTabCount, undefined)
  assert.equal(value.claimError, undefined)
})
