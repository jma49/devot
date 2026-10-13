import { MAX_TITLE_CHARS } from '../../src/core/noteLimits'
import { expect, test } from './fixtures'

const savedNotes = () => localStorage.getItem('devot.test.notes') ?? ''

test('a note survives a reload', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Tracer bullet')
  const body = page.getByRole('textbox', { name: 'Note body' })
  await body.click()
  await page.keyboard.type('Hello from the editor')
  await expect(body).toContainText('Hello from the editor')

  // Autosave writes the title and the Markdown snapshot after a short pause.
  await expect.poll(() => page.evaluate(savedNotes)).toContain('Hello from the editor')
  await expect.poll(() => page.evaluate(savedNotes)).toContain('Tracer bullet')

  await page.reload()
  await page.getByRole('option', { name: /Tracer bullet/ }).click()
  await expect(page.getByRole('textbox', { name: 'Note body' })).toContainText(
    'Hello from the editor',
  )
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Tracer bullet')
})

test('only a note just created takes the keyboard, not one reopened from the list', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  const rows = page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
  for (const title of ['First', 'Second']) {
    const before = await rows.count()
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    await expect(rows).toHaveCount(before + 1)
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
    await page.getByRole('textbox', { name: 'Title' }).fill(title)
  }
  await rows.filter({ has: page.locator('.row-title', { hasText: 'First' }) }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('First')
  await rows.filter({ has: page.locator('.row-title', { hasText: 'Second' }) }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Second')
  await expect(
    rows.filter({ has: page.locator('.row-title', { hasText: 'Second' }) }),
  ).toBeFocused()
})

test('a long title pasted in is cut to the limit, and the note keeps saving', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(1)
  const title = page.getByRole('textbox', { name: 'Title' })
  await expect(title).toHaveValue('')
  await title.click()
  await page.keyboard.insertText('x'.repeat(1500))
  await expect(title).toHaveValue('x'.repeat(MAX_TITLE_CHARS))
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText('typed after the paste')
  // Saved, with the title cut to the limit.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
            title: string
            bodyMd: string
          }[]
        ).map((n) => [n.title.length, n.bodyMd]),
      ),
    )
    .toEqual([[MAX_TITLE_CHARS, 'typed after the paste']])
})
