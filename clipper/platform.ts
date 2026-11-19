export const extension =
  (globalThis as typeof globalThis & { browser?: typeof chrome }).browser ?? chrome
