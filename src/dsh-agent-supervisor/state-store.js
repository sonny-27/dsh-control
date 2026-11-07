import { lstat, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validId } from './model.js'

export function createStateStore(root) {
  const path = join(root, 'state.json')
  let writes = Promise.resolve()
  async function assertDirectory() {
    await mkdir(root, { recursive: true })
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('插件状态目录必须是普通目录')
  }
  return {
    async load() {
      try {
        const parent = await lstat(root)
        const info = await lstat(path)
        if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('插件状态文件无效')
        const saved = JSON.parse(await readFile(path, 'utf8'))
        if (saved.version !== 1 || typeof saved.cascade !== 'boolean' || !Array.isArray(saved.paused) || saved.paused.length > 2000) throw new Error('插件状态格式无效')
        const paused = saved.paused.filter(item => validId(item.id) && typeof item.token === 'string' && item.token.length < 100 && Number.isSafeInteger(item.at))
        if (paused.length !== saved.paused.length) throw new Error('插件暂停记录无效')
        return { cascade: saved.cascade, paused }
      } catch (error) {
        if (error.code === 'ENOENT') return { cascade: true, paused: [] }
        throw error
      }
    },
    save(value) {
      const data = JSON.stringify({ version: 1, cascade: value.cascade, paused: value.paused }) + '\n'
      if (value.paused.length > 2000 || Buffer.byteLength(data) > 256 * 1024) return Promise.reject(new Error('暂停记录已达容量上限，请解除不再需要的暂停'))
      const operation = writes.catch(() => {}).then(async () => {
        await assertDirectory()
        const current = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
        if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('插件状态目标不是普通文件')
        const temporary = join(root, '.state-' + randomUUID() + '.tmp')
        let created = false
        try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); created = true; await rename(temporary, path) }
        finally { if (created) await unlink(temporary).catch(() => {}) }
      })
      writes = operation
      return operation
    },
    flush: () => writes,
  }
}
