import type { Page } from '@playwright/test'
import { expect, openSettings, test } from './fixtures'

// The quick capture window (menu bar mode). Rust and the main window's core save its note
// (src-tauri/src/menu_bar.rs); here `quick_capture_save` is mocked and the calls are read back.

const NOTEBOOKS = [
  { id: 'b1', name: 'Work', depth: 0 },
  { id: 'b2', name: 'Inbox', depth: 1 },
]

async function open(
  page: Page,
  options: {
    defaultNotebook?: string
    save?: unknown
    holdSave?: boolean
    prefills?: { title: string; body: string }[][]
  } = {},
) {
  await page.addInitScript(
    ({ notebooks, defaultNotebook, save, holdSave, prefills }) => {
      const w = window
      // The main window publishes the notebooks (notebookChoices.ts).
      w.localStorage.setItem('devot.notebookChoices', JSON.stringify(notebooks))
      if (defaultNotebook) w.devotEditorSettings = { defaultNotebook }
      w.devotIpcMocks = {
        quick_capture_save: holdSave
          ? () =>
              new Promise<null>((answer) => {
                w.devotAnswerSave = () => answer(null)
              })
          : (save ?? null),
        quick_capture_close: null,
        quick_capture_prefill_take: () => w.devotPrefills?.shift() ?? [],
      }
      w.devotPrefills = prefills
    },
    {
      notebooks: NOTEBOOKS,
      defaultNotebook: options.defaultNotebook,
      save: options.save,
      holdSave: options.holdSave ?? false,
      prefills: options.prefills ?? [],
    },
  )
  await page.goto('/quick-capture.html')
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => window.devotIpcCalls.filter((call) => call.cmd === c).map((call) => call.args),
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
    'That notebook no longer exists. Choose another one.',
  )
  await expect(title(page)).toHaveValue('Lost?')
  expect(await calls(page, 'quick_capture_close')).toEqual([])
  await expect(save(page)).toBeEnabled()
})

test('says a note Devot is still saving will appear, so it is not saved twice', async ({
  page,
}) => {
  await open(page, { save: { error: 'E_QUICK_CAPTURE_LATE' } })
  await title(page).fill('Slow')
  await save(page).click()
  await expect(page.getByRole('alert')).toHaveText(
    'Devot is still saving this note. It will appear in your notes; check there before saving it again.',
  )
  await expect(title(page)).toHaveValue('Slow')
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

test('while a save is on its way, nothing can be typed, cancelled or left as a draft', async ({
  page,
}) => {
  await open(page, { holdSave: true })
  await title(page).fill('Sent')
  await body(page).fill('as typed')
  await body(page).press('Meta+Enter')
  await expect.poll(() => calls(page, 'quick_capture_save')).toHaveLength(1)
  await expect(title(page)).not.toBeEditable()
  await expect(body(page)).not.toBeEditable()
  await expect(notebook(page)).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  await body(page).press('Escape')
  expect(await calls(page, 'quick_capture_close')).toEqual([])
  await page.evaluate(() => window.devotAnswerSave?.())
  await expect.poll(() => calls(page, 'quick_capture_close')).toHaveLength(1)
  await page.reload()
  await expect(title(page)).toHaveValue('')
  await expect(body(page)).toHaveValue('')
})

/** A capture link reached Rust while the window is open. */
const linkArrives = (page: Page, prefill: { title: string; body: string }) =>
  page.evaluate((p) => {
    const w = window
    w.devotPrefills = [...(w.devotPrefills ?? []), [p]]
    w.dispatchEvent(new w.CustomEvent('devot:quick-capture-prefill'))
  }, prefill)

test('a capture link fills the window it opens, and only Save makes the note', async ({ page }) => {
  await open(page, { prefills: [[{ title: 'Page', body: 'A quote\n\nhttps://example.com' }]] })
  await expect(title(page)).toHaveValue('Page')
  await expect(body(page)).toHaveValue('A quote\n\nhttps://example.com')
  expect(await calls(page, 'quick_capture_save')).toEqual([])
  await body(page).press('Meta+Enter')
  await expect
    .poll(() => calls(page, 'quick_capture_save'))
    .toEqual([{ capture: { title: 'Page', body: 'A quote\n\nhttps://example.com', bookId: null } }])
  await expect.poll(() => calls(page, 'quick_capture_close')).toHaveLength(1)
})

test('a capture link that reaches the open window adds to what is typed', async ({ page }) => {
  await open(page)
  await title(page).fill('Mine')
  await body(page).fill('typed')
  await linkArrives(page, { title: 'Page', body: 'quote' })
  await expect(body(page)).toHaveValue('typed\n\nPage\nquote')
  await expect(title(page)).toHaveValue('Mine')
})

test('a capture link that comes while saving opens as a capture of its own', async ({ page }) => {
  await open(page, { holdSave: true })
  await body(page).fill('first')
  await body(page).press('Meta+Enter')
  await expect.poll(() => calls(page, 'quick_capture_save')).toHaveLength(1)
  await linkArrives(page, { title: 'Second', body: 'later' })
  await expect(body(page)).toHaveValue('first')
  await page.evaluate(() => window.devotAnswerSave?.())
  await expect(title(page)).toHaveValue('Second')
  await expect(body(page)).toHaveValue('later')
  await expect(body(page)).toBeEditable()
  expect(await calls(page, 'quick_capture_close')).toEqual([])
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
