import { describe, expect, it } from 'vitest'
import {
  EXPORT_HEADER,
  TEMPLATES_BOOK_ID,
  emptyManifest,
  markdownFile,
  noteSource,
  numberedName,
  planMirror,
  renderMirrorText,
  sha256Hex,
  type BookRecord,
  type DiskState,
  type MirrorManifest,
  type MirrorOp,
  type MirrorPlan,
  type MirrorPlanInput,
  type MirrorText,
  type NoteStatus,
  type NoteSummary,
  type TagRecord,
} from '../../src/core'

// The mirror's plan: the database, the manifest and what is known about the
// disk in; the operations Rust runs out. Pure, so every rule is checked here
// without files; tests/core/mirror-sync.test.ts runs plans on real files.

const id = (n: number) => `0192a6f0-0000-7000-8000-${String(n).padStart(12, '0')}`

const note = (
  n: number,
  title: string,
  more: Partial<NoteSummary> = {},
): NoteSummary & { n: number } => ({
  n,
  id: id(n),
  title,
  createdAt: n,
  updatedAt: 1000 + n,
  bookId: null,
  status: 'none',
  pinned: false,
  tagIds: [],
  ...more,
})

const book = (n: number, name: string, parentId: string | null = null, key = 'a'): BookRecord => ({
  id: id(n),
  name,
  nameHlc: 'h',
  parentId,
  parentHlc: 'h',
  createdAt: n,
  updatedAt: n,
  deletedAt: null,
  deletedHlc: null,
  aiAccess: false,
  aiAccessHlc: '',
  icon: null,
  iconColor: null,
  iconHlc: '',
  sortKey: key,
  sortKeyHlc: 'h',
})

const tag = (n: number, name: string): TagRecord => ({
  id: id(n),
  name,
  nameHlc: 'h',
  createdAt: n,
  updatedAt: n,
  deletedAt: null,
  deletedHlc: null,
  color: null,
  colorHlc: '',
})

interface World {
  notes: NoteSummary[]
  books?: BookRecord[]
  tags?: TagRecord[]
  bodies: Record<string, string>
  files?: Record<string, string>
  disk?: Record<string, DiskState>
  linked?: string[]
  hashes?: Record<string, string>
  manifest?: MirrorManifest
  includeAttachments?: boolean
  limit?: number
  checked?: Record<string, DiskState>
}

type Asked = { bodies: string[]; paths: string[]; hashes: string[] }

/** Plans like the runner: answers what the plan needs until it needs nothing. */
function settle(world: World): MirrorPlan & { asked: Asked } {
  const bodies = new Map<string, string>()
  const files = new Map<string, string | null>()
  const hashes = new Map<string, string | null>()
  const texts = new Map<string, Map<string, MirrorText>>()
  const disk = new Map<string, DiskState>(Object.entries(world.checked ?? {}))
  const asked: Asked = { bodies: [], paths: [], hashes: [] }
  const diskAt = (path: string): DiskState =>
    world.linked?.some((link) => path === link || path.startsWith(`${link}/`))
      ? 'other'
      : (world.disk?.[path] ?? null)
  const input = (): MirrorPlanInput => ({
    notes: world.notes,
    books: world.books ?? [],
    tags: world.tags ?? [],
    manifest: world.manifest ?? emptyManifest(),
    includeAttachments: world.includeAttachments ?? true,
    untitled: 'Untitled',
    bodies,
    files,
    hashes,
    texts,
    disk,
    ...(world.limit ? { limit: world.limit } : {}),
  })
  for (let round = 0; round < 20; round += 1) {
    const plan = planMirror(input())
    const { needs } = plan
    if (
      !needs.bodies.length &&
      !needs.files.length &&
      !needs.hashes.length &&
      !needs.texts.length &&
      !needs.paths.length
    ) {
      return { ...plan, asked }
    }
    for (const n of needs.bodies) {
      const body = world.bodies[n]
      if (body === undefined) throw new Error(`E_TEST_NO_BODY ${n}`)
      bodies.set(n, body)
      asked.bodies.push(n)
    }
    for (const n of needs.files) files.set(n, world.files?.[n] ?? null)
    for (const n of needs.hashes) {
      hashes.set(n, world.hashes?.[n] ?? null)
      asked.hashes.push(n)
    }
    for (const spec of needs.texts) {
      if (!texts.has(spec.id)) texts.set(spec.id, new Map())
      texts.get(spec.id)!.set(spec.path, renderMirrorText(spec))
    }
    for (const p of needs.paths) {
      disk.set(p, diskAt(p))
      asked.paths.push(p)
    }
  }
  throw new Error('E_TEST_PLAN_DID_NOT_SETTLE')
}

function after(manifest: MirrorManifest, ops: readonly MirrorOp[]): MirrorManifest {
  const next = structuredClone(manifest)
  for (const op of ops) {
    if (op.kind === 'keep' || op.kind === 'forget' || op.kind === 'remove') {
      delete (op.entry === 'note' ? next.notes : next.files)[op.id]
    } else if (op.kind === 'note') {
      const size = op.text?.length ?? next.notes[op.id]?.size ?? 0
      next.notes[op.id] = {
        path: op.path,
        sha256: op.sha256,
        size,
        source: op.source,
        files: op.files,
      }
    } else if (op.kind === 'file') {
      next.files[op.id] = op.copy
        ? { path: op.path, sha256: `copy-of-${op.id}`, size: 1 }
        : { path: op.path, sha256: null, size: 0 }
    } else if (op.path === null) delete next.books[op.id]
    else next.books[op.id] = op.path
  }
  return next
}

const diskOf = (manifest: MirrorManifest): Record<string, DiskState> =>
  Object.fromEntries(
    [...Object.values(manifest.notes), ...Object.values(manifest.files)]
      .filter((e) => e.sha256 !== null)
      .map((e) => [e.path, e.sha256]),
  )

const kinds = (ops: readonly MirrorOp[]) =>
  ops.map((op) =>
    op.kind === 'note'
      ? `note ${op.from ?? '-'} -> ${op.path}${op.text === undefined ? ' (record)' : ''}`
      : op.kind === 'file'
        ? `file ${op.path}${op.copy ? '' : ' (name)'}`
        : op.kind === 'book'
          ? `book ${op.path ?? '-'}`
          : `${op.kind} ${op.kind === 'forget' ? op.id : op.path}`,
  )

const textOf = (plan: MirrorPlan, path: string) => {
  const op = plan.ops.find((o) => o.kind === 'note' && o.path === path)
  return op?.kind === 'note' ? op.text : undefined
}

function library(): World {
  const work = book(100, 'Work', null, 'a')
  const plans = book(101, 'Plans: 2026', work.id, 'a')
  const empty = book(102, 'Empty', null, 'b')
  const attachments = book(103, 'attachments', null, 'c')
  const notes = [
    note(1, 'Inbox', { bookId: work.id }),
    note(2, 'Plan', { bookId: plans.id, tagIds: [id(200)], status: 'active' }),
    note(3, 'Plan', { bookId: plans.id }),
    note(4, 'Loose'),
    note(5, '', { bookId: attachments.id }),
    note(6, 'A template', { bookId: TEMPLATES_BOOK_ID }),
  ]
  return {
    notes,
    books: [work, plans, empty, attachments, book(1, 'Templates')].map((b, i) =>
      i === 4 ? { ...b, id: TEMPLATES_BOOK_ID } : b,
    ),
    tags: [tag(200, 'q4')],
    bodies: {
      [id(1)]: '# Inbox\n\nLoose thoughts.\n',
      [id(2)]: `# Plan\n\n![Board](devot://file/${id(300)}#half)\n`,
      [id(3)]: 'Second plan.\n',
      [id(4)]: 'At the top.\n',
      [id(5)]: 'Untitled body.\n',
      [id(6)]: 'Never mirrored.\n',
    },
    files: { [id(300)]: 'board.png' },
  }
}

describe('a first mirror', () => {
  it('lays the notes out like an export of every notebook, without templates', () => {
    const world = library()
    const plan = settle(world)
    expect(kinds(plan.ops)).toEqual([
      'file attachments/board.png',
      'note - -> attachments 2/Untitled.md',
      'note - -> Loose.md',
      'note - -> Work/Plans 2026/Plan 2.md',
      'note - -> Work/Plans 2026/Plan.md',
      'note - -> Work/Inbox.md',
      'book Work',
      'book attachments 2',
      'book Work/Plans 2026',
    ])
    expect(textOf(plan, 'Work/Inbox.md')).toBe('# Inbox\n\nLoose thoughts.\n')
    expect(textOf(plan, 'Work/Plans 2026/Plan.md')).toBe(
      markdownFile(
        { title: 'Plan', bodyMd: world.bodies[id(2)]!, tags: ['q4'], status: 'active' },
        'Plan.md',
        new Map([[id(300), '../../attachments/board.png']]),
      ),
    )
    expect(textOf(plan, 'Work/Plans 2026/Plan.md')).toContain(
      '![Board](../../attachments/board.png#half)',
    )
    expect(textOf(plan, 'Work/Plans 2026/Plan 2.md')).toBe(
      `---\n${EXPORT_HEADER}\ntitle: 'Plan'\n---\nSecond plan.\n`,
    )
    const notes = plan.ops.flatMap((op) => (op.kind === 'note' ? [op] : []))
    expect(notes.map((op) => op.sha256)).toEqual(notes.map((op) => sha256Hex(op.text!)))
    expect(plan.deferred).toBe(0)
  })

  it('asks for the bodies, attachments and paths it needs, and only those', () => {
    const plan = settle(library())
    expect(plan.asked.bodies.sort()).toEqual([id(1), id(2), id(3), id(4), id(5)])
    expect(plan.asked.paths.sort()).toEqual(
      [
        'Loose.md',
        'Work',
        'Work/Inbox.md',
        'Work/Plans 2026',
        'Work/Plans 2026/Plan 2.md',
        'Work/Plans 2026/Plan.md',
        'attachments 2',
        'attachments 2/Untitled.md',
        'attachments/board.png',
      ].sort(),
    )
  })

  it('works through a large library a slice at a time, newest first', () => {
    const world: World = {
      notes: Array.from({ length: 5 }, (_, i) => note(i + 1, `Note ${i + 1}`)),
      bodies: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [id(i + 1), `Body ${i}\n`])),
      limit: 2,
    }
    const first = settle(world)
    expect(kinds(first.ops)).toEqual(['note - -> Note 5.md', 'note - -> Note 4.md'])
    expect(first.deferred).toBe(3)
    const manifest = after(emptyManifest(), first.ops)
    const second = settle({ ...world, manifest, disk: diskOf(manifest) })
    expect(kinds(second.ops)).toEqual(['note - -> Note 3.md', 'note - -> Note 2.md'])
    expect(second.deferred).toBe(1)
  })
})

function mirrored(world: World = library()) {
  const plan = settle(world)
  const manifest = after(world.manifest ?? emptyManifest(), plan.ops)
  return { ...world, manifest, disk: { ...world.disk, ...diskOf(manifest) } }
}

const changeNote = (world: World, n: number, change: Partial<NoteSummary>): World => ({
  ...world,
  notes: world.notes.map((x) =>
    x.id === id(n) ? { ...x, updatedAt: x.updatedAt + 1, ...change } : x,
  ),
})

describe('keeping it up to date', () => {
  it('needs nothing when nothing changed', () => {
    const plan = settle(mirrored())
    expect(plan.ops).toEqual([])
    expect(plan.asked).toEqual({ bodies: [], paths: [], hashes: [] })
  })

  it('a body edit writes that note alone, in place, and reads only its body', () => {
    const world = mirrored()
    const edited = changeNote(world, 1, {})
    edited.bodies = { ...edited.bodies, [id(1)]: '# Inbox\n\nNew thoughts.\n' }
    const plan = settle(edited)
    expect(kinds(plan.ops)).toEqual(['note Work/Inbox.md -> Work/Inbox.md'])
    expect(textOf(plan, 'Work/Inbox.md')).toBe('# Inbox\n\nNew thoughts.\n')
    expect(plan.asked).toEqual({ bodies: [id(1)], paths: ['Work/Inbox.md'], hashes: [] })
  })

  it('a change that leaves the file as it is (pinning) only records it, without the disk', () => {
    const world = mirrored()
    const plan = settle(changeNote(world, 1, { pinned: true }))
    expect(kinds(plan.ops)).toEqual(['note Work/Inbox.md -> Work/Inbox.md (record)'])
    expect(plan.asked.paths).toEqual([])
    const op = plan.ops[0]!
    expect(op.kind === 'note' && op.sha256).toBe(world.manifest!.notes[id(1)]!.sha256)
  })

  it('renaming a note moves its file; its text follows the new name', () => {
    const world = mirrored()
    const plan = settle(changeNote(world, 4, { title: 'Renamed' }))
    expect(kinds(plan.ops)).toEqual(['note Loose.md -> Renamed.md'])
    expect(textOf(plan, 'Renamed.md')).toBe('At the top.\n')
  })

  it('a case change renames the file in place, unless someone else holds that name', () => {
    const world = mirrored()
    const recased = changeNote(world, 4, { title: 'loose' })
    const sha = world.manifest!.notes[id(4)]!.sha256
    const same = settle({ ...recased, disk: { ...recased.disk, 'loose.md': sha } })
    expect(kinds(same.ops)).toEqual(['note Loose.md -> loose.md (record)'])
    expect(same.asked.paths.sort()).toEqual(['Loose.md', 'loose.md'])
    expect(kinds(settle(recased).ops)).toEqual(['note Loose.md -> loose.md'])
    const theirs = settle({
      ...recased,
      disk: { ...recased.disk, 'loose.md': sha256Hex('theirs') },
    })
    expect(kinds(theirs.ops)).toEqual(['note Loose.md -> loose 2.md'])
  })

  it('moving a note to another notebook moves its file and its image links', () => {
    const world = mirrored()
    const plan = settle(changeNote(world, 2, { bookId: id(100) }))
    expect(kinds(plan.ops)).toEqual(['note Work/Plans 2026/Plan.md -> Work/Plan.md'])
    expect(textOf(plan, 'Work/Plan.md')).toContain('![Board](../attachments/board.png#half)')
  })

  it('renaming or moving a notebook moves the files under it, and only those', () => {
    const world = mirrored()
    const renamed = {
      ...world,
      books: world.books!.map((b) => (b.id === id(101) ? { ...b, name: 'Goals' } : b)),
    }
    expect(kinds(settle(renamed).ops)).toEqual([
      'note Work/Plans 2026/Plan 2.md -> Work/Goals/Plan 2.md',
      'note Work/Plans 2026/Plan.md -> Work/Goals/Plan.md',
      'book Work/Goals',
    ])
    const moved = {
      ...world,
      books: world.books!.map((b) => (b.id === id(101) ? { ...b, parentId: null } : b)),
    }
    const plan = settle(moved)
    expect(kinds(plan.ops)).toEqual([
      'note Work/Plans 2026/Plan 2.md -> Plans 2026/Plan 2.md',
      'note Work/Plans 2026/Plan.md -> Plans 2026/Plan.md',
      'book Plans 2026',
    ])
    expect(textOf(plan, 'Plans 2026/Plan.md')).toContain('](../attachments/board.png#half)')
  })

  it('a tag or status change rewrites the note with its new front matter', () => {
    const world = mirrored()
    const retagged = { ...world, tags: [tag(200, 'q1')] }
    const plan = settle(retagged)
    expect(kinds(plan.ops)).toEqual(['note Work/Plans 2026/Plan.md -> Work/Plans 2026/Plan.md'])
    expect(textOf(plan, 'Work/Plans 2026/Plan.md')).toContain("tags: ['q1']")
    const status = settle(changeNote(world, 4, { status: 'on_hold' as NoteStatus }))
    expect(textOf(status, 'Loose.md')).toContain('status: on-hold')
  })

  it('a note that leaves (Trash, purge, Templates) has its file removed; back, it is written again', () => {
    const world = mirrored()
    const gone = { ...world, notes: world.notes.filter((n) => n.id !== id(4)) }
    const plan = settle(gone)
    const sha = world.manifest!.notes[id(4)]!.sha256
    expect(plan.ops).toEqual([
      { kind: 'remove', entry: 'note', id: id(4), path: 'Loose.md', sha256: sha },
    ])
    const left = after(world.manifest!, plan.ops)
    const back = settle({ ...world, manifest: left, disk: diskOf(left) })
    expect(kinds(back.ops)).toEqual(['note - -> Loose.md'])
    const template = settle(changeNote(world, 4, { bookId: TEMPLATES_BOOK_ID }))
    expect(kinds(template.ops)).toEqual(['remove Loose.md'])
  })

  it("a deleted notebook's notes move to the top; its folder goes from the manifest", () => {
    const world = mirrored()
    const deleted = { ...world, books: world.books!.filter((b) => b.id !== id(101)) }
    expect(kinds(settle(deleted).ops)).toEqual([
      'note Work/Plans 2026/Plan 2.md -> Plan 2.md',
      'note Work/Plans 2026/Plan.md -> Plan.md',
      'book -',
    ])
  })
})

describe('names', () => {
  it('a notebook renamed only in case keeps its folder', () => {
    const world = mirrored()
    const recased = {
      ...world,
      books: world.books!.map((b) => (b.id === id(100) ? { ...b, name: 'WORK' } : b)),
    }
    expect(settle(recased).ops).toEqual([])
  })

  const NFC = 'Caf\u00e9'
  const NFD = 'CAFE\u0301'
  const SHARP = 'Stra\u00dfe'

  it('numbers names macOS takes for one file, by the rule export numbers them by', () => {
    const world: World = {
      notes: [note(1, NFC), note(2, NFD), note(3, 'STRASSE'), note(4, SHARP)],
      bodies: {
        [id(1)]: `![a](devot://file/${id(301)})\n`,
        [id(2)]: `![b](devot://file/${id(302)})\n`,
        [id(3)]: 'c\n',
        [id(4)]: 'd\n',
      },
      files: { [id(301)]: `${NFC}.png`, [id(302)]: `${NFD}.png` },
    }
    const plan = settle(world)
    const paths = plan.ops.flatMap((op) =>
      op.kind === 'note' || op.kind === 'file' ? [op.path] : [],
    )
    expect(paths.sort()).toEqual(
      [
        `${NFC}.md`,
        `${NFD} 2.md`,
        'STRASSE.md',
        `${SHARP} 2.md`,
        `attachments/${NFC}.png`,
        `attachments/${NFD} 2.png`,
      ].sort(),
    )
    const onDisk = settle({ ...world, disk: { [`${NFC}.md`]: sha256Hex('theirs') } })
    expect(onDisk.ops.flatMap((op) => (op.kind === 'note' ? [op.path] : [])).sort()).toEqual(
      [`${NFC} 2.md`, `${NFD} 3.md`, 'STRASSE.md', `${SHARP} 2.md`].sort(),
    )
  })

  it('a notebook or a note renamed only in the form of its accents keeps its name', () => {
    const cafe = book(100, NFC)
    const world = mirrored({
      notes: [note(1, 'Menu', { bookId: cafe.id }), note(2, NFC)],
      books: [cafe],
      bodies: { [id(1)]: 'a\n', [id(2)]: 'b\n' },
    })
    expect(
      Object.values(world.manifest!.notes)
        .map((e) => e.path)
        .sort(),
    ).toEqual([`${NFC}.md`, `${NFC}/Menu.md`].sort())
    const renamed = {
      ...changeNote(world, 2, { title: NFD }),
      books: [{ ...cafe, name: NFD }],
    }
    const sha = world.manifest!.notes[id(2)]!.sha256
    const plan = settle({ ...renamed, disk: { ...renamed.disk, [`${NFD}.md`]: sha } })
    expect(kinds(plan.ops)).toEqual([`note ${NFC}.md -> ${NFD}.md (record)`])
  })

  const SQUARED = 'x\u00b2'
  const WIDE = '\uff37\uff4f\uff52\uff4b'

  it('a notebook renamed across a compatibility form moves its folder', () => {
    for (const [oldName, newName] of [
      [SQUARED, 'x2'],
      [WIDE, 'Work'],
    ] as const) {
      const named = book(100, oldName)
      const world = mirrored({
        notes: [note(1, 'Menu', { bookId: named.id })],
        books: [named],
        bodies: { [id(1)]: 'a\n' },
      })
      const renamed = { ...world, books: [{ ...named, name: newName }] }
      expect(kinds(settle(renamed).ops)).toEqual([
        `note ${oldName}/Menu.md -> ${newName}/Menu.md`,
        `book ${newName}`,
      ])
      const theirs = settle({
        ...renamed,
        disk: { ...renamed.disk, [newName]: 'dir', [`${newName}/Menu.md`]: sha256Hex('theirs') },
      })
      expect(kinds(theirs.ops)).toEqual([
        `note ${oldName}/Menu.md -> ${newName}/Menu 2.md`,
        `book ${newName}`,
      ])
    }
    const ligature = book(100, '\ufb01nance')
    const world = mirrored({
      notes: [note(1, 'Menu', { bookId: ligature.id })],
      books: [ligature],
      bodies: { [id(1)]: 'a\n' },
    })
    expect(settle({ ...world, books: [{ ...ligature, name: 'finance' }] }).ops).toEqual([])
  })

  it('a link to an attachment ID Devot never made stays a link', () => {
    const world = library()
    const foreign = '123e4567-e89b-42d3-a456-426614174000'
    world.bodies[id(4)] = `![x](devot://file/${foreign})\n`
    const plan = settle(world)
    expect(textOf(plan, 'Loose.md')).toBe(`![x](devot://file/${foreign})\n`)
    expect(kinds(plan.ops).filter((k) => k.startsWith('file'))).toEqual([
      'file attachments/board.png',
    ])
  })

  it('a note keeps its numbered name; a new note takes the free one', () => {
    const world = mirrored()
    const first = { ...world, notes: world.notes.filter((n) => n.id !== id(2)) }
    const plan = settle(first)
    expect(kinds(plan.ops)).toEqual([
      'remove Work/Plans 2026/Plan.md',
      'remove attachments/board.png',
    ])
    const manifest = after(world.manifest!, plan.ops)
    const added = settle({
      ...first,
      manifest,
      disk: diskOf(manifest),
      notes: [...first.notes, note(7, 'Plan', { bookId: id(101) })],
      bodies: { ...first.bodies, [id(7)]: 'New.\n' },
    })
    expect(kinds(added.ops)).toEqual(['note - -> Work/Plans 2026/Plan.md'])
  })

  it('never takes the name of a file or a link Devot did not write; a folder may be shared', () => {
    const world = library()
    world.disk = {
      'Loose.md': sha256Hex('mine'),
      Work: 'dir',
      'attachments 2': 'other',
      'attachments/board.png': sha256Hex('another image'),
    }
    const plan = settle(world)
    const paths = plan.ops.flatMap((op) => ('path' in op && op.path ? [op.path] : []))
    expect(paths).toContain('Loose 2.md')
    expect(paths).toContain('Work/Inbox.md')
    expect(paths).toContain('attachments 3/Untitled.md')
    expect(paths).toContain('attachments/board 2.png')
    expect(paths).not.toContain('Loose.md')
    expect(textOf(plan, 'Work/Plans 2026/Plan.md')).toContain(
      '../../attachments/board%202.png#half',
    )
  })

  it("a notebook's folder never takes a note's file name or the attachments folder", () => {
    const top = book(100, 'Top')
    const world: World = {
      notes: [
        note(1, 'Plan', { bookId: top.id }),
        note(2, 'Inner', { bookId: id(101) }),
        note(3, 'Kept', { bookId: id(102) }),
      ],
      books: [top, book(101, 'Plan.md', top.id, 'a'), book(102, 'attachments', null, 'b')],
      bodies: { [id(1)]: 'a\n', [id(2)]: 'b\n', [id(3)]: 'c\n' },
    }
    const paths = settle(world).ops.flatMap((op) => (op.kind === 'note' ? [op.path] : []))
    expect(paths.sort()).toEqual(['Top/Plan.md', 'Top/Plan.md 2/Inner.md', 'attachments 2/Kept.md'])
  })

  it('numbers attachments like Rust', () => {
    expect(numberedName('board.png', 1)).toBe('board.png')
    expect(numberedName('board.png', 2)).toBe('board 2.png')
    expect(numberedName('archive.tar.gz', 3)).toBe('archive.tar 3.gz')
    expect(numberedName('noext', 2)).toBe('noext 2')
  })
})

describe('files changed outside Devot', () => {
  const edited = sha256Hex('edited outside')

  it('are kept before a note edit writes its own version', () => {
    const world = mirrored()
    const next = changeNote(world, 1, {})
    next.bodies = { ...next.bodies, [id(1)]: '# Inbox\n\nNew.\n' }
    next.disk = { ...next.disk, 'Work/Inbox.md': edited }
    expect(kinds(settle(next).ops)).toEqual(['keep Work/Inbox.md', 'note - -> Work/Inbox.md'])
  })

  it('are kept on a rename, a move, a trash and a purge', () => {
    const world = mirrored()
    world.disk = { ...world.disk, 'Loose.md': edited }
    expect(kinds(settle(changeNote(world, 4, { title: 'Renamed' })).ops)).toEqual([
      'keep Loose.md',
      'note - -> Renamed.md',
    ])
    expect(kinds(settle(changeNote(world, 4, { bookId: id(100) })).ops)).toEqual([
      'keep Loose.md',
      'note - -> Work/Loose.md',
    ])
    const gone = { ...world, notes: world.notes.filter((n) => n.id !== id(4)) }
    expect(kinds(settle(gone).ops)).toEqual(['keep Loose.md'])
  })

  it('are kept by a reconcile even when the note did not change; a missing file is written again', () => {
    const world = mirrored()
    const checked = { ...diskOf(world.manifest!), 'Loose.md': edited, 'Work/Inbox.md': null }
    const plan = settle({ ...world, checked, disk: { ...world.disk, ...checked } })
    expect(kinds(plan.ops)).toEqual([
      'keep Loose.md',
      'note - -> Loose.md',
      'note - -> Work/Inbox.md',
    ])
  })

  it('that hold what Devot would write are taken as written, not kept', () => {
    const world = mirrored()
    const next = changeNote(world, 4, {})
    next.bodies = { ...next.bodies, [id(4)]: 'Changed.\n' }
    next.disk = { ...next.disk, 'Loose.md': sha256Hex('Changed.\n') }
    const plan = settle(next)
    expect(kinds(plan.ops)).toEqual(['note Loose.md -> Loose.md (record)'])
  })

  it('replaced by a folder or a link: the entry is forgotten and the note takes another name', () => {
    const world = mirrored()
    world.disk = { ...world.disk, 'Loose.md': 'dir' }
    const plan = settle({ ...world, checked: { 'Loose.md': 'dir' } })
    expect(kinds(plan.ops)).toEqual([`forget ${id(4)}`, 'note - -> Loose 2.md'])
  })

  it('are kept for attachments too, and a fresh copy is written', () => {
    const world = mirrored()
    const checked = { ...diskOf(world.manifest!), 'attachments/board.png': edited }
    const plan = settle({ ...world, checked, disk: { ...world.disk, ...checked } })
    expect(kinds(plan.ops)).toEqual(['keep attachments/board.png', 'file attachments/board.png'])
  })
})

describe('files Devot wrote that the manifest does not list', () => {
  // A batch's files reach the disk before its manifest does: a crash, a
  // power loss or a quit in between leaves them without entries (as does a
  // folder chosen again after its manifest was lost).
  it('a note file that holds exactly what Devot would write there is taken back, not numbered', () => {
    const world = library()
    world.disk = { 'Loose.md': sha256Hex('At the top.\n') }
    const plan = settle(world)
    expect(kinds(plan.ops)).toContain('note - -> Loose.md (record)')
    expect(kinds(plan.ops).filter((k) => k.includes('Loose 2'))).toEqual([])
    world.disk = { 'Loose.md': sha256Hex('At the top, edited.\n') }
    expect(kinds(settle(world).ops)).toContain('note - -> Loose 2.md')
  })

  it('a whole first mirror whose manifest never reached the disk is taken back, file for file', () => {
    const world: World = { ...library(), hashes: { [id(300)]: sha256Hex('board bytes') } }
    const first = settle(world)
    expect(first.asked.hashes).toEqual([])
    const disk: Record<string, DiskState> = { attachments: 'dir' }
    for (const op of first.ops) {
      if (op.kind === 'note') disk[op.path] = op.sha256
      if (op.kind === 'file') disk[op.path] = world.hashes![op.id]!
      if (op.kind === 'book' && op.path !== null) disk[op.path] = 'dir'
    }
    const again = settle({ ...world, disk })
    expect(kinds(again.ops)).toEqual(
      kinds(first.ops).map((k) => (k.startsWith('note') ? `${k} (record)` : k)),
    )
    expect(again.asked.hashes).toEqual([id(300)])
    const theirs = settle({ ...world, disk: { ...disk, 'attachments/board.png': sha256Hex('x') } })
    expect(kinds(theirs.ops)).toContain('file attachments/board 2.png')
  })

  it('a note file is checked against what Devot would write at that very place, whatever came first', () => {
    // The image went to `board 2.png` (someone's own `board.png` was there),
    // so the note's file links that one.
    const board = id(300)
    const world: World = {
      notes: [note(1, 'Plan')],
      bodies: { [id(1)]: `![b](devot://file/${board})\n` },
      files: { [board]: 'board.png' },
      hashes: { [board]: sha256Hex('board bytes') },
    }
    const written = markdownFile(
      { title: 'Plan', bodyMd: world.bodies[id(1)]!, tags: [], status: 'none' },
      'Plan.md',
      new Map([[board, 'attachments/board 2.png']]),
    )
    world.disk = {
      'attachments/board.png': sha256Hex('theirs'),
      'attachments/board 2.png': sha256Hex('board bytes'),
      'Plan.md': sha256Hex(written),
    }
    expect(kinds(settle(world).ops)).toEqual([
      'file attachments/board 2.png',
      'note - -> Plan.md (record)',
    ])
  })

  it('a note takes its own file back even when an older note of the same title came first', () => {
    const world: World = {
      notes: [note(1, 'Plan'), note(2, 'Plan')],
      bodies: { [id(1)]: 'Older.\n', [id(2)]: 'Newer.\n' },
      disk: { 'Plan.md': sha256Hex('Newer.\n') },
    }
    expect(kinds(settle(world).ops)).toEqual(['note - -> Plan.md (record)', 'note - -> Plan 2.md'])
  })

  it('a copy written after Include Attachments came on, but never listed, is taken back', () => {
    const off = mirrored({ ...library(), includeAttachments: false })
    expect(off.manifest.files[id(300)]).toEqual({
      path: 'attachments/board.png',
      sha256: null,
      size: 0,
    })
    const plan = settle({
      ...off,
      includeAttachments: true,
      hashes: { [id(300)]: sha256Hex('board bytes') },
      disk: { ...off.disk, 'attachments/board.png': sha256Hex('board bytes') },
    })
    expect(kinds(plan.ops)).toEqual(['file attachments/board.png'])
  })
})

describe('folders that are no longer folders', () => {
  const checkedWith = (world: World, under: string) =>
    Object.fromEntries(
      Object.entries(diskOf(world.manifest!)).map(([p, s]) => [
        p,
        p.startsWith(`${under}/`) ? 'other' : s,
      ]),
    )

  it("a notebook's folder replaced by a link: its notes go to a new folder, and the plan settles", () => {
    const world = mirrored()
    const plan = settle({ ...world, linked: ['Work'], checked: checkedWith(world, 'Work') })
    expect(kinds(plan.ops)).toEqual([
      `forget ${id(3)}`,
      `forget ${id(2)}`,
      `forget ${id(1)}`,
      'note - -> Work 2/Plans 2026/Plan 2.md',
      'note - -> Work 2/Plans 2026/Plan.md',
      'note - -> Work 2/Inbox.md',
      'book Work 2',
      'book Work 2/Plans 2026',
    ])
  })

  it('a note file replaced by a link in a real notebook folder: the notebook keeps its folder', () => {
    const world = mirrored()
    const checked = { ...diskOf(world.manifest!), 'Work/Inbox.md': 'other' }
    const plan = settle({ ...world, linked: ['Work/Inbox.md'], disk: { Work: 'dir' }, checked })
    expect(kinds(plan.ops)).toEqual([`forget ${id(1)}`, 'note - -> Work/Inbox 2.md'])
  })

  it('the attachments folder replaced by a link: only names are kept there, and the plan settles', () => {
    const world = mirrored()
    const plan = settle({
      ...world,
      linked: ['attachments'],
      checked: checkedWith(world, 'attachments'),
    })
    expect(kinds(plan.ops)).toEqual([`forget ${id(300)}`, 'file attachments/board.png (name)'])
    const fresh = settle({ ...library(), linked: ['attachments'] })
    expect(kinds(fresh.ops).filter((k) => k.startsWith('file'))).toEqual([
      'file attachments/board.png (name)',
    ])
    expect(textOf(fresh, 'Work/Plans 2026/Plan.md')).toContain(
      '](../../attachments/board.png#half)',
    )
  })
})

describe('attachments', () => {
  const shared = (): World => {
    const world = library()
    world.notes = [...world.notes, note(8, 'Shares', {})]
    world.bodies = { ...world.bodies, [id(8)]: `![b](devot://file/${id(300)})\n` }
    return world
  }

  it('one copy for every note that shows it; it goes when none does', () => {
    const world = mirrored(shared())
    expect(Object.keys(world.manifest!.files)).toEqual([id(300)])
    const ownerGone = { ...world, notes: world.notes.filter((n) => n.id !== id(2)) }
    expect(kinds(settle(ownerGone).ops)).toEqual(['remove Work/Plans 2026/Plan.md'])
    const noneLeft = { ...ownerGone, notes: ownerGone.notes.filter((n) => n.id !== id(8)) }
    expect(kinds(settle(noneLeft).ops)).toEqual([
      'remove Shares.md',
      'remove Work/Plans 2026/Plan.md',
      'remove attachments/board.png',
    ])
  })

  it('copies an attachment shown only by an <img> tag in raw HTML, and points the tag at it', () => {
    const world = library()
    world.notes = [...world.notes, note(9, 'Diagram')]
    world.bodies = {
      ...world.bodies,
      [id(9)]: `<p align="center"><IMG SRC="devot://file/${id(301)}" width="300"></p>\n`,
    }
    world.files = { ...world.files, [id(301)]: 'diagram.png' }
    const plan = settle(world)
    expect(kinds(plan.ops)).toContain('file attachments/diagram.png')
    expect(textOf(plan, 'Diagram.md')).toBe(
      '<p align="center"><IMG SRC="attachments/diagram.png" width="300"></p>\n',
    )
    const op = plan.ops.find((o) => o.kind === 'note' && o.path === 'Diagram.md')
    expect(op?.kind === 'note' && op.files).toEqual([id(301)])
  })

  it('an attachment no longer in the database (its note purged) turns back into its link', () => {
    const world = mirrored(shared())
    const purged = { ...world, notes: world.notes.filter((n) => n.id !== id(2)), files: {} }
    const plan = settle(purged)
    expect(kinds(plan.ops)).toEqual([
      'remove Work/Plans 2026/Plan.md',
      'remove attachments/board.png',
      'note Shares.md -> Shares.md',
    ])
    expect(textOf(plan, 'Shares.md')).toBe(`![b](devot://file/${id(300)})\n`)
  })

  it('off: no copies, links still point at attachments/<name>; copies written before go', () => {
    const fresh = settle({ ...library(), includeAttachments: false })
    expect(kinds(fresh.ops).filter((k) => k.startsWith('file'))).toEqual([
      'file attachments/board.png (name)',
    ])
    expect(textOf(fresh, 'Work/Plans 2026/Plan.md')).toContain('../../attachments/board.png#half')
    const world = mirrored()
    const off = settle({ ...world, includeAttachments: false })
    expect(kinds(off.ops)).toEqual([
      'remove attachments/board.png',
      'file attachments/board.png (name)',
    ])
    // Changed outside Devot: kept, never deleted.
    const editedCopy = settle({
      ...world,
      includeAttachments: false,
      disk: { ...world.disk, 'attachments/board.png': sha256Hex('x') },
    })
    expect(kinds(editedCopy.ops)).toEqual([
      'keep attachments/board.png',
      'file attachments/board.png (name)',
    ])
    const manifest = after(world.manifest!, off.ops)
    const on = settle({ ...world, manifest, disk: diskOf(manifest) })
    expect(kinds(on.ops)).toEqual(['file attachments/board.png'])
  })
})

describe('what a note is written from', () => {
  it('changes with its update time, title, status, tags, path and attachment paths only', () => {
    const base = note(1, 'Plan')
    const source = noteSource(base, ['a'], 'Plan.md', ['attachments/x.png'])
    expect(noteSource({ ...base }, ['a'], 'Plan.md', ['attachments/x.png'])).toBe(source)
    for (const other of [
      noteSource({ ...base, updatedAt: 1 }, ['a'], 'Plan.md', ['attachments/x.png']),
      noteSource({ ...base, title: 'Other' }, ['a'], 'Plan.md', ['attachments/x.png']),
      noteSource({ ...base, status: 'active' }, ['a'], 'Plan.md', ['attachments/x.png']),
      noteSource(base, ['b'], 'Plan.md', ['attachments/x.png']),
      noteSource(base, ['a'], 'Other.md', ['attachments/x.png']),
      noteSource(base, ['a'], 'Plan.md', ['-']),
    ]) {
      expect(other).not.toBe(source)
    }
  })
})
