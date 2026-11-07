export const PROJECTION = 'agentSupervisor'
export const STATUS_ORDER = { running: 0, stopping: 1, error: 2, blocked: 3, waiting: 4, stopped: 5, completed: 6, unknown: 7 }

export function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f/\\]/.test(value) && value !== '.' && value !== '..'
}
export function textOf(content, limit = 280) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : ''
  return text.replace(/\s+/g, ' ').trim().slice(0, limit)
}
export function initialState(inherited = 0) {
  return { inherited, task: '', latest: '', todos: null, planTurn: null, turn: 0, turnEpoch: -1, open: false, reason: null, updatedAt: 0 }
}
export function reduceState(state, event) {
  if (event.seq < state.inherited) return state
  const { type, data = {} } = event
  if (type === 'subagent/descriptor') return { ...initialState(state.inherited), updatedAt: event.time ?? 0 }
  if (type === 'turn/start') return { ...state, turn: data.turn, turnEpoch: event.seq, open: true, reason: null, updatedAt: event.time ?? state.updatedAt }
  if (type === 'turn/end') return { ...state, open: false, reason: data.reason ?? null, updatedAt: event.time ?? state.updatedAt }
  if (type === 'user/message' && data.source?.kind === 'user' && !state.task) return { ...state, task: textOf(data.content), updatedAt: event.time ?? state.updatedAt }
  if (type === 'assistant/message' && data.interrupted !== true) {
    const latest = textOf(data.message?.content ?? data.content, 220)
    if (latest) return { ...state, latest, updatedAt: event.time ?? state.updatedAt }
  }
  if (type === 'todo/write' && Array.isArray(data.todos)) return {
    ...state, todos: data.todos.map(item => ({ content: textOf(item.content, 300), status: item.status })), planTurn: state.turn,
    updatedAt: event.time ?? state.updatedAt,
  }
  return state
}
export function planProgress(state) {
  if (!Array.isArray(state.todos) || state.todos.length === 0) return null
  if (state.todos.some(item => !['pending', 'in_progress', 'completed'].includes(item.status))) return null
  const total = state.todos.length, completed = state.todos.filter(item => item.status === 'completed').length
  return { total, completed, active: state.todos.filter(item => item.status === 'in_progress').length, percent: Math.round(completed / total * 100), previousTurn: state.planTurn !== state.turn, items: state.todos.slice(0, 200), truncated: total > 200 }
}
export function stateStatus(state, running, paused) {
  if (running) return paused ? 'stopping' : 'running'
  const kind = state.reason?.kind
  if (kind === 'completed') return 'completed'
  if (kind === 'error' || kind === 'max-tokens') return 'error'
  if (kind === 'blocked') return 'blocked'
  if (paused || kind === 'aborted' || kind === 'interrupted') return 'stopped'
  if (state.open) return 'unknown'
  return 'waiting'
}
export function statusDetail(state, status, pausedBy, id) {
  if(status==='unknown'&&state.open)return '日志尚未记录结束，等待运行状态同步'
  if(status==='stopped'||status==='stopping'){
    if(pausedBy)return pausedBy.id===id?'本任务处于暂停锁定状态':'上级任务树暂停，子任务联动停止'
    const reason=state.reason?.reason?.kind
    return reason==='parent'?'父会话停止后联动中止':reason==='user'?'收到用户类型取消信号':reason==='disposed'?'会话或宿主已结束':'已记录中断结束'
  }
  return status==='completed'?'已记录正常结束':''
}
export function childEdges(agents) {
  const edges = new Map()
  for (const agent of agents) {
    const header = agent.session?.header
    if (header?.origin !== 'subagent' || !validId(header.parentSession)) continue
    const siblings = edges.get(header.parentSession) ?? []
    siblings.push(agent); edges.set(header.parentSession, siblings)
  }
  return edges
}
export function liveTree(agents, rootId) {
  const edges = childEdges(agents), byId = new Map(agents.map(agent => [agent.id, agent])), seen = new Set(), result = []
  const queue = [rootId]
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    if (byId.has(id)) result.push(byId.get(id))
    for (const child of edges.get(id) ?? []) queue.push(child.id)
  }
  return result
}
export function sortEntries(entries) {
  return [...entries].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}
