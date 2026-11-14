import type { Page } from '@playwright/test'
import { expect, pickMenuItem, test } from './fixtures'

// Ask Your Notes from the command palette. Rust is faked in the page: `ai_generate` answers what the test queues in
// `devotAiReplies`, and every request is in `devotIpcCalls`. Without a sentence model, sources come from keyword search.

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
      .filter((c) => c.cmd === 'ai_generate')
      .map((c) => c.args['request'] as { messages: { content: string }[] }),
  )

async function fakeProvider(page: Page, replies: string[]) {
  await page.addInitScript((queued) => {
    const w = window
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      ai_generate: () => ({
        provider: 'anthropic',
        model: 'test-model',
        text: queued.shift() ?? 'unexpected request',
        stop: 'end',
        usage: null,
      }),
    }
  }, replies)
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
