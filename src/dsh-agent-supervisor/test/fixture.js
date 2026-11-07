import { createSupervisor } from '../supervisor.js'
import { initialState, PROJECTION, reduceState } from '../model.js'
import { initialModelState, MODEL_PROJECTION, reduceModelState } from '../model-info.js'

export async function fixture(t, saved = { cascade: true, paused: [] }) {
  const agents = new Map(), sessions = new Map(), disk = new Map(), handlers = new Map(), writes = [], reads = [], disposedReads = []
  let clock = 1000
  const ctx = {
    agents: { get: id => agents.get(id), list: () => [...agents.values()], roots: () => [...agents.values()].filter(agent => !agent.session.header.parentSession), currentInitiator: () => undefined },
    get: name => name === 'goals' ? { get: agent => agent.session.goal } : undefined,
    sessions: { get: id => sessions.get(id) },
    logger: { warn() {} },
    sessionProjections: { snapshot(session) {
      let state = initialState(session.inheritedEventCount)
      let model = initialModelState(session.inheritedEventCount)
      for (const event of session.events) { state = reduceState(state, event); model = reduceModelState(model, event) }
      return { values: { [PROJECTION]: state, [MODEL_PROJECTION]: model, subagent: session.identity, subagentCatalog: session.catalog, goal: session.goal } }
    } },
    sessionQuery: { async observeSession(id, options) {
      options.signal?.throwIfAborted(); reads.push(id)
      const session = disk.get(id)
      if (!session) throw new Error('not found')
      return { header: session.header, inheritedEventCount: session.inheritedEventCount, events: session.events, projections: ctx.sessionProjections.snapshot(session), [Symbol.dispose]: () => disposedReads.push(id) }
    } },
    on(name, fn, options = {}) { const list = handlers.get(name) ?? []; options.prepend ? list.unshift(fn) : list.push(fn); handlers.set(name, list); return () => handlers.set(name, list.filter(item => item !== fn)) },
  }
  function emit(name, ...args) { for (const fn of [...(handlers.get(name) ?? [])]) fn(...args) }
  function add(id, parent, options = {}) {
    const session = { id, header: { id, origin: parent ? options.origin ?? 'subagent' : 'user', ...(parent ? { parentSession: parent } : {}), createdAt: ++clock },
      events: [], inheritedEventCount: 0, identity: parent ? { mode: options.mode ?? 'continuable', label: options.label ?? id } : null, catalog: [] }
    Object.defineProperty(session, 'seq', { get: () => session.events.length })
    session.snapshotEvents = (from = 0, to = session.seq) => session.events.slice(from, to)
    session.append = (type, data) => { const event = { seq: session.events.length, time: ++clock, type, data }; session.events.push(event); emit('session/event', session, event); return event }
    sessions.set(id, session)
    const agent = { id, session, status: options.running === false ? 'idle' : 'running', cancelled: [], controller: new AbortController(), hold: false,
      cancel(cause, cancelOptions) { this.cancelled.push({ cause, options: cancelOptions }); this.controller.abort(cause); if (!this.hold) { this.status = 'idle'; emit('agent/status', { agent: this, status: 'idle' }) } } }
    agents.set(id, agent)
    if (parent && session.header.origin === 'subagent') (sessions.get(parent) ?? disk.get(parent))?.catalog.push({ id, label: options.label ?? id, mode: options.mode ?? 'continuable', createdAt: session.header.createdAt })
    emit('agent/created', { agent })
    return agent
  }
  const store = { load: async () => { if (saved instanceof Error) throw saved; return saved }, save: async value => { writes.push(structuredClone(value)) }, flush: async () => {} }
  const supervisor = createSupervisor({ ctx, store, now: () => clock })
  await supervisor.init()
  t.after(() => supervisor.dispose())
  return { supervisor, ctx, agents, sessions, disk, writes, reads, disposedReads, add, emit,
    preStep(agent, turn = 1) { return (handlers.get('agent/pre-step') ?? [])[0]({ agent, signal: agent.controller.signal, turn }, () => Promise.resolve({ kind: 'enter' })) },
    cold(id) { const session = sessions.get(id); agents.delete(id); sessions.delete(id); disk.set(id, session) },
  }
}
