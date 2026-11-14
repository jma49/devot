import { describe, expect, it } from 'vitest'
import { linkGraphView, MAX_GRAPH_NOTES, type LinkGraph } from '../../src/core'
import { expectWithinBudget } from '../support/budget'

// A large library at the graph's limit: as many notes as it shows, ten links each.
const NOTES = MAX_GRAPH_NOTES
const BUDGET_MS = 400

function library(): LinkGraph {
  let seed = 7
  const rand = () => ((seed = (seed * 16_807) % 2_147_483_647) - 1) / 2_147_483_646
  const id = (i: number) => `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`
  const links: [string, string][] = []
  for (let i = 0; i < NOTES; i += 1) {
    for (let l = 0; l < 10; l += 1) links.push([id(i), id(Math.floor(rand() * NOTES))])
  }
  return {
    notes: Array.from({ length: NOTES }, (_, i) => ({ id: id(i), title: `Note ${i}` })),
    links,
  }
}

describe(`the graph of ${NOTES} notes`, () => {
  it(`is built and laid out in under ${BUDGET_MS} ms`, (context) => {
    const graph = library()
    expect(linkGraphView(graph).notes).toHaveLength(NOTES)
    const times: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const start = performance.now()
      linkGraphView(graph)
      times.push(performance.now() - start)
    }
    expectWithinBudget(context, times.sort((a, b) => a - b)[1]!, BUDGET_MS)
  })
})
