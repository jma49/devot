import type { Locator, Page } from '@playwright/test'
import { expect, openApp, statusPicker, test, type TestWindow } from './fixtures'

// A dialog or pop-up opened again while its closing copy fades takes over from the copy: keys reach the
// window during the fade, one of it shows at a time, and its opacity and the dim never fall back.

interface Sample {
  count: number
  /** Which element is open: a reopened dialog or pop-up is a new one. */
  liveId: number | null
  live: number | null
  copy: number | null
  dim: number
}

interface KeyRecord {
  code: string
  t: number
  copies: number
}

interface Probe {
  devotSamples: Sample[]
  devotSampling: boolean
  devotKeys: KeyRecord[]
  /** The copy's and the dim's opacity as the reopened one took them over (removed them). */
  devotBefore?: { copy: number | null; dim: number | null }
}

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const field = (page: Page) => palette(page).getByRole('combobox', { name: 'Command Palette' })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const newNoteButton = (page: Page) => page.getByRole('button', { name: 'New Note', exact: true })

async function openWithMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      backups_list: { backups: [], lastError: null },
    }
  })
  await openApp(page)
  await expect(newNoteButton(page)).toBeEnabled()
}

/** Notes, on every key pressed, how many closing dialog copies were in the page. */
async function recordKeys(page: Page) {
  await page.evaluate(() => {
    const w = globalThis as unknown as Probe
    w.devotKeys = []
    addEventListener(
      'keydown',
      (e) => {
        const copies = document.querySelectorAll('dialog[data-closing]').length
        w.devotKeys.push({ code: e.code, t: performance.now(), copies })
      },
      { capture: true },
    )
  })
}

/**
 * `ms` after the next `trigger` event (a real Escape or click), presses Command and a key (`code`) or
 * sends a page event, from the page itself so the gap does not depend on the runner's round trips.
 */
async function soonAfter(
  page: Page,
  trigger: 'keydown' | 'click',
  then: { code: string } | { event: string },
  ms = 20,
) {
  await page.evaluate(
    ([type, action, wait]) => {
      const act = () => {
        if ('event' in action) return dispatchEvent(new CustomEvent(action.event))
        const target = document.activeElement ?? document.body
        const key = action.code.replace('Key', '').toLowerCase()
        const init = { code: action.code, key, metaKey: true, bubbles: true, cancelable: true }
        return target.dispatchEvent(new KeyboardEvent('keydown', init))
      }
      addEventListener(type, () => setTimeout(act, wait), { capture: true, once: true })
    },
    [trigger, then, ms] as const,
  )
}

const keys = (page: Page) => page.evaluate(() => (globalThis as unknown as Probe).devotKeys)

/**
 * Samples, every frame, the elements matching `selector`: how many there are, the open one's opacity,
 * its closing copy's, and how dark the page is under them (the closing dim and the open dialog's
 * backdrop together).
 */
async function startSampling(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const w = globalThis as unknown as Probe
    w.devotSamples = []
    w.devotSampling = true
    const ids = new Map<Element, number>()
    const idOf = (el: Element) => ids.get(el) ?? ids.set(el, ids.size + 1).size
    const opacity = (el: Element | null, pseudo?: string) =>
      el ? Number.parseFloat(getComputedStyle(el, pseudo).opacity) : null
    const sample = (): Sample => {
      const live = document.querySelector(`${sel}:not([data-closing])`)
      const dim = opacity(document.querySelector('.dialog-backdrop[data-closing]')) ?? 0
      const backdrop = live instanceof HTMLDialogElement ? (opacity(live, '::backdrop') ?? 0) : 0
      return {
        count: document.querySelectorAll(sel).length,
        liveId: live ? idOf(live) : null,
        live: opacity(live),
        copy: opacity(document.querySelector(`${sel}[data-closing]`)),
        dim: 1 - (1 - dim) * (1 - backdrop),
      }
    }
    const before = { copy: null as number | null, dim: null as number | null }
    w.devotBefore = before
    const remove = Element.prototype.remove
    Element.prototype.remove = function (this: Element) {
      if (this.isConnected && before.copy === null && this.matches(`${sel}[data-closing]`))
        before.copy = opacity(this)
      if (this.isConnected && before.dim === null && this.matches('.dialog-backdrop[data-closing]'))
        before.dim = opacity(this)
      remove.call(this)
    }
    const tick = () => {
      if (!w.devotSampling) return
      w.devotSamples.push(sample())
      requestAnimationFrame(tick)
    }
    tick()
  }, selector)
}

/** The samples taken every frame, and what the reopened one took over. */
async function stopSampling(page: Page, frames = 20) {
  return page.evaluate(async (n) => {
    const w = globalThis as unknown as Probe
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r))
    w.devotSampling = false
    return { samples: w.devotSamples, before: w.devotBefore }
  }, frames)
}

/** What shows of the dialog or pop-up: the open one, else its closing copy. */
const shown = (s: Sample) => s.live ?? s.copy ?? 0

/**
 * Asserts the one opened again took over where its copy was: on its first frame it shows at least
 * what the copy (or the dim) showed as it was taken over, and it only grows from there.
 */
function expectTakesOver(
  { samples, before }: { samples: Sample[]; before?: Probe['devotBefore'] },
  value: (s: Sample) => number = shown,
  from: number | null | undefined = before?.copy,
) {
  const reopened = samples.findIndex(
    (s, i) => i > 0 && s.liveId !== null && s.liveId !== samples[i - 1]?.liveId,
  )
  expect(reopened).toBeGreaterThan(0)
  expect(from).toBeGreaterThan(0)
  const after = samples.slice(reopened).map(value)
  const trace = `${from!.toFixed(2)} | ${samples.map((s) => value(s).toFixed(2)).join(' ')}`
  expect(after[0], trace).toBeGreaterThanOrEqual(from! - 0.01)
  expectNeverFalls(after)
}

function expectNeverFalls(values: number[]) {
  const falls = values.flatMap((v, i) => (i > 0 && v < (values[i - 1] ?? 0) - 0.01 ? [i] : []))
  expect(falls, values.map((v) => v.toFixed(2)).join(' ')).toEqual([])
}

/** Waits until `el` has finished growing in, so the samples start from a settled page. */
async function settled(el: Locator) {
  await expect.poll(() => el.evaluate((node) => getComputedStyle(node).opacity)).toBe('1')
}

test('Escape then Command-K within 50 ms opens the palette again over its fading copy', async ({
  page,
}) => {
  await openWithMotion(page)
  await page.keyboard.press('Meta+KeyK')
  await expect(field(page)).toBeFocused()
  await settled(palette(page))
  await recordKeys(page)
  await startSampling(page, 'dialog.palette[open]')
  await soonAfter(page, 'keydown', { code: 'KeyK' })
  await page.keyboard.press('Escape')
  await expect(field(page)).toBeFocused()
  const sampled = await stopSampling(page)
  const { samples } = sampled

  const pressed = await keys(page)
  const escape = pressed.find((k) => k.code === 'Escape')
  const reopen = pressed.find((k) => k.code === 'KeyK')
  expect(reopen!.t - escape!.t).toBeLessThan(50)
  expect(reopen?.copies).toBe(1)
  expect(Math.max(...samples.map((s) => s.count))).toBe(1)
  expectTakesOver(sampled)
  await expect(page.locator('dialog.palette')).toHaveCount(1)
})

test('Command-N right after confirming a dialog creates a note', async ({ page }) => {
  await openWithMotion(page)
  const before = await noteRows(page).count()
  await newNoteButton(page).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  const tagField = page.getByRole('combobox', { name: 'Add Tag' })
  await tagField.fill('temp')
  await tagField.press('Enter')
  const tagRow = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', {
    name: /^temp 1$/,
  })
  await tagRow.focus()
  await page.keyboard.press('Delete')
  const confirm = page.getByRole('dialog', { name: 'Delete the tag “temp”?' })
  await expect(confirm).toBeVisible()
  await recordKeys(page)
  await soonAfter(page, 'click', { code: 'KeyN' })
  await confirm.getByRole('button', { name: 'Delete Tag' }).click()
  await expect(noteRows(page)).toHaveCount(before + 2)
  const pressed = (await keys(page)).find((k) => k.code === 'KeyN')
  expect(pressed?.copies).toBe(1)
})

test('a sheet opened again while its dim fades keeps the page from brightening', async ({
  page,
}) => {
  await openWithMotion(page)
  const showBackups = () =>
    page.evaluate(() => {
      dispatchEvent(new CustomEvent('devot:show-backups'))
    })
  await showBackups()
  const sheet = page.getByRole('dialog', { name: 'Backups' })
  await settled(sheet)
  await startSampling(page, 'dialog.sheet[open]')
  // Halfway through the copy's 200 ms fade.
  await soonAfter(page, 'keydown', { event: 'devot:show-backups' }, 100)
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog.sheet[data-closing]')).toHaveCount(0)
  await expect(sheet).toBeVisible()
  const sampled = await stopSampling(page)
  const { samples } = sampled

  expect(Math.max(...samples.map((s) => s.count))).toBe(1)
  expectTakesOver(sampled)
  expectTakesOver(sampled, (s) => s.dim, sampled.before?.dim)
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0)
})

test('a sheet closed before its dim has faded in fades the dim out from there', async ({
  page,
}) => {
  await openWithMotion(page)
  await startSampling(page, 'dialog.sheet[open]')
  // Opened and closed from the page: Done goes once the dim shows, well before its 2 s fade ends.
  const atClose = await page.evaluate(async () => {
    dispatchEvent(new CustomEvent('devot:show-backups'))
    const frame = () => new Promise((r) => requestAnimationFrame(r))
    const sheet = () => document.querySelector<HTMLDialogElement>('dialog.sheet[open]')
    const dim = () => {
      const open = sheet()
      return open ? Number.parseFloat(getComputedStyle(open, '::backdrop').opacity) : 0
    }
    for (let i = 0; i < 600 && dim() < 0.1; i++) await frame()
    const drawn = dim()
    const done = Array.from(sheet()?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Done',
    )
    done?.click()
    return drawn
  })
  await expect(page.locator('dialog.sheet')).toHaveCount(0)
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0)
  const { samples } = await stopSampling(page, 2)

  expect(atClose).toBeGreaterThanOrEqual(0.1)
  expect(atClose).toBeLessThan(0.9)
  const closed = samples.findIndex(
    (s, i) => i > 0 && s.liveId === null && samples[i - 1]?.liveId !== null,
  )
  expect(closed).toBeGreaterThan(0)
  const dims = samples.slice(closed - 1).map((s) => s.dim)
  const rises = dims.flatMap((d, i) => (i > 0 && d > (dims[i - 1] ?? 0) + 0.01 ? [i] : []))
  expect(rises, dims.map((d) => d.toFixed(3)).join(' ')).toEqual([])
})

test('a sheet opened again over its fading dim and closed early fades the dim out from there', async ({
  page,
}) => {
  await openWithMotion(page)
  await startSampling(page, 'dialog.sheet[open]')
  // From the page: closed once the dim shows, opened again while its copy fades (the dim goes on
  // from there), and closed again before that fade has ended.
  const atCloses = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r))
    const sheet = () =>
      document.querySelector<HTMLDialogElement>('dialog.sheet[open]:not([data-closing])')
    const dim = () => {
      const open = sheet()
      return open ? Number.parseFloat(getComputedStyle(open, '::backdrop').opacity) : 0
    }
    const done = () =>
      Array.from(sheet()?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent === 'Done')
        ?.click()
    const drawn: number[] = []
    dispatchEvent(new CustomEvent('devot:show-backups'))
    for (let i = 0; i < 600 && dim() < 0.1; i++) await frame()
    drawn.push(dim())
    done()
    await frame()
    dispatchEvent(new CustomEvent('devot:show-backups'))
    for (let i = 0; i < 600 && !sheet(); i++) await frame()
    const resumed = dim()
    for (let i = 0; i < 600 && dim() < resumed + 0.05; i++) await frame()
    drawn.push(dim())
    done()
    return drawn
  })
  await expect(page.locator('dialog.sheet')).toHaveCount(0)
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0)
  const { samples } = await stopSampling(page, 2)

  for (const drawn of atCloses) {
    expect(drawn).toBeGreaterThan(0.05)
    expect(drawn).toBeLessThan(0.9)
  }
  const closed = samples.findLastIndex(
    (s, i) => i > 0 && s.liveId === null && samples[i - 1]?.liveId !== null,
  )
  expect(samples.filter((s, i) => i > 0 && s.liveId !== samples[i - 1]?.liveId).length).toBe(4)
  const dims = samples.slice(closed - 1).map((s) => s.dim)
  const rises = dims.flatMap((d, i) => (i > 0 && d > (dims[i - 1] ?? 0) + 0.01 ? [i] : []))
  expect(rises, dims.map((d) => d.toFixed(3)).join(' ')).toEqual([])
})

test('a dropdown opened again while it fades out never dips', async ({ page }) => {
  await openWithMotion(page)
  await newNoteButton(page).click()
  await statusPicker(page).click()
  const list: Locator = page.locator('.picker-popover:not([data-closing])')
  await settled(list)
  await startSampling(page, '.picker-popover')
  // Escape, then the button 60 ms later, inside the 200 ms fade.
  await page.evaluate(
    ([popover, button]) =>
      new Promise<void>((done) => {
        popover?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
        setTimeout(() => {
          ;(button as HTMLElement | null)?.click()
          done()
        }, 60)
      }),
    [await list.elementHandle(), await statusPicker(page).elementHandle()] as const,
  )
  await expect(list).toBeVisible()
  const sampled = await stopSampling(page)
  const { samples } = sampled

  expect(Math.max(...samples.map((s) => s.count))).toBe(1)
  expectTakesOver(sampled)
})

test('a dropdown opened again before its fade draws a frame stays fully shown', async ({
  page,
}) => {
  await openWithMotion(page)
  await newNoteButton(page).click()
  await statusPicker(page).click()
  const list: Locator = page.locator('.picker-popover:not([data-closing])')
  await settled(list)
  await startSampling(page, '.picker-popover')
  // In one task, so no frame comes between the close and the reopen.
  await page.evaluate(
    async ([popover, button]) => {
      popover?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
      ;(button as HTMLElement | null)?.click()
    },
    [await list.elementHandle(), await statusPicker(page).elementHandle()] as const,
  )
  await expect(list).toBeVisible()
  const sampled = await stopSampling(page)

  expect(Math.max(...sampled.samples.map((s) => s.count))).toBe(1)
  expectTakesOver(sampled)
})

test('the palette fades out where its results were scrolled to', async ({ page }) => {
  await openWithMotion(page)
  await page.keyboard.press('Meta+KeyK')
  await field(page).fill('> ')
  const results = palette(page).locator('.palette-results')
  await expect
    .poll(() => results.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(50)
  const top = await results.evaluate(async (el) => {
    el.scrollTop = el.scrollHeight
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return el.scrollTop
  })
  expect(top).toBeGreaterThan(0)
  await page.mouse.click(2, 2)
  const copy = page.locator('dialog.palette[data-closing] .palette-results')
  expect(await copy.evaluate((el) => el.scrollTop)).toBe(top)
})

test('a completion list fades out where it was scrolled to', async ({ page }) => {
  await openWithMotion(page)
  await newNoteButton(page).click()
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.type('/')
  const list = page.locator('.cm-tooltip-autocomplete:not([data-closing]) > ul')
  await expect(list.getByRole('option').first()).toBeVisible()
  await expect
    .poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(50)
  const top = await list.evaluate(async (el) => {
    el.scrollTop = el.scrollHeight
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return el.scrollTop
  })
  expect(top).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  const copy = page.locator('.cm-tooltip-autocomplete[data-closing] > ul')
  expect(await copy.evaluate((el) => el.scrollTop)).toBe(top)
})
