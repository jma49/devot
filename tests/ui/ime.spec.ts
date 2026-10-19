import type { Locator, Page } from '@playwright/test'
import { COMPOSITION_END_KEY_MS } from '../../src/renderer/src/ime'
import { expect, openSettings, test } from './fixtures'

// Input-method keys (src/renderer/src/ime.ts) arrive with `isComposing` set, or after `compositionend` with key code 229 or sometimes
// the key's own code; only `watchCompositions` tells them apart. No field, shortcut or editor key may act on them.

const HOW = ['composing', 'ended'] as const
type How = (typeof HOW)[number]

interface Press {
  key: string
  code: string
  metaKey?: boolean
  ctrlKey?: boolean
}

const ENTER: Press = { key: 'Enter', code: 'Enter' }
const ESCAPE: Press = { key: 'Escape', code: 'Escape' }
const ARROW_DOWN: Press = { key: 'ArrowDown', code: 'ArrowDown' }
const TAB: Press = { key: 'Tab', code: 'Tab' }

function imeKey(target: Locator, press: Press, how: How): Promise<boolean> {
  return target.evaluate(
    (el, sent) => {
      // This config has no DOM types: the one browser class used here.
      const w = globalThis as unknown as {
        KeyboardEvent: new (type: string, init: object) => { defaultPrevented: boolean }
      }
      const event = new w.KeyboardEvent('keydown', {
        ...sent.press,
        isComposing: sent.how === 'composing',
        bubbles: true,
        cancelable: true,
        composed: true,
      })
      if (sent.how === 'ended') Object.defineProperty(event, 'keyCode', { value: 229 })
      ;(el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(event)
      return event.defaultPrevented
    },
    { press, how },
  )
}

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const findBar = (page: Page) => page.getByRole('search', { name: 'Find in Note' })
const findField = (page: Page) => findBar(page).getByRole('textbox', { name: 'Find' })
const replaceField = (page: Page) => findBar(page).getByRole('textbox', { name: 'Replace' })
const findStatus = (page: Page) => findBar(page).getByRole('status')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })

const composition = (page: Page, type: 'compositionstart' | 'compositionend') =>
  body(page).evaluate((el, name) => {
    const w = globalThis as unknown as {
      CompositionEvent: new (name: string, init: object) => unknown
    }
    const event = new w.CompositionEvent(name, { bubbles: true, composed: true, data: '' })
    ;(el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(event)
  }, type)

/** Runs a composition and sends `press` right after it, as WebKit does; returns ms from composition start to the key. */
const keyEndingComposition = (target: Locator, press: Press, keyCode: number) =>
  target.evaluate(
    (el, sent) => {
      const w = globalThis as unknown as {
        CompositionEvent: new (name: string, init: object) => unknown
        KeyboardEvent: new (name: string, init: object) => unknown
        performance: { now(): number }
      }
      const node = el as unknown as { dispatchEvent(e: unknown): boolean }
      const init = { bubbles: true, composed: true }
      const start = w.performance.now()
      node.dispatchEvent(new w.CompositionEvent('compositionstart', { ...init, data: '' }))
      node.dispatchEvent(new w.CompositionEvent('compositionend', { ...init, data: '' }))
      const key = new w.KeyboardEvent('keydown', { ...init, ...sent.press, cancelable: true })
      Object.defineProperty(key, 'keyCode', { value: sent.keyCode })
      node.dispatchEvent(key)
      return w.performance.now() - start
    },
    { press, keyCode },
  )

/** A key with its own code only counts as the input method's right after the composition ends; on a stalled machine skip, don't pass. */
function skipUnlessAtOnce(took: number) {
  test.skip(took >= COMPOSITION_END_KEY_MS, `the page took ${Math.round(took)} ms to send the key`)
}

const pickFormat = (page: Page, id: string) =>
  page.evaluate((detail) => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (type: string, init: { detail: unknown }) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:format', { detail }))
  }, id)

async function createNote(page: Page, title: string, text = '') {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  if (!text) return
  await body(page).click()
  // Inserted at once, so the editor's bracket helpers do not interfere.
  await page.keyboard.insertText(text)
  await expect(body(page)).toHaveText(text)
}

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toBeFocused()
  await field.fill(name)
  await field.press('Enter')
  await expect(book(page, name)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('in Move to Notebook, composition keys neither move the choice nor pick', async ({ page }) => {
  await createBook(page, 'Work')
  await createNote(page, 'Errand')
  const row = noteRows(page).filter({ hasText: 'Errand' })
  await row.click()
  await expect(row).toBeFocused()
  await page.keyboard.press('KeyM')
  const picker = page.getByRole('dialog', { name: 'Move to Notebook' })
  const filter = picker.getByRole('combobox', { name: 'Filter notebooks' })
  await expect(filter).toBeFocused()
  const options = picker.getByRole('option')
  await expect(options).toHaveText(['No Notebook', 'Work'])
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  for (const how of HOW) {
    await imeKey(filter, ARROW_DOWN, how)
    // Return would move the note out of Work.
    await imeKey(filter, ENTER, how)
  }
  await expect(picker).toBeVisible()
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(book(page, 'Work')).toContainText('1')
})

test('in the find bar, composition keys neither step, replace nor close it', async ({ page }) => {
  await createNote(page, 'Pets', 'cat dog cat')
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Alt+Meta+f')
  await expect(findField(page)).toBeFocused()
  await page.keyboard.type('cat')
  await expect(findStatus(page)).toHaveText('1 of 2')
  await replaceField(page).fill('bird')
  for (const how of HOW) {
    await imeKey(findField(page), ENTER, how)
    await imeKey(replaceField(page), ENTER, how)
    await imeKey(findField(page), ESCAPE, how)
    await imeKey(replaceField(page), ESCAPE, how)
  }
  await expect(findStatus(page)).toHaveText('1 of 2')
  expect(await lines(page)).toEqual(['cat dog cat'])
  await findField(page).press('Enter')
  await expect(findStatus(page)).toHaveText('2 of 2')
  await replaceField(page).press('Enter')
  expect(await lines(page)).toEqual(['cat dog bird'])
  await replaceField(page).press('Escape')
  await expect(findBar(page)).toHaveCount(0)
})

test('in the tag field, the Return of a composition adds no tag', async ({ page }) => {
  await createNote(page, 'Tagged')
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  const chips = page.getByRole('group', { name: 'Tags' }).locator('.chip')
  await field.fill('draft')
  for (const how of HOW) await imeKey(field, ENTER, how)
  await expect(field).toHaveValue('draft')
  await expect(chips).toHaveCount(0)
  await field.press('Enter')
  await expect(chips).toHaveText(['draft'])
  await expect(field).toHaveValue('')
})

test('in the tag field, the Return right after a composition adds no tag, whatever its key code', async ({
  page,
}) => {
  await createNote(page, 'Tagged')
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  const chips = page.getByRole('group', { name: 'Tags' }).locator('.chip')
  await field.fill('draft')
  // Return's own key code (13), not 229: only the main window's watch makes it the input method's.
  skipUnlessAtOnce(await keyEndingComposition(field, ENTER, 13))
  await expect(field).toHaveValue('draft')
  await expect(chips).toHaveCount(0)
  // Only that one key: the next Return is the user's.
  await field.press('Enter')
  await expect(chips).toHaveText(['draft'])
  await expect(field).toHaveValue('')
})

test('renaming a notebook, the Return or Escape of a composition neither commits nor cancels', async ({
  page,
}) => {
  await createBook(page, 'Draft')
  await book(page, 'Draft').locator('> .book-row').dblclick()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill('Ideas')
  for (const how of HOW) {
    await imeKey(field, ENTER, how)
    await imeKey(field, ESCAPE, how)
  }
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('Ideas')
  await field.press('Enter')
  await expect(book(page, 'Ideas')).toBeVisible()
  await expect(tree(page)).not.toContainText('Draft')
})

test('in the search field, the Escape of a composition keeps the query', async ({ page }) => {
  const field = page.getByRole('searchbox', { name: 'Search notes' })
  await field.fill('plan')
  for (const how of HOW) await imeKey(field, ESCAPE, how)
  await expect(field).toHaveValue('plan')
  await field.press('Escape')
  await expect(field).toHaveValue('')
})

test('window shortcuts leave the keys of a composition alone', async ({ page }) => {
  await createNote(page, 'Keys')
  await titleField(page).click()
  for (const how of HOW) {
    await imeKey(titleField(page), { key: 'f', code: 'KeyF', metaKey: true }, how)
    await imeKey(titleField(page), { key: 'p', code: 'KeyP', metaKey: true }, how)
  }
  await expect(findBar(page)).toHaveCount(0)
  await expect(palette(page)).toHaveCount(0)
  await expect(titleField(page)).toBeFocused()
  await page.keyboard.press('Meta+KeyK')
  await expect(palette(page)).toBeVisible()
})

test('Cmd+B and the Format menu leave a composition in the editor alone', async ({ page }) => {
  await createNote(page, 'Bold', 'word')
  await page.keyboard.press('Shift+Home')
  await composition(page, 'compositionstart')
  // The input method passes Cmd+B on, so the page gets it mid-composition; it must not end it.
  const mod = process.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true }
  expect(await imeKey(body(page), { key: 'b', code: 'KeyB', ...mod }, 'composing')).toBe(false)
  await pickFormat(page, 'format.bold')
  expect(await lines(page)).toEqual(['word'])
  await composition(page, 'compositionend')
  await pickFormat(page, 'format.bold')
  await expect(body(page)).toHaveText('**word**')
})

test('the Return or Escape that ends a composition adds no line and keeps the find bar', async ({
  page,
}) => {
  await createNote(page, 'List', '- item')
  // Return in a list item would start the next item.
  for (const how of HOW) await imeKey(body(page), ENTER, how)
  expect(await lines(page)).toEqual(['- item'])
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['- item', '- '])

  await page.keyboard.press('Meta+f')
  await expect(findField(page)).toBeFocused()
  await page.keyboard.type('item')
  await expect(findStatus(page)).toHaveText('1 of 1')
  await body(page).click()
  await expect(body(page)).toBeFocused()
  // Escape in the editor would close the bar.
  for (const how of HOW) await imeKey(body(page), ESCAPE, how)
  await expect(findBar(page)).toBeVisible()
  await expect(findField(page)).toHaveValue('item')
  await page.keyboard.press('Escape')
  await expect(findBar(page)).toHaveCount(0)
})

test('the Tab that ends a composition keeps the keyboard in the editor', async ({ page }) => {
  await createNote(page, 'Tabs', 'text')
  // The editor leaves the composition's last key alone, so Tab moves to the next area (areas.ts); sent with code 229 or Tab's own (9).
  await keyEndingComposition(body(page), TAB, 229)
  await expect(body(page)).toBeFocused()
  skipUnlessAtOnce(await keyEndingComposition(body(page), TAB, 9))
  await expect(body(page)).toBeFocused()
  expect(await lines(page)).toEqual(['text'])
  // The next Tab is the user's: the editor indents the line with it.
  await page.keyboard.press('Tab')
  await expect.poll(() => lines(page)).toEqual([expect.stringMatching(/^\s+text$/)])
  await expect(body(page)).toBeFocused()
})

test('in Settings, the Escape right after a composition keeps the shortcut recorder recording', async ({
  page,
}) => {
  await openSettings(page, 'Keyboard')
  const recorder = page
    .getByRole('region', { name: 'Keyboard Shortcuts' })
    .getByRole('button', { name: /^Bold shortcut/ })
  await recorder.click()
  await expect(recorder).toHaveAttribute('aria-pressed', 'true')
  // Escape's own key code (27), not 229: only the Settings window's watch makes it the input method's.
  skipUnlessAtOnce(await keyEndingComposition(recorder, ESCAPE, 27))
  await expect(recorder).toHaveAttribute('aria-pressed', 'true')
  // Only that one key: the next Escape is the user's.
  await page.keyboard.press('Escape')
  await expect(recorder).toHaveAttribute('aria-pressed', 'false')
})
