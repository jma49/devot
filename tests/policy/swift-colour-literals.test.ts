import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { colourLiterals } from '../../scripts/tokens/swift-literals'
import { listFiles } from '../support/git-files'

it('Swift code takes its colours from the generated tokens', () => {
  const files = listFiles('.', 'src-tauri').filter((file) => file.endsWith('.swift'))
  expect(files.length).toBeGreaterThan(0)
  expect(files.flatMap((file) => colourLiterals(file, readFileSync(file, 'utf8')))).toEqual([])
})

it('catches every colour literal form outside Generated/', () => {
  const code = [
    'let a = UIColor(red: 1, green: 0, blue: 0, alpha: 1)',
    'let b = Color(red: 0.2, green: 0.2, blue: 0.2)',
    'let c = Color(hex: 0xffffff)',
    'let d = UIColor(white: 0, alpha: 0.5)',
    'let e = #colorLiteral(red: 1, green: 1, blue: 1, alpha: 1)',
    'let f = Tokens.Color.phoneBackground',
  ].join('\n')
  expect(colourLiterals('apple/DevotScreens/Sources/DevotScreens/UI/Row.swift', code)).toEqual([
    'apple/DevotScreens/Sources/DevotScreens/UI/Row.swift:1',
    'apple/DevotScreens/Sources/DevotScreens/UI/Row.swift:2',
    'apple/DevotScreens/Sources/DevotScreens/UI/Row.swift:3',
    'apple/DevotScreens/Sources/DevotScreens/UI/Row.swift:4',
    'apple/DevotScreens/Sources/DevotScreens/UI/Row.swift:5',
  ])
  expect(
    colourLiterals('apple/DevotScreens/Sources/DevotScreens/Generated/Tokens.swift', code),
  ).toEqual([])
})
