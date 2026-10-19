import type { Page } from '@playwright/test'
import {
  changeMirrorElsewhere,
  expect,
  openApp,
  openSettings,
  test,
  type MockMirror,
  type TestWindow,
} from './fixtures'

const ON: Partial<MockMirror> = { folder: '~/Notes', generation: 1, size: 12_345_678 }

const section = (page: Page) => page.getByRole('region', { name: 'Markdown Mirror' }).first()
const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )
const setPick = (page: Page, pick: { folder: string; name: string; empty: boolean } | null) =>
  page.evaluate((p) => {
    ;(globalThis as unknown as TestWindow).devotMirrorPick = p
  }, pick)

async function openWith(page: Page, path: string, mirror?: Partial<MockMirror>) {
  if (mirror) {
    await page.addInitScript((m) => {
      ;(globalThis as unknown as TestWindow).devotMirror = {
        revision: 0,
        generation: 0,
        folder: null,
        includeAttachments: true,
        paused: null,
        size: 0,
        kept: [],
        keptCount: 0,
        ...m,
      }
    }, mirror)
  }
  if (path === '/settings.html') await openSettings(page, 'Mirror')
  // A key pressed before the window is ready (Cmd+K for the palette) is lost.
  else await openApp(page, path)
}

test.describe('Settings > Markdown Mirror', () => {
  test('is off by default; an empty folder turns it on and shows the folder and its size', async ({
    page,
  }) => {
    await openWith(page, '/settings.html')
    await expect(
      section(page).getByRole('heading', { name: 'Markdown Mirror' }).first(),
    ).toBeVisible()
    await expect(section(page)).toContainText('The mirror is off.')
    await expect(section(page)).toContainText('edits made there are not read back')
    await expect(section(page).getByRole('switch', { name: 'Include Attachments' })).toBeChecked()
    await expect(section(page).getByRole('button', { name: 'Turn Off' })).toHaveCount(0)

    await section(page).getByRole('button', { name: 'Choose Folder…' }).click()
    await expect(section(page)).toContainText('The mirror is off.')

    await setPick(page, { folder: '~/Notes', name: 'Notes', empty: true })
    await section(page).getByRole('button', { name: 'Choose Folder…' }).click()
    await expect(section(page)).toContainText('~/Notes')
    await expect(section(page)).toContainText('Size on disk: 0 kB')
    await expect(section(page).getByRole('button', { name: 'Turn Off' })).toBeVisible()
    expect(await calls(page, 'mirror_choose')).toHaveLength(2)
    expect(await calls(page, 'mirror_confirm')).toHaveLength(0)
  })

  test('uses a folder that is not empty only once the user agrees', async ({ page }) => {
    await openWith(page, '/settings.html')
    await setPick(page, { folder: '~/Documents', name: 'Documents', empty: false })
    const choose = section(page).getByRole('button', { name: 'Choose Folder…' })
    const dialog = page.getByRole('dialog', { name: 'Use “Documents” for the Markdown mirror?' })

    await choose.click()
    await expect(dialog).toContainText('never changes or deletes a file it did not write')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(section(page)).toContainText('The mirror is off.')
    expect(await calls(page, 'mirror_confirm')).toHaveLength(0)

    await choose.click()
    await dialog.getByRole('button', { name: 'Use Folder' }).click()
    await expect(section(page)).toContainText('~/Documents')
    expect(await calls(page, 'mirror_confirm')).toEqual([{ token: 7 }])
  })

  test('Include Attachments and Turn Off store their change at once', async ({ page }) => {
    await openWith(page, '/settings.html', ON)
    await expect(section(page)).toContainText('~/Notes')
    await expect(section(page)).toContainText('Size on disk: 12.3 MB')
    const include = section(page).getByRole('switch', { name: 'Include Attachments' })
    await include.uncheck()
    await expect(include).not.toBeChecked()
    await section(page).getByRole('button', { name: 'Turn Off' }).click()
    await expect(section(page)).toContainText('The mirror is off.')
    expect(await calls(page, 'mirror_set')).toEqual([
      { patch: { includeAttachments: false } },
      { patch: { turnOff: true } },
    ])
  })

  test('shows no size until the mirror has read its folder', async ({ page }) => {
    await openWith(page, '/settings.html', { ...ON, size: null })
    await expect(section(page)).toContainText('~/Notes')
    await expect(section(page)).not.toContainText('Size on disk')
    await changeMirrorElsewhere(page, { size: 52_000_000 })
    await expect(section(page)).toContainText('Size on disk: 52 MB')
  })

  test('Turn Off pressed from the keyboard leaves the keyboard on Choose Folder…', async ({
    page,
  }) => {
    await openWith(page, '/settings.html', ON)
    await section(page).getByRole('button', { name: 'Turn Off' }).focus()
    await page.keyboard.press('Space')
    await expect(section(page)).toContainText('The mirror is off.')
    await expect(section(page).getByRole('button', { name: 'Choose Folder…' })).toBeFocused()
  })

  test('shows a pause, and changes made in the other window, as they happen', async ({ page }) => {
    await openWith(page, '/settings.html', ON)
    await expect(section(page)).toContainText('~/Notes')
    await changeMirrorElsewhere(page, { paused: 'E_MIRROR_FOLDER_MISSING', size: 2_500 })
    await expect(section(page).getByRole('alert')).toHaveText(
      'The mirror is paused: its folder is missing (E_MIRROR_FOLDER_MISSING). It resumes once the folder is back.',
    )
    await expect(section(page)).toContainText('Size on disk: 3 kB')
    await changeMirrorElsewhere(page, { paused: null, folder: '/Volumes/Disk/Notes' })
    await expect(section(page).getByRole('alert')).toHaveCount(0)
    await expect(section(page)).toContainText('/Volumes/Disk/Notes')
  })

  test('says why a folder could not be used', async ({ page }) => {
    await page.addInitScript(() => {
      ;(globalThis as unknown as TestWindow).devotIpcMocks = {
        mirror_choose: { error: 'E_MIRROR_FOLDER_READ_ONLY' },
      }
    })
    await openWith(page, '/settings.html')
    await section(page).getByRole('button', { name: 'Choose Folder…' }).click()
    await expect(section(page).getByRole('alert')).toHaveText(
      'The folder could not be used (E_MIRROR_FOLDER_READ_ONLY).',
    )
    await expect(section(page)).toContainText('The mirror is off.')
  })
})

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const paletteField = (page: Page) =>
  palette(page).getByRole('combobox', { name: 'Command Palette' })
const commandOptions = (page: Page) =>
  palette(page).getByRole('listbox', { name: 'Results' }).getByRole('group', { name: 'Commands' })
const notices = (page: Page) => page.locator('.notices [role="alert"]')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const applied = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as TestWindow).devotMirrorApplied ?? [])

async function runCommand(page: Page, query: string, label: string) {
  await page.keyboard.press('Meta+KeyK')
  await expect(paletteField(page)).toBeFocused()
  await paletteField(page).fill(query)
  await commandOptions(page).getByRole('option', { name: label }).click()
}

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRows(page).filter({ hasText: title })).toHaveCount(1)
}

test.describe('the main window', () => {
  test('the palette chooses a folder (asking first) and turns the mirror off', async ({ page }) => {
    await openWith(page, '/')
    await page.keyboard.press('Meta+KeyK')
    await paletteField(page).fill('mirror')
    await expect(commandOptions(page).getByRole('option')).toHaveText([
      /^Choose Markdown Mirror Folder…/,
    ])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    await setPick(page, { folder: '~/Documents', name: 'Documents', empty: false })
    await runCommand(page, 'mirror folder', 'Choose Markdown Mirror Folder…')
    const dialog = page.getByRole('dialog', { name: 'Use “Documents” for the Markdown mirror?' })
    await dialog.getByRole('button', { name: 'Use Folder' }).click()
    await expect(dialog).toBeHidden()
    expect(await calls(page, 'mirror_confirm')).toEqual([{ token: 7 }])

    await runCommand(page, 'turn off mirror', 'Turn Off Markdown Mirror')
    expect(await calls(page, 'mirror_set')).toEqual([{ patch: { turnOff: true } }])
    await page.keyboard.press('Meta+KeyK')
    await paletteField(page).fill('mirror')
    await expect(commandOptions(page).getByRole('option')).toHaveText([
      /^Choose Markdown Mirror Folder…/,
    ])
  })

  test('says what could not be done: a folder used, or the mirror turned off', async ({ page }) => {
    await page.addInitScript(() => {
      ;(globalThis as unknown as TestWindow).devotIpcMocks = {
        mirror_choose: { error: 'E_MIRROR_FOLDER_READ_ONLY' },
        mirror_set: { error: 'E_MIRROR_SETTINGS_WRITE_FAILED' },
      }
    })
    await openWith(page, '/', ON)
    await runCommand(page, 'mirror folder', 'Choose Markdown Mirror Folder\u2026')
    await expect(notices(page)).toContainText(
      'The folder could not be used (E_MIRROR_FOLDER_READ_ONLY).',
    )
    await runCommand(page, 'turn off mirror', 'Turn Off Markdown Mirror')
    await expect(notices(page)).toContainText(
      'The mirror setting could not be saved (E_MIRROR_SETTINGS_WRITE_FAILED).',
    )
  })

  test('a pause and files kept because they were edited outside show as notices', async ({
    page,
  }) => {
    await openWith(page, '/', ON)
    await changeMirrorElsewhere(page, { paused: 'E_MIRROR_FOLDER_READ_ONLY' })
    await expect(notices(page)).toHaveText([
      'The mirror is paused: its folder cannot be written (E_MIRROR_FOLDER_READ_ONLY). It resumes once it can.Dismiss',
    ])
    await changeMirrorElsewhere(page, { paused: null })
    await expect(notices(page)).toHaveCount(0)

    const kept = [
      'Work/Plan (edited outside Devot).md',
      'Inbox (edited outside Devot).md',
      'attachments/board (edited outside Devot).png',
      'Ideas (edited outside Devot).md',
      'Todo (edited outside Devot).md',
    ]
    await changeMirrorElsewhere(page, { kept, keptCount: kept.length })
    const notice = notices(page)
    await expect(notice).toContainText(
      '5 files edited outside Devot were kept under new names: Work/Plan (edited outside Devot).md, Inbox (edited outside Devot).md, attachments/board (edited outside Devot).png, and 2 more.',
    )
    await notice.getByRole('button', { name: 'Dismiss' }).click()
    await expect(notices(page)).toHaveCount(0)
    expect(await calls(page, 'mirror_set')).toEqual([{ patch: { dismissKept: true } }])
  })

  test("a pass's failures reach the log by code", async ({ page }) => {
    await page.addInitScript(() => {
      ;(globalThis as unknown as TestWindow).devotIpcMocks = {
        mirror_apply: (args: unknown) =>
          ((args as { ops: unknown[] }).ops ?? []).map(() => ({ code: 'E_MIRROR_WRITE_FAILED' })),
      }
    })
    await openWith(page, '/', ON)
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    await titleField(page).fill('Plan')
    await expect
      .poll(() => calls(page, 'log_write'), { timeout: 15_000 })
      .toContainEqual({ level: 'warn', code: 'W_MIRROR_FAILED', ids: ['E_MIRROR_WRITE_FAILED'] })
  })

  test('starts once the window has restored its note, then one edit writes that note alone', async ({
    page,
  }) => {
    await openWith(page, '/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await createNote(page, 'Plan')
    await body(page).click()
    await page.keyboard.type('First line.')
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('devot.test.notes') ?? ''))
      .toContain('First line.')

    await page.addInitScript(() => {
      ;(globalThis as unknown as TestWindow).devotMirror = {
        revision: 0,
        generation: 1,
        folder: '~/Notes',
        includeAttachments: true,
        paused: null,
        size: 0,
        kept: [],
        keptCount: 0,
      }
    })
    await page.reload()
    await expect(titleField(page)).toHaveValue('Plan')
    // The first pass waits a moment after the restore.
    expect(await calls(page, 'mirror_open')).toEqual([])
    await expect
      .poll(() => applied(page), { timeout: 10_000 })
      .toEqual([expect.objectContaining({ kind: 'note', path: 'Plan.md', text: 'First line.' })])
    await expect(titleField(page)).toHaveValue('Plan')

    await body(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(' More.')
    await expect
      .poll(() => applied(page), { timeout: 10_000 })
      .toEqual([
        expect.objectContaining({ kind: 'note', path: 'Plan.md' }),
        expect.objectContaining({ kind: 'note', path: 'Plan.md', text: 'First line. More.' }),
      ])
  })
})
