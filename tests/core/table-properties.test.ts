import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
import { readProperties, withProperty } from '../../src/core/properties'
import { MAX_BODY_BYTES } from '../../src/core/noteLimits'
import { MAX_HEAD_CHARS } from '../../src/core/storage'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-table-properties-'), 'devot.sqlite'))
  open.push(storage)
  const newId = createIdGenerator()
  const service = () =>
    createNoteService({ storage, clock: createClock('mac1'), newId, saveDelayMs: 5 })
  return { notes: service(), storage, service }
}

const MISSING = '0192a6f0-0000-7000-8000-00000000000a'

describe('front matter heads', () => {
  it('reads the front matter of stored notes and of typing not saved yet', async () => {
    const { notes, service } = setup()
    const a = await notes.create('A')
    const b = await notes.create('B')
    const c = await notes.create('C')
    await notes.setBody(a, '---\nrating: 4\n---\nBody')
    await notes.setBody(b, 'No front matter\n---\n')
    await notes.setBody(c, '---\ndue: 2026-11-20\n---\n')
    await notes.flush()
    const fresh = service()
    expect(await fresh.frontMatterHeads([a, b, c, MISSING])).toEqual({
      [a]: '---\nrating: 4\n---',
      [c]: '---\ndue: 2026-11-20\n---',
    })
    await fresh.setBody(b, '---\nx: 1\n---\n')
    expect(await fresh.frontMatterHeads([b])).toEqual({ [b]: '---\nx: 1\n---' })
  })

  it('counts front matter that closes past what storage reads as none', async () => {
    const { notes, service } = setup()
    const id = await notes.create('Long')
    await notes.setBody(id, `---\nk: ${'x'.repeat(MAX_HEAD_CHARS)}\n---\nBody`)
    await notes.flush()
    expect(await service().frontMatterHeads([id])).toEqual({})
  })
})

describe('rewriting a body', () => {
  it('writes a property through the note, as an update the editor can apply', async () => {
    const { notes, service } = setup()
    const id = await notes.create('Plan')
    await notes.setBody(id, '---\nrating: 3\n---\nBody\n')
    const update = await notes.rewriteBody(id, (md) => withProperty(md, 'rating', 5))
    expect(update.byteLength).toBeGreaterThan(0)
    expect((await notes.read(id)).bodyMd).toBe('---\nrating: 5\n---\nBody\n')
    await notes.flush()
    const head = (await service().frontMatterHeads([id]))[id]!
    expect(readProperties(head)).toEqual({ rating: 5 })
  })

  it('changes nothing when the rewrite throws, and refuses a body over the limit', async () => {
    const { notes } = setup()
    const id = await notes.create('Plan')
    await notes.setBody(id, '---\na: [1,\n---\n')
    await expect(notes.rewriteBody(id, (md) => withProperty(md, 'k', 1))).rejects.toThrow(
      'E_FRONT_MATTER_INVALID',
    )
    await expect(notes.rewriteBody(id, () => 'x'.repeat(MAX_BODY_BYTES + 1))).rejects.toThrow(
      'E_NOTE_BODY_TOO_LARGE',
    )
    expect((await notes.read(id)).bodyMd).toBe('---\na: [1,\n---\n')
    await expect(notes.rewriteBody(MISSING, (md) => md)).rejects.toThrow('E_NOTE_NOT_FOUND')
  })
})
