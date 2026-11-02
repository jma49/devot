import { createContext, useContext } from 'react'

/** True when a Settings pane is shown in the iPhone layout, which leaves out what only the Mac has. */
export const OnPhone = createContext(false)

export const useOnPhone = () => useContext(OnPhone)

export interface SettingHint {
  title: string
  body: string
}

/** Where a phone pane shows an explanation; null on the Mac, whose rows keep theirs under them. */
export const ShowHint = createContext<((hint: SettingHint) => void) | null>(null)
