import type { Page } from '@playwright/test'

// Render counting through the hook React offers its developer tools. A component counts as rendered in a commit
// when its fiber holds props or hook state not seen before; a skipped component keeps the old ones.

interface RenderWindow {
  devotRenders: Record<string, number>
  devotNoteWrites: number
}

/** Counts renders of the named components (function names, as the dev server keeps them) from the next page load on. Call before `page.goto`. */
export async function countRenders(page: Page, names: readonly string[]): Promise<void> {
  await page.addInitScript((watched) => {
    const w = globalThis as unknown as RenderWindow & Record<string, unknown>
    w.devotRenders = Object.fromEntries(watched.map((name) => [name, 0]))
    w.devotNoteWrites = 0
    const storage = (globalThis as unknown as { Storage: { prototype: Record<string, unknown> } })
      .Storage.prototype
    const setItem = storage['setItem'] as (this: unknown, key: string, value: string) => void
    storage['setItem'] = function (this: unknown, key: string, value: string) {
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

export function renderCounts(
  page: Page,
): Promise<{ renders: Record<string, number>; writes: number }> {
  return page.evaluate(() => {
    const w = globalThis as unknown as RenderWindow
    return { renders: { ...w.devotRenders }, writes: w.devotNoteWrites }
  })
}

export function resetRenderCounts(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = globalThis as unknown as RenderWindow
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
