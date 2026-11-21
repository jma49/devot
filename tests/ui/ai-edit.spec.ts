import type { Page } from '@playwright/test'
import { expect, pickMenuItem, pickNoteMore, shownMenu, test } from './fixtures'

// Edit with AI from the selection toolbar and the editor menu. Rust is faked in the page: `ai_stream` sends the reply the
// test sets (a text, `{ error }`, or `{ held }`, which stops after its first word until `devotFinishAnswer(n)` for the
// n-th held reply) in pieces of a word, one reply per request; `devotAnswered` counts the replies sent in full, and every
// request is in `devotIpcCalls`.

type Reply = string | { error: string } | { held: string }

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
    window.devotIpcCalls
      .filter((c) => c.cmd === 'ai_stream')
      .map((c) => c.args['request'] as { messages: { content: string }[] }),
  )

type FakeWindow = typeof window & {
  devotFinishAnswer?: (n?: number) => void
  devotAnswered?: number
}

async function fakeProvider(page: Page, replies: Reply[]) {
  await page.addInitScript((queued) => {
    const w = window as FakeWindow
    const held: (() => void)[] = []
    w.devotAnswered = 0
    w.devotFinishAnswer = (n = 0) => held[n]?.()
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      ai_stream: async (args: { onText: { onmessage: (text: string) => void } }) => {
        const reply = queued.shift() ?? 'unexpected request'
        if (typeof reply !== 'string' && 'error' in reply) throw reply.error
        const text = typeof reply === 'string' ? reply : reply.held
        const mine = typeof reply === 'string' ? -1 : held.length
        for (const [i, word] of text.split(/(?<= )/).entries()) {
          args.onText.onmessage(word)
          if (mine >= 0 && i === 0) await new Promise<void>((done) => (held[mine] = done))
        }
        w.devotAnswered = (w.devotAnswered ?? 0) + 1
        return { provider: 'anthropic', model: 'claude-sonnet-5-5', text, stop: 'end', usage: null }
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
    await bookRow(page, name).hover()
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
    'Summarize',
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

test('a proposed change taller than its box scrolls from the keyboard', async ({ page }) => {
  const after = Array.from({ length: 40 }, (_, i) => `changed ${i}`).join('\n')
  await fakeProvider(page, [after])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'Teh first draft.')
  await selectLine(page, 0)
  await fromToolbar(page, 'Improve Writing')

  const diff = sheet(page).getByRole('region', { name: 'Proposed changes' })
  await expect(diff.locator('ins').first()).toBeVisible()
  // One change, so there is nothing to tick off: the diff is the only way to read it.
  await expect(sheet(page).getByRole('checkbox')).toHaveCount(0)
  await diff.focus()
  await expect(diff).toBeFocused()
  await page.keyboard.press('PageDown')
  await expect.poll(() => diff.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})

test('focuses the proposal, takes only the changes left checked and gives the keyboard back', async ({
  page,
}) => {
  await fakeProvider(page, ['One.\nkeep\nTwo.', 'One.\nkeep\nTwo.'])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'one\nkeep\ntwo')
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  // The editor lives in a shadow root, so the page's active element is its host.
  const inEditor = () =>
    page.evaluate(
      () =>
        document
          .querySelector('[data-devot-part="editor-body"]')
          ?.shadowRoot?.activeElement?.closest('.cm-editor') != null,
    )

  await fromToolbar(page, 'Improve Writing')
  await expect(sheet(page).getByRole('region', { name: 'Proposed changes' })).toBeFocused()
  await expect(sheet(page).getByRole('status')).toContainText('Proposed by')
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toBeHidden()
  await expect.poll(inEditor).toBe(true)

  await page.keyboard.press('ControlOrMeta+a')
  await fromToolbar(page, 'Improve Writing')
  const takes = sheet(page).getByRole('checkbox', { name: 'Apply change 1 of 2' })
  await expect(takes).toHaveCount(1)
  await expect(takes).toHaveAccessibleDescription(/one/)
  await expect(sheet(page).getByRole('checkbox', { name: 'Apply change 2 of 2' })).toBeVisible()
  await takes.uncheck()
  await sheet(page).getByRole('button', { name: 'Accept Selected' }).click()
  await expect(sheet(page)).toBeHidden()
  await expect.poll(() => savedBody(page)).toBe('one\nkeep\nTwo.')
  await expect.poll(inEditor).toBe(true)
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

test('shows the proposal as it streams in, and Discard stops the request', async ({ page }) => {
  await fakeProvider(page, [{ held: 'Hello brave new world' }, { held: 'Second try now' }])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'hello world')
  await selectLine(page, 0)

  await fromToolbar(page, 'Improve Writing')
  const writing = sheet(page).getByRole('region', { name: 'Writing the proposal…' })
  await expect(sheet(page).getByRole('status')).toHaveText('Writing the proposal…')
  await expect(writing).toHaveText('Hello ')
  await expect(writing).toHaveAttribute('aria-live', 'off')
  await sheet(page).getByRole('button', { name: 'Discard' }).click()
  await expect(sheet(page)).toBeHidden()
  const streams = () =>
    page.evaluate(() =>
      window.devotIpcCalls
        .filter((c) => c.cmd === 'ai_stream' || c.cmd === 'ai_stream_cancel')
        .map((c) => ({ cmd: c.cmd, id: c.args['streamId'] })),
    )
  await expect
    .poll(async () => (await streams()).map((call) => call.cmd))
    .toEqual(['ai_stream', 'ai_stream_cancel'])
  const [asked, cancel] = await streams()
  expect(cancel!.id).toBe(asked!.id)

  await selectLine(page, 0)
  await fromToolbar(page, 'Improve Writing')
  await expect(writing).toHaveText('Second ')
  await expect.poll(async () => (await streams()).length).toBe(3)
  expect((await streams())[2]!.id).not.toBe(asked!.id)

  // The rest of the discarded answer arrives while the second streams, and none of it shows.
  await page.evaluate(() => (window as FakeWindow).devotFinishAnswer!(0))
  await expect.poll(() => page.evaluate(() => (window as FakeWindow).devotAnswered)).toBe(1)
  await expect(writing).toHaveText('Second ')
  await page.evaluate(() => (window as FakeWindow).devotFinishAnswer!(1))
  await expect(writing).toBeHidden()
  await expect(sheet(page).locator('ins').first()).toBeVisible()
  await expect(sheet(page)).toContainText('Second')
  await expect(sheet(page)).not.toContainText('brave')
  await sheet(page).getByRole('button', { name: 'Discard' }).click()
  await expect.poll(() => savedBody(page)).toBe('hello world')
})

test('a custom instruction takes several lines: Shift+Return breaks the line, Return sends', async ({
  page,
}) => {
  await fakeProvider(page, ['HELLO'])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'hello')
  await selectLine(page, 0)
  await line(page, 0).getByText('hello').click({ button: 'right' })
  await pickMenuItem(page, 'Custom Instruction…', 'Edit with AI')

  const field = sheet(page).getByRole('textbox', { name: 'Instruction' })
  const height = (await field.boundingBox())!.height
  await field.pressSequentially('Shout it')
  await field.press('Shift+Enter')
  await field.pressSequentially('Keep it short')
  await field.press('Shift+Enter')
  await field.pressSequentially('No emoji')
  await expect(field).toHaveValue('Shout it\nKeep it short\nNo emoji')
  await expect.poll(async () => (await field.boundingBox())!.height).toBeGreaterThan(height)
  expect(await requests(page)).toEqual([])
  await field.press('Enter')
  await expect(sheet(page).locator('ins')).toHaveText(['HELLO'])
  const [request] = await requests(page)
  expect(request!.messages[0]!.content).toMatch(/^Shout it\nKeep it short\nNo emoji\n\n<selection>/)
})

test('sends nothing from a notebook without AI access, and allows it in one step', async ({
  page,
}) => {
  await fakeProvider(page, ['Plans, kept short.'])
  await page.reload()
  await notebook(page, 'Private', false)
  await note(page, 'secret plans')
  await selectLine(page, 0)

  await fromToolbar(page, 'Summarize')
  await expect(sheet(page).getByRole('alert')).toHaveText(
    'This note\u2019s notebook does not allow AI access yet. Allow it to edit the selection with AI; you can turn it off again from the notebook\u2019s menu.',
  )
  await expect(sheet(page).getByRole('button', { name: 'Try Again' })).toHaveCount(0)
  expect(await requests(page)).toEqual([])

  await sheet(page).getByRole('button', { name: 'Allow AI Access' }).click()
  await expect(sheet(page).getByRole('region', { name: 'Proposed changes' })).toContainText(
    'Plans, kept short.',
  )
  expect(await requests(page)).toHaveLength(1)
  await expect(bookRow(page, 'Private').getByRole('img', { name: 'AI access on' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'now allows AI access' })).toContainText(
    '1 notebook now allows AI access.',
  )
})

test('closes on Escape when AI access is off, and sends nothing', async ({ page }) => {
  await fakeProvider(page, [])
  await page.reload()
  await notebook(page, 'Private', false)
  await note(page, 'secret plans')
  await selectLine(page, 0)

  await fromToolbar(page, 'Summarize')
  await expect(sheet(page).getByRole('button', { name: 'Allow AI Access' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toBeHidden()
  expect(await requests(page)).toEqual([])
  await expect(bookRow(page, 'Private').getByRole('img', { name: 'AI access on' })).toHaveCount(0)
})

test('asks again after a failure that may pass', async ({ page }) => {
  await fakeProvider(page, [{ error: 'E_AI_TIMEOUT' }, '- one\n- two'])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'one, two')
  await selectLine(page, 0)

  await fromToolbar(page, 'Make Bullet List')
  await expect(sheet(page).getByRole('alert')).toContainText('could not be reached')
  await sheet(page).getByRole('button', { name: 'Try Again' }).click()
  await expect(sheet(page).locator('ins')).toHaveText(['- one', '- two'])
  expect(await requests(page)).toHaveLength(2)
})

test('says when the request stopped on its own, and asks again', async ({ page }) => {
  await fakeProvider(page, [{ error: 'E_AI_CANCELLED' }, '- one\n- two'])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'one, two')
  await selectLine(page, 0)

  await fromToolbar(page, 'Make Bullet List')
  await expect(sheet(page).getByRole('alert')).toHaveText(
    'The request stopped before it finished. Try again.',
  )
  await sheet(page).getByRole('button', { name: 'Try Again' }).click()
  await expect(sheet(page).locator('ins')).toHaveText(['- one', '- two'])
})

test('names the missing key', async ({ page }) => {
  await fakeProvider(page, [{ error: 'E_AI_KEY_MISSING' }])
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, 'text')
  await selectLine(page, 0)
  await fromToolbar(page, 'Reformat')
  await expect(sheet(page).getByRole('alert')).toHaveText(
    'No AI provider is set up. Add a key in Settings > AI.',
  )
})
