// The window marks itself ready (`data-ready` on `.window`) once its lists
// have loaded and its last state is restored. Every listener the window adds
// in an effect is added by then, so a test that acts at that moment is heard;
// before it, a key or an event can be lost. `openApp` and `reloadApp` wait
// for the mark.
import { expect, openApp, reloadApp, test } from './fixtures'

const READY = '.window[data-ready]'

/** Records, in the page, what the window looked like when it first showed and became ready. */
const WATCH = () => {
  const w = globalThis as unknown as {
    document: {
      querySelector(s: string): { hasAttribute(n: string): boolean } | null
    }
    MutationObserver: new (cb: () => void) => {
      observe(n: unknown, o: Record<string, boolean>): void
    }
    dispatchEvent(e: unknown): void
    CustomEvent: new (t: string) => unknown
    devotWatch: { shownBeforeReady?: boolean; readyAt?: number }
  }
  w.devotWatch = {}
  new w.MutationObserver(() => {
    const el = w.document.querySelector('.window')
    if (!el) return
    if (w.devotWatch.shownBeforeReady === undefined) {
      w.devotWatch.shownBeforeReady = !el.hasAttribute('data-ready')
    }
    if (el.hasAttribute('data-ready') && w.devotWatch.readyAt === undefined) {
      w.devotWatch.readyAt = 1
      // The first thing a test does: an event the window listens for.
      w.dispatchEvent(new w.CustomEvent('devot:toggle-sidebar'))
    }
  }).observe(w.document, { subtree: true, childList: true, attributes: true })
}

test('the window is ready only after it showed, and hears an event sent the moment it is ready', async ({
  page,
}) => {
  await page.addInitScript(WATCH)
  await page.goto('/')
  await expect(page.locator(READY)).toHaveCount(1)
  // The sidebar toggled by the event the moment the mark appeared.
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeHidden()
  const watched = await page.evaluate(
    () =>
      (globalThis as unknown as { devotWatch: { shownBeforeReady?: boolean } }).devotWatch
        .shownBeforeReady,
  )
  expect(watched).toBe(true)
})

test('openApp and reloadApp return with the window ready', async ({ page }) => {
  await openApp(page)
  await expect(page.locator(READY)).toHaveCount(1)
  await page.evaluate(() => {
    const w = globalThis as unknown as { devotMarker?: boolean }
    w.devotMarker = true
  })
  await reloadApp(page)
  await expect(page.locator(READY)).toHaveCount(1)
  // A fresh page: the marker of the old one is gone.
  expect(
    await page.evaluate(() => (globalThis as unknown as { devotMarker?: boolean }).devotMarker),
  ).toBeUndefined()
})
