// Authorship in the window (ADR 0007): the marks beside agents' text, the review notice with
// Review Changes and Undo All, the list mark, the sidebar's Agents section and Clear Authorship.
// devot-mcp's writes are made as devot-mcp makes them, through the core's applyAgentEdit, and
// stored with their agent_writes rows as its own transaction does; the HTTP API's go in through
// the window's core, as Rust hands them over.
import type { Locator, Page } from '@playwright/test'
import * as Y from 'yjs'
import { agentWriteRows, applyAgentEdit, newWriter, type Writer } from '../../src/core/authorship'
import {
  changeEditorSettingsElsewhere,
  expect,
  openNoteMore,
  pickMenuItem,
  pickNoteMore,
  reloadApp,
  shownMenu,
  test,
  type TestWindow,
} from './fixtures'

const CLAUDE = newWriter('mcp', 'Claude Code', 'mcp0000000000001')
const CODEX = newWriter('mcp', 'Codex', 'mcp0000000000002')
const LONG = newWriter(
  'mcp',
  'An extremely long MCP client name that introduces itself verbosely v2.3.4-beta',
  'mcp0000000000003',
)
const BOOK = '0192a6f0-0000-7000-8000-0000000b0001'
const PLAN = '0192a6f0-0000-7000-8000-0000000a0001'
const OTHER = '0192a6f0-0000-7000-8000-0000000a0002'
const THIRD = '0192a6f0-0000-7000-8000-0000000a0003'
const OWNER = 'Owner intro.\n'
const CLAUDE_TEXT = 'Claude adds this paragraph.\n'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const marks = (page: Page) =>
  page.getByRole('group', { name: 'Authorship' }).getByRole('button', { name: /^Written by / })
const notice = (page: Page) => page.getByRole('region', { name: 'Agent changes' })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const agentRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) })

interface Seeded {
  id: string
  title: string
  owner: string
  edits: { writer: Writer; markdown: string }[]
  /** How many of the first writes this device has seen. */
  seen?: number
}

/** A note as devot-mcp leaves it: the owner's text, then each agent's write as its own transaction. */
function asMcp({ id, title, owner, edits, seen = 0 }: Seeded, at: number) {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, owner)
  edits.forEach((edit, i) => applyAgentEdit(doc, { ...edit, at: at + i * 1000 }))
  const note = {
    id,
    title,
    titleHlc: '0000000000000001-0000-mcptest',
    bodyMd: doc.getText('body').toString(),
    ydoc: Array.from(Y.encodeStateAsUpdate(doc)),
    bodyVersion: 1,
    bookId: BOOK,
    bookHlc: '0000000000000001-0000-mcptest',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: at,
    updatedAt: at + edits.length * 1000,
    deletedAt: null,
    deletedHlc: null,
  }
  const rows = agentWriteRows(doc, id)
    .sort((a, b) => a.at - b.at)
    .map((row, i) => ({ ...row, noteId: id, seen: i < seen }))
  return { note, rows }
}

async function seed(page: Page, notes: Seeded[]) {
  await page.goto('/')
  const at = Date.now() - 600_000
  const written = notes.map((n, i) => asMcp(n, at + i * 60_000))
  await page.evaluate(
    ({ book, stored }) => {
      localStorage.clear()
      localStorage.setItem('devot.test.books', JSON.stringify([book]))
      localStorage.setItem('devot.test.notes', JSON.stringify(stored.map((w) => w.note)))
      localStorage.setItem('devot.test.agentWrites', JSON.stringify(stored.flatMap((w) => w.rows)))
    },
    {
      book: {
        id: BOOK,
        name: 'Shared',
        nameHlc: '0000000000000001-0000-mcptest',
        parentId: null,
        parentHlc: '',
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        deletedHlc: null,
        aiAccess: true,
        aiAccessHlc: '0000000000000001-0000-mcptest',
        sortKey: 'a',
        sortKeyHlc: '',
        icon: null,
        iconColor: null,
        iconHlc: '',
      },
      stored: written,
    },
  )
  await reloadApp(page)
}

/** A local HTTP API call, handed to the window as Rust hands it; resolves to the answer. */
const httpApi = (page: Page, op: string, note: string | null, args: Record<string, unknown>) =>
  page.evaluate(
    (call) => {
      const w = globalThis as unknown as {
        addEventListener(type: string, on: (e: { detail: { id: number } }) => void): void
        removeEventListener(type: string, on: (e: { detail: { id: number } }) => void): void
        dispatchEvent(e: unknown): void
        CustomEvent: new (t: string, init: { detail: unknown }) => unknown
      }
      const id = Math.floor(Math.random() * 1e9)
      return new Promise<unknown>((resolve) => {
        const on = (e: { detail: { id: number } }) => {
          if (e.detail.id !== id) return
          w.removeEventListener('devot:http-api-done', on)
          resolve(e.detail)
        }
        w.addEventListener('devot:http-api-done', on)
        w.dispatchEvent(new w.CustomEvent('devot://http-api', { detail: { id, ...call } }))
      })
    },
    { op, note, args },
  )

const PLAN_NOTE: Seeded = {
  id: PLAN,
  title: 'Plan',
  owner: OWNER,
  edits: [
    { writer: CLAUDE, markdown: `${OWNER}${CLAUDE_TEXT}` },
    { writer: CLAUDE, markdown: `Owner introduction.\n${CLAUDE_TEXT}` },
  ],
}

test('marks the lines agents wrote, named by writer, and View > Show Authorship hides them', async ({
  page,
}) => {
  await seed(page, [PLAN_NOTE])
  await noteRow(page, 'Plan').click()
  await expect(body(page)).toContainText(CLAUDE_TEXT.trim())
  // One mark per run of lines with the same writes: the reworded first line, then the paragraph.
  await expect(marks(page)).toHaveCount(2)
  await expect(marks(page).first()).toHaveAttribute(
    'aria-label',
    /^Written by Claude Code \(MCP\), /,
  )
  // Hovering or focusing a mark shows its writer and time.
  await marks(page).first().focus()
  const tip = page.locator('.cm-authorship-tip')
  await expect(tip).toBeVisible()
  await expect(tip).toHaveText(/^Written by Claude Code \(MCP\), /)

  // The menu item toggles the setting in Rust, which tells the windows.
  await changeEditorSettingsElsewhere(page, { authorship: false })
  await expect(marks(page)).toHaveCount(0)
  await changeEditorSettingsElsewhere(page, { authorship: true })
  await expect(marks(page)).toHaveCount(2)

  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  await expect(marks(page)).toHaveCount(2)

  // An HTTP API write is marked as the HTTP API's as soon as the window takes it in.
  await httpApi(page, 'notes.update', PLAN, {
    markdown: `Owner introduction.\n${CLAUDE_TEXT}\nFrom the API.\n`,
  })
  await expect(body(page)).toContainText('From the API.')
  await expect(marks(page)).toHaveCount(3)
  await expect(marks(page).last()).toHaveAttribute('aria-label', /^Written by HTTP API, /)
})

test('the notice reviews each unseen change, and leaving the note marks them seen', async ({
  page,
}) => {
  await seed(page, [PLAN_NOTE, { id: OTHER, title: 'Other', owner: 'Other text.\n', edits: [] }])
  await expect(noteRow(page, 'Plan')).toContainText('changed by Claude Code (MCP)')
  await expect(noteRow(page, 'Other')).not.toContainText('changed by')
  await noteRow(page, 'Plan').click()
  await expect(notice(page)).toContainText('2 changes by Claude Code (MCP) since you last looked.')

  await notice(page).getByRole('button', { name: 'Review Changes' }).click()
  const status = notice(page).getByRole('status')
  await expect(status).toHaveText(/^Change 1 of 2: Claude Code \(MCP\), /)
  const next = notice(page).getByRole('button', { name: 'Next Change' })
  await expect(next).toBeFocused()
  // Document order: the replaced word in the first line, then the paragraph.
  const selected = page.locator('.cm-selectionBackground')
  await expect(selected.first()).toBeVisible()
  const firstLine = await page.locator('.cm-line').first().boundingBox()
  const firstSelected = await selected.first().boundingBox()
  expect(Math.abs(firstSelected!.y - firstLine!.y)).toBeLessThan(firstLine!.height)
  await page.keyboard.press('ArrowDown')
  await expect(status).toHaveText(/^Change 2 of 2: Claude Code \(MCP\), /)
  await expect(next).toBeDisabled()
  await page.keyboard.press('ArrowUp')
  await expect(status).toHaveText(/^Change 1 of 2/)
  await page.keyboard.press('End')
  await expect(status).toHaveText(/^Change 2 of 2/)
  await page.keyboard.press('Home')
  await expect(status).toHaveText(/^Change 1 of 2/)
  await notice(page).getByRole('button', { name: 'Done' }).click()
  await expect(notice(page).getByRole('button', { name: 'Review Changes' })).toBeVisible()

  await noteRow(page, 'Other').click()
  await expect(notice(page)).toHaveCount(0)
  await expect(noteRow(page, 'Plan')).not.toContainText('changed by')
  await noteRow(page, 'Plan').click()
  await expect(body(page)).toContainText(CLAUDE_TEXT.trim())
  await expect(notice(page)).toHaveCount(0)
  // The marks stay: seen is not cleared.
  await expect(marks(page)).toHaveCount(2)
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem('devot.test.agentWrites') ?? '[]') as { seen: boolean }[],
  )
  expect(stored.map((row) => row.seen)).toEqual([true, true])
})

test('a note an agent wrote to while it was away opens with its marks', async ({ page }) => {
  await seed(page, [PLAN_NOTE, { id: OTHER, title: 'Other', owner: 'Other text.\n', edits: [] }])
  await noteRow(page, 'Plan').click()
  await expect(marks(page)).toHaveCount(2)
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('X')
  await noteRow(page, 'Other').click()
  await expect(body(page)).toContainText('Other text.')

  await httpApi(page, 'notes.update', PLAN, {
    markdown: `XOwner introduction.\n${CLAUDE_TEXT}\nFrom the API, while the note was away.\n`,
  })
  await noteRow(page, 'Plan').click()
  await expect(body(page)).toContainText('From the API, while the note was away.')
  await expect(marks(page)).toHaveCount(3)
})

test('Dismiss marks the shown changes seen', async ({ page }) => {
  await seed(page, [PLAN_NOTE])
  await noteRow(page, 'Plan').click()
  await notice(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice(page)).toHaveCount(0)
  await expect(noteRow(page, 'Plan')).not.toContainText('changed by')
})

test('Undo All takes out one writer’s text, keeps the owner’s and the other writer’s, and undoes as one step', async ({
  page,
}) => {
  const CODEX_TEXT = 'Codex adds a closing line.\n'
  await seed(page, [
    {
      id: PLAN,
      title: 'Plan',
      owner: OWNER,
      edits: [
        { writer: CLAUDE, markdown: `${OWNER}${CLAUDE_TEXT}` },
        { writer: CODEX, markdown: `${OWNER}${CLAUDE_TEXT}${CODEX_TEXT}` },
      ],
    },
  ])
  await noteRow(page, 'Plan').click()
  await expect(notice(page)).toContainText('2 changes by Codex (MCP) and Claude Code (MCP)')
  // The owner types after the agents wrote.
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('Owner closing.')
  await notice(page).getByRole('button', { name: 'Undo All by Claude Code (MCP)' }).click()
  await expect(body(page)).not.toContainText('Claude adds')
  await expect(body(page)).toContainText('Owner intro.')
  await expect(body(page)).toContainText(CODEX_TEXT.trim())
  await expect(body(page)).toContainText('Owner closing.')
  await expect(notice(page)).toContainText('1 change by Codex (MCP)')
  await expect(marks(page)).toHaveCount(1)

  await body(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body(page)).toContainText('Claude adds')
  await expect(body(page)).toContainText('Owner closing.')
  // The text comes back as Claude's, not the owner's.
  await expect(marks(page)).toHaveCount(2)
  await expect(marks(page).first()).toHaveAttribute(
    'aria-label',
    /^Written by Claude Code \(MCP\), /,
  )
  await expect(notice(page)).toContainText('Claude Code (MCP)')
  await expect(agentRow(page, 'Claude Code (MCP)')).toBeVisible()
  const storedNames = () =>
    page.evaluate(() =>
      (
        JSON.parse(localStorage.getItem('devot.test.agentWrites') ?? '[]') as { name: string }[]
      ).map((row) => row.name),
    )
  await expect.poll(storedNames).toContain('Claude Code')

  // Redo takes it out again, record and all. Shift+Cmd+Z on macOS; CodeMirror binds Ctrl+Y elsewhere.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
  await expect(body(page)).not.toContainText('Claude adds')
  await expect(notice(page)).toContainText('1 change by Codex (MCP)')
  await expect(marks(page)).toHaveCount(1)
  await expect.poll(storedNames).toEqual(['Codex'])

  await page.keyboard.press('ControlOrMeta+z')
  await expect(marks(page)).toHaveCount(2)
  await expect.poll(storedNames).toContain('Claude Code')
  await reloadApp(page)
  await noteRow(page, 'Plan').click()
  await expect(body(page)).toContainText('Claude adds')
  await expect(marks(page).first()).toHaveAttribute(
    'aria-label',
    /^Written by Claude Code \(MCP\), /,
  )
})

test('Undo All says how many changes it takes out when the notice counts fewer', async ({
  page,
}) => {
  await seed(page, [{ ...PLAN_NOTE, seen: 1 }])
  await noteRow(page, 'Plan').click()
  await expect(notice(page)).toContainText('1 change by Claude Code (MCP) since you last looked.')
  await notice(page).getByRole('button', { name: 'Undo All 2 Changes' }).click()
  await expect(body(page)).not.toContainText('Claude adds')
  await expect(body(page)).toContainText('Owner intro.')
  await expect(notice(page)).toHaveCount(0)
})

test('the keyboard goes back to the editor when the notice’s control goes away', async ({
  page,
}) => {
  await seed(page, [
    PLAN_NOTE,
    {
      id: OTHER,
      title: 'Other',
      owner: 'Other text.\n',
      edits: [{ writer: CODEX, markdown: 'Other text.\nCodex line.\n' }],
    },
  ])
  await noteRow(page, 'Plan').click()
  const review = notice(page).getByRole('button', { name: 'Review Changes' })
  await review.focus()
  await page.keyboard.press('Enter')
  await expect(notice(page).getByRole('button', { name: 'Next Change' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(body(page)).toBeFocused()

  await review.focus()
  await page.keyboard.press('Enter')
  await notice(page).getByRole('button', { name: 'Done' }).focus()
  await page.keyboard.press('Enter')
  await expect(body(page)).toBeFocused()

  await notice(page).getByRole('button', { name: 'Undo All' }).focus()
  await page.keyboard.press('Enter')
  await expect(body(page)).not.toContainText('Claude adds')
  await expect(body(page)).toBeFocused()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body(page)).toContainText('Claude adds')

  await noteRow(page, 'Other').click()
  await notice(page).getByRole('button', { name: 'Dismiss' }).focus()
  await page.keyboard.press('Enter')
  await expect(notice(page)).toHaveCount(0)
  await expect(body(page)).toBeFocused()
})

test('in a narrow Split pane the notice’s buttons wrap below its text, and a mark’s tip stays in the pane', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  await seed(page, [PLAN_NOTE])
  await noteRow(page, 'Plan').click()
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  const text = await notice(page).locator('.authorship-notice-text').boundingBox()
  const actions = await notice(page).locator('.authorship-notice-actions').boundingBox()
  expect(actions!.y).toBeGreaterThanOrEqual(text!.y + text!.height - 1)
  expect(text!.height).toBeLessThan(80)

  await marks(page).first().focus()
  const tip = page.locator('.cm-authorship-tip')
  await expect(tip).toBeVisible()
  const tipBox = await tip.boundingBox()
  const scroller = await page.locator('.cm-scroller').first().boundingBox()
  expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(scroller!.x + scroller!.width)
})

const TWO_WRITERS: Seeded = {
  id: PLAN,
  title: 'Plan',
  owner: OWNER,
  edits: [
    { writer: CLAUDE, markdown: `${OWNER}Claude adds this.\n` },
    { writer: CODEX, markdown: `${OWNER}Claude adds this.\nCodex adds that.\n` },
  ],
}

test('a mark’s tip sits above or below the lines it names, never over them', async ({ page }) => {
  await seed(page, [
    TWO_WRITERS,
    {
      id: OTHER,
      title: 'Other',
      owner: '',
      edits: [{ writer: CLAUDE, markdown: 'Claude starts the note.\n' }],
    },
  ])
  const tip = page.locator('.cm-authorship-tip')
  const tipClear = async (index: number) => {
    const mark = marks(page).nth(index)
    await mark.focus()
    await expect(tip).toBeVisible()
    const t = (await tip.boundingBox())!
    const m = (await mark.boundingBox())!
    return t.y + t.height <= m.y + 0.5 || t.y >= m.y + m.height - 0.5
  }
  await noteRow(page, 'Plan').click()
  await expect(marks(page)).toHaveCount(2)
  expect(await tipClear(0)).toBe(true)
  expect(await tipClear(1)).toBe(true)
  // On the note's first line there is no room above: the tip goes below.
  await noteRow(page, 'Other').click()
  await expect(marks(page)).toHaveCount(1)
  expect(await tipClear(0)).toBe(true)
})

test('review keeps the notice’s height, so the text does not jump', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await seed(page, [TWO_WRITERS])
  await noteRow(page, 'Plan').click()
  const firstLine = async () => (await page.locator('.cm-line').first().boundingBox())!.y
  await expect(body(page)).toContainText('Codex adds that.')
  const before = await firstLine()
  await notice(page).getByRole('button', { name: 'Review Changes' }).click()
  await expect(notice(page).getByRole('status')).toHaveText(/^Change 1 of 2/)
  expect(Math.abs((await firstLine()) - before)).toBeLessThan(1)
  await page.keyboard.press('ArrowDown')
  await expect(notice(page).getByRole('status')).toHaveText(/^Change 2 of 2/)
  expect(Math.abs((await firstLine()) - before)).toBeLessThan(1)
  await notice(page).getByRole('button', { name: 'Done' }).click()
  expect(Math.abs((await firstLine()) - before)).toBeLessThan(1)
})

test('while the history bar shows a past version, the notice looks as inert as it is', async ({
  page,
}) => {
  await seed(page, [TWO_WRITERS])
  await noteRow(page, 'Plan').click()
  // Undo All keeps the text before it as a version.
  await notice(page).getByRole('button', { name: 'Undo All by Claude Code (MCP)' }).click()
  await expect(body(page)).not.toContainText('Claude adds')
  const actions = notice(page).locator('.authorship-notice-actions')
  const opacity = () => actions.evaluate((el) => Number(getComputedStyle(el).opacity))
  expect(await opacity()).toBe(1)
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  const slider = page.getByRole('group', { name: 'History' }).getByRole('slider')
  await expect(slider).not.toHaveAttribute('aria-valuemax', '0')
  await slider.focus()
  await page.keyboard.press('Home')
  await expect(page.locator('.authorship-notice-slot')).toHaveAttribute('inert', '')
  expect(await opacity()).toBeLessThan(1)
})

test('a long client name is cut short, and its kind stays shown', async ({ page }) => {
  await seed(page, [
    {
      id: PLAN,
      title: 'Plan',
      owner: OWNER,
      edits: [
        { writer: CLAUDE, markdown: `${OWNER}${CLAUDE_TEXT}` },
        { writer: LONG, markdown: `${OWNER}${CLAUDE_TEXT}A long line.\n` },
      ],
    },
    { id: OTHER, title: 'Other', owner: 'Other text.\n', edits: [] },
  ])
  const fullLong = `${LONG.name} (MCP)`
  const kindShown = async (label: Locator, box: Locator) => {
    const kind = (await label.locator('.writer-label-fixed').last().boundingBox())!
    const room = (await box.boundingBox())!
    return kind.width > 0 && kind.x + kind.width <= room.x + room.width + 0.5
  }
  for (const name of ['An extremely long', 'Claude Code (MCP)']) {
    const row = agentRow(page, name)
    await expect(row).toBeVisible()
    expect(await kindShown(row.locator('.writer-label'), row.locator('.source-label'))).toBe(true)
  }
  await expect(agentRow(page, 'An extremely long').locator('.writer-label')).toHaveAttribute(
    'title',
    fullLong,
  )
  await expect(agentRow(page, 'An extremely long')).toHaveAccessibleName(
    `${fullLong} 1 unseen change`,
  )

  const agent = noteRow(page, 'Plan').locator('.row-agent')
  await expect(agent.locator('.writer-label')).toHaveAttribute('title', `changed by ${fullLong}`)
  expect(await kindShown(agent.locator('.writer-label'), noteRow(page, 'Plan'))).toBe(true)
  // The date sits at the end of the title's line, so the mark takes the details line below it.
  const title = (await noteRow(page, 'Plan').locator('.row-title').boundingBox())!
  const time = (await noteRow(page, 'Plan').locator('.row-time').boundingBox())!
  const mark = (await agent.boundingBox())!
  expect(Math.abs(time.y + time.height / 2 - (title.y + title.height / 2))).toBeLessThan(2)
  expect(mark.y).toBeGreaterThanOrEqual(title.y + title.height - 0.5)
})

test('the Agents section lists the writers with their unseen changes and filters to their notes', async ({
  page,
}) => {
  await seed(page, [PLAN_NOTE, { id: OTHER, title: 'Other', owner: 'Other text.\n', edits: [] }])
  await httpApi(page, 'notes.update', OTHER, { markdown: 'Other text.\nFrom the API.\n' })
  await expect(noteRow(page, 'Other')).toContainText('changed by HTTP API')
  await expect(sidebar(page).getByText('Agents', { exact: true })).toBeVisible()
  await expect(agentRow(page, 'HTTP API')).toHaveAccessibleName('HTTP API 1 unseen change')
  await expect(agentRow(page, 'Claude Code (MCP)')).toHaveAccessibleName(
    'Claude Code (MCP) 2 unseen changes',
  )

  await agentRow(page, 'Claude Code (MCP)').click()
  await expect(noteRows(page)).toHaveCount(1)
  await expect(noteRows(page).first()).toContainText('Plan')
  await agentRow(page, 'Claude Code (MCP)').click()
  await expect(noteRows(page)).toHaveCount(2)

  // A board shows the mark on the card too.
  await page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Board' }).click()
  const card = page.locator('.board').getByRole('option').filter({ hasText: 'Plan' })
  await expect(card.locator('.row-agent')).toHaveAttribute('title', 'changed by Claude Code (MCP)')
})

test('an agent filter that clears when its notes leave the library stays off when the agent writes again', async ({
  page,
}) => {
  await seed(page, [
    PLAN_NOTE,
    { id: OTHER, title: 'Other', owner: 'Other text.\n', edits: [] },
    { id: THIRD, title: 'Third', owner: 'Third text.\n', edits: [] },
  ])
  await httpApi(page, 'notes.update', OTHER, { markdown: 'Other text.\nFrom the API.\n' })
  await expect(noteRow(page, 'Other')).toContainText('changed by HTTP API')

  await agentRow(page, 'HTTP API').click()
  await expect(noteRows(page)).toHaveCount(1)
  // The only note the agent changed goes to the Trash, so the filter has nothing left to show and
  // is cleared: every live note comes back (A173).
  await noteRow(page, 'Other').click()
  await pickNoteMore(page, 'Move to Trash')
  await expect(noteRows(page)).toHaveCount(2)
  await expect(noteRow(page, 'Plan')).toBeVisible()
  await expect(noteRow(page, 'Third')).toBeVisible()

  // A new write from that agent brings its row back, and the list must not turn filtered again.
  await httpApi(page, 'notes.update', PLAN, { markdown: 'Plan, as the API leaves it.\n' })
  await expect(noteRow(page, 'Plan')).toContainText('changed by HTTP API')
  await expect(noteRows(page)).toHaveCount(2)
  await expect(agentRow(page, 'HTTP API')).toHaveAttribute('aria-pressed', 'false')
})

test('Clear Authorship asks first, then drops the marks, the notice and the rows', async ({
  page,
}) => {
  await seed(page, [PLAN_NOTE, { id: OTHER, title: 'Other', owner: 'Other text.\n', edits: [] }])
  const offersClear = async () => (await shownMenu(page)).includes('Clear Authorship\u2026')
  await noteRow(page, 'Plan').click({ button: 'right' })
  await expect.poll(offersClear).toBe(true)
  await noteRow(page, 'Other').click({ button: 'right' })
  await expect.poll(offersClear).toBe(false)
  await noteRow(page, 'Plan').click()
  await expect(marks(page)).toHaveCount(2)
  expect(await openNoteMore(page)).toContain('Clear Authorship…')
  await pickMenuItem(page, 'Clear Authorship…')
  const dialog = page.getByRole('dialog', { name: 'Clear the authorship of this note?' })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(marks(page)).toHaveCount(2)

  await openNoteMore(page)
  await pickMenuItem(page, 'Clear Authorship…')
  await dialog.getByRole('button', { name: 'Clear Authorship' }).click()
  await expect(marks(page)).toHaveCount(0)
  await expect(notice(page)).toHaveCount(0)
  await expect(noteRow(page, 'Plan')).not.toContainText('changed by')
  await expect(sidebar(page).getByText('Agents', { exact: true })).toHaveCount(0)
  await expect(body(page)).toContainText(CLAUDE_TEXT.trim())
})

test('once the trial is over without a licence, Undo All and Clear Authorship are off', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      licence_get: () => ({
        gated: true,
        state: 'none',
        code: null,
        id: null,
        licensee: null,
        plan: null,
        trial: { state: 'ended', endsAt: 1_790_000_000_000, code: null },
      }),
    }
  })
  await seed(page, [PLAN_NOTE])
  await noteRow(page, 'Plan').click()
  await expect(notice(page).getByRole('button', { name: 'Undo All' })).toBeDisabled()
  await expect(notice(page).getByRole('button', { name: 'Review Changes' })).toBeEnabled()
  expect(await openNoteMore(page)).not.toContain('Clear Authorship…')
})
