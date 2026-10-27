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

  it('takes the files the devot command handed over, scanned as picked files', () => {
    const scan = {
      id: 3,
      name: 'a.md',
      kind: 'files',
      files: [{ path: 'a.md', bytes: 4 }],
      images: [],
      skipped: [{ path: 'b.txt', code: 'E_IMPORT_FILE_TYPE' }],
      destination: null,
    }
    const link = { kind: 'import', scan, notebook: 'Work', first: 'a.md' }
    expect(readDeepLink(link)).toEqual(link)
    expect(readDeepLink({ ...link, notebook: null, first: null })).toEqual({
      ...link,
      notebook: null,
      first: null,
    })
    for (const value of [
      { ...link, scan: { ...scan, kind: 'folder' } },
      { ...link, scan: { ...scan, id: 'x' } },
      { ...link, scan: { ...scan, files: [{ path: 1, bytes: 4 }] } },
      { ...link, scan: { ...scan, skipped: [{ path: 'b' }] } },
      { ...link, notebook: 3 },
      { ...link, first: {} },
      { kind: 'import' },
    ]) {
      expect(readDeepLink(value)).toBeUndefined()
    }
  })
})

describe('readDeepLink, licences', () => {
  const key = 'devot1.eyJpZCI6IngifQ.c2lnbmF0dXJl'
  const offer = {
    id: '5vEvzHainWD0cA2Ht_ljHg',
    licensee: 'buyer@example.com',
    state: 'valid',
  }

  it('takes a checked key with what it is, or the code of one that failed', () => {
    const link = { kind: 'licence', key, offer, code: null }
    expect(readDeepLink(link)).toEqual(link)
    const refused = { kind: 'licence', key: null, offer: null, code: 'E_LICENCE_SIGNATURE' }
    expect(readDeepLink(refused)).toEqual(refused)
  })

  it('takes nothing that mixes the two or is not shaped as Rust sends it', () => {
    for (const value of [
      { kind: 'licence', key, offer, code: 'E_LICENCE_SIGNATURE' },
      { kind: 'licence', key: null, offer, code: null },
      { kind: 'licence', key, offer: null, code: null },
      { kind: 'licence', key: 'devot1rev.a.b', offer, code: null },
      { kind: 'licence', key: `${key}.x`, offer, code: null },
      { kind: 'licence', key: `devot1.${'a'.repeat(1024)}.b`, offer, code: null },
      { kind: 'licence', key, offer: { ...offer, id: 'short' }, code: null },
      { kind: 'licence', key, offer: { ...offer, licensee: '' }, code: null },
      { kind: 'licence', key, offer: { ...offer, state: 'great' }, code: null },
      { kind: 'licence', key: null, offer: null, code: 'not a code' },
      { kind: 'licence', key: null, offer: null, code: null },
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

  function setup(onRun: (link: DeepLink) => void = () => undefined) {
    const ran: DeepLink[] = []
    const dropped: DeepLink[] = []
    const state = { blocked: false, watching: false, settling: false, now: 0 }
    let watched: (() => void) | undefined
    let settle: (() => void) | undefined
    const queue = new LinkQueue(
      (link) => {
        ran.push(link)
        onRun(link)
      },
      () => state.blocked,
      (changed) => {
        state.watching = true
        watched = changed
        return () => {
          state.watching = false
        }
      },
      (done) => {
        state.settling = true
        settle = done
        return () => {
          state.settling = false
        }
      },
      () => state.now,
      (link) => dropped.push(link),
    )
    return { queue, ran, dropped, state, tick: () => watched?.(), timeout: () => settle?.() }
  }

  it('runs a link at once when nothing blocks it', () => {
    const q = setup()
    q.queue.push(note('a'))
    expect(q.ran).toEqual([note('a')])
    expect(q.state.watching).toBe(false)
  })

  it('runs the next link only once the window has rendered the last one', () => {
    const q = setup()
    q.queue.push(note('a'))
    q.queue.push(note('b'))
    expect(q.ran).toEqual([note('a')])
    q.queue.settled()
    expect(q.ran).toEqual([note('a'), note('b')])
    // Settling stops the fallback timer of the link before.
    expect(q.state.settling).toBe(true)
    q.queue.settled()
    expect(q.state.settling).toBe(false)
  })

  it('goes on after a while when a link renders nothing', () => {
    const q = setup()
    q.queue.push(note('a'))
    q.queue.push(note('b'))
    q.timeout()
    expect(q.ran).toEqual([note('a'), note('b')])
  })

  it('holds links while a sheet is up and runs them in order once it closes', () => {
    const q = setup()
    q.state.blocked = true
    q.queue.push(note('a'))
    q.queue.push(note('b'))
    expect(q.ran).toEqual([])
    expect(q.state.watching).toBe(true)
    // A look that finds the sheet still up keeps them waiting.
    q.tick()
    expect(q.ran).toEqual([])
    q.state.blocked = false
    q.queue.settled() // The render that closed the sheet.
    expect(q.ran).toEqual([note('a')])
    expect(q.state.watching).toBe(false)
    q.queue.settled()
    expect(q.ran).toEqual([note('a'), note('b')])
  })

  it('holds the next link behind a sheet the last one put up', () => {
    const q = setup()
    q.queue.push(note('a'))
    q.queue.push(note('b'))
    q.state.blocked = true // The link opened the palette, say.
    q.queue.settled()
    expect(q.ran).toEqual([note('a')])
    expect(q.state.watching).toBe(true)
    q.state.blocked = false
    q.tick()
    expect(q.ran).toEqual([note('a'), note('b')])
  })

  it('drops the same link sent again within a second', () => {
    const q = setup()
    q.queue.push(note('a'))
    q.state.now = 500
    q.queue.push(note('a'))
    q.queue.settled()
    expect(q.ran).toEqual([note('a')])
    // Each repeat counts from the one before, so a loop stays dropped.
    q.state.now = 1400
    q.queue.push(note('a'))
    q.queue.settled()
    expect(q.ran).toEqual([note('a')])
    q.state.now = 2500
    q.queue.push(note('a'))
    expect(q.ran).toEqual([note('a'), note('a')])
    // Another link in between is no repeat.
    q.queue.settled()
    q.queue.push(note('b'))
    q.queue.settled()
    q.queue.push(note('a'))
    expect(q.ran).toEqual([note('a'), note('a'), note('b'), note('a')])
  })

  it('keeps at most 16 links waiting', () => {
    const q = setup()
    q.state.blocked = true
    for (let i = 0; i < 20; i += 1) q.queue.push(note(`n${i}`))
    expect(q.queue.stop()).toHaveLength(16)
  })

  it('keeps up to 64 handed-over files apart from URLs, and drops the rest so their session ends', () => {
    const q = setup()
    q.state.blocked = true
    const files = (id: number): DeepLink => ({
      kind: 'import',
      scan: {
        id,
        name: 'a.md',
        kind: 'files',
        files: [],
        images: [],
        skipped: [],
        destination: null,
      },
      notebook: null,
      first: null,
    })
    for (let i = 0; i < 20; i += 1) q.queue.push(note(`n${i}`))
    for (let i = 0; i < 70; i += 1) q.queue.push(files(i))
    const waiting = q.queue.stop()
    expect(waiting.filter((link) => link.kind === 'import')).toHaveLength(64)
    expect(waiting).toHaveLength(16 + 64)
    expect(q.dropped).toHaveLength(4 + 6)
    expect(q.dropped.slice(4)).toEqual([64, 65, 66, 67, 68, 69].map(files))
  })

  it('drops what waits when stopped, and returns it', () => {
    const q = setup()
    q.state.blocked = true
    q.queue.push(note('a'))
    expect(q.queue.stop()).toEqual([note('a')])
    expect(q.state.watching).toBe(false)
    q.state.blocked = false
    q.queue.push(note('b'))
    q.queue.settled()
    expect(q.ran).toEqual([])
  })
})
