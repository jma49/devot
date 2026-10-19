// A restore on launch never moves a keyboard the user already moved: the
// note it opens takes the keyboard only while the page still has none and
// no search is typed.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })

async function leaveWithKeyboardInEditor(page: Page) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill('Restored')
  await body(page).click()
  await page.keyboard.insertText('original')
  await expect(body(page)).toBeFocused()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('devot.lastState.main') ?? ''))
    .toContain('"keyboard":true')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('devot.test.notes') ?? ''))
    .toContain('original')
}

/**
 * Before the app has restored anything, once the search field exists: moves
 * the keyboard to it, and with `text` types a query there.
 */
async function userStartsSearching(page: Page, text?: string) {
  await page.addInitScript((typed) => {
    interface Field {
      focus(): void
      dispatchEvent(e: unknown): void
    }
    const w = globalThis as unknown as {
      document: object & { querySelector(s: string): Field | null }
      HTMLInputElement: { prototype: object }
      Event: new (type: string, init: object) => unknown
      MutationObserver: new (cb: () => void) => {
        observe(node: object, options: object): void
        disconnect(): void
      }
    }
    const watch = new w.MutationObserver(() => {
      const field = w.document.querySelector('input[type="search"]')
      if (!field) return
      watch.disconnect()
      field.focus()
      if (typed) {
        const set = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')?.set
        set?.call(field, typed)
        field.dispatchEvent(new w.Event('input', { bubbles: true }))
      }
    })
    watch.observe(w.document, { childList: true, subtree: true })
  }, text)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a restore leaves the search field the user already focused', async ({ page }) => {
  await leaveWithKeyboardInEditor(page)
  await userStartsSearching(page)
  await page.reload()
  await expect(titleField(page)).toHaveValue('Restored')
  await expect(body(page)).toBeVisible()
  await expect(search(page)).toBeFocused()
  await page.keyboard.insertText('abc')
  await expect(search(page)).toHaveValue('abc')
  await expect(page.locator('.cm-line')).toHaveText(['original'])
})

test('a restore leaves a query typed during launch alone', async ({ page }) => {
  await leaveWithKeyboardInEditor(page)
  await userStartsSearching(page, 'orig')
  await page.reload()
  await expect(titleField(page)).toHaveValue('Restored')
  await expect(body(page)).toBeVisible()
  await expect(search(page)).toBeFocused()
  await page.keyboard.insertText('i')
  await expect(search(page)).toHaveValue('origi')
  await expect(page.locator('.cm-line')).toHaveText(['original'])
  await expect(noteRows(page)).toHaveCount(1)
})

test('a restore still gives the keyboard back when nobody moved it', async ({ page }) => {
  await leaveWithKeyboardInEditor(page)
  await page.reload()
  await expect(titleField(page)).toHaveValue('Restored')
  await expect(body(page)).toBeFocused()
})
