// What a note service keeps of big notes it holds in memory beyond their Yjs documents: a note in
// memory is read from its document, so nothing of its body should be kept a second time.
import { join } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createClock,
  createIdGenerator,
  createNoteService,
  type NoteService,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const MB = 1024 * 1024
const SIZES_MB = [1, 2, 3, 5]
const TIMEOUT_MS = 120_000

setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

const open: SqliteAdapter[] = []
afterAll(() => open.splice(0).forEach((a) => a.close()))

function service(path: string): NoteService {
  const sqlite = openSqliteAdapter(path)
  open.push(sqlite)
  return createNoteService({
    storage: sqlite,
    clock: createClock('mac1', Date.now),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
}

/** Blocks of about `bytes` of Markdown in all, with headings, lists, tasks, links, tables and code. */
function richBlocks(bytes: number, seed: number): string[] {
  const parts: string[] = []
  let size = 0
  for (let i = 0; size < bytes; i += 1) {
    const block = [
      `## Section ${seed}.${i}`,
      `Some **bold** and _italic_ text with a [link](https://example.com/${i}) and \`code ${i}\`.`,
      `- [ ] task ${i}`,
      `- [x] done ${i}`,
      `| a | b |\n| - | - |\n| ${i} | ${seed} |`,
      '```ts\nconst value = ' + i + '\n```',
      '',
    ].join('\n')
    parts.push(block)
    size += block.length + 1
  }
  return parts
}

/** An update that writes `blocks` into the note one block at a time from the end, so the body is many Yjs items as a note typed over time is. */
function typedIn(state: Uint8Array, blocks: readonly string[]): Uint8Array {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const known = Y.encodeStateVector(doc)
  const text = doc.getText(BODY)
  for (const block of blocks.toReversed()) text.insert(0, `${block}\n`)
  return Y.encodeStateAsUpdate(doc, known)
}

const used = () => {
  collect()
  collect()
  const { heapUsed, arrayBuffers } = process.memoryUsage()
  return heapUsed + arrayBuffers
}

describe('big notes in memory', () => {
  it(
    'keeps no more than their Yjs documents',
    async () => {
      const path = join(tempDir('devot-memory-bench-'), 'devot.sqlite')
      const writer = service(path)
      const ids: string[] = []
      let bodyBytes = 0
      for (const [i, size] of SIZES_MB.entries()) {
        const id = await writer.create(`Big ${i}`)
        const blocks = richBlocks(size * MB, i)
        for (const block of blocks) bodyBytes += block.length + 1
        await writer.applyUpdate(id, typedIn((await writer.open(id)).state, blocks))
        ids.push(id)
      }
      const warmUp = await writer.create('Warm-up')
      await writer.flush()

      let before = used()
      const docs: Y.Doc[] = []
      for (const id of ids) {
        const doc = new Y.Doc()
        Y.applyUpdate(doc, (await writer.open(id)).state)
        docs.push(doc)
      }
      const docsOnly = used() - before
      expect(docs).toHaveLength(SIZES_MB.length)
      docs.length = 0

      const reader = service(path)
      await reader.open(warmUp)
      before = used()
      for (const id of ids) await reader.open(id)
      const held = used() - before

      expect(held - docsOnly).toBeLessThan(0.25 * bodyBytes)
    },
    TIMEOUT_MS,
  )
})
