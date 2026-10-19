import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'

// The page globals these tests touch; this config has no DOM types.
interface Rect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

interface Animation {
  pause(): void
  currentTime: number | null
  effect: { getTiming(): { duration?: unknown } } | null
}

interface Node {
  getBoundingClientRect(): Rect
  getAnimations(): Animation[]
  querySelector(selector: string): Node | null
  querySelectorAll(selector: string): ArrayLike<Node>
  getAttribute(name: string): string | null
  click(): void
  shadowRoot: Node | null
  clientLeft: number
  clientTop: number
  clientWidth: number
  clientHeight: number
  scrollTop: number
}

interface Win {
  document: Node & {
    getElementById(id: string): Node | null
    timeline: { currentTime: number | null }
  }
  getComputedStyle(el: Node): { opacity: string; paddingLeft: string; clipPath: string }
  requestAnimationFrame(callback: () => void): number
  setTimeout(callback: () => void, ms: number): number
  localStorage: { clear(): void; setItem(key: string, value: string): void }
  performance: { now(): number }
  devotSamples: number[][]
  devotSampling: boolean
}

type Probe = 'column' | 'panes' | 'rows'

/** Records `probe` once a frame, then the animation time and the clock, until `stopSampling`. */
function startSampling(page: Page, probe: Probe, arg = ''): Promise<void> {
  return page.evaluate(
    ([kind, key]) => {
      const g = globalThis as unknown as Win
      const doc = g.document
      const textLeft = (el: Node | null | undefined) =>
        el
          ? el.getBoundingClientRect().left +
            el.clientLeft +
            Number.parseFloat(g.getComputedStyle(el).paddingLeft)
          : Number.NaN
      const opacity = (el: Node | null) =>
        el ? Number.parseFloat(g.getComputedStyle(el).opacity) : -1
      const measure = (): number[] => {
        if (kind === 'column') {
          const line = doc.querySelector('.editor')?.shadowRoot?.querySelector('.cm-line')
          return [textLeft(doc.querySelector('.window > .content > .title')), textLeft(line)]
        }
        if (kind === 'panes') {
          return ['sidebar', 'list', 'content'].flatMap((pane) => {
            const el = doc.querySelector(`.window > .${pane}`)
            return [el ? el.getBoundingClientRect().left : Number.NaN, opacity(el)]
          })
        }
        const fresh = Array.from(doc.querySelectorAll('.rows [data-note-id]')).find(
          (row) => row.getAttribute('data-note-id') !== key,
        )
        const ghosts = Array.from(doc.querySelectorAll('[data-closing="row"]')).map(opacity)
        return [opacity(fresh ?? null), ghosts.length ? Math.max(...ghosts) : -1]
      }
      g.devotSamples = []
      g.devotSampling = true
      const tick = () => {
        if (!g.devotSampling) return
        g.devotSamples.push([...measure(), Number(doc.timeline.currentTime), g.performance.now()])
        g.requestAnimationFrame(tick)
      }
      tick()
    },
    [probe, arg] as const,
  )
}

function stopSampling(page: Page): Promise<number[][]> {
  return page.evaluate(() => {
    const g = globalThis as unknown as Win
    g.devotSampling = false
    return g.devotSamples
  })
}

/** From the old place to the new one, never back and never in one step. */
function expectGlide(xs: number[]) {
  const first = xs[0] ?? Number.NaN
  const total = (xs.at(-1) ?? Number.NaN) - first
  expect(Math.abs(total)).toBeGreaterThan(20)
  for (let i = 1; i < xs.length; i++) {
    const step = (xs[i] ?? Number.NaN) - (xs[i - 1] ?? Number.NaN)
    expect(step * Math.sign(total)).toBeGreaterThanOrEqual(-0.5)
    expect(Math.abs(step)).toBeLessThanOrEqual(Math.abs(total) * 0.35)
  }
}

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const focusButton = (page: Page) => page.getByRole('button', { name: 'Focus Mode' })

async function createNote(page: Page, title: string, body = '') {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  if (body) {
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.insertText(body)
  }
}

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })).toBeVisible()
}

/** Every motion slowed `scale` times (a development build reads it on each motion). */
function slowMotion(page: Page, scale: number) {
  return page.evaluate((factor) => {
    const g = globalThis as unknown as Win
    g.localStorage.setItem('devot.motionScale', String(factor))
  }, scale)
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  await page.evaluate(() => (globalThis as unknown as Win).localStorage.clear())
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full')
  await slowMotion(page, 5)
})

/** A clip-path's inset in px, top, right, bottom, left; `none` is no inset. */
function insets(clipPath: string): [number, number, number, number] {
  const px = [...clipPath.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]))
  const [t = 0, r = t, b = t, l = r] = px
  return [t, r, b, l]
}

interface Leaving {
  row: Rect
  ghost: Rect
  clip: string
  visible: Rect
}

/** The ghost of a row that has just gone, and where its list shows rows. */
function leaving(page: Page, rows: string, row: Rect): Promise<Leaving> {
  return page.locator(`${rows} [data-closing="row"]`).evaluate(
    (ghost, [selector, before]) => {
      const g = globalThis as unknown as Win
      const list = g.document.querySelector(selector)
      if (!list) throw new Error('E_TEST_NO_LIST')
      const at = list.getBoundingClientRect()
      const left = at.left + list.clientLeft
      const top = at.top + list.clientTop
      const visible = {
        left,
        top,
        right: left + list.clientWidth,
        bottom: top + list.clientHeight,
        width: list.clientWidth,
        height: list.clientHeight,
      }
      const node = ghost as unknown as Node
      return {
        row: before,
        ghost: node.getBoundingClientRect(),
        clip: g.getComputedStyle(node).clipPath,
        visible,
      }
    },
    [rows, row] as const,
  )
}

function expectInside({ row, ghost, clip, visible }: Leaving) {
  for (const side of ['left', 'top', 'width', 'height'] as const)
    expect(Math.abs(ghost[side] - row[side])).toBeLessThanOrEqual(0.5)
  const [t, r, b, l] = insets(clip)
  expect(ghost.top + t).toBeGreaterThanOrEqual(visible.top - 0.5)
  expect(ghost.bottom - b).toBeLessThanOrEqual(visible.bottom + 0.5)
  expect(ghost.left + l).toBeGreaterThanOrEqual(visible.left - 0.5)
  expect(ghost.right - r).toBeLessThanOrEqual(visible.right + 0.5)
}

test('a trashed row fades out exactly where it was, and only inside the list', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 420 })
  const titles = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
  for (const title of titles) await createNote(page, title)
  await noteRow(page, 'Seven').click()
  // Half of it under the list's top edge, where the header and the sort chip are.
  // Scrolled once the selection has settled, then read again: nothing scrolls it back.
  const row = await noteRow(page, 'Seven').evaluate(async (el) => {
    const g = globalThis as unknown as Win
    const frames = async (n: number) => {
      for (let i = 0; i < n; i++)
        await new Promise<void>((done) => g.requestAnimationFrame(() => done()))
    }
    const target = el as unknown as Node
    const list = g.document.querySelector('.rows')
    if (!list) throw new Error('E_TEST_NO_LIST')
    await frames(3)
    const box = target.getBoundingClientRect()
    list.scrollTop += box.top - list.getBoundingClientRect().top + box.height / 2
    await frames(3)
    return target.getBoundingClientRect()
  })
  const listTop = await page.locator('.rows').evaluate((el) => el.getBoundingClientRect().top)
  expect(row.top).toBeLessThan(listTop)
  await page.keyboard.press('Meta+Backspace')
  await expect(page.locator('.rows [data-closing="row"]')).toHaveCount(1)
  const seen = await leaving(page, '.rows', row)
  expect(insets(seen.clip)[0]).toBeGreaterThan(0)
  expectInside(seen)
})

test('a deleted notebook fades out exactly where it was, inside the sidebar', async ({ page }) => {
  for (const name of ['Alpha', 'Bravo', 'Charlie']) await createBook(page, name)
  const item = page.locator('.sidebar [data-motion-key^="book:"]', { hasText: 'Bravo' })
  await item.locator('.book-row').click()
  const row = await item.evaluate((el) => (el as unknown as Node).getBoundingClientRect())
  await page.keyboard.press('Backspace')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.sidebar-scroll [data-closing="row"]')).toHaveCount(1)
  expectInside(await leaving(page, '.sidebar-scroll', row))
})

test('a row trashed while it fades in fades out from there, never brighter', async ({ page }) => {
  await createNote(page, 'Keep')
  const keep = (await noteRow(page, 'Keep').getAttribute('data-note-id')) ?? ''
  // The new row's fade is held a quarter of the way in, however long the clicks below take.
  const held = page.evaluate((key) => {
    const g = globalThis as unknown as Win
    return new Promise<number>((done) => {
      const look = () => {
        const fresh = Array.from(g.document.querySelectorAll('.rows [data-note-id]')).find(
          (row) => row.getAttribute('data-note-id') !== key,
        )
        const fade = fresh
          ?.getAnimations()
          .find((a) => !('animationName' in a) && !('transitionProperty' in a))
        if (!fresh || !fade) return void g.requestAnimationFrame(look)
        fade.pause()
        fade.currentTime = Number(fade.effect?.getTiming().duration) / 4
        done(Number.parseFloat(g.getComputedStyle(fresh).opacity))
      }
      look()
    })
  }, keep)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const opacity = await held
  expect(opacity).toBeGreaterThan(0.1)
  expect(opacity).toBeLessThan(0.9)
  await expect(noteRows(page)).toHaveCount(2)
  await startSampling(page, 'rows', keep)
  await noteRows(page).first().click()
  await page.keyboard.press('Meta+Backspace')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(page.locator('[data-closing="row"]')).toHaveCount(0, { timeout: 10_000 })
  const ghosts = (await stopSampling(page))
    .map(([, ghost]) => ghost ?? -1)
    .filter((ghost) => ghost >= 0)
  expect(ghosts.length).toBeGreaterThan(0)
  for (const ghost of ghosts) expect(ghost).toBeLessThanOrEqual(opacity + 0.01)
})

const sectionToggle = '[aria-label="Collapse Status"], [aria-label="Expand Status"]'

test('a section clicked again while it closes opens again', async ({ page }) => {
  const toggle = page.locator(sectionToggle)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.evaluate(async (selector) => {
    const g = globalThis as unknown as Win
    g.document.querySelector(selector)?.click()
    await new Promise<void>((done) => g.setTimeout(done, 30))
    g.document.querySelector(selector)?.click()
  }, sectionToggle)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const list = (globalThis as unknown as Win).document.getElementById('statuses-list')
        return list ? list.getBoundingClientRect().height : 0
      }),
    )
    .toBeGreaterThan(40)
  await page.waitForTimeout(1500)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#statuses-list')).toBeVisible()
})

test('a section closed while it opens shrinks from where it is', async ({ page }) => {
  const toggle = page.locator(sectionToggle)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  const heights = await page.evaluate(async (selector) => {
    const g = globalThis as unknown as Win
    const frame = () => new Promise<void>((done) => g.requestAnimationFrame(() => done()))
    const list = () => g.document.getElementById('statuses-list')
    g.document.querySelector(selector)?.click()
    for (let i = 0; i < 12; i++) await frame()
    const seen = [list()?.getBoundingClientRect().height ?? -1]
    g.document.querySelector(selector)?.click()
    for (let i = 0; i < 600 && list(); i++) {
      await frame()
      seen.push(list()?.getBoundingClientRect().height ?? 0)
    }
    return seen
  }, sectionToggle)
  expect(heights[0]).toBeGreaterThan(0)
  for (let i = 1; i < heights.length; i++)
    expect(heights[i] ?? 0).toBeLessThanOrEqual((heights[i - 1] ?? 0) + 0.5)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

test('entering and leaving focus mode slides the note column from where it was', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await createNote(page, 'Quiet', 'The first line of the body')
  for (const pressed of ['true', 'false']) {
    await startSampling(page, 'column')
    await focusButton(page).click()
    await expect(focusButton(page)).toHaveAttribute('aria-pressed', pressed)
    await page.waitForTimeout(2500)
    const seen = await stopSampling(page)
    expectGlide(seen.map(([title]) => title ?? Number.NaN))
    expectGlide(seen.map(([, line]) => line ?? Number.NaN))
  }
})

test('with the readable width, hiding the sidebar slides the lines from where they were', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await createNote(page, 'Quiet', 'The first line of the body')
  await changeEditorSettingsElsewhere(page, { readableWidth: true })
  await expect(page.locator('.cm-content')).toHaveCSS('max-width', '740px')
  for (const name of ['Hide Sidebar', 'Show Sidebar']) {
    await startSampling(page, 'column')
    await page.getByRole('button', { name }).click()
    await page.waitForTimeout(2500)
    const seen = await stopSampling(page)
    expectGlide(seen.map(([, line]) => line ?? Number.NaN))
  }
})

/** The slide and fade duration at motion scale 5, and how fast either can go at most. */
const PANE_MS = 380 * 5
// The move curve is at most three times as steep as a straight line.
const OPACITY_PER_MS = 3.5 / PANE_MS
const PX_PER_MS = (3.5 * 600) / PANE_MS

test('entering focus mode while the sidebar still hides carries every pane on from where it is', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await createNote(page, 'Quiet')
  const hide = await page.getByRole('button', { name: 'Hide Sidebar' }).elementHandle()
  const focus = await focusButton(page).elementHandle()
  await startSampling(page, 'panes')
  // Both clicks from the page, timed by the animation clock, so a slow runner
  // still enters focus mode partway through the sidebar's fade.
  const toggle = await page.evaluate(
    async ([hideButton, focusToggle]) => {
      const g = globalThis as unknown as Win
      const doc = g.document
      const frame = () => new Promise<void>((done) => g.requestAnimationFrame(() => done()))
      const now = () => Number(doc.timeline.currentTime)
      const panes = () =>
        ['sidebar', 'list', 'content'].flatMap((pane) => {
          const el = doc.querySelector(`.window > .${pane}`)
          if (!el) return [Number.NaN, -1]
          return [
            el.getBoundingClientRect().left,
            Number.parseFloat(g.getComputedStyle(el).opacity),
          ]
        })
      const focused = () => doc.querySelector('.window[data-focus]') !== null
      ;(hideButton as unknown as Node).click()
      await frame()
      const hidden = now()
      while (now() - hidden < 300) await frame()
      const before = panes()
      const at = now()
      const clock = g.performance.now()
      ;(focusToggle as unknown as Node).click()
      for (let i = 0; i < 100 && !focused(); i++) await Promise.resolve()
      for (let i = 0; i < 20 && !focused(); i++) await frame()
      // WebKit may draw the moves at the clock's time before the animation time moves on.
      const after = panes()
      const elapsed = Math.max(now() - at, g.performance.now() - clock)
      return { before, after, elapsed, focused: focused() }
    },
    [hide, focus] as const,
  )
  expect(toggle.focused).toBe(true)
  const sidebarOpacity = toggle.before[1] ?? -1
  expect(sidebarOpacity).toBeGreaterThan(0.05)
  expect(sidebarOpacity).toBeLessThan(0.95)
  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(2500)
  const seen = await stopSampling(page)

  const expectCarriedOn = (was: number[], is: number[], ms: number) => {
    for (const pane of [0, 1, 2]) {
      const left = (s: number[]) => s[pane * 2] ?? Number.NaN
      const opacity = (s: number[]) => s[pane * 2 + 1] ?? -1
      expect(Math.abs(opacity(is) - opacity(was))).toBeLessThanOrEqual(0.01 + OPACITY_PER_MS * ms)
      if (opacity(was) > 0.01 && opacity(is) > 0.01)
        expect(Math.abs(left(is) - left(was))).toBeLessThanOrEqual(1 + PX_PER_MS * ms)
    }
  }
  expectCarriedOn(toggle.before, toggle.after, toggle.elapsed)
  for (let i = 1; i < seen.length; i++) {
    const was = seen[i - 1] ?? []
    const is = seen[i] ?? []
    const ms = Math.max((is[6] ?? 0) - (was[6] ?? 0), (is[7] ?? 0) - (was[7] ?? 0))
    expectCarriedOn(was, is, ms)
  }
})
