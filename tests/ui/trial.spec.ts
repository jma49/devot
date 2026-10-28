import type { Page } from '@playwright/test'
import {
  expect,
  openApp,
  openSettings,
  pickNoteMore,
  reloadApp,
  test,
  type TestWindow,
} from './fixtures'

// The three-day trial: while it runs everything works; once it is over without a licence, notes are
// read-only, one bar says so with Buy and Add Licence, and Settings > Licence says how long is left.
// Rust is faked in the page; `devot:licence-changed` is what Rust's change event becomes there.

const HOUR = 3_600_000

type Licence = Record<string, unknown>

const unlicensed = (trial: Licence): Licence => ({
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial,
})
const ended = () => unlicensed({ state: 'ended', endsAt: Date.now() - HOUR, code: null })

/** No licence and a trial that ends `endsIn` milliseconds from now (ended, when negative). */
async function fakeTrial(page: Page, endsIn: number) {
  await fakeTrialEndingAt(page, Date.now() + endsIn)
}

async function fakeTrialEndingAt(page: Page, endsAt: number) {
  await page.addInitScript((end) => {
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
        trial: { state: end > Date.now() ? 'running' : 'ended', endsAt: end, code: null },
      }),
      open_external: null,
      settings_open_licence: null,
    }
  }, endsAt)
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

const changeLicence = (page: Page, licence: Licence) =>
  page.evaluate((detail) => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:licence-changed', { detail }))
  }, licence)

const bar = (page: Page) => page.locator('[data-devot-trial-ended]')
const savedNotes = () => localStorage.getItem('devot.test.notes') ?? ''

async function writeNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const body = page.getByRole('textbox', { name: 'Note body' })
  await body.click()
  await page.keyboard.type(text)
  await expect(body).toContainText(text)
}

test.describe('once the trial is over', () => {
  test('the open note keeps what was typed and turns read-only, with one bar to buy or add a licence', async ({
    page,
  }) => {
    await fakeTrial(page, 50 * HOUR)
    await openApp(page)
    await page.evaluate(() => localStorage.clear())
    await reloadApp(page)
    await writeNote(page, 'Typed before the end')
    await expect(bar(page)).toHaveCount(0)

    await changeLicence(page, ended())
    await expect(bar(page)).toHaveText(
      /Your Devot trial has ended, so notes are read-only: you can read, search, copy and export them\./,
    )
    await expect.poll(() => page.evaluate(savedNotes)).toContain('Typed before the end')

    const body = page.getByRole('textbox', { name: 'Note body' })
    await body.click()
    await page.keyboard.type(' and after')
    await page.keyboard.press('Backspace')
    await expect(body).toHaveText('Typed before the end')
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveAttribute('readonly', '')
    await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'New Notebook' })).toBeDisabled()

    // No format bar over a selection, and the keys that make or change notes do nothing.
    await page.keyboard.press('Meta+a')
    await expect(page.getByRole('toolbar', { name: 'Format' })).toHaveCount(0)
    await page.keyboard.press('Meta+b')
    await expect(body).toHaveText('Typed before the end')
    const rows = page.getByRole('listbox').getByRole('option')
    await expect(rows).toHaveCount(1)
    await page.keyboard.press('Meta+n')
    await expect(rows).toHaveCount(1)

    // Find and Replace's key opens plain Find: nothing may be replaced.
    await body.click()
    await page.keyboard.press('Alt+Meta+f')
    const find = page.getByRole('search', { name: 'Find in Note' })
    await expect(find.getByRole('textbox', { name: 'Find' })).toBeFocused()
    await expect(find.getByRole('textbox', { name: 'Replace' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await bar(page).getByRole('button', { name: 'Buy a Licence' }).click()
    expect(await calls(page, 'open_external')).toEqual([
      { url: 'https://licence.devot.online/buy' },
    ])
    await bar(page).getByRole('button', { name: 'Add Licence' }).click()
    expect(await calls(page, 'settings_open_licence')).toHaveLength(1)
    await expect(bar(page)).toHaveCount(1)
  })

  test('an empty note offers the hint and Choose a template only while notes can be changed', async ({
    page,
  }) => {
    await fakeTrial(page, 50 * HOUR)
    await openApp(page)
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    const hint = page.locator('.cm-empty-hint')
    const chip = page.getByRole('button', { name: /^Choose a template/ })
    await expect(hint).toBeVisible()
    await expect(chip).toBeVisible()

    await changeLicence(page, ended())
    await expect(bar(page)).toBeVisible()
    // Nothing can be typed and no template can be chosen: the hint would offer both.
    await expect(hint).toBeHidden()
    await expect(chip).toBeHidden()

    const now = await page.evaluate(() => Date.now())
    await changeLicence(page, unlicensed({ state: 'running', endsAt: now + 50 * HOUR, code: null }))
    await expect(bar(page)).toHaveCount(0)
    await expect(hint).toBeVisible()
    await expect(chip).toBeVisible()
  })

  test('a template makes no note while notes are read-only', async ({ page }) => {
    // Wider than the trial bar, which covers the foot of the lists.
    await page.setViewportSize({ width: 1600, height: 900 })
    await fakeTrial(page, 50 * HOUR)
    await openApp(page)
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    await changeLicence(page, ended())
    await expect(bar(page)).toBeVisible()

    const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
    await sidebar.getByRole('button', { name: /^Templates \d+$/ }).click()
    await page
      .getByRole('group', { name: 'Built-in' })
      .getByRole('button', { name: 'Planning' })
      .click()
    await page
      .getByRole('region', { name: 'Planning' })
      .getByRole('button', { name: 'Create' })
      .click()
    // Nothing is made: no note opens, and the Templates list stays empty.
    await page.waitForTimeout(1_000)
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveCount(0)
    await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(0)
  })

  test('Empty Trash is withheld while notes are read-only', async ({ page }) => {
    await fakeTrial(page, 50 * HOUR)
    await openApp(page)
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Old')
    await pickNoteMore(page, 'Move to Trash')

    await changeLicence(page, ended())
    await expect(bar(page)).toBeVisible()
    const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
    await sidebar.getByRole('button', { name: /^Trash \d+$/ }).click()
    const empty = page.getByRole('button', { name: 'Empty Trash' })
    await expect(empty).toHaveAttribute('aria-disabled', 'true')
    // A disabled button takes no click; this one is aria-disabled, so click it anyway.
    await empty.evaluate((el) => (el as HTMLElement).click())
    await page.waitForTimeout(300)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(sidebar.getByRole('button', { name: /^Trash \d+$/ })).toHaveText(/1$/)
  })

  test('the window turns read-only at the end of the trial, without being told', async ({
    page,
  }) => {
    await fakeTrial(page, 50 * HOUR)
    await openApp(page)
    const now = await page.evaluate(() => Date.now())
    await changeLicence(page, unlicensed({ state: 'running', endsAt: now + 1_500, code: null }))
    await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
    await expect(bar(page)).toHaveCount(0)
    await expect(bar(page)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeDisabled()
  })

  test('a licence unlocks the window again', async ({ page }) => {
    await fakeTrial(page, -HOUR)
    await openApp(page)
    await expect(bar(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeDisabled()
    await changeLicence(page, {
      ...ended(),
      state: 'valid',
      id: '5vEvzHainWD0cA2Ht_ljHg',
      licensee: 'buyer@example.com',
      plan: 'pro',
    })
    await expect(bar(page)).toHaveCount(0)
    await writeNote(page, 'Licensed now')
  })

  test('quick capture keeps its text and saves nothing', async ({ page }) => {
    await fakeTrial(page, -HOUR)
    await page.goto('/quick-capture.html')
    await page.getByRole('textbox', { name: 'Note' }).fill('An idea')
    await expect(page.locator('[data-devot-trial-ended]')).toHaveText(
      'Your Devot trial has ended, so no note can be saved. Add a licence in Settings > Licence.',
    )
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
    await page.getByRole('textbox', { name: 'Note' }).press('Meta+Enter')
    expect(await calls(page, 'quick_capture_save')).toEqual([])
  })
})

test.describe('the trial-ended bar', () => {
  test('leaves the end of the note list and of the note in view', async ({ page }) => {
    // The narrowest window: the bar wraps and covers about two rows of the list.
    await page.setViewportSize({ width: 760, height: 720 })
    await fakeTrial(page, -HOUR)
    await page.goto('/')
    await page.evaluate(() => {
      const start = Date.now() - 60_000
      const notes = Array.from({ length: 30 }, (_, i) => ({
        id: `0192a6f0-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
        title: `Note ${i + 1}`,
        titleHlc: '',
        bodyMd: i === 0 ? Array.from({ length: 80 }, (_line, l) => `line ${l + 1}`).join('\n') : '',
        ydoc: [0, 0],
        bookId: null,
        bookHlc: '',
        status: 'none',
        statusHlc: '',
        pinned: false,
        pinnedHlc: '',
        createdAt: start - i * 60_000,
        updatedAt: start - i * 60_000,
        deletedAt: null,
        deletedHlc: null,
      }))
      localStorage.clear()
      localStorage.setItem('devot.test.notes', JSON.stringify(notes))
    })
    await reloadApp(page)
    const list = page.getByRole('listbox', { name: 'Notes' })
    const rows = list.getByRole('option')
    await expect(rows).toHaveCount(30)

    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    // Measure the bar where it settles, not mid-slide.
    await bar(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    const lastRow = (await rows.last().boundingBox())!
    const barTop = (await bar(page).boundingBox())!.y
    expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(barTop)

    // The note's last line clears it too.
    await rows.first().click()
    await page.locator('.editor-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const lastLine = (await page.locator('.cm-line').last().boundingBox())!
    expect(lastLine.y + lastLine.height).toBeLessThanOrEqual(barTop)

    // A row scrolled into view the way the list does it lands above the bar, not under it.
    await list.evaluate((el) => {
      const row = el.querySelectorAll('[role="option"]')[20]!
      const visible = el.getBoundingClientRect()
      el.scrollTop += row.getBoundingClientRect().bottom - visible.bottom + 4
    })
    await rows.nth(20).evaluate((el) => el.scrollIntoView({ block: 'nearest' }))
    const reached = (await rows.nth(20).boundingBox())!
    // Within a pixel: the row's bottom sits on the bar's top edge, and the two are rounded apart.
    expect(reached.y + reached.height).toBeLessThanOrEqual(barTop + 1)
  })
})

test.describe('the reminder', () => {
  test('says today once midnight has passed', async ({ page }) => {
    await page.clock.install({ time: new Date(2026, 9, 26, 22, 30) })
    await fakeTrialEndingAt(page, new Date(2026, 9, 27, 22, 0).getTime())
    await openApp(page)
    await page.evaluate(() => localStorage.clear())
    await reloadApp(page)
    const reminder = page.locator('[data-devot-trial-reminder]')
    await expect(reminder).toHaveText(/ends tomorrow at/)
    await page.clock.fastForward('02:00:00')
    await expect(reminder).toHaveText(/ends today at/)
  })

  test('shows once in the last day of the trial, and dismissed it does not come back', async ({
    page,
  }) => {
    await fakeTrial(page, 20 * HOUR)
    await openApp(page)
    await page.evaluate(() => localStorage.clear())
    await reloadApp(page)
    const reminder = page.locator('[data-devot-trial-reminder]')
    await expect(reminder).toHaveText(
      /Your Devot trial ends (today|tomorrow) at .+\. After that, notes are read-only until you add a licence\./,
    )
    await reminder.getByRole('button', { name: 'Add Licence' }).click()
    expect(await calls(page, 'settings_open_licence')).toHaveLength(1)
    await reminder.getByRole('button', { name: 'Dismiss' }).click()
    await expect(reminder).toHaveCount(0)
    await reloadApp(page)
    await expect(page.locator('.notices')).toBeAttached()
    await expect(reminder).toHaveCount(0)
  })

  test('waits for the last day', async ({ page }) => {
    await fakeTrial(page, 30 * HOUR)
    await openApp(page)
    await expect(page.locator('.notices')).toBeAttached()
    await expect(page.locator('[data-devot-trial-reminder]')).toHaveCount(0)
    await expect(bar(page)).toHaveCount(0)
  })
})

test.describe('Settings > Licence', () => {
  test('shows the time left while the trial runs, and that it ended after', async ({ page }) => {
    await fakeTrial(page, 50 * HOUR)
    await openSettings(page, 'Licence')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText(
      /Everything works, sync and AI included, until the trial ends on .+ \(2 days left\)\./,
    )
    await changeLicence(page, ended())
    await expect(panel).toContainText(
      'The trial has ended, so notes are read-only and sync and AI are locked until you add a licence.',
    )
  })

  test('opens at the Licence pane when Add Licence asks for it', async ({ page }) => {
    await page.goto('/settings.html?pane=licence')
    await expect(page.getByRole('tab', { name: 'Licence', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.getByRole('tab', { name: 'General', exact: true }).click()
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        dispatchEvent(e: unknown): void
        CustomEvent: new (t: string, init: { detail: unknown }) => unknown
      }
      w.dispatchEvent(new w.CustomEvent('devot:settings-pane', { detail: 'licence' }))
    })
    await expect(page.getByRole('tab', { name: 'Licence', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })
})
