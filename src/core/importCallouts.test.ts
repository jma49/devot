import { describe, expect, it } from 'vitest'
import { calloutsAsAlerts } from './importCallouts'

describe('calloutsAsAlerts', () => {
  it('maps each callout kind to the nearest of the five alerts', () => {
    const kind = (name: string) => calloutsAsAlerts(`> [!${name}]\n> Body`).split('\n')[0]
    for (const name of [
      'note',
      'info',
      'abstract',
      'summary',
      'tldr',
      'todo',
      'example',
      'quote',
      'cite',
    ])
      expect(kind(name)).toBe('> [!NOTE]')
    for (const name of ['tip', 'hint', 'success', 'check', 'done'])
      expect(kind(name)).toBe('> [!TIP]')
    for (const name of ['important', 'question', 'help', 'faq'])
      expect(kind(name)).toBe('> [!IMPORTANT]')
    for (const name of ['warning', 'caution', 'attention']) expect(kind(name)).toBe('> [!WARNING]')
    for (const name of ['danger', 'error', 'bug', 'failure', 'fail', 'missing'])
      expect(kind(name)).toBe('> [!CAUTION]')
  })

  it('reads the kind in any case, and an unknown kind as a note', () => {
    expect(calloutsAsAlerts('> [!Warning]\n> Hot')).toBe('> [!WARNING]\n> Hot')
    expect(calloutsAsAlerts('> [!recipe]\n> Flour')).toBe('> [!NOTE]\n> Flour')
  })

  it('puts a title on a bold line of its own and drops the fold marker', () => {
    expect(calloutsAsAlerts('> [!tip]- Read this first\n> Body')).toBe(
      '> [!TIP]\n> **Read this first**\n> Body',
    )
    expect(calloutsAsAlerts('> [!faq]+\n> Why?')).toBe('> [!IMPORTANT]\n> Why?')
  })

  it('converts a callout nested in a quote or another callout', () => {
    expect(calloutsAsAlerts('> [!note]\n> Outer\n> > [!bug] Inner\n> > Body')).toBe(
      '> [!NOTE]\n> Outer\n> > [!CAUTION]\n> > **Inner**\n> > Body',
    )
  })

  it('leaves alerts, plain quotes, code and text alone', () => {
    const kept = [
      '> [!NOTE]\n> Already an alert',
      '> A quote\n> [!tip] in the middle',
      '```\n> [!tip] in code\n```',
      'Text with [!tip] inline',
    ].join('\n\n')
    expect(calloutsAsAlerts(kept)).toBe(kept)
  })

  it('keeps CRLF line endings', () => {
    expect(calloutsAsAlerts('> [!info] Title\r\n> Body\r\n')).toBe(
      '> [!NOTE]\r\n> **Title**\r\n> Body\r\n',
    )
  })
})
