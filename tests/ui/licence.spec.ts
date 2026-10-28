import type { Page } from '@playwright/test'
import { expect, openApp, openSettings, pickMenuItem, test, type TestWindow } from './fixtures'

// The licence: Settings > Licence, what sync and AI show while it is missing, and devot://licence
// links. Rust is faked in the page: it keeps one licence and answers as the real commands do,
// never with the key.

const KEY = 'devot1.eyJpZCI6IngifQ.c2lnbmF0dXJl'
const OTHER_KEY = 'devot1.eyJpZCI6InkifQ.b3RoZXI'
const BAD_KEY = 'devot1.eyJpZCI6InoifQ.YmFk'
const ID = '5vEvzHainWD0cA2Ht_ljHg'
const OTHER_ID = '3f4lHWhFWnUPeDt7yIa3rw'

type Licence = Record<string, unknown>

/** No licence, the trial over. */
const none = (gated = true): Licence => ({
  gated,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: gated ? { state: 'ended', endsAt: 1_790_000_000_000, code: null } : null,
})

const inTrial = (): Licence => ({
  ...none(),
  trial: { state: 'running', endsAt: Date.now() + 50 * 3_600_000, code: null },
})

const held = (state: string, id = ID): Licence => ({
  gated: true,
  state,
  code: null,
  id,
  licensee: 'buyer@example.com',
  plan: 'pro',
  trial: { state: 'ended', endsAt: 1_790_000_000_000, code: null },
})

/** `added` is what `licence_set` makes of any key but BAD_KEY. */
async function fakeRust(page: Page, initial: Licence, added: Licence = held('valid')) {
  await page.addInitScript(
    ([start, next, bad]) => {
      const w = globalThis as unknown as TestWindow
      let licence = start
      w.devotIpcMocks = {
        ...w.devotIpcMocks,
        licence_get: () => licence,
        licence_set: (args: { key: string }) => {
          if (args.key.trim() === bad) throw 'E_LICENCE_SIGNATURE'
          licence = next
          return licence
        },
        licence_remove: () => {
          licence = { ...licence, state: 'none', id: null, licensee: null }
          return licence
        },
        open_external: () => null,
      }
    },
    [initial, added, BAD_KEY] as const,
  )
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

test.describe('Settings > Licence', () => {
  test('adds a pasted key, shows who it is for and removes it after asking', async ({ page }) => {
    await fakeRust(page, none())
    await openSettings(page, 'Licence')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText('Devot works fully for a three-day trial')
    await expect(panel).toContainText('No licence is added.')
    await expect(panel).toContainText('The trial has ended, so notes are read-only')
    const field = panel.getByRole('textbox', { name: 'Licence Key' })
    const add = panel.getByRole('button', { name: 'Add Licence' })
    const remove = panel.getByRole('button', { name: 'Remove Licence…' })
    await expect(add).toBeDisabled()
    await expect(remove).toBeDisabled()

    // Rust drops the spaces a mail client wrapped the key in.
    await field.fill(`  ${KEY} `)
    await add.click()
    expect(await calls(page, 'licence_set')).toEqual([{ key: `  ${KEY} ` }])
    await expect(field).toHaveValue('')
    await expect(panel).toContainText('Editing, sync and AI are unlocked on this device.')
    await expect(panel).not.toContainText('The trial has ended')
    await expect(panel).toContainText('buyer@example.com')
    await expect(panel).toContainText(ID)
    await expect(panel).not.toContainText('Updates Until')
    await expect(panel.getByRole('button', { name: 'Replace Licence' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Buy a Licence' })).toHaveCount(0)

    await remove.click()
    const dialog = page.getByRole('dialog', { name: 'Remove the licence from this device?' })
    await expect(dialog).toContainText('sync and AI stop until you add a licence again')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    expect(await calls(page, 'licence_remove')).toEqual([])
    await remove.click()
    await dialog.getByRole('button', { name: 'Remove Licence' }).click()
    expect(await calls(page, 'licence_remove')).toHaveLength(1)
    await expect(panel).toContainText('No licence is added.')
    await expect(panel).not.toContainText('buyer@example.com')
  })

  test('refuses a key that does not verify, with the reason and the code', async ({ page }) => {
    await fakeRust(page, none())
    await openSettings(page, 'Licence')
    const panel = page.getByRole('tabpanel')
    await panel.getByRole('textbox', { name: 'Licence Key' }).fill(BAD_KEY)
    await panel.getByRole('textbox', { name: 'Licence Key' }).press('Enter')
    await expect(panel.getByRole('alert')).toHaveText(
      'The key could not be added. Its signature does not match, so it was changed after it was issued. (E_LICENCE_SIGNATURE)',
    )
    await expect(panel.getByRole('textbox', { name: 'Licence Key' })).toHaveValue(BAD_KEY)
  })

  test('opens the Buy page, also for a revoked licence', async ({ page }) => {
    await fakeRust(page, none())
    await openSettings(page, 'Licence')
    const panel = page.getByRole('tabpanel')
    await panel.getByRole('button', { name: 'Buy a Licence' }).click()
    expect(await calls(page, 'open_external')).toEqual([
      { url: 'https://licence.devot.online/buy' },
    ])

    await fakeRust(page, held('revoked'))
    await page.reload()
    await page.getByRole('tab', { name: 'Licence', exact: true }).click()
    await expect(panel).toContainText('This licence was revoked after a refund or a lost dispute')
    await expect(panel.getByRole('button', { name: 'Renew' })).toHaveCount(0)
    await panel.getByRole('button', { name: 'Buy a Licence' }).click()
    expect(await calls(page, 'open_external')).toEqual([
      { url: 'https://licence.devot.online/buy' },
    ])
  })

  test('says why a licence on this device is locked', async ({ page }) => {
    await fakeRust(page, { ...none(), state: 'invalid', code: 'E_LICENCE_UNKNOWN_KID' })
    await openSettings(page, 'Licence')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText(
      'The licence on this device could not be verified (E_LICENCE_UNKNOWN_KID)',
    )
    await expect(panel.getByRole('button', { name: 'Buy a Licence' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Remove Licence…' })).toBeEnabled()
  })

  test('says when this build checks no licence', async ({ page }) => {
    await openSettings(page, 'Licence')
    await expect(page.getByRole('tabpanel')).toContainText(
      'This build of Devot does not check licences, so everything works without one.',
    )
  })
})

test.describe('locked sync and AI', () => {
  test('Settings > Sync and AI say the trial has ended and a licence is needed, with Buy', async ({
    page,
  }) => {
    await fakeRust(page, none())
    await openSettings(page, 'Sync')
    const sync = page.getByRole('tabpanel')
    await expect(sync).toContainText(
      'Your trial has ended, and sync needs a Devot licence. Add one in Settings > Licence.',
    )
    await sync.getByRole('textbox', { name: 'Join With a Code' }).fill('0400')
    await expect(sync.getByRole('button', { name: 'Join With a Code' })).toBeDisabled()
    await sync.getByRole('button', { name: 'Buy a Licence' }).click()
    expect(await calls(page, 'open_external')).toEqual([
      { url: 'https://licence.devot.online/buy' },
    ])
    await page.getByRole('tab', { name: 'AI', exact: true }).click()
    await expect(page.getByRole('tabpanel')).toContainText(
      'Your trial has ended, and AI needs a Devot licence. Add one in Settings > Licence.',
    )
  })

  test('nothing is locked while the trial runs', async ({ page }) => {
    await fakeRust(page, inTrial())
    await openSettings(page, 'Sync')
    await expect(page.getByRole('tabpanel')).toContainText('Relay')
    await expect(page.getByRole('tabpanel')).not.toContainText('needs a Devot licence')
    await page.getByRole('tab', { name: 'AI', exact: true }).click()
    await expect(page.getByRole('tabpanel')).not.toContainText('needs a Devot licence')
  })

  test('nothing is locked with a valid licence, or in a build that gates nothing', async ({
    page,
  }) => {
    await openSettings(page, 'Sync')
    await expect(page.getByRole('tabpanel')).toContainText('Relay')
    await expect(page.getByRole('tabpanel')).not.toContainText('needs a Devot licence')
    await fakeRust(page, held('valid'))
    await page.reload()
    await page.getByRole('tab', { name: 'AI', exact: true }).click()
    await expect(page.getByRole('tabpanel')).toContainText('Provider')
    await expect(page.getByRole('tabpanel')).not.toContainText('needs a Devot licence')
  })

  test('Edit with AI says a licence is needed when Rust refuses it', async ({ page }) => {
    await fakeRust(page, inTrial())
    await page.addInitScript(() => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcMocks = {
        ...w.devotIpcMocks,
        ai_generate: { error: 'E_LICENCE_REQUIRED' },
      }
    })
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.getByRole('button', { name: 'New Notebook' }).click()
    await page.getByRole('textbox', { name: 'Notebook name' }).fill('Work')
    await page.getByRole('textbox', { name: 'Notebook name' }).press('Enter')
    const work = page
      .getByRole('tree', { name: 'Notebooks' })
      .getByRole('treeitem', { name: /^Work\b/ })
      .locator('> .book-row')
    await work.click({ button: 'right' })
    await pickMenuItem(page, 'Allow AI Access')
    await work.click()
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.insertText('Teh first draft.')
    await page.locator('.cm-line').first().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Shift+Home')
    await page
      .getByRole('toolbar', { name: 'Format' })
      .getByRole('button', { name: 'Edit with AI' })
      .click()
    await pickMenuItem(page, 'Proofread')
    const sheet = page.getByRole('dialog', { name: /^Edit with AI/ })
    await expect(sheet.getByRole('alert')).toContainText(
      'AI needs a Devot licence. Add one in Settings > Licence.',
    )
    await sheet.getByRole('button', { name: 'Buy a Licence' }).click()
    expect(await calls(page, 'open_external')).toEqual([
      { url: 'https://licence.devot.online/buy' },
    ])
    await expect(sheet.getByRole('button', { name: 'Try Again' })).toHaveCount(0)
  })

  test('the main window says sync stopped for want of a licence, with Buy', async ({ page }) => {
    await fakeRust(page, none())
    await page.addInitScript(() => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcMocks = {
        ...w.devotIpcMocks,
        sync_get: {
          relayUrl: 'https://relay.example.com',
          enabled: true,
          vault: true,
          enrolled: true,
          status: { state: 'stopped', lastSync: null, code: 'E_LICENCE_REQUIRED', tooLarge: 0 },
        },
      }
    })
    await openApp(page)
    const notice = page.getByRole('alert').filter({ hasText: 'Sync has stopped' })
    await expect(notice).toContainText('your trial has ended, and sync needs a Devot licence')
    await notice.getByRole('button', { name: 'Buy a Licence' }).click()
    expect(await calls(page, 'open_external')).toEqual([
      { url: 'https://licence.devot.online/buy' },
    ])
  })
})

test.describe('the read-only library', () => {
  test('an empty list says notes are read-only, not to create one with a disabled button', async ({
    page,
  }) => {
    await fakeRust(page, none())
    await openApp(page)
    await expect(page.getByText('No Notes Yet')).toBeVisible()
    await expect(page.getByText('Notes are read-only until you add a licence.')).toBeVisible()
    await expect(page.getByText('Create a note with the New Note button.')).toHaveCount(0)

    await page
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: /^Templates/ })
      .click()
    await expect(page.getByText('No Templates Yet')).toBeVisible()
    await expect(page.getByText('Templates are read-only until you add a licence.')).toBeVisible()
    await expect(page.getByText('Create one with the New Template button.')).toHaveCount(0)
  })
})

test.describe('the read-only library', () => {
  test('a built-in template cannot be made into a note while the trial is over', async ({
    page,
  }) => {
    await fakeRust(page, none())
    await openApp(page)
    const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
    await sidebar.getByRole('button', { name: /^Templates/ }).click()
    // The trial-ended notice lies over the list's top; the press still reaches its button.
    await page
      .getByRole('group', { name: 'Built-in' })
      .getByRole('button', { name: 'Planning' })
      .evaluate((el) => (el as HTMLElement).click())
    await expect(page.getByRole('region', { name: 'Planning' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Edit a Copy' })).toBeDisabled()
  })
})

test.describe('devot://licence links', () => {
  const offer = (id = ID, licensee = 'buyer@example.com') => ({ id, licensee, state: 'valid' })

  async function open(page: Page) {
    await openApp(page)
    await expect
      .poll(() =>
        page.evaluate(() =>
          (globalThis as unknown as TestWindow).devotIpcCalls.some(
            (call) => call.cmd === 'deep_link_take',
          ),
        ),
      )
      .toBe(true)
  }

  const sendLink = (page: Page, link: Record<string, unknown>) =>
    page.evaluate((detail) => {
      const w = globalThis as unknown as {
        dispatchEvent(e: unknown): void
        CustomEvent: new (t: string, init: { detail: unknown }) => unknown
      }
      w.dispatchEvent(new w.CustomEvent('devot:open-url', { detail }))
    }, link)

  const notice = (page: Page) => page.locator('[data-devot-licence-link]')

  test('adds the licence to a device that holds none', async ({ page }) => {
    await fakeRust(page, none())
    await open(page)
    await sendLink(page, { kind: 'licence', key: KEY, offer: offer(), code: null })
    await expect(notice(page)).toHaveText(
      /The licence for buyer@example.com was added. Editing, sync and AI are unlocked./,
    )
    expect(await calls(page, 'licence_set')).toEqual([{ key: KEY }])
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('asks before it replaces another licence, and Cancel keeps it', async ({ page }) => {
    await fakeRust(page, held('valid', OTHER_ID))
    await open(page)
    await sendLink(page, {
      kind: 'licence',
      key: OTHER_KEY,
      offer: offer(ID, 'someone@example.com'),
      code: null,
    })
    const dialog = page.getByRole('dialog', { name: 'Replace the licence on this device?' })
    await expect(dialog).toContainText(
      `This device holds the licence for buyer@example.com (${OTHER_ID}). The key in the link is for someone@example.com (${ID}).`,
    )
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect(await calls(page, 'licence_set')).toEqual([])

    // Another key: the window drops the same link sent twice within a second.
    await sendLink(page, {
      kind: 'licence',
      key: `${OTHER_KEY}2`,
      offer: offer(ID, 'someone@example.com'),
      code: null,
    })
    await dialog.getByRole('button', { name: 'Replace' }).click()
    expect(await calls(page, 'licence_set')).toEqual([{ key: `${OTHER_KEY}2` }])
  })

  test('changes nothing for the licence the device holds already', async ({ page }) => {
    await fakeRust(page, held('valid'))
    await open(page)
    await sendLink(page, { kind: 'licence', key: KEY, offer: offer(), code: null })
    await expect(notice(page)).toHaveText(/This licence is already on this device./)
    expect(await calls(page, 'licence_set')).toEqual([])
  })

  test('says why a key that failed Rust’s check was not added', async ({ page }) => {
    await fakeRust(page, none())
    await open(page)
    await sendLink(page, { kind: 'licence', key: null, offer: null, code: 'E_LICENCE_UNKNOWN_KID' })
    await expect(notice(page)).toHaveText(
      /The licence in the link could not be added. It was signed by a key this version of Devot does not know. Update Devot and try again. \(E_LICENCE_UNKNOWN_KID\)/,
    )
    expect(await calls(page, 'licence_set')).toEqual([])
  })
})
