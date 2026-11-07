import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

let plugin
vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(registration) { plugin = registration.factory(() => ({})) } } },
  URLSearchParams, AbortController, setTimeout, clearTimeout,
})
test('opening a child uses the exact direct-parent native sidebar address without navigating the main conversation', () => {
  const calls = []
  const ctx = { sidebarRight: { openResource: (...args) => calls.push(args) }, uiWorkspace: { openSession() { assert.fail('Must not replace the main conversation') } } }
  plugin.openChild(ctx, { openable: true, id: 'grand child', parentId: 'child-parent', mode: 'continuable' })
  const url = new URL(calls[0][0])
  assert.equal(url.hostname, 'subagentchat'); assert.equal(decodeURIComponent(url.pathname), '/session/grand child')
  assert.equal(url.searchParams.get('parent'), 'child-parent'); assert.equal(url.searchParams.get('mode'), 'continuable')
  assert.equal(calls[0][1].preferNewPane, false)
  assert.throws(() => plugin.nativeAddress({ openable: false, id: 'bad' }))
})
test('status CSS separates pulse, completion, errors and reduced-motion rendering', () => {
  assert.match(plugin.css, /\.das-dot\.running\{animation:/)
  assert.match(plugin.css, /\.das-dot\.error\{background:#cc3045/)
  assert.match(plugin.css, /prefers-reduced-motion:reduce/)
  assert.doesNotMatch(plugin.css, /\.das-dot\.completed\{animation:/)
})
test('plugin does not render an independent stop button', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /IconStop|action: 'stop'|action: 'stop-branch'/)
})
test('title-bar entry is removed while the composer dock entry remains', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /conversation\.session\.header\.actions/)
  assert.match(source, /conversation\.input\.dock/)
})

test('an unconfirmed terminal state is labeled syncing, while real cancellation stays stopped', () => {
  assert.equal(plugin.statusLabel({status:'unknown',statusPending:true}),'同步中')
  assert.equal(plugin.statusLabel({status:'stopped',statusPending:false}),'已中止')
  assert.equal(plugin.statusLabel({status:'completed',statusPending:false}),'已完成')
})
