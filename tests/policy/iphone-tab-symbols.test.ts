import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

it("the system tab bar draws the web tab bar's filled symbols", () => {
  const { symbols } = JSON.parse(read('design/icons/symbols.json')) as {
    symbols: Record<string, string>
  }
  const model = read('src-tauri/apple/DevotScreens/Sources/DevotScreens/Model/TabModel.swift')
  for (const tab of ['notes', 'library', 'activity', 'settings']) {
    expect(symbols[`phone.tab.${tab}.fill`]).toBe(`${symbols[`phone.tab.${tab}`]}.fill`)
    expect(model).toContain(`case .${tab}: "${symbols[`phone.tab.${tab}.fill`]}"`)
  }
})
