import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { slowCore } from './slowCore'

// Switching notes keeps the note being left on screen until the next one's
// body has loaded, then shows it at once: the editor and the preview are
// never blank in between, however slow the load.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const row = (page: Page, title: string) =>
  noteRows(page).filter({ hasText: new RegExp(`^${title}`) })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
// The lines on screen, also while the note being left is no longer offered to type into.
const shownBody = (page: Page) => page.locator('[data-devot-part="editor-body"] .cm-content')

async function newNote(page: Page, title: string, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect(body(page)).toHaveText(text)
}

/** Samples the editor's and the preview's text every frame until `stop` is called. */
const watchFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { devotFrames: { editor: string; preview: string }[] }
    w.devotFrames = []
    const sample = () => {
      const editor =
        document
          .querySelector('[data-devot-part="editor-body"]')
          ?.shadowRoot?.querySelector('.cm-content')?.textContent ?? ''
      const preview = document.querySelector('article[aria-label="Preview"]')?.textContent ?? ''
      w.devotFrames.push({ editor, preview })
      if (w.devotFrames.length < 10_000) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

const framesSeen = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { devotFrames: { editor: string; preview: string }[] }).devotFrames,
  )

test.beforeEach(async ({ page }) => {
  await slowCore(page, ['open'])
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await newNote(page, 'First', 'First body.')
  await newNote(page, 'Second', 'Second body.')
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  await expect(page.getByRole('article', { name: 'Preview' })).toContainText('Second body.')
})

test('a slow open keeps the note being left until the next one shows, never a blank body', async ({
  page,
}) => {
  await watchFrames(page)
  const first = row(page, 'First')
  await first.click()
  // The list moves at once; the body waits for its note.
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await expect(shownBody(page)).toHaveText('Second body.')
  await expect(page.locator('.panes[data-loading]')).toHaveCount(1)
  await expect(shownBody(page)).toHaveText('First body.')
  await expect(page.locator('.panes[data-loading]')).toHaveCount(0)
  await expect(page.getByRole('article', { name: 'Preview' })).toContainText('First body.')

  const frames = await framesSeen(page)
  expect(frames.length).toBeGreaterThan(0)
  expect(frames.filter((f) => f.editor === '')).toEqual([])
  expect(frames.filter((f) => f.preview === '')).toEqual([])
})

test('quick switches show only the last note chosen, with its own text and undo', async ({
  page,
}) => {
  await row(page, 'First').click()
  await row(page, 'Second').click()
  await row(page, 'First').click()
  await expect(body(page)).toHaveText('First body.')
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('First')
  await page.waitForTimeout(1200)
  await expect(body(page)).toHaveText('First body.')

  await body(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' More.')
  await expect(body(page)).toHaveText('First body. More.')
  await row(page, 'Second').click()
  await expect(body(page)).toHaveText('Second body.')
  await row(page, 'First').click()
  await expect(body(page)).toHaveText('First body. More.')
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body(page)).toHaveText('First body.')
})

const storedBodies = (page: Page) =>
  page.evaluate(() =>
    (
      JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
        title: string
        bodyMd: string
      }[]
    )
      .map(({ title, bodyMd }) => `${title}: ${bodyMd}`)
      .sort(),
  )

test('keys typed while the next note loads go to that note, not the one being left', async ({
  page,
}) => {
  await body(page).click()
  // Back to First, from the editor; its body is 500 ms late.
  await page.keyboard.press('Meta+[')
  // The window shows First's title while its body still loads.
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('First')
  await expect(shownBody(page)).toHaveText('Second body.')
  await page.keyboard.type('Z')
  await expect(body(page)).toContainText('First body.')
  await expect(body(page)).toContainText('Z')
  await expect
    .poll(() => storedBodies(page))
    .toEqual(['First: ZFirst body.', 'Second: Second body.'])
})
