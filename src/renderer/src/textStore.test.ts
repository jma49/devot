import { describe, expect, it } from 'vitest'
import { textStore } from './textStore'

function frames() {
  const queued: (() => void)[] = []
  return {
    next: (run: () => void) => void queued.push(run),
    run: () => {
      for (const run of queued.splice(0)) run()
    },
  }
}

describe('textStore', () => {
  it('holds the latest text and tells only current subscribers', () => {
    const frame = frames()
    const store = textStore('', frame.next)
    expect(store.get()).toBe('')
    const heard: string[] = []
    const stop = store.subscribe(() => heard.push(store.get()))
    store.changed(() => 'a')
    frame.run()
    store.changed(() => 'ab')
    frame.run()
    stop()
    store.changed(() => 'abc')
    frame.run()
    expect(heard).toEqual(['a', 'ab'])
    expect(store.get()).toBe('abc')
  })

  it('reads a changed text only when asked, once per change', () => {
    const store = textStore('', frames().next)
    let reads = 0
    const reader = (text: string) => () => {
      reads += 1
      return text
    }
    store.changed(reader('a'))
    store.changed(reader('ab'))
    expect(reads).toBe(0)
    expect(store.get()).toBe('ab')
    expect(store.get()).toBe('ab')
    expect(reads).toBe(1)
  })

  it('tells subscribers of changes once per frame', () => {
    const frame = frames()
    const store = textStore('', frame.next)
    const heard: string[] = []
    store.subscribe(() => heard.push(store.get()))
    for (const text of ['a', 'ab', 'abc']) store.changed(() => text)
    expect(heard).toEqual([])
    frame.run()
    expect(heard).toEqual(['abc'])
    store.changed(() => 'abcd')
    frame.run()
    expect(heard).toEqual(['abc', 'abcd'])
  })

  it('asks for no frame while nothing subscribes', () => {
    let asked = 0
    const store = textStore('', () => (asked += 1))
    store.changed(() => 'a')
    expect(asked).toBe(0)
    expect(store.get()).toBe('a')
  })
})
