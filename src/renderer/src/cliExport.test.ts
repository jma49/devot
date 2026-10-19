import { describe, expect, it } from 'vitest'
import { exportPage, readSource } from './cliExport'

const source = { markdown: '# Plan\n\nSee *this*.\n', title: 'Trip', simple: false, print: false }

describe('the source of devot export', () => {
  it('is read as Rust sends it, and nothing else', () => {
    expect(readSource(source)).toEqual(source)
    expect(readSource({ ...source, title: null })).toEqual({ ...source, title: null })
    for (const value of [
      null,
      'text',
      { ...source, markdown: 1 },
      { ...source, title: 2 },
      { ...source, simple: 'yes' },
      { markdown: '', title: null, simple: false },
    ]) {
      expect(readSource(value)).toBeUndefined()
    }
  })
})

describe('the page of devot export', () => {
  it('is a document of its own, titled after the file', async () => {
    const html = await exportPage(source)
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html).toContain('<title>Trip</title>')
    expect(html).toContain('<em>this</em>')
    expect(html).toContain('<style>')
  })

  it('is Untitled from standard input', async () => {
    expect(await exportPage({ ...source, title: null })).toContain('<title>Untitled</title>')
  })

  it('is the bare markup when simple', async () => {
    const html = await exportPage({ ...source, simple: true })
    expect(html).not.toContain('<html')
    expect(html).not.toContain('class=')
    expect(html).toContain('<h1>Plan</h1>')
  })

  it('loads nothing from the web when it is printed', async () => {
    const html = await exportPage({
      ...source,
      markdown: '![shot](https://example.com/a.png)\n',
      print: true,
    })
    expect(html).toContain('img-src data:')
    expect(html).not.toContain('<img')
  })
})
