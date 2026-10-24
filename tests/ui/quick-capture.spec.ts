import type { Page } from '@playwright/test'
import { expect, openSettings, test, type TestWindow } from './fixtures'

// The quick capture window (menu bar mode). Rust and the main window's core save its note
// (src-tauri/src/menu_bar.rs); here `quick_capture_save` is mocked and the calls are read back.

const NOTEBOOKS = [
  { id: 'b1', name: 'Work', depth: 0 },
  { id: 'b2', name: 'Inbox', depth: 1 },
]

async function open(page: Page, options: { defaultNotebook?: string; save?: unknown } = {}) {
  await page.addInitScript(
    ({ notebooks, defaultNotebook, save }) => {
      const w = globalThis as unknown as TestWindow & {
        localStorage: { setItem(key: string, value: string): void }
      }
      // The main window publishes the notebooks (notebookChoices.ts).
      w.localStorage.setItem('devot.notebookChoices', JSON.stringify(notebooks))
      if (defaultNotebook) w.devotEditorSettings = { defaultNotebook }
      w.devotIpcMocks = {
        quick_capture_save: save ?? null,
        quick_capture_close: null,
      }
    },
    { notebooks: NOTEBOOKS, defaultNotebook: options.defaultNotebook, save: options.save },
  )
  await page.goto('/quick-capture.html')
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

const title = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note' })
const notebook = (page: Page) => page.getByRole('combobox', { name: 'Notebook' })
const save = (page: Page) => page.getByRole('button', { name: 'Save' })

test('saves a title and body into the default notebook with Command-Return, then closes', async ({
  page,
}) => {
  await open(page, { defaultNotebook: 'b2' })
  await expect(title(page)).toBeFocused()
  await expect(save(page)).toBeDisabled()
  await expect(notebook(page)).toHaveValue('b2')
  await title(page).fill('Groceries')
  await title(page).press('Enter')
  await expect(body(page)).toBeFocused()
  await body(page).fill('- milk\n- bread')
  await body(page).press('Meta+Enter')
  await expect.poll(() => calls(page, 'quick_capture_close')).toHaveLength(1)
  expect(await calls(page, 'quick_capture_save')).toEqual([
    { capture: { title: 'Groceries', body: '- milk\n- bread', bookId: 'b2' } },
  ])
  await expect(title(page)).toHaveValue('')
  await expect(body(page)).toHaveValue('')
})

test('saves into the notebook picked, or none', async ({ page }) => {
  await open(page)
  await expect(notebook(page)).toHaveValue('')
  await body(page).fill('A thought')
  await notebook(page).selectOption('b1')
  await save(page).click()
  await expect
    .poll(() => calls(page, 'quick_capture_save'))
    .toEqual([{ capture: { title: '', body: 'A thought', bookId: 'b1' } }])
})

test('keeps the text and says why when the note could not be saved', async ({ page }) => {
  await open(page, { save: { error: 'E_BOOK_NOT_FOUND' } })
  await title(page).fill('Lost?')
  await save(page).click()
  await expect(page.getByRole('alert')).toHaveText(
    'That notebook no longer exists (E_BOOK_NOT_FOUND). Choose another one.',
  )
  await expect(title(page)).toHaveValue('Lost?')
  expect(await calls(page, 'quick_capture_close')).toEqual([])
  await expect(save(page)).toBeEnabled()
})

test('keeps a draft when the window closes before saving, and brings it back', async ({ page }) => {
  await open(page)
  await title(page).fill('Call back')
  await body(page).fill('about the lease')
  await notebook(page).selectOption('b1')
  await body(page).press('Escape')
  await expect.poll(() => calls(page, 'quick_capture_close')).toHaveLength(1)
  expect(await calls(page, 'quick_capture_save')).toEqual([])
  await page.reload()
  await expect(title(page)).toHaveValue('Call back')
  await expect(body(page)).toHaveValue('about the lease')
  await expect(notebook(page)).toHaveValue('b1')
})

test('Settings > General turns menu bar mode on and names the shortcut', async ({ page }) => {
  await openSettings(page, 'General')
  const toggle = page.getByRole('switch', { name: 'Keep in Menu Bar' })
  await expect(toggle).not.toBeChecked()
  await expect(toggle).toHaveAccessibleDescription(/press ⌃⌥⌘N in any app/)
  await toggle.check()
  await expect
    .poll(() => calls(page, 'editor_settings_set'))
    .toContainEqual({ patch: { menuBar: true } })
})
