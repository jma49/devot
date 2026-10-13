import { describe, expect, it } from 'vitest'
import { textStore } from './textStore'

describe('textStore', () => {
  it('holds the latest text and tells only current subscribers', () => {
    const store = textStore()
    expect(store.get()).toBe('')
    const heard: string[] = []
    const stop = store.subscribe(() => heard.push(store.get()))
    store.set('a')
    store.set('ab')
    stop()
    store.set('abc')
    expect(heard).toEqual(['a', 'ab'])
    expect(store.get()).toBe('abc')
  })

  it('does not tell subscribers about the same text again', () => {
    const store = textStore()
    let told = 0
    store.subscribe(() => (told += 1))
    store.set('same')
    store.set('same')
    expect(told).toBe(1)
  })
})
