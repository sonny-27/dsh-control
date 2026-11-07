export const MODEL_PROJECTION = 'agentSupervisorModel'

function field(value, limit = 160) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : ''
}
function configuredModel(config) {
  const id = field(config?.model)
  if (!id) return null
  return { id, provider: field(config?.provider), reasoningEffort: field(config?.reasoningEffort, 40) }
}
export function initialModelState(inherited = 0) {
  return { inherited, descriptorSeen: false, request: null, configured: null }
}
export function reduceModelState(state, event) {
  if (event.seq < state.inherited) return state
  if (event.type === 'request/header') return { ...state, request: configuredModel(event.data?.header?.config) }
  if (event.type === 'request/context') {
    const request = configuredModel(event.data)
    if (!request || state.request?.id === request.id && state.request.provider === request.provider) return state
    return { ...state, request }
  }
  if (event.type === 'subagent/descriptor' && !state.descriptorSeen) {
    const data = event.data
    // `provider` here names the subagent backend, not the AI provider.
    const configured = data?.version === 3 && data.mode === 'continuable' ? configuredModel({
      provider: data.agentProvider, model: data.agentModel, reasoningEffort: data.agentReasoningEffort,
    }) : null
    return { ...state, descriptorSeen: true, configured }
  }
  return state
}
export function resolveModelInfo(state, liveOptions) {
  if (state?.request?.id) return { ...state.request, source: 'request' }
  const configured = configuredModel(liveOptions) ?? state?.configured
  return configured?.id ? { ...configured, source: 'configured' } : null
}
export function modelStateFromEvents(events, inherited, signal, previous) {
  signal?.throwIfAborted()
  if (!Array.isArray(events) || !Number.isSafeInteger(inherited) || inherited < 0) return null
  let state = previous ?? initialModelState(inherited)
  for (let index = 0; index < events.length; index++) {
    if (index % 512 === 0) signal?.throwIfAborted()
    state = reduceModelState(state, events[index])
  }
  return state
}
export function createModelReader() {
  const cache = new WeakMap()
  return {
    session(session, signal) {
      signal?.throwIfAborted()
      const cut = session.inheritedEventCount, cursor = session.seq
      if (!Number.isSafeInteger(cut) || cut < 0 || !Number.isSafeInteger(cursor) || cursor < cut || typeof session.snapshotEvents !== 'function') return null
      const old = cache.get(session)
      const usable = old && old.cut === cut && old.cursor <= cursor
      if (usable && old.cursor === cursor) return old.state
      const events = session.snapshotEvents(usable ? old.cursor : cut, cursor)
      const state = modelStateFromEvents(events, cut, signal, usable ? old.state : undefined)
      cache.set(session, { cut, cursor, state })
      return state
    },
    observation(source, signal) { return modelStateFromEvents(source.events, source.inheritedEventCount, signal) },
  }
}
