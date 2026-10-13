import { describe, expect, it } from 'vitest'
import { latestOnly } from './latest'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('latestOnly', () => {
  it('runs at most one job at a time and skips to the newest input', async () => {
    const started: string[] = []
    const gates = new Map<string, ReturnType<typeof deferred<string>>>()
    const results: string[] = []
    const push = latestOnly(
      (input: string) => {
        started.push(input)
        const gate = deferred<string>()
        gates.set(input, gate)
        return gate.promise
      },
      (result) => results.push(result),
    )
    push('a')
    push('b')
    push('c')
    expect(started).toEqual(['a'])
    gates.get('a')!.resolve('A')
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['a', 'c'])
    gates.get('c')!.resolve('C')
    await new Promise((r) => setTimeout(r, 0))
    expect(results).toEqual(['A', 'C'])
  })

  it('keeps going after a failed job', async () => {
    const results: string[] = []
    const push = latestOnly(
      (input: string) =>
        input === 'bad' ? Promise.reject(new Error('E_TEST')) : Promise.resolve(input),
      (result) => results.push(result),
      () => results.push('error'),
    )
    push('bad')
    await new Promise((r) => setTimeout(r, 0))
    push('good')
    await new Promise((r) => setTimeout(r, 0))
    expect(results).toEqual(['error', 'good'])
  })
})
