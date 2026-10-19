import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { failCoreCalls, slowCore } from './slowCore'

// Keys typed between New Note and its editor opening (#267, #268).

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const newNoteButton = (page: Page) => page.getByRole('button', { name: 'New Note', exact: true })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

const storedNotes = (page: Page) =>
  page.evaluate(() =>
    (
      JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
        title: string
        bodyMd: string
      }[]
    ).map(({ title, bodyMd }) => ({ title, bodyMd })),
  )

async function start(page: Page, late: string[]) {
  await slowCore(page, late)
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

async function makeNotes(page: Page, titles: string[]) {
  for (const title of titles) {
    const before = await noteRows(page).count()
    await newNoteButton(page).click()
    await expect(noteRows(page)).toHaveCount(before + 1)
    await titleField(page).fill(title)
    await expect(body(page)).toBeVisible()
  }
  await expect
    .poll(async () => (await storedNotes(page)).map((n) => n.title).sort())
    .toEqual([...titles].sort())
}

test('Return, Backspace and Tab typed before a new note opens edit its body in order', async ({
  page,
}) => {
  await start(page, ['open'])
  await newNoteButton(page).click()
  await page.keyboard.type('Hello')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Worlx')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('d')
  await expect(body(page)).toBeFocused()
  await expect.poll(() => storedNotes(page)).toEqual([{ title: '', bodyMd: 'Hello\nWorld' }])
})

test('a row clicked in the same tick as New Note leaves the keys typed to the new note', async ({
  page,
}) => {
  await start(page, ['open'])
  await makeNotes(page, ['Note 1', 'Note 2', 'Note 3', 'Note 4'])
  const button = await newNoteButton(page).elementHandle()
  await noteRows(page)
    .filter({ hasText: 'Note 3' })
    .evaluate((row, newNote) => {
      ;(row as HTMLElement).click()
      ;(newNote as HTMLElement).click()
    }, button)
  await page.keyboard.type('typed')
  await expect(noteRows(page)).toHaveCount(5)
  await expect
    .poll(async () => (await storedNotes(page)).filter((n) => n.bodyMd.includes('typed')))
    .toEqual([{ title: '', bodyMd: 'typed' }])
  expect((await storedNotes(page)).find((n) => n.title === 'Note 3')?.bodyMd).toBe('')
})

test('a New Note that fails gives the keyboard and the keys typed back to the field left', async ({
  page,
}) => {
  await start(page, ['open', 'create'])
  await makeNotes(page, ['Plan'])
  await titleField(page).click()
  await titleField(page).press('End')
  await failCoreCalls(page, ['create'])
  await page.keyboard.press('Meta+KeyN')
  await page.keyboard.type(' ahead')
  await expect(titleField(page)).toBeFocused()
  await expect(titleField(page)).toHaveValue('Plan ahead')
  await expect(noteRows(page)).toHaveCount(1)
  await expect.poll(() => storedNotes(page)).toEqual([{ title: 'Plan ahead', bodyMd: '' }])
})
