import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelReader, initialModelState, modelStateFromEvents, reduceModelState, resolveModelInfo } from '../model-info.js'

const header = (seq, model, provider = 'isolated-ai', reasoningEffort = 'high') => ({ seq, type: 'request/header', data: { header: { config: { model, provider, reasoningEffort } } } })
test('inherited model headers never become the child model', () => {
  let state = reduceModelState(initialModelState(10), header(2, 'parent-model'))
  assert.equal(resolveModelInfo(state), null)
  state = reduceModelState(state, header(10, 'child-model'))
  assert.equal(resolveModelInfo(state).id, 'child-model')
  assert.equal(resolveModelInfo(state).source, 'request')
})
test('resolved request models override declared options and update on route changes', () => {
  let state = reduceModelState(initialModelState(), header(0, 'resolved-model'))
  assert.equal(resolveModelInfo(state, { model: 'configured-model' }).id, 'resolved-model')
  state = reduceModelState(state, header(1, 'new-model', 'new-provider', 'xhigh'))
  assert.deepEqual(resolveModelInfo(state), { id: 'new-model', provider: 'new-provider', reasoningEffort: 'xhigh', source: 'request' })
})
test('request context retains matching effort but never carries effort across a different model', () => {
  let state = reduceModelState(initialModelState(), header(0, 'first'))
  state = reduceModelState(state, { seq: 1, type: 'request/context', data: { provider: 'isolated-ai', model: 'first' } })
  assert.equal(resolveModelInfo(state).reasoningEffort, 'high')
  state = reduceModelState(state, { seq: 2, type: 'request/context', data: { provider: 'isolated-ai', model: 'second' } })
  assert.equal(resolveModelInfo(state).id, 'second'); assert.equal(resolveModelInfo(state).reasoningEffort, '')
})
test('subagent backend names are not mistaken for AI providers and the first own descriptor is authoritative', () => {
  let state = reduceModelState(initialModelState(), { seq: 0, type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'fork', agentModel: 'configured-child', agentProvider: 'child-ai', agentReasoningEffort: 'medium' } })
  state = reduceModelState(state, { seq: 1, type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', agentModel: 'unexpected-replacement' } })
  assert.deepEqual(resolveModelInfo(state), { id: 'configured-child', provider: 'child-ai', reasoningEffort: 'medium', source: 'configured' })
  const oneshot = reduceModelState(initialModelState(), { seq: 0, type: 'subagent/descriptor', data: { version: 3, mode: 'one-shot', provider: 'spawn' } })
  assert.equal(resolveModelInfo(oneshot), null)
})
test('explicit child runtime options are labeled configuration and missing models remain unknown', () => {
  assert.deepEqual(resolveModelInfo(initialModelState(), { model: 'child-option', provider: 'own-ai' }), { id: 'child-option', provider: 'own-ai', reasoningEffort: '', source: 'configured' })
  assert.equal(resolveModelInfo(initialModelState(), { provider: 'only-provider' }), null)
  assert.equal(resolveModelInfo(initialModelState(), { model: 123 }), null)
})
test('raw Session fallback is incremental and still excludes inherited parent models', () => {
  const events = [header(0, 'parent'), { seq: 1, type: 'turn/end', data: {} }, header(2, 'child')], reads = []
  const session = { inheritedEventCount: 2, get seq() { return events.length }, snapshotEvents(from,to) { reads.push([from,to]); return events.slice(from,to) } }
  const reader = createModelReader()
  assert.equal(resolveModelInfo(reader.session(session)).id, 'child')
  reader.session(session); assert.deepEqual(reads, [[2,3]])
  events.push(header(3, 'changed-child'))
  assert.equal(resolveModelInfo(reader.session(session)).id, 'changed-child')
  assert.deepEqual(reads, [[2,3],[3,4]])
  events.length = 2
  assert.equal(resolveModelInfo(reader.session(session)), null)
})
test('observation fallback requires a proven inherited cut and obeys cancellation', () => {
  const reader = createModelReader()
  assert.equal(reader.observation({ events: [header(0,'unknown-owner')] }), null)
  assert.equal(resolveModelInfo(reader.observation({ events: [header(0,'parent'),header(1,'child')], inheritedEventCount: 1 })).id, 'child')
  const abort = new AbortController(); abort.abort(new Error('isolated abort'))
  assert.throws(() => modelStateFromEvents([],0,abort.signal), /isolated abort/)
})
