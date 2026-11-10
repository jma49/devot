import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const assets = 'src-tauri/apple/DevotScreens/Sources/DevotScreens/Resources/Brand.xcassets'

describe("the iPhone screens' brand assets", () => {
  it.each([
    ['AppMark.imageset/AppMark.svg', 'design/app-icon/source-ios.svg'],
    ['Dove.imageset/Dove.svg', 'design/app-icon/dove.svg'],
  ])('keep %s equal to %s', (copy, source) => {
    expect(readFileSync(`${assets}/${copy}`, 'utf8')).toBe(readFileSync(source, 'utf8'))
  })
})
