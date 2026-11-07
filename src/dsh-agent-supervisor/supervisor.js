import { randomUUID } from 'node:crypto'
import { initialState, planProgress, PROJECTION, sortEntries, stateStatus, statusDetail, textOf, validId } from './model.js'
import { createModelReader, MODEL_PROJECTION, resolveModelInfo } from './model-info.js'

export function supervisorError(status, message) { return Object.assign(new Error(message), { status }) }

export function createSupervisor({ ctx, store, now = Date.now, maxEntries = 2000 }) {
  let cascade = true, persistenceError = '', closed = false
  const paused = new Map(), knownHeaders = new Map(), cold = new Map(), watched = new WeakSet(), signalDisposers = new Set(), turnWatches = new Map()
  const models = createModelReader()
  const observedUserStops = new WeakMap(), consumedGoalResumes = new WeakMap()
  const sessionOf = id => ctx.agents.get(id)?.session ?? ctx.sessions.get(id)
  const remember = header => { if (header && validId(header.id)) knownHeaders.set(header.id, header) }
  function lineage(agent) {
    let id = agent.id, header = agent.session.header
    const seen = new Set(), ids = []
    while (validId(id) && !seen.has(id)) {
      seen.add(id); ids.push(id)
      if (header?.origin !== 'subagent' || !validId(header.parentSession)) break
      id = header.parentSession
      header = sessionOf(id)?.header ?? knownHeaders.get(id)
    }
    return ids
  }
  function pausedAncestor(agent) {
    for (const id of lineage(agent)) if (paused.has(id)) return paused.get(id)
    return null
  }
  function persist() {
    return store.save({ cascade, paused: [...paused.values()] }).then(() => { persistenceError = '' }, error => {
      persistenceError = String(error.message ?? error).slice(0, 240)
      ctx.logger?.warn('agent-supervisor: state persistence failed: ' + persistenceError)
    })
  }
  function currentState(session) {
    return ctx.sessionProjections.snapshot(session, [PROJECTION, MODEL_PROJECTION, 'subagent', 'subagentCatalog']).values
  }
  async function read(id, signal, refresh = false) {
    signal?.throwIfAborted()
    const session = sessionOf(id)
    if (session) {
      remember(session.header)
      const values = { ...currentState(session) }
      values[MODEL_PROJECTION] = models.session(session, signal) ?? values[MODEL_PROJECTION]
      return { header: session.header, values }
    }
    const cached = cold.get(id)
    if (!refresh && cached && now() - cached.at < 15000) return cached.value
    const observation = await ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'all' })
    try {
      remember(observation.header)
      const values = { ...observation.projections?.values }
      values[MODEL_PROJECTION] = models.observation(observation, signal) ?? values[MODEL_PROJECTION]
      const value = { header: observation.header, values }
      cold.set(id, { at: now(), value })
      if (cold.size > maxEntries + 1) cold.delete(cold.keys().next().value)
      return value
    } finally { observation[Symbol.dispose]?.() }
  }
  function cancelExact(agent, cause) {
    if (ctx.agents.get(agent.id) !== agent) return false
    // Keep accepted messages in the native inbox; the wake guard, not deletion, holds them.
    agent.cancel(cause, { keepInbox: true })
    return true
  }
  function stopLiveTree(id, userRoot = true) {
    if (!validId(id)) throw supervisorError(400, '会话 ID 无效')
    const root = ctx.agents.get(id)
    if (root) remember(root.session.header)
    if (!paused.has(id)) paused.set(id, { id, token: randomUUID(), at: now() })
    const targets = ctx.agents.list().filter(agent => lineage(agent).includes(id)).sort((a, b) => lineage(b).indexOf(id) - lineage(a).indexOf(id)), failures = []
    for (const agent of targets) {
      try { cancelExact(agent, { kind: agent.id === id && userRoot ? 'user' : 'parent' }) }
      catch (error) { failures.push({ id: agent.id, error: textOf(String(error.message ?? error), 180) }) }
    }
    void persist()
    return { requested: targets.length, failures }
  }
  function watchTurn(agent, signal, turn) {
    if (!signal || watched.has(signal)) return
    watched.add(signal)
    turnWatches.get(agent)?.remove()
    const stop = () => {
      if (closed || !cascade || signal.reason?.kind !== 'user' || ctx.agents.get(agent.id) !== agent) return
      if (Number.isSafeInteger(turn)) observedUserStops.set(agent, Math.max(observedUserStops.get(agent) ?? -1, turn))
      if (paused.has(agent.id)) return
      stopLiveTree(agent.id, false)
    }
    const remove = () => {
      signal.removeEventListener('abort', stop); signal.removeEventListener('abort', remove); signalDisposers.delete(remove)
      if (turnWatches.get(agent)?.signal === signal) turnWatches.delete(agent)
    }
    turnWatches.set(agent, { signal, turn, remove })
    signalDisposers.add(remove)
    signal.addEventListener('abort', stop, { once: true })
    signal.addEventListener('abort', remove, { once: true })
    if (signal.aborted) { stop(); remove() }
  }
  function acknowledgeExplicitGoalResume({ agent, change }) {
    if (closed || !agent || ctx.agents.get(agent.id) !== agent || change?.operation !== 'resume') return
    // Only a host/user mutation on the exact live runtime root may reopen its stop latch.
    // Model tool execution carries an initiator; background goal prompts carry no resume mutation.
    if (typeof ctx.agents.currentInitiator !== 'function' || ctx.agents.currentInitiator() !== undefined) return
    if (typeof ctx.agents.roots !== 'function' || !ctx.agents.roots().includes(agent)) return
    const ref = change.ref, goal = ctx.get?.('goals')?.get(agent)
    if (!ref || !goal || goal.id !== ref.id || goal.revision !== ref.revision || goal.phase !== 'active' || goal.activation !== 'armed') return
    const session = agent.session, seq = session.seq - 1
    if (!Number.isSafeInteger(seq) || seq < 0 || seq <= (consumedGoalResumes.get(session) ?? -1)) return
    const event = session.snapshotEvents(seq, seq + 1)[0]
    if (event?.type !== 'goal/change' || event.data?.operation !== 'resume' || event.data.goal?.id !== ref.id || event.data.goal.revision !== ref.revision) return
    consumedGoalResumes.set(session, seq)
    if (paused.delete(agent.id)) void persist()
  }
  const disposers = []
  function installHooks() {
    // Run before the native goal driver queues work or emits the next running edge.
    disposers.push(ctx.on('goal/changed', acknowledgeExplicitGoalResume, { prepend: true }))
    disposers.push(ctx.on('agent/pre-step', (event, next) => {
      const { agent, signal } = event
      remember(agent.session.header); watchTurn(agent, signal, event.turn)
      if (pausedAncestor(agent)) {
        cancelExact(agent, { kind: 'parent' })
        return { kind: 'reject' }
      }
      return next()
    }))
    disposers.push(ctx.on('agent/created', ({ agent }) => {
      remember(agent.session.header)
      if (pausedAncestor(agent) && agent.status === 'running') cancelExact(agent, { kind: 'parent' })
    }))
    disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'running' && pausedAncestor(agent)) cancelExact(agent, { kind: 'parent' })
    }))
    disposers.push(ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      // Only an explicit user input to this exact paused root reopens its tree.
      if (message.source?.kind === 'user' && paused.delete(agent.id)) void persist()
    }))
    disposers.push(ctx.on('agent/disposed', ({ agent }) => { cold.delete(agent.id); turnWatches.get(agent)?.remove() }))
    disposers.push(ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = ctx.agents.get(session.id), watch = turnWatches.get(agent)
      if (watch && watch.turn === event.data.turn) watch.remove()
      // Catch an already-running turn that predates this plugin's signal hook.
      if (agent && agent.session === session && cascade && event.data.reason?.kind === 'aborted' && event.data.reason.reason?.kind === 'user') {
        const turn = event.data.turn
        if (Number.isSafeInteger(turn) && turn <= (observedUserStops.get(agent) ?? -1)) return
        if (Number.isSafeInteger(turn)) observedUserStops.set(agent, turn)
        if (!paused.has(agent.id)) stopLiveTree(agent.id, false)
      }
    }))
    for (const agent of ctx.agents.list()) {
      remember(agent.session.header)
      if (pausedAncestor(agent) && agent.status === 'running') cancelExact(agent, { kind: 'parent' })
    }
  }
  async function init() {
    try {
      const saved = await store.load()
      cascade = saved.cascade
      for (const item of saved.paused) paused.set(item.id, item)
    } catch (error) { cascade = false; persistenceError = '状态不可读，联动停止已禁用：' + String(error.message ?? error).slice(0, 180) }
    installHooks()
  }
  async function snapshot(rootId, signal, refresh = false) {
    if (!validId(rootId)) throw supervisorError(400, '请选择有效会话')
    const root = await read(rootId, signal, refresh).catch(error => {
      if (signal?.aborted) throw error
      throw supervisorError(404, '主会话不可用，请重新打开会话')
    })
    const live = ctx.agents.list(), children = new Map()
    for (const agent of live) {
      const header = agent.session.header
      remember(header)
      if (header.origin !== 'subagent' || !validId(header.parentSession)) continue
      const list = children.get(header.parentSession) ?? []
      list.push({ id: agent.id, createdAt: header.createdAt, mode: 'unknown' }); children.set(header.parentSession, list)
    }
    let rootState = root.values[PROJECTION] ?? initialState()
    const queue = [{ id: rootId, source: root, depth: 0 }], visited = new Set([rootId]), entries = [], warnings = []
    let truncated = false
    while (queue.length) {
      signal?.throwIfAborted()
      const parent = queue.shift()
      const catalog = new Map()
      for (const child of [...(children.get(parent.id) ?? []), ...(parent.source.values.subagentCatalog ?? [])]) if (validId(child.id)) catalog.set(child.id, child)
      for (const entry of catalog.values()) {
        if (visited.has(entry.id)) continue
        if (entries.length >= maxEntries) { truncated = true; break }
        visited.add(entry.id)
        const base = { id: entry.id, parentId: parent.id, parentLabel: textOf(parent.source.values.subagent?.label, 120) || parent.id, depth: parent.depth + 1, createdAt: entry.createdAt ?? 0, label: textOf(entry.label, 120) || entry.id, mode: entry.mode ?? 'unknown', updatedAt: 0 }
        try {
          const previouslyRead = await read(entry.id, signal, refresh)
          // The asynchronous read can finish across a turn boundary. Sample the
          // live agent and its projection together, after the await, rather than
          // mixing an old open log with a newly idle runtime.
          const agent = ctx.agents.get(entry.id), localSession = agent?.session ?? ctx.sessions.get(entry.id)
          const source = localSession ? { header:localSession.header, values:{...currentState(localSession)} } : previouslyRead
          if(localSession)source.values[MODEL_PROJECTION]=models.session(localSession,signal)??source.values[MODEL_PROJECTION]
          if (source.header.origin !== 'subagent' || source.header.parentSession !== parent.id) {
            warnings.push({ id: entry.id, message: '目录与实际父子归属不一致，已排除' }); continue
          }
          const state = source.values[PROJECTION] ?? initialState()
          const identity = source.values.subagent
          const pausedBy = pausedAncestor(agent ?? { id: entry.id, session: { header: source.header } })
          const status = !agent && state.open ? 'unknown' : stateStatus(state, agent?.status === 'running', !!pausedBy)
          entries.push({ ...base, mode: identity?.mode ?? base.mode, label: textOf(identity?.label, 120) || base.label,
            status, statusPending:status==='unknown'&&state.open, statusDetail:statusDetail(state,status,pausedBy,entry.id),statusAt:(status==='stopped'||status==='stopping')&&pausedBy?.at?pausedBy.at:state.updatedAt,
            running: agent?.status === 'running', paused: paused.get(entry.id) ?? null, turnEpoch: state.turnEpoch,
            task: state.task || base.label, latest: state.latest,
            model: resolveModelInfo(source.values[MODEL_PROJECTION], agent?.options),
            error: status === 'error' ? textOf(state.reason?.error?.message ?? state.reason?.reason?.reason ?? state.reason?.kind, 220) : '',
            plan: planProgress(state), updatedAt: state.updatedAt, openable: true,
          })
          queue.push({ id: entry.id, source, depth: base.depth })
        } catch (error) {
          if (signal?.aborted) throw error
          entries.push({ ...base, status: 'unknown', running: false, task: base.label, latest: '', error: '子代理记录暂不可读', model: null, plan: null, openable: false, turnEpoch: -1 })
        }
      }
      if (truncated) break
    }
    const rootAgent = ctx.agents.get(rootId)
    if(rootAgent)rootState=currentState(rootAgent.session)[PROJECTION]??rootState
    const rootPause = pausedAncestor(rootAgent ?? { id: rootId, session: { header: root.header } })
    return { apiVersion: 1, rootId, rootEpoch: rootState.turnEpoch, rootRunning: rootAgent?.status === 'running', paused: rootPause,
      cascade, persistenceError, entries: sortEntries(entries), warnings, truncated, asOf: now(),
      counts: { total: entries.length, running: entries.filter(item => item.status === 'running').length, stopping: entries.filter(item => item.status === 'stopping').length, completed: entries.filter(item => item.status === 'completed').length, error: entries.filter(item => item.status === 'error').length, unknown: entries.filter(item => item.status === 'unknown').length },
    }
  }
  async function control(request, signal) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw supervisorError(400, '控制请求无效')
    const { rootId, action } = request
    const state = await snapshot(rootId, signal)
    if (action === 'options') {
      if (typeof request.cascade !== 'boolean') throw supervisorError(400, '联动开关无效')
      cascade = request.cascade; await persist()
    } else if (action === 'resume') {
      if (!state.paused || request.token !== state.paused.token || paused.get(state.paused.id)?.token !== request.token) throw supervisorError(409, '暂停状态已变化，请刷新后重试')
      paused.delete(state.paused.id); await persist()
    } else if (action === 'stop' || action === 'stop-branch') {
      const targetId = action === 'stop' ? rootId : request.targetId
      const target = action === 'stop' ? { turnEpoch: state.rootEpoch } : state.entries.find(item => item.id === targetId && item.openable)
      if (!target) throw supervisorError(403, '目标不属于当前任务树')
      if (request.turnEpoch !== target.turnEpoch) throw supervisorError(409, '目标已进入新一轮，请刷新后重试')
      const liveState = sessionOf(targetId)
      if (liveState && currentState(liveState)[PROJECTION]?.turnEpoch !== request.turnEpoch) throw supervisorError(409, '目标已进入新一轮，请刷新后重试')
      const result = stopLiveTree(targetId)
      await store.flush?.().catch(() => {})
      return { ...await snapshot(rootId, signal), result }
    } else throw supervisorError(400, '未知控制操作')
    return snapshot(rootId, signal)
  }
  async function dispose() {
    closed = true
    for (const remove of signalDisposers) remove()
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
    await store.flush?.().catch(() => {})
  }
  return { init, snapshot, control, dispose, stopLiveTree, pausedAncestor, watchTurn }
}
