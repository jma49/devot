import { afterEach, describe, expect, it } from 'vitest'
import { effectiveKeymap } from '../commands/keymap'
import { setCommandKeys } from '../commands/registry'
import { TOOLBAR_GROUPS, toolbarTip } from './toolbarButtons'

const tipOf = (id: string) => toolbarTip(TOOLBAR_GROUPS.flat().find((b) => b.id === id)!)

describe('the selection toolbar buttons', () => {
  afterEach(() => setCommandKeys(undefined))

  it('come in three groups, in order', () => {
    expect(TOOLBAR_GROUPS.map((group) => group.map((b) => b.id))).toEqual([
      ['heading', 'bold', 'italic', 'strikethrough', 'highlight', 'link'],
      ['code', 'codeBlock'],
      ['bulletList', 'numberedList', 'taskList', 'quote', 'alert'],
    ])
  })

  it('show the command name and its key from the registry', () => {
    expect(tipOf('bold')).toEqual({ title: 'Bold', key: '⌘B' })
    expect(tipOf('link')).toEqual({ title: 'Link', key: '⌥⌘K' })
    expect(tipOf('codeBlock')).toEqual({ title: 'Code Block', key: '⇧⌘C' })
  })

  it('show a rebound key', () => {
    setCommandKeys(effectiveKeymap({ 'format.bold': ['Mod+Alt+J'] }))
    expect(tipOf('bold')).toEqual({ title: 'Bold', key: '⌥⌘J' })
  })

  it('show no key for Heading, Highlight and Alert', () => {
    for (const id of ['heading', 'highlight', 'alert']) expect(tipOf(id).key).toBeUndefined()
  })
})
