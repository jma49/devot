// Usage events (see src/core/usage.ts and src-tauri/src/usage.rs). The main
// window records them; only the Settings window can read and clear them.
import { invoke } from './ipc'
import { createUsageTracker, type StoredUsageEvent } from '../../core/usage'

export const track = createUsageTracker({
  record: (event) =>
    invoke('usage_record', { name: event.name, properties: event.properties }).then(
      () => undefined,
    ),
  // Codes only, so they reach the local log.
  onError: (code) => console.warn(code),
})

export const listUsage = () => invoke<StoredUsageEvent[]>('usage_list')

export const clearUsage = () => invoke('usage_clear').then(() => undefined)
