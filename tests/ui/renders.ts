import type { Page } from '@playwright/test'

// Render counting through the hook React offers its developer tools. A component counts as rendered in a commit
// when its fiber holds props or hook state not seen before; a skipped component keeps the old ones. Components are
// found by function name, which the UI tests' build keeps (vite.ui-test.config.ts).

/** Counts renders of the named components (by function name) from the next page load on. Call before `page.goto`. */
export async function countRenders(page: Page, names: readonly string[]): Promise<void> {
  await page.addInitScript((watched) => {
    const w = window
    w.devotRenders = Object.fromEntries(watched.map((name) => [name, 0]))
    w.devotRendered = []
    w.devotNoteWrites = 0
    const storage = Storage.prototype
    const setItem = storage.setItem
    storage.setItem = function (this: Storage, key: string, value: string) {
      if (key === 'devot.test.notes') w.devotNoteWrites += 1
      return setItem.call(this, key, value)
    }
    type Fiber = {
      type: unknown
      memoizedProps: unknown
      memoizedState: unknown
      child: Fiber | null
      sibling: Fiber | null
    }
    const watchedNames = new Set(watched)
    const seen = new WeakSet<object>()
    const fresh = (value: unknown) =>
      typeof value === 'object' && value !== null && !seen.has(value)
    const remember = (value: unknown) => {
      if (typeof value === 'object' && value !== null) seen.add(value)
    }
    w['__REACT_DEVTOOLS_GLOBAL_HOOK__'] = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject() {
        return 1
      },
      checkDCE() {},
      onScheduleFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        const stack: Fiber[] = [root.current]
        while (stack.length > 0) {
          const fiber = stack.pop()!
          if (fiber.sibling) stack.push(fiber.sibling)
          if (fiber.child) stack.push(fiber.child)
          const type = fiber.type as { name?: string } | null
          const name = typeof type === 'function' ? type.name : undefined
          if (name === undefined || !watchedNames.has(name)) continue
          if (!w.devotRendered.includes(name)) w.devotRendered.push(name)
          if (fresh(fiber.memoizedProps) || fresh(fiber.memoizedState)) {
            w.devotRenders[name] = (w.devotRenders[name] ?? 0) + 1
          }
          remember(fiber.memoizedProps)
          remember(fiber.memoizedState)
        }
      },
    }
  }, names)
}

/** Fails for a watched component no commit has shown, whose count would read 0 for a name the build lost. */
export async function renderCounts(
  page: Page,
): Promise<{ renders: Record<string, number>; writes: number }> {
  const { renders, rendered, writes } = await page.evaluate(() => {
    const w = window
    return { renders: { ...w.devotRenders }, rendered: w.devotRendered, writes: w.devotNoteWrites }
  })
  const unseen = Object.keys(renders).filter((name) => !rendered.includes(name))
  if (unseen.length > 0) throw new Error(`E_TEST_RENDERS_UNSEEN: ${unseen.join(', ')}`)
  return { renders, writes }
}

export function resetRenderCounts(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window
    for (const name of Object.keys(w.devotRenders)) w.devotRenders[name] = 0
    w.devotNoteWrites = 0
  })
}

/** Stores `count` notes in the test storage, "Note 1" the newest, then reloads and waits for the list. */
export async function seedNotes(page: Page, count: number): Promise<void> {
  await page.goto('/')
  await page.evaluate((n) => {
    const start = Date.now() - 60_000
    const notes = Array.from({ length: n }, (_, i) => ({
      id: `0192a6f0-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
      title: `Note ${i + 1}`,
      titleHlc: '',
      bodyMd: '',
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
  }, count)
  await page.reload()
}
