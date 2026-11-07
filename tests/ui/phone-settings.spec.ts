import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

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

test('an ended trial shows on the Settings tab and its License row at launch', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      licence_get: () => ({
        gated: true,
        state: 'none',
        code: null,
        id: null,
        licensee: null,
        plan: null,
        trial: { state: 'ended', endsAt: Date.now() - 86_400_000, code: null },
      }),
    }
  })
  await page.goto('/')
  await expect(
    tabs(page)
      .getByRole('button', { name: 'Settings' })
      .getByRole('img', { name: 'Needs attention' }),
  ).toBeVisible()
  await tabs(page).getByRole('button', { name: 'Settings' }).click()
  await expect(root(page).getByRole('button', { name: /^License/ })).toContainText(
    'Needs attention',
  )
})

test('Settings has its groups and leaves out what only the Mac has', async ({ page }) => {
  await openSettings(page)
  for (const title of ['General', 'Sync & Storage', 'AI & Integrations']) {
    await expect(root(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
  await expect(root(page).getByRole('button', { name: /^Appearance/ })).toBeEnabled()
  for (const name of ['Keyboard', 'Mirror', 'Integrations', 'Local HTTP API', 'Plugins']) {
    await expect(root(page).getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0)
  }
  await expect(root(page).getByText('On the Mac')).toHaveCount(0)
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

test('Appearance offers the glass transparency', async ({ page }) => {
  const pane = await openPane(page, 'Appearance')
  await expect(pane.getByRole('slider', { name: 'Glass Transparency' })).toBeVisible()
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

test('no pane has an info button or a long explanation under a row', async ({ page }) => {
  for (const name of ['Appearance', 'Editing', 'Preview', 'Sync', 'AI', 'License']) {
    const pane = await openPane(page, name)
    await expect(pane.getByRole('button', { name: /^About / })).toHaveCount(0)
    await expect(pane.getByText('Glass lets the background show through')).toHaveCount(0)
  }
})

test('Editing rows have at most one line of description, the control centred', async ({ page }) => {
  const pane = await openPane(page, 'Editing')
  const rows = pane.locator('.setting:has(.setting-description)')
  expect(await rows.count()).toBeGreaterThan(0)
  for (const row of await rows.all()) {
    const text = row.locator('.setting-description')
    // Fonts differ between machines, so the length is checked rather than the wrapped height.
    expect((await text.textContent())!.length).toBeLessThanOrEqual(40)
    const box = (await text.boundingBox())!
    const label = (await row.locator('.setting-label').boundingBox())!
    expect(box.x).toBeCloseTo(label.x, 0)
    const whole = (await row.boundingBox())!
    const control = (await row.locator('.setting-control').boundingBox())!
    expect(control.y + control.height / 2).toBeCloseTo(whole.y + whole.height / 2, 0)
  }
  await expect(
    pane.locator('.setting:has(label:text-is("Floating Toolbars")) .setting-description'),
  ).toHaveText('Over selected text and tables')
})

test('the controls in a card share one right edge', async ({ page }) => {
  const pane = await openPane(page, 'Editing')
  for (const card of await pane.locator('.settings-card').all()) {
    const edges = await card
      .locator('.setting:not(.setting-stacked) > .setting-control > *')
      .evaluateAll((controls) => controls.map((c) => Math.round(c.getBoundingClientRect().right)))
    expect(new Set(edges).size).toBeLessThanOrEqual(1)
  }
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
    window.devotIpcMocks = {
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
    window.devotIpcMocks = {
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
  await expect(pane.getByRole('button', { name: 'Show Pairing Code' })).toBeVisible()
  await expect(pane.getByText('Recovery Key')).toHaveCount(0)
})

test('the Sync pane shows the recovery key only while it waits to be saved', async ({ page }) => {
  await page.addInitScript(() => {
    window.devotIpcMocks = {
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
  const pane = await openPane(page, 'Editing')
  for (const [role, name, control] of [
    ['spinbutton', 'Cursor Scroll Margin', '.stepper'],
    ['combobox', 'Indent Unit', '.select'],
  ] as const) {
    const row = pane.locator('.setting').filter({ has: page.getByRole(role, { name }) })
    const box = row.locator(control)
    const [label, drawn] = await Promise.all([
      row.locator('.setting-label').boundingBox(),
      box.boundingBox(),
    ])
    expect(drawn!.x).toBeGreaterThan(label!.x + label!.width)
    const whole = (await row.boundingBox())!
    expect(Math.abs(drawn!.y + drawn!.height / 2 - (whole.y + whole.height / 2))).toBeLessThan(2)
    expect(await rightPadding(box)).toBeCloseTo(16, 0)
    expect(whole.height).toBeGreaterThanOrEqual(56)
  }
})

test('a select row is its native target, its value and chevron on the right', async ({ page }) => {
  const pane = await openPane(page, 'Appearance')
  const select = pane.getByRole('combobox', { name: 'Animations' })
  const row = pane
    .locator('.setting')
    .filter({ has: page.getByRole('combobox', { name: 'Animations' }) })
  const [box, whole] = [(await select.boundingBox())!, (await row.boundingBox())!]
  expect(box.x).toBeCloseTo(whole.x, 0)
  expect(box.width).toBeCloseTo(whole.width, 0)
  expect(box.height).toBeCloseTo(whole.height, 0)
  await select.selectOption('off')
  const drawn = select.locator('xpath=..')
  await expect(drawn.locator('.select-value')).toHaveText('Off')
  await expect(drawn.locator('.phone-chevron')).toBeAttached()
  await expect(drawn.locator('.select-chevron')).toHaveCount(0)
  const [value, chevron] = await Promise.all([
    drawn.locator('.select-value').boundingBox(),
    drawn.locator('.phone-chevron').boundingBox(),
  ])
  expect(chevron!.x).toBeGreaterThanOrEqual(value!.x + value!.width)
})

test('a free-text field stacks under its label at the row width', async ({ page }) => {
  const pane = await openPane(page, 'Sync')
  await pane.getByRole('button', { name: 'This Is My First Device' }).click()
  const field = pane.getByRole('textbox', { name: 'Relay' })
  const label = pane.getByText('Relay', { exact: true })
  const [box, labelBox] = await Promise.all([field.boundingBox(), label.boundingBox()])
  expect(box!.y).toBeGreaterThanOrEqual(labelBox!.y + labelBox!.height)
  expect(box!.width).toBe(390 - 2 * 16 - 2 * 16)
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

test('a pane does not repeat its screen title as its first section title', async ({ page }) => {
  for (const [name, repeated] of [
    ['License', 'License'],
    ['Preview', 'Preview'],
  ] as const) {
    const pane = await openPane(page, name)
    await expect(pane.locator('.settings-block-title', { hasText: repeated })).toHaveCount(0)
    await expect(pane.locator(`.settings-block[aria-label="${repeated}"]`)).toBeAttached()
  }
})

test('a long select value is cut with an ellipsis inside its card', async ({ page }) => {
  const name = `Imported ${'Very Long Font Family Name '.repeat(4)}End`
  await page.addInitScript((font) => {
    window.devotIpcMocks = {
      ...window.devotIpcMocks,
      fonts_list: () => [{ id: 'long.ttf', name: font }],
    }
  }, name)
  const pane = await openPane(page, 'Appearance')
  await pane.getByRole('combobox', { name: 'Note Font' }).selectOption('imported')
  const select = pane.locator('select[id$="imported-font"]').first()
  await select.selectOption('long.ttf')
  const shown = select.locator('xpath=..').locator('.select-value')
  await expect(shown).toContainText('Very Long Font Family Name')
  const seen = await shown.evaluate((el) => ({
    cut: el.scrollWidth > el.clientWidth,
    overflow: getComputedStyle(el).textOverflow,
    wrap: getComputedStyle(el).whiteSpace,
  }))
  expect(seen).toEqual({ cut: true, overflow: 'ellipsis', wrap: 'nowrap' })
  const drawn = select.locator('xpath=..')
  const [value, chevron, row, card] = await Promise.all([
    shown.boundingBox(),
    drawn.locator('.phone-chevron').boundingBox(),
    drawn.boundingBox(),
    shown.locator('xpath=ancestor::*[contains(@class,"settings-card")]').boundingBox(),
  ])
  expect(value!.x - card!.x).toBeCloseTo(16, 0)
  expect(card!.x + card!.width - (chevron!.x + chevron!.width)).toBeCloseTo(16, 0)
  expect(chevron!.x).toBeGreaterThanOrEqual(value!.x + value!.width)
  expect(row!.height).toBeGreaterThanOrEqual(56)
  expect(await drawn.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    'linear-gradient',
  )
})

test.describe('License and disabled switches', () => {
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
      const w = window
      w.devotIpcMocks = { ...w.devotIpcMocks, licence_get: () => licence }
    }, noLicence)

  const atDoubleText = (page: Page) =>
    page.locator('.phone-app').evaluate((app) => {
      const shell = app
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

  test('License starts where other panes do, with no empty head', async ({ page }) => {
    await seedLicence(page)
    const sync = await firstCardTop(await openPane(page, 'Sync'))
    for (const name of ['Editing', 'Preview', 'License']) {
      const pane = await openPane(page, name)
      if (await pane.locator('.settings-card').count()) {
        const first = pane.locator('.settings-block').first()
        const titled = await first.locator('.settings-block-title').count()
        if (!titled) await expect.poll(() => firstCardTop(pane)).toBeCloseTo(sync, 0)
      }
    }
  })

  test('at twice the text size License stacks its buttons as full-width rows', async ({ page }) => {
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
      expect(box.width).toBeCloseTo(card.width, 0)
      expect(box.x).toBeGreaterThanOrEqual(card.x)
      expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width)
    }
    for (const button of [add, remove]) {
      const fits = await button.evaluate((el) => el.scrollWidth <= el.clientWidth)
      expect(fits).toBe(true)
    }
  })

  test('a disabled row is dimmed as a whole, its switch drawn as an enabled one', async ({
    page,
  }) => {
    const paint = (input: Locator) =>
      input.evaluate((el) => {
        const after = getComputedStyle(el, '::after')
        return {
          opacity: getComputedStyle(el).opacity,
          thumb: after.backgroundColor,
          shadow: after.boxShadow,
          track: getComputedStyle(el).backgroundColor,
        }
      })
    const sync = await openPane(page, 'Sync')
    const disabled = sync.getByRole('switch', { name: 'Sync This Device' })
    await expect(disabled).toBeDisabled()
    const row = sync
      .locator('.setting')
      .filter({ has: page.getByRole('switch', { name: 'Sync This Device' }) })
    const faded = (target: Locator) =>
      target.evaluate((el) => ({
        row: getComputedStyle(el).opacity,
        parts: [...el.children].map((child) => getComputedStyle(child).opacity),
        label: getComputedStyle(el.querySelector('.setting-label')!).color,
      }))
    const dimmed = await faded(row)
    expect(dimmed.row).toBe('1')
    expect(new Set(dimmed.parts)).toEqual(new Set(['0.45']))
    const off = await paint(disabled)
    expect(off.opacity).toBe('1')
    const preview = await openPane(page, 'Preview')
    const enabled = preview.getByRole('switch').first()
    if (await enabled.isChecked()) await enabled.click()
    await expect(enabled).not.toBeChecked()
    expect(
      await preview
        .locator('.setting')
        .filter({ has: page.getByRole('switch') })
        .first()
        .evaluate((el) => getComputedStyle(el).opacity),
    ).toBe('1')
    await expect.poll(() => paint(enabled)).toEqual(off)
    const enabledLabel = await faded(
      preview
        .locator('.setting')
        .filter({ has: page.getByRole('switch') })
        .first(),
    )
    expect(dimmed.label).toBe(enabledLabel.label)
  })

  test('a disabled select row fades once, its hairline kept', async ({ page }) => {
    const pane = await openPane(page, 'Appearance')
    const select = pane.getByRole('combobox', { name: 'Animations' })
    const row = pane
      .locator('.setting')
      .filter({ has: page.getByRole('combobox', { name: 'Animations' }) })
    await select.evaluate((el) => ((el as HTMLSelectElement).disabled = true))
    const seen = await row.evaluate((el) => ({
      row: getComputedStyle(el).opacity,
      parts: [...el.children].map((child) => getComputedStyle(child).opacity),
      select: getComputedStyle(el.querySelector('.select')!).opacity,
    }))
    expect(seen.row).toBe('1')
    expect(new Set(seen.parts)).toEqual(new Set(['0.45']))
    expect(seen.select).toBe('1')
  })

  test('at twice the text size a select and a stepper stack under their label, on the right edge', async ({
    page,
  }) => {
    const pane = await openPaneAtDoubleText(page, 'Editing')
    for (const [role, name, control] of [
      ['spinbutton', 'Cursor Scroll Margin', '.stepper'],
      ['combobox', 'Indent Unit', '.select'],
    ] as const) {
      const row = pane.locator('.setting').filter({ has: page.getByRole(role, { name }) })
      const [label, drawn] = await Promise.all([
        row.locator('.setting-label').boundingBox(),
        row.locator(control).boundingBox(),
      ])
      expect(drawn!.y).toBeGreaterThanOrEqual(label!.y + label!.height - 1)
      expect(Math.abs((await rightPadding(row.locator(control))) - 16)).toBeLessThanOrEqual(1)
    }
  })
})

test('the Sync pane shows what the relay holds, with the room left and a warning near the cap', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.devotIpcMocks = {
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
  await expect(pane.getByText('700 MB, images up to 700 MB', { exact: true })).toBeVisible()
  await expect(pane.getByText(/^The relay is over 80% full\./)).toBeVisible()
  await expect(pane.getByText(/^Holds up to/)).toHaveCount(0)
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

test('buttons in a card are full-width action rows with tinted labels on the keyline', async ({
  page,
}) => {
  const pane = await openPane(page, 'Sync')
  const buttons = pane.locator('.settings-card .settings-buttons .button:visible')
  await expect(buttons.first()).toBeVisible()
  for (const button of await buttons.all()) {
    const card = button.locator('xpath=ancestor::*[contains(@class, "settings-card")][1]')
    const [box, cardBox] = [(await button.boundingBox())!, (await card.boundingBox())!]
    expect(box.x).toBeCloseTo(cardBox.x, 0)
    expect(box.width).toBeCloseTo(cardBox.width, 0)
    expect(box.height).toBeGreaterThanOrEqual(56)
    const seen = await button.evaluate((el) => {
      const style = getComputedStyle(el)
      const probe = document.createElement('span')
      probe.style.color = 'var(--color-accent-text)'
      el.append(probe)
      const accent = getComputedStyle(probe).color
      probe.remove()
      return {
        radius: parseFloat(style.borderTopLeftRadius),
        padding: parseFloat(style.paddingLeft),
        tinted: style.color === accent,
        background: style.backgroundColor,
      }
    })
    expect(seen).toEqual({ radius: 0, padding: 16, tinted: true, background: 'rgba(0, 0, 0, 0)' })
    expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
})

/** A token expression's length in px, resolved where `el` is. */
const resolved = (target: Locator, expression: string) =>
  target.evaluate((el, value) => {
    const probe = document.createElement('div')
    probe.style.width = value
    el.parentElement!.append(probe)
    const width = probe.getBoundingClientRect().width
    probe.remove()
    return width
  }, expression)

const radius = (target: Locator) =>
  target.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))

test('segmented controls and steppers in a card are concentric with it', async ({ page }) => {
  const inner = 'calc(var(--radius-phone-grouped-card) - var(--size-phone-grouped-pad-x))'
  const appearance = await openPane(page, 'Appearance')
  const segmented = appearance.locator('.settings-card .phone-segmented').first()
  await expect(segmented).toBeVisible()
  expect(await radius(segmented)).toBeCloseTo(await resolved(segmented, inner), 0)
  const pill = segmented.locator('.phone-segmented-pill')
  expect(await radius(pill)).toBeCloseTo((await resolved(segmented, inner)) - 3, 0)

  const editing = await openPane(page, 'Editing')
  const stepper = editing.locator('.settings-card .stepper').first()
  await expect(stepper).toBeVisible()
  const expected = await resolved(stepper, inner)
  const corners = await stepper.locator('.stepper-button').evaluateAll((buttons) =>
    buttons.map((el) => {
      const style = getComputedStyle(el)
      return [parseFloat(style.borderTopLeftRadius), parseFloat(style.borderTopRightRadius)]
    }),
  )
  expect(corners).toEqual([
    [expected, 0],
    [0, expected],
  ])
  const field = (await stepper.locator('.stepper-field').boundingBox())!
  const minus = (await stepper.locator('.stepper-button').first().boundingBox())!
  expect(field.x + field.width).toBeLessThanOrEqual(minus.x)
  expect((await stepper.boundingBox())!.width).toBeLessThan(200)
})

test('a stepper reads and tabs as its number, then - and +, each a 44 by 44 target', async ({
  page,
}) => {
  const pane = await openPane(page, 'Editing')
  const stepper = pane.locator('.settings-card .stepper').first()
  await stepper.scrollIntoViewIfNeeded()
  expect(
    await stepper
      .locator('input, button')
      .evaluateAll((items) => items.map((el) => el.getAttribute('aria-label') ?? el.tagName)),
  ).toEqual(['INPUT', 'Less', 'More'])
  await stepper.getByRole('button', { name: 'More' }).click()
  await expect(stepper.getByRole('button', { name: 'Less' })).toBeEnabled()
  const targets = await stepper.locator('.stepper-button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect()
      const x = box.left + box.width / 2
      const hits = (y: number) => document.elementFromPoint(x, y)?.closest('.stepper-button')
      const reach = (from: number, step: number) => {
        let y = from
        while (hits(y + step) === button) y += step
        return y
      }
      const middle = box.top + box.height / 2
      return { width: box.width, height: reach(middle, 1) - reach(middle, -1) + 1 }
    }),
  )
  expect(targets).toHaveLength(2)
  for (const target of targets) {
    expect(target.width).toBeGreaterThanOrEqual(44)
    expect(target.height).toBeGreaterThanOrEqual(43)
  }
})

const cardRight = (control: Locator) =>
  control
    .locator('xpath=ancestor::*[contains(@class,"settings-card")][1]')
    .evaluate((card) => card.getBoundingClientRect().right)

test('trailing values, chevrons and switches share one right edge across every row', async ({
  page,
}) => {
  for (const name of ['Editing', 'Appearance', 'Preview']) {
    const pane = await openPane(page, name)
    const controls = pane.locator(
      '.settings-card .setting:not(.setting-stacked) > .setting-control > :is([role="switch"], .select, .stepper)',
    )
    expect(await controls.count()).toBeGreaterThan(0)
    const gaps: number[] = []
    for (const control of await controls.all()) {
      const right = await control.evaluate((el) => el.getBoundingClientRect().right)
      gaps.push((await cardRight(control)) - right)
    }
    for (const gap of gaps) expect(Math.abs(gap - 16)).toBeLessThanOrEqual(1)
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1)
  }
})

test('pane rows are at least 56 high, 72 with a description', async ({ page }) => {
  for (const name of ['Editing', 'Appearance', 'Preview', 'Sync']) {
    const pane = await openPane(page, name)
    const rows = await pane.locator('.settings-card .setting:visible').evaluateAll((items) =>
      items.map((row) => ({
        height: row.getBoundingClientRect().height,
        described: row.querySelector('.setting-description') !== null,
      })),
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.height).toBeGreaterThanOrEqual(row.described ? 72 : 56)
  }
})

test('rows in a card are parted by inset hairlines, none above the first', async ({ page }) => {
  const pane = await openPane(page, 'Editing')
  const cards = await pane.locator('.settings-card').evaluateAll((items) =>
    items.map((card) =>
      [...card.children]
        .filter((child) => !child.classList.contains('visually-hidden'))
        .map((child) => {
          const style = getComputedStyle(child)
          return { image: style.backgroundImage, size: style.backgroundSize }
        }),
    ),
  )
  const parted = cards.filter((rows) => rows.length > 1)
  expect(parted.length).toBeGreaterThan(0)
  for (const [first, ...rest] of parted) {
    expect(first!.image).toBe('none')
    for (const row of rest) {
      expect(row.image).toContain('linear-gradient')
      expect(row.size).toMatch(/^calc\(100% - 16px\) 0\.5px$|^calc\(-16px \+ 100%\) 0\.5px$/)
    }
  }
})

test('section headers and footers start on one inset, the rows text keyline', async ({ page }) => {
  await page.addInitScript(() => {
    const provider = (endpoint: string) => ({
      endpoint,
      model: '',
      defaultEndpoint: endpoint,
      defaultModel: 'm',
      key: 'unset',
    })
    window.devotIpcMocks = {
      ai_settings_get: () => ({
        active: 'anthropic',
        suggestOnIdle: false,
        anthropic: provider('https://a.example'),
        openai: provider('https://o.example'),
      }),
    }
  })
  const pane = await openPane(page, 'AI')
  const starts = await pane.evaluate((el) => {
    const start = (node: Element) =>
      node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft)
    const card = el.querySelector('.settings-card')!.getBoundingClientRect().left
    return {
      card,
      headers: [...el.querySelectorAll('.settings-block-title')].map(start),
      footers: [...el.querySelectorAll('.phone-footnote')].map(start),
      labels: [...el.querySelectorAll('.settings-card .setting-label')].map(
        (label) => label.getBoundingClientRect().left,
      ),
    }
  })
  expect(starts.headers.length).toBeGreaterThan(0)
  expect(starts.footers.length).toBeGreaterThan(0)
  for (const x of [...starts.headers, ...starts.footers, ...starts.labels])
    expect(x).toBeCloseTo(starts.card + 16, 0)
})

test('a button that removes something is in the destructive colour', async ({ page }) => {
  await page.addInitScript(() => {
    const provider = (endpoint: string) => ({
      endpoint,
      model: '',
      defaultEndpoint: endpoint,
      defaultModel: 'm',
      key: 'set',
    })
    window.devotIpcMocks = {
      ai_settings_get: () => ({
        active: 'anthropic',
        suggestOnIdle: false,
        anthropic: provider('https://a.example'),
        openai: provider('https://o.example'),
      }),
      licence_get: () => ({
        gated: true,
        state: 'valid',
        code: null,
        id: 'DEVOT-0123',
        licensee: 'Ada',
        plan: 'pro',
      }),
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
  const destructive = async (button: Locator) => {
    await expect(button).toBeVisible()
    const [color, expected] = await button.evaluate((el) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--color-phone-destructive)'
      el.parentElement!.append(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      return [getComputedStyle(el).color, value]
    })
    expect(color).toBe(expected)
  }
  await destructive((await openPane(page, 'Sync')).getByRole('button', { name: /^Remove Desk/ }))
  await destructive((await openPane(page, 'AI')).getByRole('button', { name: 'Remove Key' }))
  await destructive(
    (await openPane(page, 'License')).getByRole('button', { name: 'Remove License…' }),
  )
})

test('a device shows when it was added, its date in figures, and no This Device', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.devotIpcMocks = {
      sync_get: () => ({
        relayUrl: 'https://relay.example',
        enabled: true,
        vault: true,
        enrolled: true,
        status: { state: 'idle', lastSync: 1_700_000_000_000, code: null, pausedUntil: null },
      }),
      sync_devices: () => [
        { id: 'd1', label: 'This phone', created: 1_700_000_000_000, current: true },
      ],
      sync_recovery_key: () => null,
    }
  })
  const pane = await openPane(page, 'Sync')
  const meta = pane.locator('.sync-device .setting-description')
  await expect(meta).toHaveText(/^Added \S/)
  await expect(meta).not.toContainText('This Device')
  await expect(meta).not.toHaveCSS('font-family', /mono|Menlo/i)
  await expect(meta.locator('.phone-figures')).toHaveCSS('font-variant-numeric', 'tabular-nums')
  await expect(meta.locator('.phone-figures')).not.toHaveCSS('font-family', /mono|Menlo/i)
  await expect(meta.locator('.phone-figures')).not.toContainText('Added')
})

test('at twice the text size a Settings row puts its value under its whole label', async ({
  page,
}) => {
  await openSettings(page)
  await page.locator('.phone-app').evaluate((app) => {
    const shell = app
    shell.style.setProperty('--phone-text-scale', '2')
    shell.dataset['textSize'] = 'accessibility'
  })
  const row = root(page).getByRole('button', { name: /^Sync/ })
  const [label, value] = await Promise.all([
    row.locator('.phone-grouped-label').boundingBox(),
    row.locator('.phone-grouped-count').boundingBox(),
  ])
  expect(label!.height).toBeLessThan(17 * 2 * 1.5)
  expect(value!.y).toBeGreaterThanOrEqual(label!.y + label!.height - 1)
})

for (const name of ['Editing', 'Preview', 'Appearance', 'Sync', 'AI', 'License']) {
  test(`the ${name} pane leaves the page no wider than the screen and unable to pan sideways`, async ({
    page,
  }) => {
    await openPane(page, name)
    const scroller = () =>
      page.evaluate(() => {
        const el = document.scrollingElement!
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
      })
    const before = await scroller()
    expect(before.scrollWidth).toBeLessThanOrEqual(before.clientWidth)
    await page.mouse.move(195, 400)
    await page.mouse.wheel(300, 0)
    await page.evaluate(() => window.scrollTo(120, 0))
    expect(await page.evaluate(() => window.scrollX)).toBe(0)
  })
}
