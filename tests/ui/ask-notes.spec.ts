import type { Page } from '@playwright/test'
import { expect, pickMenuItem, test } from './fixtures'

// Ask Your Notes from the command palette. Rust is faked in the page: `ai_stream` sends each queued reply in pieces of
// a word and answers it whole, and every request is in `devotIpcCalls`. Without a sentence model, sources come from
// keyword search.

const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const bookRow = (page: Page, name: string) =>
  tree(page)
    .getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
    .locator('> .book-row')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Ask Your Notes' })
const question = (page: Page) => sheet(page).getByRole('textbox', { name: 'Question' })

const requests = (page: Page) =>
  page.evaluate(() =>
    window.devotIpcCalls
      .filter((c) => c.cmd === 'ai_generate' || c.cmd === 'ai_stream')
      .map((c) => c.args['request'] as { messages: { content: string }[] }),
  )

async function fakeProvider(page: Page, replies: string[], hold = false) {
  await page.addInitScript(
    ({ queued, held }) => {
      const w = window as typeof window & { devotFinishAnswer?: () => void }
      w.devotIpcMocks = {
        ...w.devotIpcMocks,
        ai_stream: async (args: { onText: { onmessage: (text: string) => void } }) => {
          const text = queued.shift() ?? 'unexpected request'
          const words = text.split(/(?<= )/)
          for (const [i, word] of words.entries()) {
            args.onText.onmessage(word)
            if (held && i === 0) await new Promise<void>((done) => (w.devotFinishAnswer = done))
          }
          return { provider: 'anthropic', model: 'test-model', text, stop: 'end', usage: null }
        },
      }
    },
    { queued: replies, held: hold },
  )
}

async function notebook(page: Page, name: string, aiAccess: boolean) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill(name)
  await field.press('Enter')
  await expect(bookRow(page, name)).toBeVisible()
  if (aiAccess) {
    await bookRow(page, name).click({ button: 'right' })
    await pickMenuItem(page, 'Allow AI Access')
    await bookRow(page, name).hover()
    await expect(bookRow(page, name).getByRole('img', { name: 'AI access on' })).toBeVisible()
  }
  await bookRow(page, name).click()
}

async function note(page: Page, title: string, body: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(body)
  // Sources come from saved notes.
  await expect
    .poll(() =>
      page.evaluate(
        (text) => (localStorage.getItem('devot.test.notes') ?? '').includes(text),
        body,
      ),
    )
    .toBe(true)
}

async function openAsk(page: Page) {
  await page.keyboard.press('Meta+KeyK')
  await palette(page).getByRole('combobox', { name: 'Command Palette' }).fill('ask your notes')
  await palette(page)
    .getByRole('option', { name: /Ask Your Notes/ })
    .click()
  await expect(question(page)).toBeFocused()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
})

test('answers from notes AI may read, citing each one, and a citation opens its note', async ({
  page,
}) => {
  await fakeProvider(page, ['The boiler is serviced every October [1].'])
  await page.reload()
  await notebook(page, 'Private', false)
  await note(page, 'Boiler secrets', 'boiler service code 1234')
  await notebook(page, 'Home', true)
  await note(page, 'Boiler', 'The boiler service is booked each October.')
  await note(page, 'Garden', 'Plant tulips')

  await openAsk(page)
  await question(page).fill('When is the boiler service?')
  await question(page).press('Enter')

  await expect(sheet(page).getByRole('status')).toHaveText(
    'Answered by test-model from your notes.',
  )
  const answer = sheet(page).getByRole('region', { name: 'Answer' })
  await expect(answer).toContainText('The boiler is serviced every October')
  const [request] = await requests(page)
  expect(request!.messages[0]!.content).toContain('booked each October')
  expect(request!.messages[0]!.content).not.toContain('1234')
  expect(request!.messages[0]!.content).not.toContain('tulips')

  await answer.getByRole('button', { name: 'Source 1: Boiler' }).click()
  await expect(sheet(page)).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Boiler')
})

test('shows the answer as it comes, and keeps the one that comes whole', async ({ page }) => {
  await fakeProvider(page, ['Every October [1].'], true)
  await page.reload()
  await notebook(page, 'Home', true)
  await note(page, 'Boiler', 'The boiler service is booked each October.')

  await openAsk(page)
  await question(page).fill('When is the boiler service?')
  await question(page).press('Enter')
  const answer = sheet(page).getByRole('region', { name: 'Answer' })
  await expect(sheet(page).getByRole('status')).toHaveText('Writing the answer\u2026')
  await expect(answer).toHaveText('Every ')
  await page.evaluate(() => (window as { devotFinishAnswer?: () => void }).devotFinishAnswer?.())
  await expect(sheet(page).getByRole('status')).toHaveText(
    'Answered by test-model from your notes.',
  )
  await expect(answer).toHaveText('Every October 1.')
  await expect(answer.getByRole('button', { name: 'Source 1: Boiler' })).toBeVisible()
})

test('sends nothing when no notebook allows AI access, and says why', async ({ page }) => {
  await fakeProvider(page, [])
  await page.reload()
  await notebook(page, 'Private', false)
  await note(page, 'Plans', 'secret plans')

  await openAsk(page)
  await question(page).fill('What are the plans?')
  await sheet(page).getByRole('button', { name: 'Ask' }).click()
  await expect(sheet(page).getByRole('alert')).toContainText('No notebook allows AI access yet.')
  expect(await requests(page)).toEqual([])
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toBeHidden()
})
