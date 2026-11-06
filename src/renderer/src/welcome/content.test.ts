import { describe, expect, it } from 'vitest'
import { WELCOME_BOOK_ID, welcomeSeed } from '../../../core'
import { noteLinks } from '../../../core/links'
import { toBase64 } from '../storage/wire'
import { fillWelcome, welcomeContent } from './content'

describe('first-launch content', () => {
  it('fills every key and ID placeholder from the registry', () => {
    const { notes } = welcomeContent()
    expect(notes).toHaveLength(2)
    for (const note of notes) expect(note.body).not.toMatch(/\{\{/)
    expect(notes[0]?.body).toContain('⌘N')
    expect(notes[1]?.body).toContain('devot://note/')
    expect(notes[1]?.files?.[0]?.data.length).toBeGreaterThan(0)
  })

  it('refuses an unknown placeholder', () => {
    expect(() => fillWelcome('{{key:no.such}}')).toThrow('E_WELCOME_PLACEHOLDER')
    expect(() => fillWelcome('{{id:nobody}}')).toThrow('E_WELCOME_PLACEHOLDER')
  })

  // Rust writes this copy, never the window's, so a library without a licence takes these notes and no others.
  // After changing the text, `pnpm vitest run src/renderer/src/welcome -u` writes it again.
  it('is the seed the app bundles', async () => {
    const seed = welcomeSeed(welcomeContent(), '', 0)
    const bundled = {
      bookId: WELCOME_BOOK_ID,
      bookName: seed.bookName,
      notes: seed.notes.map(({ ydoc, ...note }) => ({
        ...note,
        ydoc: toBase64(ydoc),
        links: noteLinks(note.bodyMd),
      })),
      files: seed.files.map(({ data, ...file }) => ({ ...file, data: toBase64(data) })),
    }
    await expect(`${JSON.stringify(bundled, null, 2)}\n`).toMatchFileSnapshot(
      '../../../../src-tauri/src/commands/welcome_seed.json',
    )
  })
})
