import type { Page } from '@playwright/test'
import { expect, pickStatus, statusPicker, test } from './fixtures'

// The main window shows a note's front matter in Note Info, not in the preview's body: what
// differs from the note's own title, status and tags gets an Apply that sets the note's field.

const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const card = (page: Page) => page.getByRole('dialog', { name: 'Note info' })
const row = (page: Page, key: string) =>
  card(page)
    .locator('.note-info-property')
    .filter({ has: page.locator('dt', { hasText: key }) })
const editorTags = (page: Page) => page.getByRole('group', { name: 'Tags' })

const WORK = '0192a6f0-0000-7000-8000-0000000000b1'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate((id) => {
    localStorage.clear()
    localStorage.setItem(
      'devot.test.tags',
      JSON.stringify([
        {
          id,
          name: 'work',
          nameHlc: '0000000000000001-0000-test',
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          deletedHlc: null,
          color: 'green',
          colorHlc: '0000000000000001-0000-test',
        },
      ]),
    )
  }, WORK)
  await page.reload()
})

test('front matter that differs from the note offers to apply it', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Launch plan')
  await pickStatus(page, 'Active')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(
    '---\ntitle: Launch plan\nstatus: on hold\ntags: work, q4\n---\n\nBody',
  )
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  await expect(preview(page)).toContainText('Body')
  await expect(preview(page).locator('.frontmatter')).toHaveCount(0)

  const summary = page.getByRole('button', { name: /^Note info: / })
  await expect(summary).toHaveText(/^3 properties · /)
  await summary.click()

  await expect(row(page, 'title').locator('.frontmatter-badge')).toHaveCount(0)
  await expect(row(page, 'status').locator('.frontmatter-badge')).toHaveText('Note: Active')
  await expect(row(page, 'tags').locator('.frontmatter-badge')).toHaveText('Note: No Tags')
  const chips = row(page, 'tags').locator('.frontmatter-chip')
  await expect(chips).toHaveText(['work', 'q4'])
  await expect(chips.nth(0)).toHaveClass('frontmatter-chip tag-chip tag-color-green')
  await expect(chips.nth(1)).toHaveClass('frontmatter-chip')

  await row(page, 'status').getByRole('button', { name: 'Apply status to note' }).click()
  await expect(statusPicker(page)).toHaveAttribute('data-value', 'on_hold')
  await expect(statusPicker(page)).toHaveAccessibleName('Status: On Hold')
  await expect(row(page, 'status').locator('.frontmatter-note')).toHaveCount(0)

  await row(page, 'tags').getByRole('button', { name: 'Apply tags to note' }).click()
  await expect(editorTags(page).locator('.chip')).toHaveText(['q4', 'work'])
  await expect(row(page, 'tags').locator('.frontmatter-note')).toHaveCount(0)
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem('devot.test.tags') ?? '[]') as { name: string }[],
  )
  expect(stored.map((tag) => tag.name).sort()).toEqual(['q4', 'work'])

  // The card's chip is painted as the note header's chip for the same tag.
  const paint = (el: Element) => {
    const style = getComputedStyle(el)
    return [style.backgroundColor, style.borderTopColor, style.color]
  }
  const header = editorTags(page).locator('.chip', { hasText: 'work' })
  await expect(header).toHaveClass(/tag-color-green/)
  expect(await chips.nth(0).evaluate(paint)).toEqual(await header.evaluate(paint))
})
