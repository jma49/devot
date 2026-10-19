import { describe, expect, it, vi } from 'vitest'
import type { ImageLinks, ImportPreparer, PreparedImport } from '../../core'
import {
  preparerOffThread,
  type ImportReply,
  type ImportRequest,
  type ImportWorker,
} from './importWorker'

const prepared = (title: string): PreparedImport => ({
  title,
  meta: { title: null, notebook: null, tags: [], status: null },
  text: '',
  images: { links: [], unlocated: [] },
  embedded: [],
  dropped: [],
})

class FakeWorker implements ImportWorker {
  sent: ImportRequest[] = []
  terminated = false
  private listeners = new Map<string, ((event: { data: ImportReply }) => void)[]>()

  postMessage(message: ImportRequest) {
    this.sent.push(message)
  }

  addEventListener(type: string, listener: (event: { data: ImportReply }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  terminate() {
    this.terminated = true
  }

  emit(type: string, data?: ImportReply) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: data! })
  }
}

const here = (): ImportPreparer & { asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    file: async (_raw, path) => {
      asked.push(path)
      return prepared(`here ${path}`)
    },
    links: async (text) => {
      asked.push(text)
      return { links: [], unlocated: [text] }
    },
  }
}

describe('preparing imported files off the core worker', () => {
  it('sends each call to one worker and answers each by its own reply, in any order', async () => {
    const worker = new FakeWorker()
    const spawn = vi.fn<() => ImportWorker>(() => worker)
    const local = here()
    const prepare = preparerOffThread(spawn, local, () => {})
    const first = prepare.file('# A', 'a.md', true)
    const second = prepare.links('text')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(worker.sent).toEqual([
      { kind: 'file', raw: '# A', path: 'a.md', withImages: true, id: 1 },
      { kind: 'links', text: 'text', id: 2 },
    ])
    const links: ImageLinks = { links: [], unlocated: ['x.png'] }
    worker.emit('message', { id: 2, value: links })
    worker.emit('message', { id: 1, value: prepared('A') })
    await expect(second).resolves.toEqual(links)
    await expect(first).resolves.toEqual(prepared('A'))
    expect(local.asked).toEqual([])
  })

  it('rejects a call with the code the worker answered', async () => {
    const worker = new FakeWorker()
    const prepare = preparerOffThread(
      () => worker,
      here(),
      () => {},
    )
    const call = prepare.file('<p>', 'a.html', false)
    worker.emit('message', { id: 1, code: 'E_IMPORT_FAILED' })
    await expect(call).rejects.toThrow('E_IMPORT_FAILED')
  })

  it('prepares here when the worker cannot start', async () => {
    const failed = vi.fn<() => void>()
    const local = here()
    const prepare = preparerOffThread(
      () => {
        throw new Error('no workers')
      },
      local,
      failed,
    )
    await expect(prepare.file('# A', 'a.md', true)).resolves.toEqual(prepared('here a.md'))
    await expect(prepare.links('t')).resolves.toEqual({ links: [], unlocated: ['t'] })
    expect(local.asked).toEqual(['a.md', 't'])
    expect(failed).toHaveBeenCalledTimes(1)
  })

  it.for(['error', 'messageerror'])(
    'after a worker %s, prepares here what it waited for and all that follows',
    async (event) => {
      const worker = new FakeWorker()
      const spawn = vi.fn<() => ImportWorker>(() => worker)
      const failed = vi.fn<() => void>()
      const local = here()
      const prepare = preparerOffThread(spawn, local, failed)
      const waiting = prepare.file('# A', 'a.md', true)
      worker.emit(event)
      await expect(waiting).resolves.toEqual(prepared('here a.md'))
      await expect(prepare.file('# B', 'b.md', true)).resolves.toEqual(prepared('here b.md'))
      expect(worker.terminated).toBe(true)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(failed).toHaveBeenCalledTimes(1)
      worker.emit(event)
      expect(failed).toHaveBeenCalledTimes(1)
    },
  )

  it('ends the worker when closed, preparing here anything still waiting', async () => {
    const worker = new FakeWorker()
    const local = here()
    const prepare = preparerOffThread(
      () => worker,
      local,
      () => {},
    )
    const waiting = prepare.file('# A', 'a.md', true)
    prepare.close()
    expect(worker.terminated).toBe(true)
    await expect(waiting).resolves.toEqual(prepared('here a.md'))
    worker.emit('message', { id: 1, value: prepared('late') })
    expect(local.asked).toEqual(['a.md'])
  })

  it('starts no worker for an import that prepares nothing', () => {
    const spawn = vi.fn<() => ImportWorker>(() => new FakeWorker())
    preparerOffThread(spawn, here(), () => {}).close()
    expect(spawn).not.toHaveBeenCalled()
  })
})
