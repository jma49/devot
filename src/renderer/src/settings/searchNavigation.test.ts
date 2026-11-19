// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { focusSetting, searchKey, waitForSetting } from './searchNavigation'

describe('settings search navigation', () => {
  it('moves within results and opens the highlighted result', () => {
    const key = (name: string) => ({ key: name, keyCode: 0, isComposing: false })
    expect(searchKey(key('ArrowDown'), 0, 3)).toEqual({ type: 'select', index: 1 })
    expect(searchKey(key('ArrowUp'), 0, 3)).toEqual({ type: 'select', index: 2 })
    expect(searchKey(key('Enter'), 2, 3)).toEqual({ type: 'open', index: 2 })
    expect(searchKey(key('ArrowDown'), 0, 0)).toBeUndefined()
    expect(searchKey(key('Enter'), 0, 0)).toBeUndefined()
    expect(searchKey(key('Escape'), 0, 0)).toEqual({ type: 'clear' })
  })

  it('leaves composition keys to the input method', () => {
    for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
      expect(searchKey({ key, keyCode: 0, isComposing: true }, 0, 3)).toBeUndefined()
      expect(searchKey({ key, keyCode: 229, isComposing: false }, 0, 3)).toBeUndefined()
    }
  })

  it('scrolls the specific row and focuses its control, including in the current pane', () => {
    const body = document.createElement('div')
    body.innerHTML =
      '<div class="setting"><label>Other</label><input></div><div class="setting"><label>Tab size</label><select><option>4</option></select></div>'
    document.body.append(body)
    const row = body.children[1] as HTMLElement
    row.scrollIntoView = vi.fn<HTMLElement['scrollIntoView']>()
    expect(focusSetting(body, 'Tab size')).toBe(true)
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' })
    expect(document.activeElement).toBe(row.querySelector('select'))
    expect(focusSetting(body, 'Missing')).toBe(false)
    body.remove()
  })

  it('focuses a noninteractive or disabled setting without changing its value', () => {
    const body = document.createElement('div')
    body.innerHTML =
      '<div class="setting"><span>Unavailable</span><button disabled>Choose</button></div>'
    document.body.append(body)
    const row = body.firstElementChild as HTMLElement
    row.scrollIntoView = vi.fn<HTMLElement['scrollIntoView']>()
    expect(focusSetting(body, 'Unavailable')).toBe(true)
    expect(document.activeElement).toBe(row)
    row.blur()
    expect(row.hasAttribute('tabindex')).toBe(false)
    body.remove()
  })

  it('retries a pending setting when its async row appears and can cancel the request', async () => {
    const body = document.createElement('div')
    body.scrollIntoView = vi.fn<HTMLElement['scrollIntoView']>()
    document.body.append(body)
    const done = vi.fn<() => void>()
    const cancel = waitForSetting(body, 'Port', done)
    await Promise.resolve()
    expect(document.activeElement).toBe(body)
    const row = document.createElement('div')
    row.className = 'setting'
    row.innerHTML = '<label>Port</label><input>'
    row.scrollIntoView = vi.fn<HTMLElement['scrollIntoView']>()
    body.append(row)
    await vi.waitFor(() => expect(document.activeElement).toBe(row.querySelector('input')))
    expect(done).toHaveBeenCalledOnce()
    cancel()
    const cancelled = vi.fn<() => void>()
    const stop = waitForSetting(body, 'Other', cancelled)
    stop()
    await Promise.resolve()
    expect(cancelled).not.toHaveBeenCalled()
    body.remove()
  })

  it('expires a missing target and stops observing on cancellation', async () => {
    vi.useFakeTimers()
    const body = document.createElement('div')
    document.body.append(body)
    const done = vi.fn<() => void>()
    const cancel = waitForSetting(body, 'Missing', done)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5000)
    expect(done).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    cancel()
    const cancelled = vi.fn<() => void>()
    const stop = waitForSetting(body, 'Missing', cancelled)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(cancelled).not.toHaveBeenCalled()
    body.remove()
    vi.useRealTimers()
  })
})
