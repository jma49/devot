import type { Locator, Page } from '@playwright/test'
import { expect, test, type TestWindow } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Tabs' })
const root = (page: Page) => page.getByRole('region', { name: 'Settings' })

async function openSettings(page: Page): Promise<void> {
  await page.goto('/')
  await tabs(page).getByRole('button', { name: 'Settings' }).click()
}

async function openPane(page: Page, name: string): Promise<Locator> {
  await openSettings(page)
  await root(page)
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
  const pane = page.locator(`section.phone-screen[aria-label="${name}"]`)
  await expect(pane.locator('.settings-section')).toBeAttached()
  return pane
}

async function rightPadding(control: Locator): Promise<number> {
  const [box, card] = await Promise.all([
    control.boundingBox(),
    control.locator('xpath=ancestor::*[contains(@class,"settings-card")]').boundingBox(),
  ])
  return card!.x + card!.width - (box!.x + box!.width)
}

const glassOpaque = (page: Page) =>
  tabs(page).evaluate((bar) => getComputedStyle(bar).backdropFilter === 'none')

test('Settings has its groups, and what lives on the Mac says so and does not open', async ({
  page,
}) => {
  await openSettings(page)
  for (const title of ['General', 'Sync & storage', 'AI & integrations']) {
    await expect(root(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
  for (const name of ['Keyboard', 'Mirror', 'Integrations', 'Local HTTP API', 'Plugins']) {
    const row = root(page).getByRole('button', { name: new RegExp(`^${name}`) })
    await expect(row).toBeDisabled()
    await expect(row).toContainText('On the Mac')
  }
})

test('the search button finds a pane by name and opens it', async ({ page }) => {
  await openSettings(page)
  await root(page).getByRole('button', { name: 'Search Settings' }).click()
  const field = root(page).getByRole('searchbox')
  await field.fill('appear')
  await root(page)
    .locator('.phone-settings-search')
    .getByRole('button', { name: /^Appearance/ })
    .click()
  await expect(page.locator('section.phone-screen[aria-label="Appearance"]')).toBeVisible()
})

test('opening the search shows its field at once, at nearly the full width', async ({ page }) => {
  await openSettings(page)
  await root(page).getByRole('button', { name: 'Search Settings' }).click()
  const field = root(page).locator('.phone-settings-search .phone-search-field')
  expect(await field.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  expect((await field.boundingBox())!.width).toBeGreaterThan(390 - 2 * 16 - 44 - 16)
  await expect(root(page).getByRole('searchbox')).toBeFocused()
})

test('a search with no match says so, and a Mac-only pane is not found', async ({ page }) => {
  await openSettings(page)
  await root(page).getByRole('button', { name: 'Search Settings' }).click()
  await root(page).getByRole('searchbox').fill('plugins')
  await expect(root(page).getByText('No matching settings')).toBeVisible()
  await root(page).getByRole('button', { name: 'Close search' }).click()
  await expect(root(page).getByRole('searchbox')).toHaveCount(0)
})

test('Classic makes the glass opaque, hides the slider and leaves the Mac keys alone', async ({
  page,
}) => {
  const pane = await openPane(page, 'Appearance')
  const slider = pane.getByRole('slider', { name: 'Glass Transparency' })
  await expect(slider).toBeVisible()
  await pane.getByRole('radio', { name: 'Classic' }).click()
  await expect(slider).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-phone-glass', 'classic')
  expect(await glassOpaque(page)).toBe(true)
  const stored = await page.evaluate(() => ({
    style: localStorage.getItem('devot.phone.interfaceStyle'),
    keys: Object.keys(localStorage).filter((k) => /interfaceStyle|windowTransparency/.test(k)),
  }))
  expect(stored.style).toBe('classic')
  expect(stored.keys).toEqual(['devot.phone.interfaceStyle'])
  await pane.getByRole('radio', { name: 'Glass', exact: true }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-phone-glass', 'classic')
  expect(await glassOpaque(page)).toBe(false)
})

test('the transparency slider scales the glass tint and survives a reload', async ({ page }) => {
  const pane = await openPane(page, 'Appearance')
  const slider = pane.getByRole('slider', { name: 'Glass Transparency' })
  const alpha = () =>
    tabs(page).evaluate((bar) => {
      const parts = getComputedStyle(bar).backgroundColor.match(/[\d.]+/g)!
      return parts.length > 4 || parts.length === 4 ? Number(parts.at(-1)) : 1
    })
  const start = await alpha()
  await slider.fill('100')
  await expect.poll(alpha).toBeCloseTo(start / 2, 1)
  await slider.fill('-100')
  await expect.poll(alpha).toBe(1)
  await page.reload()
  const stored = await page.evaluate(() => localStorage.getItem('devot.phone.glassTransparency'))
  expect(stored).toBe('-100')
  await expect.poll(alpha).toBe(1)
})

test('controls have the design sizes and reach their targets', async ({ page }) => {
  const pane = await openPane(page, 'Appearance')
  const segmented = (await pane.locator('.phone-segmented').first().boundingBox())!
  expect(segmented.height).toBe(36)
  const hit = await pane
    .locator('.phone-segment')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el, '::after').height))
  expect(hit).toBeGreaterThanOrEqual(44)
  const slider = (await pane.locator('.phone-slider').first().boundingBox())!
  expect(slider.height).toBeGreaterThanOrEqual(44)
  await pane.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
})

test('a long explanation opens in a sheet, and Done closes it', async ({ page }) => {
  const pane = await openPane(page, 'Appearance')
  await expect(pane.getByText('Glass lets the background show through')).toHaveCount(0)
  const button = pane.getByRole('button', { name: 'About Interface' })
  const box = (await button.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
  await button.click()
  const sheet = page.getByRole('dialog', { name: 'Interface' })
  await expect(sheet.getByText('Glass lets the background show through')).toBeVisible()
  const done = (await sheet.getByRole('button', { name: 'Done' }).boundingBox())!
  expect(done.height).toBeCloseTo(50, 1)
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toHaveCount(0)
})

test('shared rows show their explanation behind an info button on a phone', async ({ page }) => {
  const pane = await openPane(page, 'Editing')
  await expect(pane.locator('.setting-description')).toHaveCount(0)
  await pane.getByRole('button', { name: 'About Unordered List Bullet' }).click()
  await expect(page.getByRole('dialog', { name: 'Unordered List Bullet' })).toBeVisible()
})

test('a pane switch is 51 by 31', async ({ page }) => {
  const pane = await openPane(page, 'Editing')
  const box = (await pane.getByRole('switch').first().boundingBox())!
  expect(box.width).toBe(51)
  expect(box.height).toBe(31)
})

test('the AI pane picks a provider with a segmented control and shows only its fields', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const provider = (endpoint: string) => ({
      endpoint,
      model: '',
      defaultEndpoint: endpoint,
      defaultModel: 'm',
      key: 'unset',
    })
    const state: Record<string, unknown> = {
      active: 'anthropic',
      suggestOnIdle: false,
      anthropic: provider('https://a.example'),
      openai: provider('https://o.example'),
    }
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      ai_settings_get: () => state,
      ai_settings_set: (args: { settings: Record<string, unknown> }) => {
        for (const id of ['anthropic', 'openai'] as const) {
          Object.assign(state[id] as object, args.settings[id])
        }
        state['active'] = args.settings['active']
        state['suggestOnIdle'] = args.settings['suggestOnIdle']
        return JSON.parse(JSON.stringify(state))
      },
    }
  })
  const pane = await openPane(page, 'AI')
  await expect(pane.getByRole('radio', { name: 'Anthropic' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(pane.getByRole('textbox', { name: 'Endpoint' })).toHaveCount(1)
  await pane.getByRole('radio', { name: /^OpenAI/ }).click()
  await expect(pane.getByRole('radio', { name: /^OpenAI/ })).toHaveAttribute('aria-checked', 'true')
  await expect(pane.getByRole('textbox', { name: 'Endpoint' })).toHaveValue('https://o.example')
  await pane.getByRole('switch').click()
  await expect(pane.getByRole('switch')).toBeChecked()
})

test('the Sync pane lists devices, marks this one and offers pairing', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      sync_get: () => ({
        relayUrl: 'https://relay.example',
        enabled: true,
        vault: true,
        enrolled: true,
        status: { state: 'idle', lastSync: 1_700_000_000_000, code: null, pausedUntil: null },
      }),
      sync_devices: () => [
        { id: 'd1', label: 'This phone', created: 1_700_000_000_000, current: true },
        { id: 'd2', label: 'Desk', created: 1_690_000_000_000, current: false },
      ],
      sync_recovery_key: () => null,
    }
  })
  const pane = await openPane(page, 'Sync')
  await expect(pane.getByText(/^Last synced/)).toBeVisible()
  await expect(pane.getByRole('listitem').filter({ hasText: 'This phone' })).toContainText('You')
  await expect(pane.getByRole('button', { name: 'Remove' }).first()).toBeVisible()
  await expect(pane.locator('.phone-accent-button')).toBeVisible()
  await expect(pane.getByText('Recovery Key')).toHaveCount(0)
})

test('the Sync pane shows the recovery key only while it waits to be saved', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      sync_get: () => ({
        relayUrl: 'https://relay.example',
        enabled: true,
        vault: true,
        enrolled: true,
        status: { state: 'idle', lastSync: 1_700_000_000_000, code: null, pausedUntil: null },
      }),
      sync_devices: () => [],
      sync_recovery_key: () => 'ABCDE-FGHIJ-KLMNO',
    }
  })
  const pane = await openPane(page, 'Sync')
  await expect(pane.getByRole('group', { name: 'Recovery Key' })).toContainText('ABCDE-FGHIJ-KLMNO')
})

test('a stepper and a select sit on their label row, at the row right padding', async ({
  page,
}) => {
  const pane = await openPane(page, 'Appearance')
  for (const [role, name, control] of [
    ['spinbutton', 'Preview Font Size', '.stepper'],
    ['combobox', 'Animations', '.select'],
  ] as const) {
    const row = pane.locator('.setting').filter({ has: page.getByRole(role, { name }) })
    const box = row.locator(control)
    const [label, drawn] = await Promise.all([
      row.locator('.setting-label').boundingBox(),
      box.boundingBox(),
    ])
    expect(drawn!.x).toBeGreaterThan(label!.x + label!.width)
    expect(Math.abs(drawn!.y + drawn!.height / 2 - (label!.y + label!.height / 2))).toBeLessThan(2)
    expect(await rightPadding(box)).toBeCloseTo(12, 0)
    expect((await row.boundingBox())!.height).toBeCloseTo(44, 0)
  }
})

test('a select draws its chosen value at its own width and stays a native 44 target', async ({
  page,
}) => {
  const pane = await openPane(page, 'Appearance')
  const select = pane.getByRole('combobox', { name: 'Animations' })
  const box = (await select.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  await select.selectOption('off')
  const value = select.locator('xpath=..').locator('.select-value')
  await expect(value).toHaveText('Off')
  expect((await select.boundingBox())!.width).toBeLessThan(box.width)
})

test('a free-text field stacks under its label at the row width', async ({ page }) => {
  const pane = await openPane(page, 'Sync')
  const field = pane.getByRole('textbox', { name: 'Relay' })
  const label = pane.getByText('Relay', { exact: true })
  const [box, labelBox] = await Promise.all([field.boundingBox(), label.boundingBox()])
  expect(box!.y).toBeGreaterThanOrEqual(labelBox!.y + labelBox!.height)
  expect(box!.width).toBe(390 - 2 * 16 - 2 * 12)
})

test('theme thumbs share one size and one set of columns, and choosing moves nothing', async ({
  page,
}) => {
  const pane = await openPane(page, 'Appearance')
  const boxes = (group: string) =>
    pane.getByRole('radiogroup', { name: group }).evaluate((row) =>
      [...row.querySelectorAll('.choice')].map((choice) => {
        const thumb = choice.querySelector('.phone-theme-thumb')!.getBoundingClientRect()
        const name = choice.querySelector('.choice-name')!.getBoundingClientRect()
        return { x: thumb.x, width: thumb.width, height: thumb.height, nameX: name.x }
      }),
    )
  const light = await boxes('Light Mode Theme')
  const dark = await boxes('Dark Mode Theme')
  expect(light).toHaveLength(6)
  expect(dark.map((b) => b.x)).toEqual(light.map((b) => b.x))
  expect(new Set(light.map((b) => `${b.width}x${b.height}`)).size).toBe(1)
  const ring = await pane
    .getByRole('radiogroup', { name: 'Light Mode Theme' })
    .locator('.choice-frame')
    .first()
    .evaluate((frame) => {
      const thumb = frame.firstElementChild!.getBoundingClientRect()
      const box = frame.getBoundingClientRect()
      const inset = parseFloat(getComputedStyle(frame, '::after').left)
      return { left: thumb.x - box.x, top: thumb.y - box.y, inset }
    })
  expect(ring.left).toBe(0)
  expect(ring.top).toBe(0)
  expect(ring.inset).toBe(-4)
  await pane
    .getByRole('radiogroup', { name: 'Light Mode Theme' })
    .getByRole('radio', { name: 'Tide' })
    .check({ force: true })
  await expect(
    pane.getByRole('radiogroup', { name: 'Light Mode Theme' }).getByRole('radio', { name: 'Tide' }),
  ).toBeChecked()
  expect(await boxes('Light Mode Theme')).toEqual(light)
})

function seedUsage(page: Page, count: number) {
  return page.addInitScript((events) => {
    const now = Date.now()
    const names = ['note.created', 'search.run', 'import.finished']
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      usage_list: () =>
        Array.from({ length: events }, (_, i) => ({
          id: i + 1,
          at: now - i * 3_600_000,
          name: names[i % 3],
          properties: {},
        })),
    }
  }, count)
}

test('no label in the Usage type list wraps, and numbers share a right edge', async ({ page }) => {
  await seedUsage(page, 9)
  const pane = await openPane(page, 'Usage')
  const rows = pane.locator('.phone-usage-types li')
  await expect(rows).toHaveCount(3)
  const heights = await pane
    .locator('.phone-usage-type')
    .evaluateAll((labels) =>
      labels.map(
        (label) =>
          label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).fontSize),
      ),
    )
  for (const lines of heights) expect(lines).toBeLessThan(1.6)
  const rights = await pane
    .locator('.phone-usage-count')
    .evaluateAll((counts) => counts.map((c) => c.getBoundingClientRect().right))
  expect(new Set(rights).size).toBe(1)
  const borders = await rows.evaluateAll((items) =>
    items.map((item) => getComputedStyle(item).borderTopWidth),
  )
  expect(new Set(borders)).toEqual(new Set(['0px']))
})

test('Usage with no events shows one empty state and no zero rows', async ({ page }) => {
  await seedUsage(page, 0)
  const pane = await openPane(page, 'Usage')
  await expect(pane.getByText('No recorded events in this period.')).toHaveCount(1)
  await expect(pane.locator('.phone-usage-types')).toHaveCount(0)
  await expect(pane.getByText(/^Shading is relative/)).toHaveCount(0)
  const clear = pane.getByRole('button', { name: /^Clear Usage Data/ })
  await expect(clear).toHaveAttribute('aria-disabled', 'true')
  expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect(await clear.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
})

test('the Usage heat map legend stays inside its card at 390 pt', async ({ page }) => {
  await seedUsage(page, 9)
  const pane = await openPane(page, 'Usage')
  const legend = (await pane.locator('.usage-legend').boundingBox())!
  const card = (await pane.locator('.settings-card').filter({ hasText: 'Fewer' }).boundingBox())!
  expect(legend.x).toBeGreaterThanOrEqual(card.x)
  expect(legend.x + legend.width).toBeLessThanOrEqual(card.x + card.width)
})

test('a General pane with nothing to set says so, centred and clear of the band', async ({
  page,
}) => {
  const pane = await openPane(page, 'General')
  const empty = pane.getByText('Nothing here to set on this iPhone.')
  await expect(empty).toBeVisible()
  const box = (await empty.boundingBox())!
  expect(box.x + box.width / 2).toBeCloseTo(195, 0)
  const padding = await empty.evaluate((el) => {
    const style = getComputedStyle(el)
    return { left: style.paddingLeft, right: style.paddingRight, top: parseFloat(style.paddingTop) }
  })
  expect(padding.left).toBe(padding.right)
  expect(padding.top).toBeGreaterThan(44)
})

test('a pane does not repeat its screen title as its first section title', async ({ page }) => {
  await seedUsage(page, 9)
  for (const [name, repeated] of [
    ['License', 'License'],
    ['Preview', 'Preview'],
    ['Usage', 'Usage overview'],
  ] as const) {
    const pane = await openPane(page, name)
    await expect(pane.locator('.settings-block-title', { hasText: repeated })).toHaveCount(0)
    await expect(pane.locator(`.settings-block[aria-label="${repeated}"]`)).toBeAttached()
  }
})

test('Usage stats are full-width rows in one card, figures on the right edge', async ({ page }) => {
  await seedUsage(page, 9)
  const pane = await openPane(page, 'Usage')
  const stats = pane.locator('.usage-stat')
  await expect(stats).toHaveCount(3)
  const boxes = await stats.evaluateAll((rows) =>
    rows.map((row) => {
      const box = row.getBoundingClientRect()
      const figure = row.querySelector('strong')!.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: figure.right }
    }),
  )
  expect(new Set(boxes.map((box) => box.x)).size).toBe(1)
  expect(new Set(boxes.map((box) => box.y)).size).toBe(3)
  expect(new Set(boxes.map((box) => box.right)).size).toBe(1)
  for (const box of boxes) {
    expect(box.width).toBe(390 - 2 * 16 - 2 * 12)
    expect(box.height).toBeGreaterThanOrEqual(44)
  }
})

test('a long select value is cut with an ellipsis, in its row, beside its whole label', async ({
  page,
}) => {
  const long = `custom.${'very-long-event-name-'.repeat(6)}end`
  await page.addInitScript((name) => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      usage_list: () => [{ id: 1, at: Date.now(), name, properties: {} }],
    }
  }, long)
  const pane = await openPane(page, 'Usage')
  const select = pane.getByRole('combobox', { name: 'Event type' })
  await select.selectOption(long)
  const row = pane
    .locator('.setting')
    .filter({ has: page.getByRole('combobox', { name: 'Event type' }) })
  const value = row.locator('.select-value')
  await expect(value).toContainText('very-long-event-name')
  const seen = await value.evaluate((el) => ({
    cut: el.scrollWidth > el.clientWidth,
    overflow: getComputedStyle(el).textOverflow,
    wrap: getComputedStyle(el).whiteSpace,
  }))
  expect(seen).toEqual({ cut: true, overflow: 'ellipsis', wrap: 'nowrap' })
  const [label, drawn, card] = await Promise.all([
    row.locator('.setting-label').evaluate((el) => ({
      right: el.getBoundingClientRect().right,
      whole: el.scrollWidth <= el.clientWidth,
    })),
    row.locator('.select').boundingBox(),
    row.locator('xpath=ancestor::*[contains(@class,"settings-card")]').boundingBox(),
  ])
  expect(label.whole).toBe(true)
  expect(drawn!.x).toBeGreaterThanOrEqual(label.right)
  expect(drawn!.x + drawn!.width).toBeLessThanOrEqual(card!.x + card!.width - 12 + 0.5)
})

test.describe('License, Usage and disabled switches', () => {
  const noLicence = {
    gated: true,
    state: 'none',
    code: null,
    id: null,
    licensee: null,
    plan: null,
    trial: { state: 'ended', endsAt: 1_790_000_000_000, code: null },
  }

  const seedLicence = (page: Page) =>
    page.addInitScript((licence) => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcMocks = { ...w.devotIpcMocks, licence_get: () => licence }
    }, noLicence)

  const atDoubleText = (page: Page) =>
    page.locator('.phone-app').evaluate((app) => {
      const shell = app as unknown as {
        style: CSSStyleDeclaration
        dataset: Record<string, string>
      }
      shell.style.setProperty('--phone-text-scale', '2')
      shell.dataset['textSize'] = 'accessibility'
    })

  const openPaneAtDoubleText = async (page: Page, name: string) => {
    await openSettings(page)
    await atDoubleText(page)
    await root(page)
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click()
    const pane = page.locator(`section.phone-screen[aria-label="${name}"]`)
    await expect(pane.locator('.settings-section')).toBeAttached()
    return pane
  }

  const firstCardTop = async (pane: Locator) =>
    (await pane.locator('.settings-card').first().boundingBox())!.y

  test('License and Usage start where other panes do, the info on a first row', async ({
    page,
  }) => {
    await seedLicence(page)
    await seedUsage(page, 9)
    const sync = await firstCardTop(await openPane(page, 'Sync'))
    for (const [name, about, sheet] of [
      ['License', 'About License', 'License'],
      ['Usage', 'About Usage overview', 'Usage overview'],
    ] as const) {
      const pane = await openPane(page, name)
      await expect(pane.locator('.phone-block-head:not(:has(.settings-block-title))')).toHaveCount(
        0,
      )
      await expect.poll(() => firstCardTop(pane)).toBeCloseTo(sync, 0)
      const info = pane
        .locator('.settings-card')
        .first()
        .getByRole('button', { name: about, exact: true })
      const box = (await info.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
      await info.click()
      const dialog = page.getByRole('dialog', { name: sheet })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Done' }).click()
    }
  })

  test('at twice the text size License stacks its buttons at the row width', async ({ page }) => {
    await seedLicence(page)
    const pane = await openPaneAtDoubleText(page, 'License')
    const card = (await pane.locator('.settings-card').boundingBox())!
    const status = (await pane.getByText('No license is added.').boundingBox())!
    const buy = (await pane.getByRole('button', { name: 'Buy a License' }).boundingBox())!
    expect(status.y + status.height).toBeLessThanOrEqual(buy.y + 1)
    const add = pane.getByRole('button', { name: 'Add License' })
    const remove = pane.getByRole('button', { name: 'Remove License…' })
    const addBox = (await add.boundingBox())!
    const removeBox = (await remove.boundingBox())!
    expect(addBox.y + addBox.height).toBeLessThanOrEqual(removeBox.y)
    for (const box of [buy, addBox, removeBox]) {
      expect(box.width).toBeCloseTo(card.width - 2 * 12, 0)
      expect(box.x).toBeGreaterThanOrEqual(card.x)
      expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width)
    }
    for (const button of [add, remove]) {
      const fits = await button.evaluate((el) => el.scrollWidth <= el.clientWidth)
      expect(fits).toBe(true)
    }
  })

  test('at twice the text size Usage stacks its period and chart headings', async ({ page }) => {
    await seedUsage(page, 9)
    const pane = await openPaneAtDoubleText(page, 'Usage')
    const segments = pane.getByRole('radio')
    await expect(segments).toHaveCount(3)
    const boxes = await Promise.all(
      [0, 1, 2].map(async (i) => (await segments.nth(i).boundingBox())!),
    )
    for (const [i, box] of boxes.entries()) {
      expect(box.height).toBeGreaterThanOrEqual(44)
      if (i > 0) expect(box.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.height - 1)
      const fits = await segments.nth(i).evaluate((el) => el.scrollWidth <= el.clientWidth)
      expect(fits).toBe(true)
    }
    const pill = (await pane.locator('.phone-segmented-pill').boundingBox())!
    expect(pill.y).toBeCloseTo(boxes[1]!.y, 0)
    expect(pill.height).toBeCloseTo(boxes[1]!.height, 0)

    const day = (await pane.getByRole('heading', { name: 'By day' }).boundingBox())!
    const average = (await pane.getByText(/^Average /).boundingBox())!
    expect(average.y).toBeGreaterThanOrEqual(day.y + day.height - 1)
  })

  test('a disabled switch stays at full opacity and differs from an off one', async ({ page }) => {
    const paint = (input: Locator) =>
      input.evaluate((el) => {
        const after = getComputedStyle(el, '::after')
        return { opacity: getComputedStyle(el).opacity, thumb: after.backgroundColor }
      })
    const sync = await openPane(page, 'Sync')
    const disabled = sync.getByRole('switch', { name: 'Sync This Device' })
    await expect(disabled).toBeDisabled()
    const off = await paint(disabled)
    expect(off.opacity).toBe('1')
    const preview = await openPane(page, 'Preview')
    const enabled = preview.getByRole('switch').first()
    if (await enabled.isChecked()) await enabled.click()
    await expect(enabled).not.toBeChecked()
    expect(off.thumb).not.toBe((await paint(enabled)).thumb)
  })
})

test('the Sync pane shows what the relay holds, with the room left and a warning near the cap', async ({
  page,
}) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      sync_get: () => ({
        relayUrl: 'https://relay.example',
        enabled: true,
        vault: true,
        enrolled: true,
        status: { state: 'idle', lastSync: 1_700_000_000_000, code: null, pausedUntil: null },
      }),
      sync_devices: () => [],
      sync_recovery_key: () => null,
      sync_usage: () => ({
        storedBytes: 3_300_000_000,
        fileBytes: 1_000_000_000,
        caps: {
          rowsWritten: 80_000,
          requests: 80_000,
          storedBytes: 4_000_000_000,
          fileBytes: 3_000_000_000,
        },
      }),
    }
  })
  const pane = await openPane(page, 'Sync')
  await expect(pane.getByText('Notes and Other Records')).toBeVisible()
  await expect(pane.getByText('1 GB of 3 GB')).toBeVisible()
  await expect(pane.getByText('3.3 GB of 4 GB')).toBeVisible()
  await expect(pane.getByText(/^700 MB\. Images can use 700 MB of that\./)).toBeVisible()
  await expect(pane.getByText(/The relay’s storage is more than 80% full/)).toBeVisible()
})

test('a phone without sync asks first or another device, then shows only that path', async ({
  page,
}) => {
  const pane = await openPane(page, 'Sync')
  await expect(pane.getByRole('textbox', { name: 'Relay' })).toHaveCount(0)
  await pane.getByRole('button', { name: 'I’m Adding Another Device' }).click()
  await expect(pane.getByRole('textbox', { name: 'Join With a Code' })).toBeVisible()
  await expect(pane.getByRole('button', { name: 'Create Vault' })).toHaveCount(0)
  await pane.getByRole('button', { name: 'Change Answer' }).click()
  await pane.getByRole('button', { name: 'This Is My First Device' }).click()
  await expect(pane.getByRole('textbox', { name: 'Relay' })).toBeVisible()
  await expect(pane.getByRole('textbox', { name: 'Join With a Code' })).toHaveCount(0)
})
