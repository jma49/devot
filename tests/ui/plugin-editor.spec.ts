import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'
import { pluginFrame, servePlugins, testPlugin } from './plugins'

// The editor calls of API v2 (ADR 0023): a command reads the selection and writes in its place as one undo step, the slash
// menu lists a plugin's commands, and a plugin with notes.read hears which note opens.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const popup = (page: Page) => page.locator('.cm-tooltip-autocomplete')

const MAIN = `
globalThis.opened = []
devot.notes.onOpened((id) => globalThis.opened.push(id))
devot.commands.handle('bold', async () => {
  const selection = await devot.note.selection()
  globalThis.selection = selection
  await devot.note.insert('**' + selection.text + '**', { replacing: selection.text })
})
devot.commands.handle('stamp', () => devot.note.insert('Stamped'))
`

const editor = testPlugin(
  'com.example.editor',
  ['note.read', 'note.edit', 'notes.read', 'commands', 'keymaps'],
  {
    commands: [
      { id: 'bold', title: 'Bold Selection' },
      { id: 'stamp', title: 'Stamp Here' },
    ],
    keymaps: [{ command: 'bold', key: 'Mod+Ctrl+Shift+B' }],
    slashMenu: [{ command: 'stamp' }],
  },
  MAIN,
)
editor.manifest = { ...editor.manifest, apiVersion: 2 }

test.beforeEach(async ({ page }) => {
  await servePlugins(page, [editor])
  await openApp(page)
  await pluginFrame(page, 'com.example.editor')
})

test('a command makes the selected text bold as one step Undo takes back', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await body(page).click()
  await page.keyboard.insertText('make this loud')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Meta+Control+Shift+KeyB')
  await expect(body(page)).toHaveText('make this **loud**')
  const frame = await pluginFrame(page, 'com.example.editor')
  expect(await frame.evaluate(() => (globalThis as { selection?: unknown }).selection)).toEqual({
    from: 10,
    to: 14,
    text: 'loud',
  })
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body(page)).toHaveText('make this loud')
})

test('the slash menu lists a plugin command, which writes where the slash was', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await body(page).click()
  await page.keyboard.type('/stamp')
  await expect(popup(page).getByRole('option').first()).toContainText('Stamp Here')
  await expect(popup(page).locator('completion-section')).toHaveText(['Plugins'])
  // The list takes keys once its queries ran and CodeMirror's interaction delay passed.
  await expect(popup(page)).not.toHaveClass(/cm-tooltip-autocomplete-disabled/)
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await expect(body(page)).toHaveText('Stamped')
})

test('a plugin with notes.read hears which note opens', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  const frame = await pluginFrame(page, 'com.example.editor')
  await expect
    .poll(() =>
      frame.evaluate(() => {
        const g = globalThis as unknown as {
          opened: unknown[]
          devot: { notes: { opened(): unknown } }
        }
        return { last: g.opened.at(-1), now: g.devot.notes.opened() }
      }),
    )
    .toEqual({ last: expect.any(String), now: expect.any(String) })
})
