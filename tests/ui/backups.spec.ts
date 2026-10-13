import type { Page } from '@playwright/test'
import { expect, openApp, test, type TestWindow } from './fixtures'

const OLD = {
  id: 'devot-2026-10-08T09-00-00-000Z.sqlite',
  createdAt: Date.UTC(2026, 9, 8, 9),
  size: 250_000,
}
const NEW = {
  id: 'devot-2026-10-09T09-00-00-000Z.sqlite',
  createdAt: Date.UTC(2026, 9, 9, 9),
  size: 12_345_678,
}

async function open(page: Page, mocks: Record<string, unknown>) {
  await page.addInitScript((m) => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = m
  }, mocks)
  await openApp(page)
}

// The app listens for the menu event only once it has started; dispatching
// earlier loses the event (seen on slow CI runners).
const showBackups = async (page: Page) => {
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:show-backups'))
  })
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => (globalThis as unknown as TestWindow).devotIpcCalls.filter((call) => call.cmd === c),
    cmd,
  )

test('lists backups newest first with their sizes', async ({ page }) => {
  await open(page, { backups_list: { backups: [NEW, OLD], lastError: null } })
  await showBackups(page)
  const dialog = page.getByRole('dialog', { name: 'Backups' })
  await expect(dialog).toBeVisible()
  const rows = dialog.getByRole('listitem')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('12.3 MB')
  await expect(rows.nth(1)).toContainText('250 kB')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
})

test('says when there are no backups, and backs up on request', async ({ page }) => {
  await open(page, { backups_list: { backups: [], lastError: null }, backup_now: NEW })
  await showBackups(page)
  const dialog = page.getByRole('dialog', { name: 'Backups' })
  await expect(dialog.getByText('No backups yet.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Back Up Now' }).click()
  await expect.poll(async () => (await calls(page, 'backup_now')).length).toBe(1)
})

test('restoring asks first, then restores and reloads', async ({ page }) => {
  await open(page, { backups_list: { backups: [NEW, OLD], lastError: null }, backup_restore: null })
  await showBackups(page)
  const restore = page.getByRole('button', { name: /^Restore the backup from Oct 8, 2026/ })
  await restore.click()
  const confirm = page.getByRole('dialog', { name: /Restore the backup from Oct 8, 2026/ })
  await expect(confirm).toContainText('Devot backs them up first')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  expect(await calls(page, 'backup_restore')).toHaveLength(0)

  await page.evaluate(() => {
    ;(globalThis as unknown as { beforeReload?: boolean }).beforeReload = true
  })
  await restore.click()
  await page
    .getByRole('dialog', { name: /Restore the backup/ })
    .getByRole('button', { name: 'Restore' })
    .click()
  // The page reloads, so the call log starts over; the marker is gone.
  await expect
    .poll(() =>
      page.evaluate(() => (globalThis as unknown as { beforeReload?: boolean }).beforeReload),
    )
    .toBeUndefined()
  await expect(page.getByRole('dialog', { name: 'Backups' })).toBeHidden()
})

test('a failed restore keeps the dialog open with the code', async ({ page }) => {
  await open(page, {
    backups_list: { backups: [OLD], lastError: null },
    backup_restore: { error: 'E_BACKUP_RESTORE_FAILED' },
  })
  await showBackups(page)
  await page.getByRole('button', { name: /^Restore the backup from/ }).click()
  await page
    .getByRole('dialog', { name: /Restore the backup/ })
    .getByRole('button', { name: 'Restore' })
    .click()
  await expect(page.getByRole('alert')).toHaveText('The backup failed (E_BACKUP_RESTORE_FAILED).')
  expect(await calls(page, 'backup_restore')).toEqual([
    { cmd: 'backup_restore', args: { id: OLD.id } },
  ])
})

test('a failed automatic backup shows a notice that opens the backups', async ({ page }) => {
  await open(page, { backups_list: { backups: [OLD], lastError: 'E_BACKUP_SNAPSHOT_FAILED' } })
  const notice = page.getByRole('alert')
  await expect(notice).toHaveText(/The automatic backup failed \(E_BACKUP_SNAPSHOT_FAILED\)/)
  await notice.getByRole('button', { name: 'Show Backups' }).click()
  await expect(page.getByRole('dialog', { name: 'Backups' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Backups' }).getByRole('alert')).toContainText(
    'E_BACKUP_SNAPSHOT_FAILED',
  )
})

test('a failure while the window is open shows the notice; Dismiss hides it', async ({ page }) => {
  await open(page, { backups_list: { backups: [], lastError: null } })
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: string }) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:backup-failed', { detail: 'E_BACKUP_DIR' }))
  })
  const notice = page.getByRole('alert')
  await expect(notice).toContainText('E_BACKUP_DIR')
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toBeHidden()
})

test('stays open through repeated Escapes while busy, then closes', async ({ page }) => {
  await page.addInitScript((backup) => {
    const w = globalThis as unknown as TestWindow & { releaseBackup?: () => void }
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    w.releaseBackup = () => release()
    w.devotIpcMocks = {
      backups_list: { backups: [], lastError: null },
      backup_now: async () => {
        await held
        return backup
      },
    }
  }, NEW)
  await openApp(page)
  await showBackups(page)
  const dialog = page.getByRole('dialog', { name: 'Backups' })
  await dialog.getByRole('button', { name: 'Back Up Now' }).click()
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeDisabled()
  // WebKit lets a page refuse Escape only a few times, then closes the
  // dialog anyway; it must stay up while a backup runs.
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
  }
  await page.evaluate(() => (globalThis as unknown as { releaseBackup(): void }).releaseBackup())
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // It opens again from the menu.
  await showBackups(page)
  await expect(dialog).toBeVisible()
})

test('the Backups menu key acts on nothing here while another window has the keyboard', async ({
  page,
}) => {
  await open(page, { backups_list: { backups: [NEW], lastError: null } })
  const focus = (on: boolean) =>
    page.evaluate((v) => {
      ;(globalThis as unknown as { document: { hasFocus(): boolean } }).document.hasFocus = () => v
    }, on)
  await focus(false)
  await showBackups(page)
  await page.waitForTimeout(150)
  await expect(page.getByRole('dialog', { name: 'Backups' })).toBeHidden()
  await focus(true)
  await showBackups(page)
  await expect(page.getByRole('dialog', { name: 'Backups' })).toBeVisible()
})
