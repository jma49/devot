// What Tauri's IPC does in the page with a command's arguments before it sends them
// (process-ipc-message-fn.js in the tauri crate, 2.12): bytes go as they are, anything else
// through JSON.stringify with a replacer, on the UI thread.
export function tauriIpcBody(args: unknown): string | ArrayBuffer | ArrayBufferView | unknown[] {
  if (args instanceof ArrayBuffer || ArrayBuffer.isView(args) || Array.isArray(args)) return args
  return JSON.stringify(args, (_key, value: unknown) => {
    if (value instanceof Map) return Object.fromEntries(value.entries())
    if (value instanceof Uint8Array) return Array.from(value)
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
    return value
  })
}

/** A call's arguments as a worker's postMessage hands them to the page: cloned, with the buffers of its top-level fields moved rather than copied (Comlink.transfer). */
export function crossed<T>(args: T): T {
  const fields = typeof args === 'object' && args !== null ? Object.values(args) : []
  const transfer = fields.filter((value): value is ArrayBuffer => value instanceof ArrayBuffer)
  return structuredClone(args, { transfer })
}
