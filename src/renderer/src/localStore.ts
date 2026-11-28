export type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The window's localStorage, read at each call; undefined where there is none or access is refused. */
export function localStore(): Storage | undefined {
  try {
    return globalThis.localStorage as Storage | undefined
  } catch {
    return undefined
  }
}

/** The window's sessionStorage, read at each call; undefined where there is none or access is refused. */
export function sessionStore(): Storage | undefined {
  try {
    return globalThis.sessionStorage as Storage | undefined
  } catch {
    return undefined
  }
}
