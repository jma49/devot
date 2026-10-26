import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { shownGroups } from '../contextMenu'
import { t } from '../i18n'
import {
  EDITOR_MENU,
  editorMenuShows,
  editorMenuTarget,
  spellingWordAt,
  type EditorMenuTarget,
} from './editorMenu'
import { noteMarkdown } from './markdown'

function state(doc: string, from: number, to = from): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.range(from, to),
    extensions: [noteMarkdown],
  })
}

const groupsFor = (target: EditorMenuTarget) =>
  shownGroups(EDITOR_MENU, target).map((group) =>
    group.map((entry) =>
      entry.predefined ? entry.predefined : (entry.text?.(target) ?? t(entry.label as never)),
    ),
  )

const plain: EditorMenuTarget = {
  link: null,
  selection: null,
  canMakeNote: false,
  canAiEdit: false,
}

describe('the editor menu', () => {
  it('without a selection or a link has the edit items and Speech', () => {
    expect(groupsFor(plain)).toEqual([
      ['Undo', 'Redo'],
      ['Cut', 'Copy', 'Paste', 'Paste as Plain Text', 'SelectAll'],
      ['Speech'],
    ])
  })

  it('on a link starts with Open Link and Copy Link Address', () => {
    expect(groupsFor({ ...plain, link: 'https://example.com' })[0]).toEqual([
      'Open Link',
      'Copy Link Address',
    ])
  })

  it('on a link the app does not open offers only Copy Link Address', () => {
    for (const link of ['http://example.com', 'mailto:a@b.c', 'other.md']) {
      expect(groupsFor({ ...plain, link })[0]).toEqual(['Copy Link Address'])
    }
    expect(
      groupsFor({ ...plain, link: 'devot://note/0192a6f0-0000-7000-8000-000000000001' })[0],
    ).toEqual(['Open Link', 'Copy Link Address'])
  })

  it('with a selection offers Look Up (the text cut short) and New Note from Selection', () => {
    const target: EditorMenuTarget = { ...plain, selection: 'word', canMakeNote: true }
    expect(groupsFor(target).slice(0, 2)).toEqual([['Look Up “word”'], ['New Note from Selection']])
    const long: EditorMenuTarget = { ...target, selection: `${'a'.repeat(40)}\n  b` }
    expect(groupsFor(long)[0]).toEqual([`Look Up “${'a'.repeat(24)}…”`])
  })

  it('leaves New Note from Selection out where a note cannot be made', () => {
    const target: EditorMenuTarget = { ...plain, selection: 'word', canMakeNote: false }
    expect(editorMenuShows('lookUp', target)).toBe(true)
    expect(editorMenuShows('newNote', target)).toBe(false)
  })

  it('with a selection AI may edit offers Edit with AI, a submenu of the presets', () => {
    const target: EditorMenuTarget = { ...plain, selection: 'word', canAiEdit: true }
    expect(groupsFor(target)[1]).toEqual(['Edit with AI'])
    expect(editorMenuShows('ai', { ...target, canAiEdit: false })).toBe(false)
    const ai = EDITOR_MENU.flat().find((entry) => entry.action === 'ai')!
    expect(ai.submenu!.map((entry) => t(entry.label as never))).toEqual([
      'Improve Writing',
      'Proofread',
      'Reformat',
      'Summarise',
      'Make Bullet List',
      'Make Task List',
      'Make Table',
      'Add Headings',
      'Create Mermaid Diagram',
      'Custom Instruction\u2026',
    ])
  })

  it('puts the groups in order: link, look up, note, undo, clipboard, speech', () => {
    const all: EditorMenuTarget = {
      link: 'https://a.example',
      selection: 'x',
      canMakeNote: true,
      canAiEdit: true,
    }
    expect(groupsFor(all).map((g) => g.length)).toEqual([2, 1, 2, 2, 5, 1])
  })
})

describe('the menu target', () => {
  it('finds the link at the point and the selected text', () => {
    const doc = 'see [link](https://example.com/a) here'
    const target = editorMenuTarget(state(doc, 4, 10), 8, true)
    expect(target).toEqual({
      link: 'https://example.com/a',
      selection: '[link]',
      canMakeNote: true,
      canAiEdit: false,
    })
    expect(editorMenuTarget(state(doc, 4, 10), 8, true, true).canAiEdit).toBe(true)
  })

  it('has no link away from one, or without a point', () => {
    const s = state('plain text and [x](https://e.com)', 0)
    expect(editorMenuTarget(s, 1, true).link).toBeNull()
    expect(editorMenuTarget(s, null, true).link).toBeNull()
  })

  it('has no selection for a caret or white space', () => {
    expect(editorMenuTarget(state('a b', 2), 0, true, true)).toMatchObject({
      selection: null,
      canMakeNote: false,
      canAiEdit: false,
    })
    expect(editorMenuTarget(state('a b', 1, 2), 0, true).selection).toBeNull()
  })

  it('offers no new note where the window cannot make one', () => {
    expect(editorMenuTarget(state('word', 0, 4), 0, false)).toMatchObject({
      selection: 'word',
      canMakeNote: false,
    })
  })
})

describe('the word the menu offers spelling guesses for', () => {
  it('is the word at the point, with no selection or with that word selected', () => {
    expect(spellingWordAt(state('I recieve mail', 4), 4)).toEqual({
      from: 2,
      to: 9,
      text: 'recieve',
    })
    expect(spellingWordAt(state('I recieve mail', 2, 9), 5)?.text).toBe('recieve')
    expect(spellingWordAt(state('un caf\u00e9', 5), 5)?.text).toBe('caf\u00e9')
  })

  it('is none away from a word, with another selection, or for what is not a word', () => {
    expect(spellingWordAt(state('one two', 0), null)).toBeNull()
    expect(spellingWordAt(state('one  two', 4), 4)).toBeNull()
    expect(spellingWordAt(state('one two', 0, 7), 1)).toBeNull()
    expect(spellingWordAt(state('abc123 x', 1), 1)).toBeNull()
    expect(spellingWordAt(state('x'.repeat(101), 1), 1)).toBeNull()
  })

  it('is none in a note that cannot change, where picking a guess would do nothing', () => {
    const locked = EditorState.create({
      doc: 'I recieve mail',
      selection: EditorSelection.cursor(4),
      extensions: [noteMarkdown, EditorState.readOnly.of(true)],
    })
    expect(spellingWordAt(locked, 4)).toBeNull()
  })
})
