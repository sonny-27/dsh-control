import assert from 'node:assert/strict'
import test from 'node:test'
import { initialState, planProgress, reduceState, sortEntries, stateStatus, textOf, validId } from '../model.js'

test('task state excludes inherited history, reasoning, runtime notices and failed assistant fragments', () => {
  let state = initialState(5)
  state = reduceState(state, { seq: 0, type: 'todo/write', data: { todos: [{ content: 'inherited', status: 'completed' }] } })
  assert.equal(state.todos, null)
  state = reduceState(state, { seq: 5, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Not the task' }] } })
  assert.equal(state.task, '')
  state = reduceState(state, { seq: 6, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Review isolated module' }] } })
  state = reduceState(state, { seq: 7, type: 'assistant/message', data: { interrupted: true, message: { content: [{ type: 'text', text: 'Partial response' }] } } })
  assert.equal(state.task, 'Review isolated module'); assert.equal(state.latest, '')
  assert.equal(textOf([{ type: 'reasoning', text: 'Private reasoning' }, { type: 'text', text: 'Visible output' }]), 'Visible output')
})
test('plan progress counts only completed items and never invents progress from agent completion', () => {
  let state = reduceState(initialState(), { seq: 0, type: 'turn/start', data: { turn: 1 } })
  state = reduceState(state, { seq: 1, type: 'todo/write', data: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }] } })
  state = reduceState(state, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(planProgress(state).percent, 33)
  assert.equal(stateStatus(state, false, false), 'completed')
  state = reduceState(state, { seq: 3, type: 'turn/start', data: { turn: 2 } })
  assert.equal(planProgress(state).previousTurn, true)
  assert.equal(planProgress(initialState()), null)
  assert.equal(planProgress({ ...state, todos: [{ content: 'invalid', status: 'guess' }] }), null)
})
test('transient errors cannot mark an active agent failed; cancellation is not completion', () => {
  const state = { ...initialState(), reason: { kind: 'error' } }
  assert.equal(stateStatus(state, true, false), 'running')
  assert.equal(stateStatus(state, true, true), 'stopping')
  assert.equal(stateStatus({ ...state, reason: { kind: 'aborted' } }, false, false), 'stopped')
  assert.equal(stateStatus(state, false, false), 'error')
  assert.equal(stateStatus({ ...state, reason: { kind: 'completed' } }, false, true), 'completed', 'Pausing future work must not rewrite a completed result')
  assert.equal(stateStatus(state, false, true), 'error', 'A failed result remains failed after stopping its parent')
})
test('running agents sort first without mutating the caller array', () => {
  const items = [{ id: 'done', status: 'completed', updatedAt: 10, createdAt: 1 }, { id: 'run', status: 'running', updatedAt: 1, createdAt: 0 }, { id: 'bad', status: 'error', updatedAt: 9, createdAt: 1 }]
  assert.deepEqual(sortEntries(items).map(item => item.id), ['run', 'bad', 'done'])
  assert.equal(items[0].id, 'done')
  for (const id of ['', '..', 'a/b', 'a\\b', ' a', '\0']) assert.equal(validId(id), false)
  assert.equal(validId('session-test-123'), true)
})
