// Hybrid logical clock. Timestamps order metadata writes across devices for
// last-writer-wins: wall time first, then a counter, then the node ID.
//
// Encoding: `<16-digit wall ms>-<4 hex counter>-<node>`. The fixed-width
// prefix makes plain string comparison match HLC order.

export interface Hlc {
  wall: number
  counter: number
  node: string
}

const MAX_COUNTER = 0xffff
const NODE = /^[a-z0-9]{1,32}$/
const HLC = /^(\d{16})-([0-9a-f]{4})-([a-z0-9]{1,32})$/

export function formatHlc({ wall, counter, node }: Hlc): string {
  return `${String(wall).padStart(16, '0')}-${counter.toString(16).padStart(4, '0')}-${node}`
}

export function parseHlc(text: string): Hlc {
  const match = HLC.exec(text)
  if (!match) throw new Error('E_HLC_INVALID')
  return { wall: Number(match[1]), counter: parseInt(match[2]!, 16), node: match[3]! }
}

export const compareHlc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * A node ID for one process's clock: 16 random hex digits (64 bits), new at
 * every start and never stored, so no two processes, whatever storage they
 * share, stamp a write alike.
 */
export function newNodeId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export interface Clock {
  /** A timestamp for a local write, later than every timestamp seen so far. */
  tick(): string
  /**
   * Merges a timestamp written elsewhere (another device, another process,
   * an earlier start); returns the updated local time.
   */
  receive(remote: string): string
}

/**
 * Takes in the stamps of records read from storage before writing over
 * them, so every later tick is later than each: a write based on what was
 * read always wins over it. That holds even when the stamps were written
 * while the system clock ran ahead and it has been set back since (a
 * restore, a rename or a move would otherwise lose to them, silently, until
 * the clock caught up). Empty stamps (a field never set) and malformed ones
 * are skipped; only the newest is received.
 */
export function receiveStored(clock: Clock, stamps: Iterable<string | null | undefined>): void {
  let newest: string | undefined
  for (const stamp of stamps) {
    if (stamp && HLC.test(stamp) && (newest === undefined || stamp > newest)) newest = stamp
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
    return formatHlc({ wall, counter, node })
  }

  return {
    tick: () => advance(-1, 0),
    receive: (remote) => {
      const r = parseHlc(remote)
      return advance(r.wall, r.counter)
    },
  }
}
