import type { Locator, Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

const DOC = 'Some `inline` code.\n\n```\nplain block\n```\n\n```ts\nconst titled = 1\n```\n\nAfter.'

async function openNote(page: Page) {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(DOC)
}

const showPreview = (page: Page) =>
  page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Preview', exact: true })
    .click()

const tokenColour = (page: Page, name: string) =>
  page.evaluate((token) => {
    const probe = document.createElement('div')
    probe.style.background = `var(${token})`
    document.body.append(probe)
    const colour = getComputedStyle(probe).backgroundColor
    probe.remove()
    return colour
  }, name)

const addTag = (page: Page) => page.getByRole('combobox', { name: 'Add Tag' })

async function expectFilledPill(pill: Locator, fill: string) {
  await expect(pill).toHaveCSS('border-top-width', '0px')
  await expect(pill).toHaveCSS('height', '26px')
  await expect(pill).toHaveCSS('background-color', fill)
}

test('Glass pills are filled capsules with no border; a coloured tag keeps its tint', async ({
  page,
}) => {
  await openNote(page)
  const fill = await tokenColour(page, '--color-fill-card')
  const pills = page.locator('.note-meta .popup')
  await expect(pills).toHaveCount(2)
  for (const pill of await pills.all()) await expectFilledPill(pill, fill)

  const hovered = await tokenColour(page, '--color-fill-tool-hover')
  await pills.first().hover()
  await expect(pills.first()).toHaveCSS('background-color', hovered)

  await addTag(page).fill('plain')
  await addTag(page).press('Enter')
  const chip = page.locator('.note-meta .chip')
  await expectFilledPill(chip, fill)
  await expect(chip).toHaveCSS('padding-left', '10px')
  await expect(chip).toHaveCSS('padding-right', '10px')
  await chip.hover()
  await expect(chip).toHaveCSS('background-color', hovered)

  await page.mouse.move(0, 0)
  await chip.evaluate((el) => {
    el.classList.add('tag-chip')
    ;(el as HTMLElement).style.setProperty('--tag-color', 'rgb(200, 0, 0)')
  })
  await expect(chip).toHaveCSS('border-top-width', '0px')
  await expect(chip).toHaveCSS('height', '26px')
  await expect(chip).not.toHaveCSS('background-color', fill)
})

test('a tag pill is symmetric at rest and its x shows over the label without a change of width', async ({
  page,
}) => {
  await openNote(page)
  await addTag(page).fill('plain')
  await addTag(page).press('Enter')
  const chip = page.locator('.note-meta .chip')
  const label = chip.locator('.chip-label')
  const remove = chip.getByRole('button', { name: 'Remove Tag plain' })
  const cover = () =>
    label.evaluate((el) => getComputedStyle(el).getPropertyValue('--chip-label-cover').trim())
  await page.mouse.move(0, 0)
  await expect(remove).toHaveCSS('opacity', '0')
  await expect.poll(cover).toBe('0px')
  const rest = await chip.boundingBox()
  if (!rest) throw new Error('no box')

  for (const reveal of [() => chip.hover(), () => remove.focus()]) {
    await page.mouse.move(0, 0)
    await reveal()
    await expect(remove).toHaveCSS('opacity', '1')
    await expect.poll(cover).toBe('14px')
    const pill = await chip.boundingBox()
    const x = await remove.boundingBox()
    if (!pill || !x) throw new Error('no box')
    expect(pill.width).toBe(rest.width)
    expect([x.width, x.height]).toEqual([16, 16])
    expect(Math.round(pill.x + pill.width - (x.x + x.width))).toBe(5)
    expect(Math.round(x.y - pill.y)).toBe(5)
    await remove.blur()
  }
})

test('Add Tag is plain tertiary text at rest and shows a dashed ring on the keyboard', async ({
  page,
}) => {
  await openNote(page)
  const input = addTag(page)
  const label = page.locator('.note-meta .tag-field-short')
  await expect(label).toHaveText('+ Tag')
  await expect(label).toHaveCSS('padding-left', '8px')
  await expect(label).toHaveCSS('padding-right', '8px')
  await expect(label).toHaveCSS('color', await tokenColour(page, '--color-text-tertiary'))
  await expect(input).toHaveCSS('border-top-width', '0px')
  await expect(input).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(input).toHaveCSS('outline-style', 'none')
  await expect(page.locator('.note-meta .tag-field-plus')).toBeHidden()

  const field = await page.locator('.note-meta .tag-field').boundingBox()
  const box = await input.boundingBox()
  expect(box?.width).toBeCloseTo(field?.width ?? 0, 0)
  expect(box?.height).toBe(26)

  await input.focus()
  await expect(label).toBeHidden()
  await expect(input).toHaveCSS('outline-style', 'dashed')
  await expect(input).toHaveCSS('outline-width', '2px')
  await expect(input).toHaveCSS('outline-color', await tokenColour(page, '--color-focus-ring'))
  await expect(input).toHaveCSS('border-top-width', '0px')

  await input.pressSequentially('kept')
  await input.blur()
  expect((await input.boundingBox())?.width ?? 0).toBeGreaterThan(40)
  await expect(input).toHaveCSS('outline-style', 'none')
})

test('Glass code in the editor and the preview is filled with no border', async ({ page }) => {
  await openNote(page)
  const editorInline = page.locator('.cm-md-code').first()
  await expect(editorInline).toHaveCSS('border-top-width', '0px')
  await expect(editorInline).toHaveCSS('border-top-left-radius', '5px')

  const boxEdge = (selector: string, property: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el, name) => getComputedStyle(el, '::before').getPropertyValue(name), property)
  expect(await boxEdge('.cm-line.cm-codeblock-first', 'border-top-width')).toBe('0px')
  expect(await boxEdge('.cm-line.cm-codeblock-first', 'border-left-width')).toBe('0px')
  expect(await boxEdge('.cm-line.cm-codeblock-first', 'border-top-left-radius')).toBe('12px')
  expect(await boxEdge('.cm-line.cm-codeblock-last', 'border-bottom-width')).toBe('0px')
  expect(await boxEdge('.cm-line.cm-codeblock-last', 'border-bottom-left-radius')).toBe('12px')

  await showPreview(page)

  const plain = page.locator('.preview pre').first()
  const block = page.locator('.preview .code-block')
  const inline = page.locator('.preview p > code')
  await expect(block).toHaveCount(1)
  for (const boxed of [plain, block]) {
    await expect(boxed).toHaveCSS('border-top-width', '0px')
    await expect(boxed).toHaveCSS('border-left-width', '0px')
    await expect(boxed).toHaveCSS('border-top-left-radius', '12px')
    await expect(boxed).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  }
  await expect(inline).toHaveCSS('border-top-width', '0px')
  await expect(inline).toHaveCSS('border-top-left-radius', '5px')
  await expect(inline).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
})

test('Glass Edit mode draws a table box with fill only and list-row corners', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText('| a |\n| - |\n| b |\n\nAfter.')
  await expect(page.locator('.cm-md-table-first')).toHaveCount(1)
  const edge = (selector: string, property: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el, name) => getComputedStyle(el, '::before').getPropertyValue(name), property)
  const fill = await tokenColour(page, '--color-code-block-bg')
  expect(await edge('.cm-md-table-first', 'background-color')).toBe(fill)
  for (const side of ['top', 'right', 'bottom', 'left'])
    expect(await edge('.cm-md-table-first', `border-${side}-width`)).toBe('0px')
  expect(await edge('.cm-md-table-first', 'border-top-left-radius')).toBe('12px')
  expect(await edge('.cm-md-table-last', 'border-bottom-width')).toBe('0px')
  expect(await edge('.cm-md-table-last', 'border-bottom-right-radius')).toBe('12px')
})

test('the Write button takes the toolbar hover wash, pressed or not', async ({ page }) => {
  await openNote(page)
  const write = page.getByRole('button', { name: 'Write Mode' })
  const more = page.getByRole('button', { name: 'More', exact: true })
  const hovered = async (button: Locator) => {
    await button.hover()
    await expect(button).toHaveCSS('box-shadow', /1\d{3}px inset/)
    return button.evaluate((el) => {
      const style = getComputedStyle(el)
      return { background: style.backgroundColor, shadow: style.boxShadow }
    })
  }
  const wash = await tokenColour(page, '--color-fill-tool-hover')
  const expected = await hovered(more)
  expect(expected.shadow).toContain(wash)
  for (const pressed of ['false', 'true']) {
    await expect(write).toHaveAttribute('aria-pressed', pressed)
    expect(await hovered(write)).toEqual(expected)
    await write.click()
  }
})

test('tables and alerts keep their edges', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText('| a |\n| - |\n| b |\n\n> [!NOTE]\n> About.')
  await showPreview(page)
  await expect(page.locator('.preview table')).toHaveCSS('box-shadow', /1px/)
  await expect(page.locator('.preview .alert')).toHaveCSS('box-shadow', /inset/)
})
