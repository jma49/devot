// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { engineLoader } from './loader'
import { registerEngine, type DrawingEngine } from './registry'

const SCRIPTS = { mermaid: '/m.js', plantuml: '/p.js', markmap: '/k.js' }

const drawing: DrawingEngine = async () => ({ type: 'rendered', svg: '<svg/>' })

function appendedScripts(): HTMLScriptElement[] {
  const appended: HTMLScriptElement[] = []
  vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
    appended.push(node as HTMLScriptElement)
    return node
  })
  return appended
}

afterEach(() => vi.restoreAllMocks())

it('loads an engine script once, as a classic script, and draws with what it registers', async () => {
  const appended = appendedScripts()
  const load = engineLoader(SCRIPTS)
  const first = load('plantuml')
  const second = load('plantuml')
  expect(appended).toHaveLength(1)
  expect(appended[0]!.getAttribute('src')).toBe('/p.js')
  expect(appended[0]!.type).toBe('')
  registerEngine('plantuml', drawing)
  appended[0]!.onload?.(new Event('load'))
  await expect(first).resolves.toBe(drawing)
  await expect(second).resolves.toBe(drawing)
  await expect(load('plantuml')).resolves.toBe(drawing)
  expect(appended).toHaveLength(1)
})

it('fails a drawing whose script does not load, and asks for the script again with the next one', async () => {
  const appended = appendedScripts()
  const load = engineLoader(SCRIPTS)
  const failed = load('markmap')
  const removed = vi.spyOn(appended[0]!, 'remove')
  appended[0]!.onerror?.(new Event('error'))
  await expect(failed).rejects.toThrow('E_DIAGRAM_ENGINE')
  expect(removed).toHaveBeenCalled()

  const retried = load('markmap')
  expect(appended).toHaveLength(2)
  registerEngine('markmap', drawing)
  appended[1]!.onload?.(new Event('load'))
  await expect(retried).resolves.toBe(drawing)
})

it('fails a drawing whose script loads but registers no engine, and asks again next time', async () => {
  const appended = appendedScripts()
  const load = engineLoader(SCRIPTS, () => undefined)
  const failed = load('mermaid')
  appended[0]!.onload?.(new Event('load'))
  await expect(failed).rejects.toThrow('E_DIAGRAM_ENGINE')
  void load('mermaid').catch(() => undefined)
  expect(appended).toHaveLength(2)
})
