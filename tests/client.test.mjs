// client/client.js（web 客户端插件）的冒烟测试：模拟宿主的 ModuleLoader
// 装载协议取出工厂，用假宿主服务驱动 apply，验证 @tab 输入源的注册，以及
// 客户端【不再】向宿主注册任何会话节点/聊天插槽（issue #22 的回归守卫：
// 状态卡曾靠一条自定义会话事件驱动，那条事件会让整个会话冷加载失败）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

/* 装载一次 client.js 并返回其模块导出。客户端零依赖：工厂不应 require 任何东西。 */
function loadClient() {
  globalThis.window = { __ModuleLoader__: { load: (handoff) => { globalThis.__handoff = handoff } } }
  eval(readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'))
  return globalThis.__handoff.factory((spec) => {
    throw new Error(`unexpected require: ${spec}`)
  })
}

/*
 * 宿主服务的最小假件。刻意把两代会话节点服务和 slots 都摆出来：客户端
 * 不该碰它们中的任何一个——requested 记录 ctx.get 被问过哪些服务，
 * registeredNodes / slotRegistrations 记录真实的注册结果。
 */
function mockServices({ requested, registeredNodes, slotRegistrations, sources, withInputTriggers = true }) {
  return {
    get(name) {
      requested.push(name)
      if (name === 'inputTriggers' && withInputTriggers) {
        return { registerSource: (source) => { sources.push(source); return () => {} } }
      }
      if (name === 'uiConversation') {
        return { events: { register: (definition) => { registeredNodes.push(definition); return () => {} } } }
      }
      if (name === 'conversationEvents') {
        return { register: (definition) => { registeredNodes.push(definition); return () => {} } }
      }
      if (name === 'slots') {
        return {
          inject: (slot, callback) => { slotRegistrations.push({ slot, callback }); return () => {} },
          register: (spec, view) => ({ spec, view }),
        }
      }
      return undefined
    },
    effect(fn) { const cleanup = fn(); return () => cleanup?.() },
  }
}

test('registers the @tab source and nothing else', () => {
  const client = loadClient()
  assert.equal(client.name, 'dsh-tabbit-client')
  assert.deepEqual(client.inject, ['inputTriggers'])

  const requested = []
  const registeredNodes = []
  const slotRegistrations = []
  const sources = []
  client.apply(mockServices({ requested, registeredNodes, slotRegistrations, sources }))

  assert.equal(sources.length, 1)
  assert.equal(typeof sources[0].name, 'string')

  // issue #22 回归守卫：不注册会话节点、不占聊天插槽，也不去探测那几个服务。
  assert.equal(registeredNodes.length, 0)
  assert.equal(slotRegistrations.length, 0)
  assert.deepEqual(requested, ['inputTriggers'])
})

test('stays silent when the input-trigger service is missing', () => {
  const client = loadClient()
  const requested = []
  const sources = []
  client.apply(mockServices({
    requested, registeredNodes: [], slotRegistrations: [], sources, withInputTriggers: false,
  }))
  assert.equal(sources.length, 0)
})
