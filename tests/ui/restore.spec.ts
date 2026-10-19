import type { Locator, Page } from '@playwright/test'
import { expect, reloadApp, test, pickNoteMore, pickStatus } from './fixtures'

const STATE_KEY = 'devot.lastState.main'

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const noteRows = (page: Page) => list(page).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const caption = (page: Page) =>
  page.getByRole('toolbar', { name: 'Toolbar' }).locator('.list-count')
const source = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) })
const book = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Notebooks' })
    .getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const modeButton = (page: Page, name: string) =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name, exact: true })
const backButton = (page: Page) => page.getByRole('button', { name: 'Back', exact: true })
const scroller = (page: Page) => page.locator('[data-devot-part="editor-scroll"]')
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
/**
 * The scroll position once it stopped moving. CodeMirror corrects a position
 * set from outside a frame or two later (700 became 728 once its measured
 * line heights settled), so a read right after the set is not the position
 * that is stored: read again after two frames until it holds.
 */
const settledTop = (target: Locator) =>
  target.evaluate(async (e) => {
    const w = globalThis as unknown as { requestAnimationFrame(cb: () => void): void }
    const frames = () =>
      new Promise<void>((resolve) =>
        w.requestAnimationFrame(() => w.requestAnimationFrame(resolve)),
      )
    let top = e.scrollTop
    for (let i = 0; i < 50; i += 1) {
      await frames()
      if (e.scrollTop === top) return top
      top = e.scrollTop
    }
    return top
  })
const line = (page: Page, text: string) =>
  page.locator('.cm-line').filter({ hasText: new RegExp(`^${text}$`) })

async function dblclickWord(page: Page, text: string, from: number, to: number) {
  const word = await line(page, text).evaluate(
    (e, [start, end]) => {
      interface Rect {
        left: number
        top: number
        width: number
        height: number
      }
      const { Range } = globalThis as unknown as {
        Range: new () => {
          setStart(node: unknown, offset: number): void
          setEnd(node: unknown, offset: number): void
          getBoundingClientRect(): Rect
        }
      }
      const range = new Range()
      range.setStart(e.firstChild, start)
      range.setEnd(e.firstChild, end)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    },
    [from, to] as const,
  )
  await page.mouse.dblclick(word.x, word.y)
}

const longBody = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toHaveValue('New Notebook')
  await field.fill(name)
  await field.press('Enter')
  await expect(book(page, name)).toBeVisible()
}

async function createNote(page: Page, title: string, button = 'New Note') {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: button, exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRow(page, title)).toHaveCount(1)
  // Stored before the page goes away (titles save shortly after typing).
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('devot.test.notes') ?? ''))
    .toContain(`"title":"${title}"`)
}

async function writeBody(page: Page, text: string) {
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect(page.locator('.cm-line').last()).toHaveText(text.split('\n').at(-1) ?? '')
}

async function storedState(page: Page, ready: (state: Record<string, unknown>) => boolean) {
  let state: Record<string, unknown> = {}
  await expect
    .poll(async () => {
      const raw = await page.evaluate((key) => localStorage.getItem(key), STATE_KEY)
      state = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      return ready(state)
    })
    .toBe(true)
  return state
}

const openNoteState = (state: Record<string, unknown>) =>
  (state['note'] ?? {}) as Record<string, unknown>

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await reloadApp(page)
})

test('a reload restores the view, its filter, the open note, its selection and scroll, and the mode', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await createBook(page, 'Work')
  await createNote(page, 'Other')
  await createNote(page, 'Long')
  await pickStatus(page, 'Active')
  await writeBody(page, longBody(120))
  await source(page, 'Active').click()
  await expect(noteRows(page)).toHaveText([/^Long/])
  await modeButton(page, 'Split').click()
  await expect(preview(page)).toBeVisible()

  await scroller(page).evaluate((e) => {
    e.scrollTop = 900
  })
  await line(page, 'line 60').scrollIntoViewIfNeeded()
  const top = await settledTop(scroller(page))
  expect(top).toBeGreaterThan(300)
  await dblclickWord(page, 'line 60', 5, 7)
  await expect(body(page)).toBeFocused()
  // Saved shortly after the selection changes, before the page goes away.
  // "60" on line 60: after lines 1 to 9 (7 characters each with the line
  // break) and 10 to 59 (8 each), and "line ".
  const sixty = { anchor: 9 * 7 + 50 * 8 + 5, head: 9 * 7 + 50 * 8 + 7 }
  const saved = await storedState(
    page,
    (s) => JSON.stringify(openNoteState(s)['selection']) === JSON.stringify(sixty),
  )
  expect(saved['mode']).toBe('split')
  expect(openNoteState(saved)['keyboard']).toBe(true)

  await reloadApp(page)
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'true')
  await expect(source(page, 'Active')).toHaveAttribute('aria-pressed', 'true')
  await expect(header(page)).toHaveText('Active')
  await expect(caption(page)).toHaveText('Work · 1 note')
  await expect(titleField(page)).toHaveValue('Long')
  await expect(noteRow(page, 'Long')).toHaveAttribute('aria-selected', 'true')
  await expect(modeButton(page, 'Split')).toHaveAttribute('aria-pressed', 'true')
  await expect(preview(page)).toBeVisible()
  await expect(body(page)).toBeFocused()
  await expect.poll(() => scroller(page).evaluate((e) => e.scrollTop)).toBeCloseTo(top, -1)
  await page.keyboard.insertText('sixty')
  await expect(line(page, 'line sixty')).toHaveCount(1)
  await expect(line(page, 'line 60')).toHaveCount(0)
  await expect(backButton(page)).toBeDisabled()
})

test('preview mode comes back scrolled where it was, without taking the keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await createNote(page, 'Read me')
  await writeBody(page, longBody(150).replace(/\n/g, '\n\n'))
  await scroller(page).evaluate((e) => {
    e.scrollTop = 700
  })
  const editorTop = await settledTop(scroller(page))
  await storedState(page, (s) => openNoteState(s)['editorTop'] !== undefined)
  await modeButton(page, 'Preview').click()
  await expect(preview(page).getByText('line 150', { exact: true })).toBeAttached()
  await preview(page).evaluate((e) => {
    e.scrollTop = 1200
  })
  const top = await settledTop(preview(page))
  expect(top).toBeGreaterThan(600)
  const saved = await storedState(page, (s) => openNoteState(s)['previewTop'] === top)
  expect(saved['mode']).toBe('preview')
  expect(openNoteState(saved)['keyboard']).toBe(false)

  await reloadApp(page)
  await expect(titleField(page)).toHaveValue('Read me')
  await expect(modeButton(page, 'Preview')).toHaveAttribute('aria-pressed', 'true')
  await expect(preview(page).getByText('line 150', { exact: true })).toBeAttached()
  await expect.poll(() => preview(page).evaluate((e) => e.scrollTop)).toBe(top)
  await expect(scroller(page)).toBeHidden()
  expect(
    await page.evaluate(() => {
      const { document } = globalThis as unknown as {
        document: { activeElement: { closest(selector: string): unknown } | null }
      }
      return document.activeElement?.closest('[data-devot-part="editor-body"]') ? 'editor' : 'other'
    }),
  ).toBe('other')

  await modeButton(page, 'Edit').click()
  await expect.poll(() => scroller(page).evaluate((e) => e.scrollTop)).toBeCloseTo(editorTop, -1)
})

test('a restored preview position past content that loads later is still reached', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await createNote(page, 'Diagram')
  // A tall diagram at the end: it draws after the text, in its own frame.
  const chain = Array.from({ length: 14 }, (_, i) => `  N${i} --> N${i + 1}`).join('\n')
  await writeBody(
    page,
    `${longBody(20).replace(/\n/g, '\n\n')}\n\n\`\`\`mermaid\ngraph TD\n${chain}\n\`\`\``,
  )
  await modeButton(page, 'Preview').click()
  await expect(preview(page).locator('.island-mermaid svg')).toBeVisible()
  await preview(page).evaluate((e) => {
    e.scrollTop = e.scrollHeight
  })
  const top = await settledTop(preview(page))
  await storedState(page, (s) => openNoteState(s)['previewTop'] === top)

  await reloadApp(page)
  await expect(preview(page).locator('.island-mermaid svg')).toBeVisible()
  await expect.poll(() => preview(page).evaluate((e) => e.scrollTop)).toBe(top)
})

test('a note deleted meanwhile is skipped quietly, and the view stays', async ({ page }) => {
  await createBook(page, 'Work')
  await createNote(page, 'Kept')
  await createNote(page, 'Gone')
  const saved = await storedState(page, (s) => typeof openNoteState(s)['id'] === 'string')
  const goneId = openNoteState(saved)['id'] as string

  await page.evaluate((id) => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
      id: string
      deletedAt: number | null
      deletedHlc: string | null
    }[]
    for (const note of notes) {
      if (note.id !== id) continue
      note.deletedAt = Date.now()
      note.deletedHlc = '9999999999999-ffff-zzzz'
    }
    localStorage.setItem('devot.test.notes', JSON.stringify(notes))
  }, goneId)
  const warnings: string[] = []
  page.on('console', (m) => warnings.push(m.text()))
  await reloadApp(page)

  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'true')
  await expect(noteRows(page)).toHaveText([/^Kept/])
  await expect(titleField(page)).toHaveCount(0)
  await expect(backButton(page)).toBeDisabled()
  // Nothing was opened, so nothing failed to open.
  expect(warnings.filter((w) => /W_NOTE_OPEN_FAILED|W_LAST_STATE_RESTORE_FAILED/.test(w))).toEqual(
    [],
  )
  await reloadApp(page)
  await expect(noteRows(page)).toHaveText([/^Kept/])
  await expect(titleField(page)).toHaveCount(0)
})

test('a note shorter than its stored scroll position still reports and saves typing', async ({
  page,
}) => {
  await createNote(page, 'Short')
  await writeBody(page, 'abc')
  const saved = await storedState(
    page,
    (s) => (openNoteState(s)['selection'] as { head?: number } | undefined)?.head === 3,
  )
  const stale = { ...saved, note: { ...openNoteState(saved), editorTop: { pos: 500, offset: 0 } } }
  await page.addInitScript(
    ([key, value]) => {
      if (sessionStorage.getItem('devot.test.planted')) return
      sessionStorage.setItem('devot.test.planted', '1')
      localStorage.setItem(key, value)
    },
    [STATE_KEY, JSON.stringify(stale)] as const,
  )
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  await reloadApp(page)
  await expect(titleField(page)).toHaveValue('Short')
  await expect(line(page, 'abc')).toHaveCount(1)

  await line(page, 'abc').click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('def')
  await expect(line(page, 'abcdef')).toHaveCount(1)
  const after = await storedState(
    page,
    (s) => (openNoteState(s)['selection'] as { head?: number } | undefined)?.head === 6,
  )
  expect(
    (openNoteState(after)['editorTop'] as { pos: number } | undefined)?.pos ?? 0,
  ).toBeLessThanOrEqual(6)
  expect(errors.filter((e) => /out of range/i.test(e))).toEqual([])
})

test('a notebook deleted meanwhile shows All Notes, with the note open', async ({ page }) => {
  await createBook(page, 'Gone')
  await createNote(page, 'Still here')
  const saved = await storedState(
    page,
    (s) =>
      (s['view'] as { kind?: string } | undefined)?.kind === 'book' && !!openNoteState(s)['id'],
  )
  const bookId = (saved['view'] as { id: string }).id
  await page.evaluate((id) => {
    const books = JSON.parse(localStorage.getItem('devot.test.books') ?? '[]') as {
      id: string
      deletedAt: number | null
      deletedHlc: string | null
    }[]
    for (const b of books) {
      if (b.id !== id) continue
      b.deletedAt = Date.now()
      b.deletedHlc = '9999999999999-ffff-zzzz'
    }
    localStorage.setItem('devot.test.books', JSON.stringify(books))
  }, bookId)
  await reloadApp(page)

  await expect(source(page, 'All Notes')).toHaveAttribute('aria-current', 'true')
  await expect(header(page)).toHaveText('All Notes')
  await expect(titleField(page)).toHaveValue('Still here')
})

test('the restored note is where Back returns to', async ({ page }) => {
  await createNote(page, 'First')
  await createNote(page, 'Restored')
  await storedState(page, (s) => typeof openNoteState(s)['id'] === 'string')
  await reloadApp(page)
  await expect(titleField(page)).toHaveValue('Restored')
  await expect(backButton(page)).toBeDisabled()

  await noteRow(page, 'First').click()
  await expect(titleField(page)).toHaveValue('First')
  await backButton(page).click()
  await expect(titleField(page)).toHaveValue('Restored')
  await expect(backButton(page)).toBeDisabled()
})

test('the Trash is not restored: the library view before it comes back', async ({ page }) => {
  await createNote(page, 'Trashed')
  await pickNoteMore(page, 'Move to Trash')
  await expect(noteRows(page)).toHaveCount(0)
  await createNote(page, 'Open one')
  await writeBody(page, 'first second')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('devot.test.notes') ?? ''))
    .toContain('first second')
  await dblclickWord(page, 'first second', 0, 5)
  await source(page, 'Trash').click()
  await expect(header(page)).toHaveText('Trash')
  await noteRows(page).first().click()
  await reloadApp(page)

  await expect(header(page)).toHaveText('All Notes')
  await expect(titleField(page)).toHaveValue('Open one')
  await body(page).focus()
  await page.keyboard.insertText('1st')
  await expect(line(page, '1st second')).toHaveCount(1)
})

test('Templates come back with the template that was open', async ({ page }) => {
  await createNote(page, 'A note')
  await source(page, 'Templates').click()
  await expect(header(page)).toHaveText('Templates')
  await createNote(page, 'Weekly', 'New Template')
  await storedState(page, (s) => (s['view'] as { kind?: string } | undefined)?.kind === 'templates')
  await reloadApp(page)

  await expect(header(page)).toHaveText('Templates')
  await expect(source(page, 'Templates')).toHaveAttribute('aria-current', 'true')
  await expect(titleField(page)).toHaveValue('Weekly')
})
