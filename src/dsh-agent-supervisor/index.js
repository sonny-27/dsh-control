import { z } from 'zod'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createStateStore } from './state-store.js'
import { createSupervisor } from './supervisor.js'
import { createHandlers } from './http.js'
import { initialState, PROJECTION, reduceState } from './model.js'
import { initialModelState, MODEL_PROJECTION, reduceModelState } from './model-info.js'

export const name = 'dsh-agent-supervisor'
export const inject = ['webServer', 'agents', 'sessions', 'sessionQuery', 'sessionProjections']

export function projectionDefinition() {
  const schema = z.object({
    inherited: z.number().int().nonnegative(), task: z.string(), latest: z.string(),
    todos: z.array(z.object({ content: z.string(), status: z.string() })).nullable(), planTurn: z.number().int().nullable(),
    turn: z.number().int(), turnEpoch: z.number().int(), open: z.boolean(), reason: z.unknown().nullable(), updatedAt: z.number(),
  })
  return { key: PROJECTION, stateVersion: 1, stateSchema: schema,
    init: (_header, inherited) => initialState(inherited), apply: reduceState, wire: { viewSchema: schema, view: state => state } }
}
export function modelProjectionDefinition() {
  const model = z.object({ id: z.string(), provider: z.string(), reasoningEffort: z.string() }).nullable()
  const schema = z.object({ inherited: z.number().int().nonnegative(), descriptorSeen: z.boolean(), request: model, configured: model })
  return { key: MODEL_PROJECTION, stateVersion: 1, stateSchema: schema,
    init: (_header, inherited) => initialModelState(inherited), apply: reduceModelState, wire: { viewSchema: schema, view: state => state } }
}
export async function apply(ctx) {
  const unregisterProjection = ctx.sessionProjections.register(projectionDefinition())
  const unregisterModelProjection = ctx.sessionProjections.register(modelProjectionDefinition())
  const supervisor = createSupervisor({ ctx, store: createStateStore(dshHomePath('dsh-agent-supervisor')) })
  await supervisor.init()
  const handlers = createHandlers(supervisor)
  const disposers = [
    ctx.webServer.register({ path: '/api/dsh-agent-supervisor/state', method: 'get', handler: handlers.state }),
    ctx.webServer.register({ path: '/api/dsh-agent-supervisor/control', method: 'post', handler: handlers.control }),
  ]
  return async () => {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
    await supervisor.dispose()
    unregisterModelProjection()
    unregisterProjection()
  }
}
