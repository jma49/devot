import type { Page } from '@playwright/test'
import type { NoteSummary } from '../../src/core/storage'

// Without the native screens the phone page has no tab bar or lists (docs/specs/iphone-screens.md,
// Install and the kill switch); UI tests reach its remaining screens through its test driver.

type PhoneTab = 'notes' | 'library' | 'activity' | 'settings'

interface PhoneTestDriver {
  showTab(tab: PhoneTab): void
  openNote(noteId: string): void
  notes(): readonly NoteSummary[]
}

type Driven = { devotPhone?: PhoneTestDriver }

export async function showPhoneTab(page: Page, tab: PhoneTab): Promise<void> {
  await page.waitForFunction(() => (globalThis as Driven).devotPhone !== undefined)
  await page.evaluate((shown) => (globalThis as Driven).devotPhone!.showTab(shown), tab)
}

/** Opens the note with this title, or the newest note neither pinned nor completed. */
export async function openPhoneNote(page: Page, title?: string): Promise<void> {
  await page.waitForFunction((wanted) => {
    const notes = (globalThis as Driven).devotPhone?.notes() ?? []
    return wanted === undefined ? notes.length > 0 : notes.some((n) => n.title === wanted)
  }, title)
  await page.evaluate((wanted) => {
    const phone = (globalThis as Driven).devotPhone!
    const newestFirst = [...phone.notes()].sort(
      (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    const note =
      wanted === undefined
        ? newestFirst.find((n) => !n.pinned && n.status !== 'completed')
        : newestFirst.find((n) => n.title === wanted)
    phone.openNote(note!.id)
  }, title)
}
