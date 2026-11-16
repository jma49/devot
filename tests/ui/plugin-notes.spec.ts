import { appReady, expect, test } from './fixtures'
import { pluginFrame, servePlugins, type TestPlugin } from './plugins'
import { seedNotes } from './renders'

// A plugin with notes.read (ADR 0022) lists, searches and reads the notes through the core, from its sandboxed frame; one
// without it is refused. The UI test build keeps the notes in memory.

const plugin = (id: string, permissions: string[]): TestPlugin => ({
  manifest: { id, name: id, version: '1.0.0', apiVersion: 2, main: 'main.js', permissions },
  main: '',
})

interface Runtime {
  devot: {
    notes: {
      list(options?: { limit?: number }): Promise<{ id: string; title: string }[]>
      search(query: string): Promise<{ id: string; title: string }[]>
      get(id: string): Promise<{ id: string; title: string; markdown: string }>
    }
    notebooks: { list(): Promise<unknown[]> }
  }
}

test.beforeEach(async ({ page }) => {
  await servePlugins(page, [
    plugin('com.example.reader', ['notes.read']),
    plugin('com.example.blind', []),
  ])
  await seedNotes(page, 3)
  await appReady(page)
})

test('a plugin with notes.read lists, searches and reads notes', async ({ page }) => {
  const reader = await pluginFrame(page, 'com.example.reader')
  const listed = await reader.evaluate(() =>
    (globalThis as unknown as Runtime).devot.notes.list({ limit: 2 }),
  )
  expect(listed.map((n) => n.title)).toEqual(['Note 1', 'Note 2'])
  const id = listed[1]!.id
  expect(
    await reader.evaluate((note) => (globalThis as unknown as Runtime).devot.notes.get(note), id),
  ).toEqual({ id, title: 'Note 2', notebook: null, markdown: '' })
  await expect
    .poll(async () =>
      (
        await reader.evaluate(() => (globalThis as unknown as Runtime).devot.notes.search('Note 3'))
      ).map((n) => n.title),
    )
    .toContain('Note 3')
  expect(
    await reader.evaluate(() => (globalThis as unknown as Runtime).devot.notebooks.list()),
  ).toEqual([])
})

test('a plugin without notes.read reads no note', async ({ page }) => {
  const blind = await pluginFrame(page, 'com.example.blind')
  expect(
    await blind.evaluate(() =>
      (globalThis as unknown as Runtime).devot.notes.list().then(
        () => 'listed',
        (error: { code: string }) => error.code,
      ),
    ),
  ).toBe('E_PLUGIN_PERMISSION_DENIED')
})
