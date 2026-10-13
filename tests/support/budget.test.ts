import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest'
import { expectWithinBudget, setOverloadProbe, skipIfOverloaded } from './budget'
import { machineOverloaded } from './machine-load'

class Skipped extends Error {}

function fakeContext() {
  const skip = vi.fn<(note?: string) => never>((note) => {
    throw new Skipped(note)
  })
  return { context: { skip } as unknown as TestContext, skip }
}

afterEach(() => setOverloadProbe(machineOverloaded))

describe('time budgets', () => {
  it('pass within the budget whatever the load', () => {
    for (const load of [false, true]) {
      setOverloadProbe(() => load)
      const { context, skip } = fakeContext()
      expectWithinBudget(context, 10, 50)
      expect(skip).not.toHaveBeenCalled()
    }
  })

  it('fail over the budget when the machine is not overloaded', () => {
    setOverloadProbe(() => false)
    const { context, skip } = fakeContext()
    expect(() => expectWithinBudget(context, 80, 50)).toThrow(/expected 80 to be less than 50/)
    expect(skip).not.toHaveBeenCalled()
  })

  it('skip over the budget on an overloaded machine, with the measured time', () => {
    setOverloadProbe(() => true)
    const { context, skip } = fakeContext()
    expect(() => expectWithinBudget(context, 80, 50)).toThrow(Skipped)
    expect(skip).toHaveBeenCalledWith('machine overloaded (80.0 ms of 50 ms)')
  })

  it('ask about the load at the moment of the check', () => {
    let load = false
    setOverloadProbe(() => load)
    const { context, skip } = fakeContext()
    skipIfOverloaded(context, 'first')
    load = true
    expect(() => skipIfOverloaded(context, 'second')).toThrow(Skipped)
    expect(skip).toHaveBeenCalledTimes(1)
    expect(skip).toHaveBeenCalledWith('machine overloaded (second)')
  })
})
