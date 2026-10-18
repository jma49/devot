import { describe, expect, it } from 'vitest'
import { LinkQueue, noteTarget, readDeepLink, type DeepLink } from './deepLink'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const OTHER = '01890a5d-ac96-774b-bcce-b302099a8058'

describe('readDeepLink', () => {
  it('takes a note link with a canonical UUIDv7 and an allowed command', () => {
    expect(readDeepLink({ kind: 'note', id: ID })).toEqual({ kind: 'note', id: ID })
    expect(readDeepLink({ kind: 'command', id: 'view.trash' })).toEqual({
      kind: 'command',
      id: 'view.trash',
    })
  })

  it('takes nothing else', () => {
    for (const value of [
      undefined,
      null,
      'devot://note/' + ID,
      { kind: 'note', id: ID.toUpperCase() },
      { kind: 'note', id: '9b2e4c1a-6f3d-4e8a-9c7b-1d2e3f4a5b6c' },
      { kind: 'note', id: `${ID}/x` },
      { kind: 'command', id: 'note.trash' },
      { kind: 'command', id: 'trash.empty' },
      { kind: 'file', id: ID },
      { kind: 'note' },
    ]) {
      expect(readDeepLink(value)).toBeUndefined()
    }
  })
})

describe('noteTarget', () => {
  const known = {
    listed: new Set([ID]),
    notes: [{ id: ID }, { id: OTHER }],
    templates: [{ id: 'template' }],
    trash: [{ id: 'gone' }],
  }

  it('opens a listed note where it is', () => {
    expect(noteTarget(ID, known)).toEqual({ kind: 'listed' })
  })

  it('shows All Notes for a live note outside the list, Templates for a template', () => {
    expect(noteTarget(OTHER, known)).toEqual({ kind: 'library', library: 'all' })
    expect(noteTarget('template', known)).toEqual({ kind: 'library', library: 'templates' })
  })

  it('opens a trashed note in the Trash, listed or not', () => {
    expect(noteTarget('gone', known)).toEqual({ kind: 'trash' })
    expect(noteTarget('gone', { ...known, listed: new Set(['gone']) })).toEqual({ kind: 'trash' })
  })

  it('finds no note that is nowhere', () => {
    expect(noteTarget('nowhere', known)).toEqual({ kind: 'missing' })
  })
})

describe('LinkQueue', () => {
  const note = (id: string): DeepLink => ({ kind: 'note', id })

  function setup() {
    const ran: DeepLink[] = []
    let blocked = false
    let changed: (() => void) | undefined
    let watches = 0
    const queue = new LinkQueue(
      (link) => ran.push(link),
      () => blocked,
      (callback) => {
        watches += 1
        changed = callback
        return () => {
          changed = undefined
        }
      },
    )
    return {
      queue,
      ran,
      block: (value: boolean) => {
        blocked = value
      },
      change: () => changed?.(),
      watching: () => changed !== undefined,
      watches: () => watches,
    }
  }

  it('runs a link at once when nothing blocks it', () => {
    const q = setup()
    q.queue.push(note('a'))
    expect(q.ran).toEqual([note('a')])
    expect(q.watching()).toBe(false)
  })

  it('holds links while a sheet is up and runs them in order once it closes', () => {
    const q = setup()
    q.block(true)
    q.queue.push(note('a'))
    q.queue.push(note('b'))
    expect(q.ran).toEqual([])
    expect(q.watching()).toBe(true)
    expect(q.watches()).toBe(1)
    // A change that leaves the sheet up keeps them waiting.
    q.change()
    expect(q.ran).toEqual([])
    q.block(false)
    q.change()
    expect(q.ran).toEqual([note('a'), note('b')])
    expect(q.watching()).toBe(false)
  })

  it('stops at a link that puts a sheet up and waits again', () => {
    const ran: DeepLink[] = []
    let blocked = true
    const queue = new LinkQueue(
      (link) => {
        ran.push(link)
        blocked = true // The link opened the palette, say.
      },
      () => blocked,
      () => () => undefined,
    )
    queue.push(note('a'))
    queue.push(note('b'))
    blocked = false
    queue.flush()
    expect(ran).toEqual([note('a')])
    blocked = false
    queue.flush()
    expect(ran).toEqual([note('a'), note('b')])
  })

  it('drops what waits when stopped', () => {
    const q = setup()
    q.block(true)
    q.queue.push(note('a'))
    q.queue.stop()
    expect(q.watching()).toBe(false)
    q.block(false)
    q.queue.push(note('b'))
    q.queue.flush()
    expect(q.ran).toEqual([])
  })
})
