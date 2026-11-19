import { expect, test, openApp, statusPicker, bookPicker } from './fixtures'
import { failCoreCalls, holdLateReplies, releaseLateReplies, slowCore } from './slowCore'

test('reopening the displayed daily note replays early keys and leaves its body editable', async ({
  page,
}) => {
  await slowCore(page, ['openTodaysNote'])
  await openApp(page)
  await page.keyboard.press('Alt+Meta+KeyT')
  const body = page.getByRole('textbox', { name: 'Note body' })
  await expect(body).toBeEditable()
  await body.click()
  await page.keyboard.type('before')
  await holdLateReplies(page)
  await page.keyboard.press('Alt+Meta+KeyT')
  const pane = page.locator('main.content')
  await expect(pane).toHaveAttribute('inert', '')
  await page.keyboard.type('during')
  await releaseLateReplies(page)
  await expect(pane).not.toHaveAttribute('inert')
  await expect(body).toBeEditable()
  await expect(body).toContainText('beforeduring')
  await body.click()
  await page.keyboard.type('after')
  await expect(body).toContainText('beforeduringafter')
})

for (const fromTemplate of [false, true]) {
  test(`${fromTemplate ? 'template' : 'blank'} create protects the whole previous pane and keeps typed keys`, async ({
    page,
  }) => {
    await slowCore(page, ['create', 'applyTemplate'])
    await openApp(page)
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    const title = page.getByRole('textbox', { name: 'Title' })
    const body = page.getByRole('textbox', { name: 'Note body' })
    await title.fill('Previous note')
    await body.click()
    await page.keyboard.insertText('Previous body')
    const controls = [
      title,
      page.getByRole('combobox', { name: 'Add Tag' }),
      statusPicker(page),
      bookPicker(page),
    ]
    const boxes = await Promise.all(controls.map((control) => control.boundingBox()))
    await holdLateReplies(page)
    if (fromTemplate) {
      await page.keyboard.press('Meta+KeyT')
      const picker = page.getByRole('dialog', { name: 'New Note from Template' })
      await picker.getByRole('group', { name: 'Built-in' }).getByRole('option').first().dblclick()
    } else {
      await page.getByRole('button', { name: 'New Note', exact: true }).click()
    }
    const pane = page.locator('main.content')
    await expect(pane).toHaveAttribute('inert', '')
    for (const box of boxes) {
      expect(box).not.toBeNull()
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.keyboard.type('q')
    }
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await releaseLateReplies(page)
    await expect(pane).not.toHaveAttribute('inert')
    await expect(body).toContainText('qqqq')
    await page.getByRole('option', { name: /Previous note/ }).click()
    await expect(title).toHaveValue('Previous note')
    await expect(body).toHaveText('Previous body')
  })
}

test('a failed create releases the pane before giving the title its keyboard back', async ({
  page,
}) => {
  await slowCore(page, ['create'])
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const title = page.getByRole('textbox', { name: 'Title' })
  await title.fill('Previous note')
  await failCoreCalls(page, ['create'])
  await holdLateReplies(page)
  await title.press('Meta+KeyN')
  const pane = page.locator('main.content')
  await expect(pane).toHaveAttribute('inert', '')
  await page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise((done) => requestAnimationFrame(done))
    }
  })
  await page.keyboard.type('q')
  await releaseLateReplies(page)
  await expect(pane).not.toHaveAttribute('inert')
  await expect(title).toBeFocused()
  await expect(title).toHaveValue('Previous noteq')
})
