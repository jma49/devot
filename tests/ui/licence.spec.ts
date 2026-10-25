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

const none = (gated = true): Licence => ({
  gated,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  updatesUntil: null,
  plan: null,
})

const held = (state: string, id = ID, updatesUntil = '2027-10-24'): Licence => ({
  gated: true,
  state,
  code: null,
  id,
  licensee: 'buyer@example.com',
  updatesUntil,
  plan: 'pro',
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
          licence = { ...licence, state: 'none', id: null, licensee: null, updatesUntil: null }
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
    await expect(panel).toContainText('Sync and AI need a Devot licence')
    await expect(panel).toContainText('No licence is added. Sync and AI stay locked')
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
    await expect(panel).toContainText('Sync and AI are unlocked on this device.')
    await expect(panel).toContainText('buyer@example.com')
    await expect(panel).toContainText(ID)
    await expect(panel).toContainText('October 24, 2027')
    await expect(panel.getByRole('button', { name: 'Replace Licence' })).toBeVisible()
    await expect(panel.getByRole('button', { name: /^(Buy a Licence|Renew)$/ })).toHaveCount(0)

    await remove.click()
    const dialog = page.getByRole('dialog', { name: 'Remove the licence from this device?' })
    await expect(dialog).toContainText('Sync and AI stop on this device')
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

  test('opens the Buy page, and Renew for a licence that ended before this version', async ({
    page,
  }) => {
    await fakeRust(page, none())
    await openSettings(page, 'Licence')
    const panel = page.getByRole('tabpanel')
    await panel.getByRole('button', { name: 'Buy a Licence' }).click()
    expect(await calls(page, 'open_external')).toEqual([
      { url: 'https://licence.devot.online/buy' },
    ])

    await fakeRust(page, held('updatesEnded', ID, '2026-01-31'))
    await page.reload()
    await page.getByRole('tab', { name: 'Licence', exact: true }).click()
    await expect(panel).toContainText(
      'This licence covers versions released until January 31, 2026. This version came out later',
    )
    await panel.getByRole('button', { name: 'Renew' }).click()
    expect(await calls(page, 'open_external')).toEqual([
      { url: `https://licence.devot.online/renew?licence=${ID}` },
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
      'This build of Devot does not check licences, so sync and AI work without one.',
    )
  })
})

test.describe('locked sync and AI', () => {
  test('Settings > Sync and AI say a licence is needed, with Buy', async ({ page }) => {
    await fakeRust(page, none())
    await openSettings(page, 'Sync')
    const sync = page.getByRole('tabpanel')
    await expect(sync).toContainText('Sync needs a Devot licence. Add one in Settings > Licence.')
    await sync.getByRole('button', { name: 'Buy a Licence' }).click()
    expect(await calls(page, 'open_external')).toEqual([
      { url: 'https://licence.devot.online/buy' },
    ])
    await page.getByRole('tab', { name: 'AI', exact: true }).click()
    await expect(page.getByRole('tabpanel')).toContainText(
      'AI needs a Devot licence. Add one in Settings > Licence.',
    )
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

  test('Edit with AI says a licence is needed and sends nothing', async ({ page }) => {
    await fakeRust(page, none())
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
    expect(await calls(page, 'ai_generate')).toEqual([])
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
    await expect(notice).toContainText('it needs a Devot licence')
    await notice.getByRole('button', { name: 'Buy a Licence' }).click()
    expect(await calls(page, 'open_external')).toEqual([
      { url: 'https://licence.devot.online/buy' },
    ])
  })
})

test.describe('devot://licence links', () => {
  const offer = (id = ID, updatesUntil = '2027-10-24', licensee = 'buyer@example.com') => ({
    id,
    licensee,
    updatesUntil,
    state: 'valid',
  })

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
      /The licence for buyer@example.com was added. Sync and AI are unlocked./,
    )
    expect(await calls(page, 'licence_set')).toEqual([{ key: KEY }])
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('asks before it replaces another licence, and Cancel keeps it', async ({ page }) => {
    await fakeRust(page, held('valid', OTHER_ID, '2027-01-01'))
    await open(page)
    await sendLink(page, {
      kind: 'licence',
      key: OTHER_KEY,
      offer: offer(ID, '2027-10-24', 'someone@example.com'),
      code: null,
    })
    const dialog = page.getByRole('dialog', { name: 'Replace the licence on this device?' })
    await expect(dialog).toContainText(
      'This device holds the licence for buyer@example.com, with updates until January 1, 2027. The key in the link is for someone@example.com, with updates until October 24, 2027.',
    )
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect(await calls(page, 'licence_set')).toEqual([])

    // Another key: the window drops the same link sent twice within a second.
    await sendLink(page, {
      kind: 'licence',
      key: `${OTHER_KEY}2`,
      offer: offer(ID, '2027-10-24', 'someone@example.com'),
      code: null,
    })
    await dialog.getByRole('button', { name: 'Replace' }).click()
    expect(await calls(page, 'licence_set')).toEqual([{ key: `${OTHER_KEY}2` }])
  })

  test('says when the key is the same licence renewed', async ({ page }) => {
    await fakeRust(page, held('updatesEnded', ID, '2026-01-31'))
    await open(page)
    await sendLink(page, { kind: 'licence', key: KEY, offer: offer(ID, '2027-01-31'), code: null })
    const dialog = page.getByRole('dialog', { name: 'Add the renewed licence?' })
    await expect(dialog).toContainText(
      `The key in the link is the licence this device holds (${ID}), renewed: updates until January 31, 2027 instead of January 31, 2026.`,
    )
    await dialog.getByRole('button', { name: 'Replace' }).click()
    expect(await calls(page, 'licence_set')).toEqual([{ key: KEY }])
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
