import { describe, expect, it } from 'vitest'
import { cliAppendHost, readCliAppendRequest, resolveAppendTarget } from './cliAppend'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const REQUEST = {
  id: 1,
  target: { kind: 'id', id: ID },
  heading: 'Log',
  position: 'append',
  text: '- done',
}

describe('a request from the devot command', () => {
  it('reads what Rust sends and nothing else', () => {
    expect(readCliAppendRequest(REQUEST)).toEqual(REQUEST)
    expect(
      readCliAppendRequest({ ...REQUEST, target: { kind: 'title', title: 'Day' }, heading: null }),
    ).toEqual({ ...REQUEST, target: { kind: 'title', title: 'Day' }, heading: null })
    for (const bad of [
      null,
      'append',
      { ...REQUEST, id: -1 },
      { ...REQUEST, target: { kind: 'id', id: 'nope' } },
      { ...REQUEST, target: { kind: 'title', title: ' ' } },
      { ...REQUEST, target: { kind: 'path', path: '/a.md' } },
      { ...REQUEST, position: 'middle' },
      { ...REQUEST, heading: 3 },
      { ...REQUEST, text: 3 },
    ]) {
      expect(readCliAppendRequest(bad)).toBeNull()
    }
  })

  it('names the note by ID as given, or by title among the live notes', async () => {
    const notes = [{ id: ID, title: 'Day', bookId: null, updatedAt: 1 }]
    expect(await resolveAppendTarget({ kind: 'id', id: ID }, async () => [])).toBe(ID)
    expect(await resolveAppendTarget({ kind: 'title', title: 'day' }, async () => notes)).toBe(ID)
    await expect(
      resolveAppendTarget({ kind: 'title', title: 'Night' }, async () => notes),
    ).rejects.toThrow('E_NOTE_NOT_FOUND')
  })

  it('runs requests one at a time and answers each with its code, or none', async () => {
    const ran: number[] = []
    const answered: [number, string | null][] = []
    const take = cliAppendHost({
      run: async (request) => {
        ran.push(request.id)
        if (request.id === 2) throw new Error('E_HEADING_NOT_FOUND')
        if (request.id === 3) throw new TypeError('boom')
      },
      reply: async (id, error) => {
        answered.push([id, error])
      },
    })
    void take(REQUEST)
    void take({ ...REQUEST, id: 2 })
    void take('junk')
    await take({ ...REQUEST, id: 3 })
    expect(ran).toEqual([1, 2, 3])
    expect(answered).toEqual([
      [1, null],
      [2, 'E_HEADING_NOT_FOUND'],
      [3, 'E_CLI_APPEND_FAILED'],
    ])
  })
})
