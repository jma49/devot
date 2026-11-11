import type { Page } from '@playwright/test'
import { expect } from './fixtures'

const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const modes = (page: Page) => page.getByRole('group', { name: 'View mode' })
const writeButton = (page: Page) =>
  page.locator('.editor-toolbar').getByRole('button', { name: 'Write Mode', exact: true })

const runCommand = (page: Page, id: string) =>
  page.evaluate(
    (detail) => {
      const w = window
      w.dispatchEvent(new w.CustomEvent('devot:open-url', { detail }))
    },
    { kind: 'command', id },
  )

/**
 * Runs `check` on a note open in Write mode while Edit mode shows its Markdown, every mark of it,
 * then brings Write mode back. The modes are switched by a command, so the keyboard stays in the
 * editor.
 *
 * The editor's lines follow the Edit button by a frame or more: a table's delimiter row came back
 * after its other rows on CI. So `check` gets a reader to poll, never the lines read once.
 */
export async function inEditMode(
  page: Page,
  check: (read: () => Promise<string[]>) => Promise<void>,
): Promise<void> {
  await runCommand(page, 'view.edit')
  await expect(modes(page).getByRole('button', { pressed: true })).toHaveAccessibleName('Edit')
  await check(() => lines(page))
  await runCommand(page, 'view.write')
  await expect(writeButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(modes(page).getByRole('button', { pressed: true })).toHaveCount(0)
}

/** Waits for the note's Markdown to be `expected`, line for line. */
export const expectSource = (page: Page, expected: readonly string[]) =>
  inEditMode(page, (read) => expect.poll(read).toEqual(expected))
