import { describe, expect, it } from 'vitest'
import { en } from '../en'
import { enPhone } from '../phone'
import { zhHans, zhHansPhone } from '.'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('the Simplified Chinese catalog', () => {
  it('translates every English key and no other', () => {
    expect(Object.keys(zhHans).sort()).toEqual(Object.keys(en).sort())
  })

  it('keeps the placeholders of each English message', () => {
    const differ = Object.entries(en as Record<string, string>).filter(
      ([key, text]) =>
        placeholders(zhHans[key as keyof typeof en]).join() !== placeholders(text).join(),
    )
    expect(differ.map(([key]) => key)).toEqual([])
  })

  it('leaves no message empty that has English text', () => {
    const empty = Object.entries(en as Record<string, string>).filter(
      ([key, text]) => text !== '' && zhHans[key as keyof typeof en].trim() === '',
    )
    expect(empty.map(([key]) => key)).toEqual([])
  })

  it('has an iPhone wording for each English one, and none names the Mac', () => {
    expect(Object.keys(zhHansPhone).sort()).toEqual(Object.keys(enPhone).sort())
    const naming = Object.entries(zhHansPhone).filter(([, text]) => /Mac|macOS|系统设置/.test(text))
    expect(naming).toEqual([])
    const differ = Object.entries(enPhone).filter(
      ([key, text]) =>
        placeholders(zhHansPhone[key as keyof typeof en] ?? '').join() !==
        placeholders(text).join(),
    )
    expect(differ.map(([key]) => key)).toEqual([])
  })

  it('writes the menu ellipsis as one character, as English does', () => {
    const dots = Object.entries(zhHans).filter(([, text]) => text.includes('...'))
    expect(dots.map(([key]) => key)).toEqual([])
  })
})
