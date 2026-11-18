export const INSPECTOR_TABS = ['outline', 'info', 'history'] as const
export type InspectorTab = (typeof INSPECTOR_TABS)[number]

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>

export function inspectorTabStore(storage: KeyValue | undefined, label: string) {
  const key = `devot.inspector.tab.${label}`
  return {
    load(): InspectorTab {
      try {
        const saved = storage?.getItem(key)
        return INSPECTOR_TABS.find((tab) => tab === saved) ?? 'outline'
      } catch {
        return 'outline'
      }
    },
    save(tab: InspectorTab) {
      try {
        storage?.setItem(key, tab)
      } catch {
        console.warn('W_INSPECTOR_TAB_SAVE_FAILED')
      }
    },
  }
}

/** What a command for an inspector tab does: no room (a narrow window, focus mode) falls back to the Note Info card, the History sheet or the Outline setting. */
export function inspectorRoute(at: { on: boolean; room: boolean }): 'show' | 'open' | 'fallback' {
  if (!at.room) return 'fallback'
  return at.on ? 'show' : 'open'
}
