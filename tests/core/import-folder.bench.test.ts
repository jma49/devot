// Markdown folder import on SQLite: a vault of nested folders with wiki-style links and images,
// imported whole. The docs set no budget for import; the budgets are baselines measured on a
// Linux runner with room for a busy machine, and the growth checks need no machine speed.
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  importMarkdown,
  prepareImportFile,
  type ImportScan,
  type ImportSource,
} from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { cpuMs, expectLinearGrowth, fourfoldGrowth, fourfoldGrowthAsync } from '../support/growth'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const TIMEOUT_MS = 180_000
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])

// Closed at the end, not after each test: revision writes an import queued may still be running.
const open: SqliteAdapter[] = []
afterAll(() => open.splice(0).forEach((a) => a.close()))

function services() {
  const storage = openSqliteAdapter(join(tempDir('devot-import-bench-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  return {
    storage,
    notes: createNoteService({ storage, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage, clock, newId }),
    tags: createTagService({ storage, clock, newId }),
    newId,
  }
}

type Vault = { files: Record<string, string>; images: string[] }

const paragraph = (n: number) =>
  `Paragraph ${n} with **bold** words, a [link](https://example.com/${n}) and \`code\`. `.repeat(4)

/** `count` notes of about 2 KB in folders of 20, ten folders to a parent, each linking to two others and showing an image. */
function vault(count: number): Vault {
  const files: Record<string, string> = {}
  const images: string[] = []
  const folderOf = (i: number) => `Area ${Math.floor(i / 200)}/Project ${Math.floor(i / 20)}`
  for (let i = 0; i < count; i += 1) {
    const folder = folderOf(i)
    if (i % 20 === 0) images.push(`${folder}/diagram.png`)
    files[`${folder}/Note ${i}.md`] = [
      `---\ntags: [area${i % 7}]\n---`,
      `# Note ${i}`,
      paragraph(i),
      `See [[Note ${(i * 31 + 7) % count}]] and [[Note ${(i + 1) % count}|the next one]].`,
      '![[diagram.png]]',
      paragraph(i + 1),
      `- [ ] task ${i}\n- [x] done ${i}`,
      paragraph(i + 2),
    ].join('\n\n')
  }
  return { files, images }
}

/** Every folder holds an `index.md` and an `image.png`, linking to the index beside it: names that repeat in every folder. */
function sameNames(count: number): Vault {
  const files: Record<string, string> = {}
  const images: string[] = []
  for (let i = 0; i < count; i += 1) {
    images.push(`Folder ${i}/image.png`)
    files[`Folder ${i}/index.md`] = `# Index ${i}\n\nSee [[index]] and ![[image.png]].\n`
  }
  return { files, images }
}

/** `count` short notes, each three folders down in a folder of its own, ten of those to a parent: 4.1 notebooks a note. */
function manyFolders(count: number): Vault {
  const files: Record<string, string> = {}
  for (let i = 0; i < count; i += 1) {
    files[`Area ${Math.floor(i / 10)}/Folder ${i}/One/Two/Three/Note ${i}.md`] =
      `# Note ${i}\n\nShort.\n`
  }
  return { files, images: [] }
}

/** Opens a store for `vault` and returns its import (with the flush of the saves it queued) to time. */
function prepareImport({ files, images }: Vault) {
  const made = services()
  const scan: ImportScan = {
    id: 1,
    name: 'Vault',
    kind: 'folder',
    files: Object.keys(files)
      .sort()
      .map((path) => ({ path, bytes: files[path]!.length })),
    images: images.sort().map((path) => ({ path, bytes: PNG.length })),
    skipped: [],
  }
  const source: ImportSource = {
    read: async (path) => files[path]!,
    attach: async (path, file) => {
      await made.storage.putFile({ ...file, name: path.split('/').pop()! }, PNG)
    },
  }
  return async () => {
    const report = await importMarkdown({ ...made, scan, source, files: made.storage })
    await made.notes.flush()
    return report
  }
}

const importVault = (made: Vault) => prepareImport(made)()

/** Growth of a whole import in CPU time, with the larger import's CPU milliseconds. */
const importGrowth = (make: (n: number) => Vault, n: number, rounds?: number) =>
  fourfoldGrowthAsync(async (size) => prepareImport(make(size)), n, rounds)

describe('importing a Markdown folder', { timeout: TIMEOUT_MS }, () => {
  const NOTES = 80
  // Measured about 12 ms a note on a Linux runner (parse, notebooks, Yjs body, image, links, save).
  const PER_NOTE_BUDGET_MS = 30

  it('imports every note, link and image of a vault', async () => {
    const report = await importVault(vault(NOTES))
    expect(report.problems).toEqual([])
    expect(report.notes).toBe(NOTES)
    expect(report.attachments).toBe(NOTES)
    expect(report.links).toBe(3 * NOTES)
    expect(report.unresolvedLinks).toBe(0)
  })

  it(`imports ${4 * NOTES} notes in under ${PER_NOTE_BUDGET_MS} ms a note, in time linear in the notes`, async (context) => {
    const { growth, largeMs } = await importGrowth(vault, NOTES)
    expectWithinBudget(context, largeMs / (4 * NOTES), PER_NOTE_BUDGET_MS)
    expectLinearGrowth(context, growth)
  })

  it('takes time linear in the notes when every folder repeats the same names', async (context) => {
    const report = await importVault(sameNames(50))
    expect(report.problems).toEqual([])
    expect(report.links).toBe(100)
    expectLinearGrowth(context, (await importGrowth(sameNames, 100)).growth)
  })
})

describe('importing thousands of folders', { timeout: TIMEOUT_MS }, () => {
  // The notebooks are made in one write: making each alone listed every notebook made before it.
  it('takes time linear in the folders', async (context) => {
    const report = await importVault(manyFolders(400))
    expect(report.problems).toEqual([])
    expect(report.books).toBe(1640)
    expectLinearGrowth(context, (await importGrowth(manyFolders, 400, 1)).growth)
  })
})

describe('preparing one large Markdown file', { timeout: TIMEOUT_MS }, () => {
  const file = (paragraphs: number) =>
    Array.from({ length: paragraphs }, (_, p) =>
      p % 10 === 0
        ? `## Section ${p}\n\n![figure](images/figure-${p}.png) and [[Note ${p}]]`
        : paragraph(p),
    ).join('\n\n')

  it('reads every image and wiki link of a large file', () => {
    const prepared = prepareImportFile(file(1000), 'Big.md', () => crypto.randomUUID())
    expect(prepared.images.links).toHaveLength(100)
    expect(prepared.images.wiki).toHaveLength(100)
  })

  // Measured about 1.6 s for 600 KB on a Linux runner, nearly all of it the one Markdown parse.
  it('prepares a 600 KB file in under 3 s, in time linear in its length', async (context) => {
    const prepare = (paragraphs: number) => {
      const markdown = file(paragraphs)
      return () => prepareImportFile(markdown, 'Big.md', () => crypto.randomUUID())
    }
    expect(file(2000).length).toBeGreaterThan(600_000)
    const growth = fourfoldGrowth(prepare, 500, 3)
    expectWithinBudget(context, await cpuMs(async () => prepare(2000)()), 3000)
    expectLinearGrowth(context, growth)
  })
})
