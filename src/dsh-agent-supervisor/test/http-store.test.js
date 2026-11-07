import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateStore } from '../state-store.js'
import { createHandlers } from '../http.js'

test('state store serializes saves, restores pauses and contains no conversation content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-state-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStateStore(join(root, 'plugin'))
  assert.deepEqual(await store.load(), { cascade: true, paused: [] })
  const first = { cascade: true, paused: [{ id: 'root', at: 1, token: 'a' }] }, last = { cascade: false, paused: [] }
  await Promise.all([store.save(first), store.save(last)])
  assert.deepEqual(await store.load(), last)
  const content = await readFile(join(root, 'plugin/state.json'), 'utf8')
  assert.doesNotMatch(content, /content|prompt|message|credential/)
})
test('state storage refuses a directory junction instead of writing through it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-junction-')); t.after(() => rm(root, { recursive: true, force: true }))
  const outside = join(root, 'outside'); await mkdir(outside)
  const linked = join(root, 'linked'); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createStateStore(linked).save({ cascade: true, paused: [] }), /普通目录/)
})
test('HTTP guards reject cross-site reads and malformed controls without any cancellation', async t => {
  let controls = 0, reads = 0
  const handlers = createHandlers({ snapshot: async rootId => { reads++; return { rootId } }, control: async body => { controls++; return { rootId: body.rootId } } })
  const server = createServer((req, res) => (req.url.startsWith('/state') ? handlers.state : handlers.control)(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(base + '/state?root=root', { headers: { origin: 'https://other.invalid' } })).status, 403)
  const post = (body, headers = {}) => fetch(base + '/control', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
  assert.equal((await post('{}', { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await post('{')).status, 400)
  assert.equal((await post('{}', { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post('x'.repeat(16385))).status, 413)
  assert.equal(controls, 0); assert.equal(reads, 0)
  assert.equal((await fetch(base + '/state?root=root')).status, 200)
  assert.equal((await post('{"rootId":"root"}')).status, 200)
  assert.equal(controls, 1)
})
