import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './fixture.js'

const goalChange = (operation = 'resume', phase = 'active', revision = 10) => ({
  kind: 'goal/change', version: 1, operation,
  goal: { id: 'isolated-goal', revision, objective: 'Isolated lifecycle test', phase, maxGoalRounds: 256 },
  roundsStarted: 17, createdAt: 1, updatedAt: 2,
})

function commitGoalChange(f, agent, change = goalChange()) {
  agent.session.append('goal/change', change)
  agent.session.goal = { ...change.goal, roundsStarted: change.roundsStarted, activation: 'armed' }
  f.emit('goal/changed', { agent, change: {
    operation: change.operation,
    ref: { id: change.goal.id, revision: change.goal.revision },
    goal: { ...change.goal, roundsStarted: change.roundsStarted, activation: 'armed' },
  } })
}

async function stoppedRoot(t) {
  const f = await fixture(t), root = f.add('root')
  root.session.append('turn/start', { turn: 103 })
  await f.preStep(root, 103)
  root.cancel({ kind: 'user' }, { keepInbox: true })
  root.session.append('turn/end', { turn: 103, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.ok((await f.supervisor.snapshot('root')).paused)
  root.controller = new AbortController()
  root.status = 'idle'
  return { ...f, root }
}

test('an explicit committed goal resume releases the exact root stop latch before goal admission', async t => {
  const f = await stoppedRoot(t)
  const resumes = goalChange()
  commitGoalChange(f, f.root, resumes)
  const cancellations = f.root.cancelled.length
  const admitted = await f.preStep(f.root)
  assert.equal((await f.supervisor.snapshot('root')).paused, null,
    'manual goal resume must not be immediately canceled by the previous root stop latch')
  assert.deepEqual(admitted, { kind: 'enter' })
  assert.equal(f.root.cancelled.length, cancellations)
  assert.equal(resumes.roundsStarted, 17)
  assert.equal(resumes.goal.maxGoalRounds, 256)
})

test('ordinary automatic goal messages and active goal updates do not resume a stopped tree', async t => {
  const f = await stoppedRoot(t)
  commitGoalChange(f, f.root, goalChange('update'))
  f.root.session.append('agent/inbox/spliced', {
    target: 'next-turn', start: 0,
    inserted: [{ id: 'automatic-continuation', role: 'user', source: { kind: 'goal', goalId: 'isolated-goal', revision: 10 }, content: [] }],
  })
  await f.preStep(f.root)
  assert.ok((await f.supervisor.snapshot('root')).paused)
  assert.equal(f.root.controller.signal.aborted, true)
})

test('a child goal resume cannot release an ancestor stop or a separately paused sibling', async t => {
  const f = await stoppedRoot(t)
  const child = f.add('child', 'root', { running: false })
  commitGoalChange(f, child)
  assert.equal((await f.supervisor.snapshot('root')).paused?.id, 'root')
})

test('cold or mismatched session replay cannot authorize a root resume', async t => {
  const f = await stoppedRoot(t)
  f.emit('session/event', { ...f.root.session }, { type: 'goal/change', seq: f.root.session.seq, time: 3, data: goalChange() })
  assert.ok((await f.supervisor.snapshot('root')).paused)
  f.cold('root')
  f.emit('session/event', f.root.session, { type: 'goal/change', seq: f.root.session.seq, time: 4, data: goalChange() })
  assert.ok((await f.supervisor.snapshot('root')).paused)
})

test('a model-originated goal resume does not clear a human stop latch', async t => {
  const f = await stoppedRoot(t)
  f.ctx.agents.currentInitiator = () => f.root
  commitGoalChange(f, f.root)
  assert.ok((await f.supervisor.snapshot('root')).paused)
})

test('a delayed end of an already-observed stop cannot re-latch after explicit resume', async t => {
  const f = await fixture(t), root = f.add('root')
  root.session.append('turn/start', { turn: 103 })
  await f.preStep(root, 103)
  root.cancel({ kind: 'user' }, { keepInbox: true })
  commitGoalChange(f, root)
  root.session.append('turn/end', { turn: 103, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.equal((await f.supervisor.snapshot('root')).paused, null)
})

test('replaying an old resume cannot clear a newer human stop', async t => {
  const f = await stoppedRoot(t)
  commitGoalChange(f, f.root)
  f.supervisor.stopLiveTree(f.root.id)
  f.emit('goal/changed', { agent: f.root, change: { operation: 'resume', ref: { id: 'isolated-goal', revision: 10 } } })
  assert.ok((await f.supervisor.snapshot('root')).paused)
})

test('a goal event without an exact committed current revision does not clear a stop', async t => {
  const f = await stoppedRoot(t)
  f.root.session.goal = { ...goalChange().goal, activation: 'armed' }
  f.emit('goal/changed', { agent: f.root, change: { operation: 'resume', ref: { id: 'isolated-goal', revision: 10 } } })
  assert.ok((await f.supervisor.snapshot('root')).paused)
})

test('resuming one root does not release another root or separately paused branch', async t => {
  const f = await stoppedRoot(t), other = f.add('other', undefined, { running: false }), child = f.add('child', 'root', { running: false })
  f.supervisor.stopLiveTree(other.id)
  f.supervisor.stopLiveTree(child.id)
  commitGoalChange(f, f.root)
  assert.equal((await f.supervisor.snapshot('root')).paused, null)
  assert.equal((await f.supervisor.snapshot('other')).paused?.id, 'other')
  assert.equal((await f.supervisor.snapshot('child')).paused?.id, 'child')
})
