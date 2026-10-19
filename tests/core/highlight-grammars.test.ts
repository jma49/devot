import hljs from 'highlight.js'
import { describe, expect, it } from 'vitest'
import { grammarsSource } from '../../scripts/preview/grammars'
import { GRAMMARS, GRAMMAR_ALIASES } from '../../src/core/preview/grammars'
import { highlight } from '../../src/core/preview/highlight'
import { previewTree } from '../support/preview-html'

describe('lazily loaded grammars', () => {
  it('lists every grammar highlight.js ships, with its aliases (run `pnpm grammars`)', () => {
    const names = hljs.listLanguages().sort()
    expect(Object.keys(GRAMMARS).sort()).toEqual(names)
    for (const name of names) {
      for (const alias of hljs.getLanguage(name)?.aliases ?? []) {
        const key = alias.toLowerCase()
        if (key === name || names.includes(key)) continue
        // Two grammars can share an alias; either one is a fair answer.
        const owner = GRAMMAR_ALIASES[key] ?? ''
        const owned = (hljs.getLanguage(owner)?.aliases ?? []).map((a) => a.toLowerCase())
        expect(owned).toContain(key)
      }
    }
    expect(grammarsSource()).toContain('highlight.js/lib/languages/nix')
  })

  it('highlights a grammar the old fixed set lacked, also through an alias', async () => {
    const nix = await highlight('nix', 'let x = 1; in x')
    expect(JSON.stringify(nix)).toContain('hljs-keyword')
    const elm = await highlight('ELM', 'module Main exposing (main)')
    expect(JSON.stringify(elm)).toContain('hljs-keyword')
    const viaAlias = await highlight('hs', 'main = putStrLn "x"')
    expect(JSON.stringify(viaAlias)).toContain('hljs-string')
  })

  it('leaves an unknown language, or a prototype key, as plain text', async () => {
    expect(await highlight('brainfork', '+++')).toBeNull()
    expect(await highlight('constructor', '+++')).toBeNull()
    expect(await highlight('__proto__', '+++')).toBeNull()
  })

  it('highlights such a block in the preview', async () => {
    const tree = await previewTree('```nix\nlet x = 1; in x\n```')
    expect(JSON.stringify(tree)).toContain('hljs-keyword')
  })
})
