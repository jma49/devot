import type { Page } from '@playwright/test'
import { expect, pickMenuItem, test, type TestWindow } from './fixtures'

// Next edit suggestions (ghost text). Rust is faked in the page: `ai_generate` answers what the test queues in
// `devotAiReplies` (a text, `{ error }`, or `{ hold }`, which waits until the test calls `devotRelease`), and
// `ai_settings_get` says whether a provider is set up and whether suggestions on a pause are on (`devotSuggestOnIdle`).

type Reply = string | { error: string } | { hold: true }
interface Window {
  devotRelease?: (text: string) => void
  devotSuggestOnIdle?: boolean
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const bookRow = (page: Page, name: string) =>
  tree(page)
    .getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
    .locator('> .book-row')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const ghost = (page: Page) => page.locator('.cm-ghost-text')
const SUGGEST_KEY = 'Alt+Backslash'

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
      .map((c) => c.args['request'] as { messages: { content: string }[]; maxTokens: number }),
  )

interface Options {
  key?: 'set' | 'unset'
  /** Suggestions on a pause, turned on once the note is written and the caret placed. */
  idle?: boolean
}

async function fakeProvider(page: Page, replies: Reply[], options: Options = {}) {
  await page.addInitScript(
    ([queued, { key = 'set' }]) => {
      const w = globalThis as unknown as TestWindow & Window
      const provider = (model: string) => ({
        endpoint: 'https://example.test',
        model,
        defaultEndpoint: 'https://example.test',
        defaultModel: model,
        key,
      })
      w.devotIpcMocks = {
        ...w.devotIpcMocks,
        ai_settings_get: () => ({
          active: 'anthropic',
          suggestOnIdle: w.devotSuggestOnIdle === true,
          anthropic: provider('claude-sonnet-5-5'),
          openai: provider(''),
        }),
        ai_generate: () => {
          const reply = queued.shift() ?? 'unexpected request'
          if (typeof reply !== 'string' && 'error' in reply) throw reply.error
          const answer = (text: string) => ({
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            text,
            stop: 'end',
            usage: null,
          })
          if (typeof reply !== 'string') {
            return new Promise((resolve) => {
              w.devotRelease = (text) => resolve(answer(text))
            })
          }
          return answer(reply)
        },
      }
    },
    [replies, options] as const,
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
    await expect(bookRow(page, name).getByRole('img', { name: 'AI access on' })).toBeVisible()
  }
  await bookRow(page, name).click()
}

async function note(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect.poll(() => savedBody(page)).toBe(text)
}

async function ready(page: Page, replies: Reply[], text: string, options: Options = {}) {
  await fakeProvider(page, replies, options)
  await page.reload()
  await notebook(page, 'Work', true)
  await note(page, text)
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  // Not before: writing the note is typing too, and on a slow machine its own pause can pass before the caret moves.
  if (options.idle) {
    await page.evaluate(() => {
      ;(globalThis as unknown as Window).devotSuggestOnIdle = true
    })
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
})

test('the key shows a suggestion as ghost text; Tab accepts it as one undo step', async ({
  page,
}) => {
  await ready(page, [' to ship the first version.'], 'We plan')
  await page.keyboard.press(SUGGEST_KEY)
  await expect(ghost(page)).toContainText('to ship the first version.')
  // Not in the note until it is accepted.
  expect(await savedBody(page)).toBe('We plan')
  const [request] = await requests(page)
  expect(request!.messages[0]!.content).toBe('<before>\nWe plan\n</before>\n<after>\n\n</after>')

  await page.keyboard.press('Tab')
  await expect(ghost(page)).toHaveCount(0)
  await expect.poll(() => savedBody(page)).toBe('We plan to ship the first version.')

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBody(page)).toBe('We plan')
})

test('Escape dismisses a suggestion and typing on drops it, with the note untouched', async ({
  page,
}) => {
  await ready(page, [' one.', ' two.'], 'We plan')
  await page.keyboard.press(SUGGEST_KEY)
  await expect(ghost(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(ghost(page)).toHaveCount(0)
  expect(await savedBody(page)).toBe('We plan')

  await page.keyboard.press(SUGGEST_KEY)
  await expect(ghost(page)).toBeVisible()
  await page.keyboard.type('!')
  await expect(ghost(page)).toHaveCount(0)
  await expect.poll(() => savedBody(page)).toBe('We plan!')
  expect(await requests(page)).toHaveLength(2)
})

test('sends nothing on its own while the pause setting is off', async ({ page }) => {
  await ready(page, [' unused.'], 'We plan')
  await page.keyboard.type(' to')
  await page.waitForTimeout(2_600)
  await expect(ghost(page)).toHaveCount(0)
  expect(await requests(page)).toEqual([])
})

test('asks after a pause when the user turned that on, and only then', async ({ page }) => {
  await ready(page, [' to ship.'], 'We plan', { idle: true })
  await page.keyboard.type(' to')
  await expect(ghost(page)).toContainText('to ship.', { timeout: 6_000 })
  expect(await requests(page)).toHaveLength(1)
  await page.keyboard.press('Tab')
  await expect.poll(() => savedBody(page)).toBe('We plan to to ship.')
})

test('Escape then Tab leaves the editor while a pause’s request is on its way, unseen', async ({
  page,
}) => {
  await ready(page, [{ hold: true }], 'We plan', { idle: true })
  await page.keyboard.type(' to')
  await expect.poll(async () => (await requests(page)).length, { timeout: 6_000 }).toBe(1)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await expect(body(page)).not.toBeFocused()
  await page.evaluate(() => (globalThis as unknown as Window).devotRelease?.(' late.'))
  await page.waitForTimeout(300)
  await expect(ghost(page)).toHaveCount(0)
  await expect.poll(() => savedBody(page)).toBe('We plan to')
})

test('sends only the text near the caret', async ({ page }) => {
  const head = 'HEAD-OF-THE-NOTE '
  const filler = `${'lorem ipsum dolor sit amet. '.repeat(120)}`
  await ready(page, [' more.'], `${head}${filler}and so`)
  await page.keyboard.press(SUGGEST_KEY)
  await expect(ghost(page)).toBeVisible()
  const [request] = await requests(page)
  const sent = request!.messages[0]!.content
  expect(sent).not.toContain('HEAD-OF-THE-NOTE')
  expect(sent).toContain('and so')
  expect(sent.length).toBeLessThan(2_700)
  expect(request!.maxTokens).toBeLessThanOrEqual(256)
})

test('typing while a request is on its way drops its answer', async ({ page }) => {
  await ready(page, [{ hold: true }], 'We plan')
  await page.keyboard.press(SUGGEST_KEY)
  await expect.poll(async () => (await requests(page)).length).toBe(1)
  await page.keyboard.type('!')
  await page.evaluate(() => (globalThis as unknown as Window).devotRelease?.(' late.'))
  await page.waitForTimeout(300)
  await expect(ghost(page)).toHaveCount(0)
  await expect.poll(() => savedBody(page)).toBe('We plan!')
})

test('switching notes drops the answer of a request for the first', async ({ page }) => {
  await ready(page, [{ hold: true }], 'First note')
  await page.keyboard.press(SUGGEST_KEY)
  await expect.poll(async () => (await requests(page)).length).toBe(1)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(2)
  await page.evaluate(() => (globalThis as unknown as Window).devotRelease?.(' late.'))
  await page.waitForTimeout(300)
  await expect(ghost(page)).toHaveCount(0)
})

test('sends nothing from a notebook without AI access, and says why', async ({ page }) => {
  await fakeProvider(page, [' unused.'])
  await page.reload()
  await notebook(page, 'Private', false)
  await note(page, 'secret plans')
  await page.keyboard.press(SUGGEST_KEY)
  await expect(page.getByRole('alert')).toContainText('(E_AI_ACCESS_DENIED)')
  await expect(ghost(page)).toHaveCount(0)
  expect(await requests(page)).toEqual([])
})

test('sends nothing without a provider set up, and says why', async ({ page }) => {
  await ready(page, [' unused.'], 'We plan', { key: 'unset' })
  await page.keyboard.press(SUGGEST_KEY)
  await expect(page.getByRole('alert')).toContainText('(E_AI_KEY_MISSING)')
  expect(await requests(page)).toEqual([])
})

test('says when the provider had nothing to add', async ({ page }) => {
  await ready(page, ['  \n'], 'We plan')
  await page.keyboard.press(SUGGEST_KEY)
  await expect(page.getByRole('alert')).toContainText('(E_AI_SUGGESTION_NONE)')
  await expect(ghost(page)).toHaveCount(0)
})

test('names a failure of the provider', async ({ page }) => {
  await ready(page, [{ error: 'E_AI_RATE_LIMITED' }], 'We plan')
  await page.keyboard.press(SUGGEST_KEY)
  await expect(page.getByRole('alert')).toContainText('(E_AI_RATE_LIMITED)')
})
