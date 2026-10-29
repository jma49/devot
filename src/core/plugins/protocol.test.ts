import { describe, expect, it } from 'vitest'
import type { PluginPermission } from './manifest'
import { checkCall, checkResult, MAX_RENDER_CHARS, readMessage, type CallMessage } from './protocol'

const call = (method: string, params?: unknown): CallMessage => ({
  devot: 1,
  kind: 'call',
  seq: 1,
  method,
  params,
})

const context = (granted: PluginPermission[], active = true) => ({
  granted: new Set(granted),
  active,
})

describe('readMessage', () => {
  it('reads calls and results of protocol version 1', () => {
    expect(readMessage({ devot: 1, kind: 'call', seq: 3, method: 'ui.hide' })).toEqual({
      devot: 1,
      kind: 'call',
      seq: 3,
      method: 'ui.hide',
      params: undefined,
    })
    expect(readMessage({ devot: 1, kind: 'result', seq: 4, ok: true, value: 'x' })).toMatchObject({
      ok: true,
      value: 'x',
    })
    expect(readMessage({ devot: 1, kind: 'result', seq: 4, ok: false, code: 'E_X' })).toMatchObject(
      { ok: false, code: 'E_X' },
    )
  })

  it('never passes on a failure text that is not a code', () => {
    expect(
      readMessage({ devot: 1, kind: 'result', seq: 4, ok: false, code: 'secret note text' }),
    ).toMatchObject({ ok: false, code: 'E_PLUGIN_FAILED' })
  })

  it('ignores anything else', () => {
    for (const raw of [
      null,
      'x',
      { devot: 2, kind: 'call', seq: 1, method: 'ui.hide' },
      { devot: 1, kind: 'call', seq: -1, method: 'ui.hide' },
      { devot: 1, kind: 'call', seq: 1.5, method: 'ui.hide' },
      { devot: 1, kind: 'call', seq: 1 },
      { devot: 1, kind: 'other', seq: 1 },
      { devot: 1, kind: 'result', seq: 1, ok: 'yes' },
    ]) {
      expect(readMessage(raw)).toBeNull()
    }
  })
})

describe('checkCall', () => {
  it('refuses methods the protocol does not have, whatever the plugin was granted', () => {
    const all: PluginPermission[] = ['note.read', 'note.edit', 'commands']
    for (const method of ['invoke', 'tauri.invoke', 'note.list', 'notes.read', '__proto__', '']) {
      expect(checkCall(call(method), context(all))).toEqual({
        ok: false,
        code: 'E_PLUGIN_METHOD_UNKNOWN',
      })
    }
  })

  it('needs note.read to read the open note and note.edit to change it', () => {
    expect(checkCall(call('note.read'), context(['commands']))).toEqual({
      ok: false,
      code: 'E_PLUGIN_PERMISSION_DENIED',
    })
    expect(checkCall(call('note.read'), context(['note.read']))).toEqual({
      ok: true,
      call: { method: 'note.read' },
    })
    const replace = call('note.replace', { base: 'a', markdown: 'b' })
    expect(checkCall(replace, context(['note.read']))).toEqual({
      ok: false,
      code: 'E_PLUGIN_PERMISSION_DENIED',
    })
    expect(checkCall(replace, context(['note.edit']))).toEqual({
      ok: true,
      call: { method: 'note.replace', base: 'a', markdown: 'b' },
    })
  })

  it('takes note calls and shows a panel only while the plugin is active', () => {
    for (const method of ['note.read', 'ui.show']) {
      expect(checkCall(call(method), context(['note.read'], false))).toEqual({
        ok: false,
        code: 'E_PLUGIN_NOT_ACTIVE',
      })
    }
    expect(checkCall(call('ui.hide'), context([], false))).toEqual({
      ok: true,
      call: { method: 'ui.hide' },
    })
  })

  it('refuses malformed parameters', () => {
    const granted = context(['note.read', 'note.edit'])
    for (const bad of [
      call('note.read', { id: 'another note' }),
      call('note.read', []),
      call('note.replace', { markdown: 'b' }),
      call('note.replace', { base: 'a', markdown: 3 }),
      call('ui.show', { height: '200' }),
      call('ui.show', { height: 1.5 }),
    ]) {
      expect(checkCall(bad, granted)).toEqual({ ok: false, code: 'E_PLUGIN_MESSAGE_INVALID' })
    }
  })

  it('refuses a lone surrogate, which storage could never parse', () => {
    const granted = context(['note.read', 'note.edit'])
    for (const bad of [
      call('note.replace', { base: 'Trip', markdown: 'Trip \ud83c' }),
      call('note.replace', { base: 'Trip \ud83c', markdown: 'Trip' }),
    ]) {
      expect(checkCall(bad, granted)).toEqual({ ok: false, code: 'E_PLUGIN_MESSAGE_INVALID' })
    }
  })

  it('keeps a panel between its smallest and largest height', () => {
    expect(checkCall(call('ui.show', { height: 5 }), context([]))).toEqual({
      ok: true,
      call: { method: 'ui.show', height: 80 },
    })
    expect(checkCall(call('ui.show', { height: 10_000 }), context([]))).toEqual({
      ok: true,
      call: { method: 'ui.show', height: 640 },
    })
    expect(checkCall(call('ui.show'), context([]))).toEqual({
      ok: true,
      call: { method: 'ui.show', height: 320 },
    })
  })
})

describe('checkResult', () => {
  const invalid = (run: () => unknown) => expect(run).toThrow('E_PLUGIN_RESULT_INVALID')

  it('takes Markdown or nothing from a renderer, up to its limit', () => {
    expect(checkResult('preview.render', '**x**')).toBe('**x**')
    expect(checkResult('preview.render', null)).toBeNull()
    expect(checkResult('preview.render', undefined)).toBeNull()
    invalid(() => checkResult('preview.render', { html: '<b>' }))
    invalid(() => checkResult('preview.render', 'x'.repeat(MAX_RENDER_CHARS + 1)))
  })

  it('takes a title and Markdown from an import, the title on one line', () => {
    expect(checkResult('import.convert', { title: ' A\nB ', markdown: 'x' })).toEqual({
      title: 'A B',
      markdown: 'x',
    })
    invalid(() => checkResult('import.convert', { title: 'A' }))
    invalid(() => checkResult('import.convert', 'x'))
    invalid(() => checkResult('import.convert', { title: 'A', markdown: 'x \ud83c' }))
    invalid(() => checkResult('import.convert', { title: 'A \ud83c', markdown: 'x' }))
  })

  it('takes text from an export', () => {
    expect(checkResult('export.convert', '* x')).toBe('* x')
    invalid(() => checkResult('export.convert', 3))
  })
})
