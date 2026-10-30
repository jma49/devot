// Hybrid logical clock. Timestamps order metadata writes across devices for last-writer-wins: wall time first, then a counter, then the node ID.
//
// Encoding: `<16-digit wall ms>-<4 hex counter>-<node>`. The fixed-width prefix makes plain string comparison match HLC order.

export interface Hlc {
  wall: number
  counter: number
  node: string
}

const MAX_COUNTER = 0xffff
/** The latest instant a `Date` holds. A larger wall time would also outgrow the 16-digit encoding and break the ordering of stamps. */
export const MAX_WALL = 8_640_000_000_000_000
const NODE = /^[a-z0-9]{1,32}$/
const HLC = /^(\d{16})-([0-9a-f]{4})-([a-z0-9]{1,32})$/

export function formatHlc({ wall, counter, node }: Hlc): string {
  return `${String(wall).padStart(16, '0')}-${counter.toString(16).padStart(4, '0')}-${node}`
}

export function parseHlc(text: string): Hlc {
  const match = HLC.exec(text)
  const wall = match ? Number(match[1]) : NaN
  if (!match || !(wall <= MAX_WALL)) throw new Error('E_HLC_INVALID')
  return { wall, counter: parseInt(match[2]!, 16), node: match[3]! }
}

export function isHlcText(text: unknown): text is string {
  if (typeof text !== 'string') return false
  try {
    parseHlc(text)
    return true
  } catch {
    return false
  }
}

export const compareHlc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** New at every start and never stored, so no two processes, whatever storage they share, stamp a write alike. */
export function newNodeId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export interface Clock {
  /** The node ID its stamps end with. */
  readonly node: string
  tick(): string
  receive(remote: string): string
}

/** Takes in the stamps of records read from storage, so every later tick is later than each and a write based on what was read always wins. That holds even when the stamps were written while the system clock ran ahead and it has since been set back. Empty and malformed stamps are skipped; only the newest is received. */
export function receiveStored(clock: Clock, stamps: Iterable<string | null | undefined>): void {
  let newest: string | undefined
  for (const stamp of stamps) {
    if (isHlcText(stamp) && (newest === undefined || stamp > newest)) newest = stamp
  }
  if (newest !== undefined) clock.receive(newest)
}

export function createClock(node: string, now: () => number = Date.now): Clock {
  if (!NODE.test(node)) throw new Error('E_HLC_NODE_INVALID')
  let wall = 0
  let counter = 0

  const advance = (remoteWall: number, remoteCounter: number) => {
    const physical = Math.floor(now())
    const nextWall = Math.max(wall, remoteWall, physical)
    if (nextWall === wall && nextWall === remoteWall) counter = Math.max(counter, remoteCounter) + 1
    else if (nextWall === wall) counter += 1
    else if (nextWall === remoteWall) counter = remoteCounter + 1
    else counter = 0
    wall = nextWall
    if (counter > MAX_COUNTER) {
      wall += 1
      counter = 0
    }
    // Past the last wall time a stamp is refused by every peer, so the clock stops at the last stamp that is valid.
    if (wall > MAX_WALL) {
      wall = MAX_WALL
      counter = MAX_COUNTER
    }
    return formatHlc({ wall, counter, node })
  }

  return {
    node,
    tick: () => advance(-1, 0),
    receive: (remote) => {
      const r = parseHlc(remote)
      return advance(r.wall, r.counter)
    },
  }
}
