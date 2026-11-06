/** The window's localStorage, read at each call; undefined where there is none (tests, workers). */
export const localStore = () => globalThis.localStorage as Storage | undefined
