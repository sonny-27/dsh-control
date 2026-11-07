import { supervisorError } from './supervisor.js'

function sameOrigin(req) {
  if (req.headers.origin) {
    let origin
    try { origin = new URL(req.headers.origin) } catch { throw supervisorError(403, '请求来源无效') }
    if (origin.host !== req.headers.host) throw supervisorError(403, '不允许跨站读取或控制会话')
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw supervisorError(403, '不允许跨站读取或控制会话')
}
export function createHandlers(supervisor) {
  const handler = operation => async (req, res) => {
    const controller = new AbortController(), abort = () => controller.abort(new Error('请求已取消'))
    const closed = () => { if (!res.writableEnded) abort() }
    req.on('aborted', abort); res.on('close', closed)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
    try {
      sameOrigin(req)
      const data = await operation(req, signal)
      if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
    } catch (error) {
      if (!res.destroyed) { res.writeHead(error.status ?? (error instanceof SyntaxError ? 400 : signal.aborted ? 408 : 500), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: String(error.message ?? error).slice(0, 300) })) }
    } finally { req.off('aborted', abort); res.off('close', closed) }
  }
  return {
    state: handler(async (req, signal) => {
      const url = new URL(req.url, 'http://localhost')
      return supervisor.snapshot(url.searchParams.get('root'), signal, url.searchParams.get('refresh') === '1')
    }),
    control: handler(async (req, signal) => {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw supervisorError(415, '控制请求必须为 JSON')
      let size = 0
      const chunks = []
      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 16384) throw supervisorError(413, '控制请求过大'); chunks.push(Buffer.from(chunk)) }
      return supervisor.control(JSON.parse(Buffer.concat(chunks).toString('utf8')), signal)
    }),
  }
}
