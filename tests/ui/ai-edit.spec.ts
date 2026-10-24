import type { Page } from '@playwright/test'
import { expect, pickMenuItem, pickNoteMore, shownMenu, test, type TestWindow } from './fixtures'

// Edit with AI from the selection toolbar and the editor menu. Rust is faked in the page: `ai_generate` answers what the
// test sets in `devotAiReplies` (a text, or `{ error }`), one per request, and every request is in `devotIpcCalls`.

type Reply = string | { error: string }

const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const bookRow = (page: Page, name: string) =>
  tree(page)
    .getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
    .locator('> .book-row')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const line = (page: Page, n: number) => page.locator('.cm-line').nth(n)
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Format' })
const sheet = (page: Page) => page.getByRole('dialog', { name: /^Edit with AI/ })

const savedBody = (page: Page) =>
  page.evaluate(() => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
      bodyMd: string
    }[]
    return notes[0]?.bodyMd
  })

const requests = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((c) => c.cmd === 'ai_generate')
      .map((c) => c.args['request'] as { messages: { content: string }[] }),
  )

async function fakeProvider(page: Page, replies: Reply[]) {
  await page.addInitScript((queued) => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      ai_generate: () => {
        const reply = queued.shift() ?? 'unexpected request'
        if (typeof reply !== 'string') throw reply.error
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          text: reply,
          stop: 'end',
          usage: null,
        }
      },
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
    await expect(bookRow(page, name).getByRole('img', { name: 'AI access on' })).toBeVisible()
  }
  await bookRow(page, name).click()
}

async function note(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect.poll(() => savedBody(page)).toBe(text)
}

async function selectLine(page: Page, n: number) {
  await line(page, n).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
}

async function fromToolbar(page: Page, preset: string) {
  await toolbar(page).getByRole('button', { name: 'Edit with AI' }).click()
  await pickMenuItem(page, preset)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
})

test('a preset from the selection toolbar proposes a diff, applied as one undo step', async ({
  page,
}) => {
  await fakeProvider(page, ['The first draft.'])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, '# Plan\n\nTeh first draft.\n\nEnd')
  await selectLine(page, 2)

  await fromToolbar(page, 'Proofread')
  expect(await shownMenu(page)).toEqual([
    'Improve Writing',
    'Proofread',
    'Reformat',
    '---',
    'Summarise',
    '---',
    'Make Bullet List',
    'Make Task List',
    'Make Table',
    'Add Headings',
    'Create Mermaid Diagram',
    '---',
    'Custom Instruction…',
  ])
  await expect(sheet(page)).toHaveAccessibleName('Edit with AI: Proofread')
  const diff = sheet(page).getByRole('region', { name: 'Proposed changes' })
  await expect(diff.locator('del')).toHaveText(['Teh first draft.'])
  await expect(diff.locator('ins')).toHaveText(['The first draft.'])
  // Only the selection went out.
  const [request] = await requests(page)
  expect(request!.messages).toHaveLength(1)
  expect(request!.messages[0]!.content).toContain('<selection>\nTeh first draft.\n</selection>')
  expect(request!.messages[0]!.content).not.toContain('Plan')

  await sheet(page).getByRole('button', { name: 'Accept' }).click()
  await expect(sheet(page)).toBeHidden()
  await expect(line(page, 2)).toHaveText('The first draft.')
  await expect.poll(() => savedBody(page)).toBe('# Plan\n\nThe first draft.\n\nEnd')

  await body(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBody(page)).toBe('# Plan\n\nTeh first draft.\n\nEnd')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
  await expect.poll(() => savedBody(page)).toBe('# Plan\n\nThe first draft.\n\nEnd')

  await pickNoteMore(page, 'Revision History…')
  const history = page.getByRole('dialog', { name: 'Revision History' })
  await expect(history.getByRole('option').first()).toContainText('Edited with AI')
})

test('takes only the changes left checked', async ({ page }) => {
  await fakeProvider(page, ['One.\nkeep\nTwo.'])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'one\nkeep\ntwo')
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+a')

  await fromToolbar(page, 'Improve Writing')
  const takes = sheet(page).getByRole('checkbox', { name: 'Apply this change' })
  await expect(takes).toHaveCount(2)
  await takes.first().uncheck()
  await sheet(page).getByRole('button', { name: 'Accept Selected' }).click()
  await expect(sheet(page)).toBeHidden()
  await expect.poll(() => savedBody(page)).toBe('one\nkeep\nTwo.')
})

test('the editor menu asks with a custom instruction, and Discard leaves the note', async ({
  page,
}) => {
  await fakeProvider(page, ['HELLO THERE'])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'hello there')
  await selectLine(page, 0)
  await line(page, 0).getByText('hello').click({ button: 'right' })
  await pickMenuItem(page, 'Custom Instruction…', 'Edit with AI')

  await expect(sheet(page)).toHaveAccessibleName('Edit with AI')
  expect(await requests(page)).toEqual([])
  await sheet(page).getByRole('textbox', { name: 'Instruction' }).fill('Shout it')
  await sheet(page).getByRole('textbox', { name: 'Instruction' }).press('Enter')
  await expect(sheet(page).locator('ins')).toHaveText(['HELLO THERE'])
  const [request] = await requests(page)
  expect(request!.messages[0]!.content).toMatch(/^Shout it\n\n<selection>\nhello there\n/)

  await sheet(page).getByRole('button', { name: 'Discard' }).click()
  await expect(sheet(page)).toBeHidden()
  await expect.poll(() => savedBody(page)).toBe('hello there')
})

test('sends nothing from a notebook without AI access, and says why', async ({ page }) => {
  await fakeProvider(page, [])
  await page.reload()
  await notebook(page, 'Private', false)
  await note(page, 'secret plans')
  await selectLine(page, 0)

  await fromToolbar(page, 'Summarise')
  await expect(sheet(page).getByRole('alert')).toHaveText(
    'AI can only use notes in a notebook with Allow AI Access on. Turn it on in the notebook’s menu. (E_AI_ACCESS_DENIED)',
  )
  await expect(sheet(page).getByRole('button', { name: 'Try Again' })).toHaveCount(0)
  expect(await requests(page)).toEqual([])
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toBeHidden()
})

test('asks again after a failure that may pass', async ({ page }) => {
  await fakeProvider(page, [{ error: 'E_AI_TIMEOUT' }, '- one\n- two'])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'one, two')
  await selectLine(page, 0)

  await fromToolbar(page, 'Make Bullet List')
  await expect(sheet(page).getByRole('alert')).toContainText('(E_AI_TIMEOUT)')
  await sheet(page).getByRole('button', { name: 'Try Again' }).click()
  await expect(sheet(page).locator('ins')).toHaveText(['- one', '- two'])
  expect(await requests(page)).toHaveLength(2)
})

test('names the missing key', async ({ page }) => {
  await fakeProvider(page, [{ error: 'E_AI_KEY_MISSING' }])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'text')
  await selectLine(page, 0)
  await fromToolbar(page, 'Reformat')
  await expect(sheet(page).getByRole('alert')).toHaveText(
    'No AI provider is set up. Add a key in Settings > AI. (E_AI_KEY_MISSING)',
  )
})
