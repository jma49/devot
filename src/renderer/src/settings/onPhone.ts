import { createContext, useContext } from 'react'

/** True when a Settings pane is shown in the iPhone layout, which leaves out what only the Mac has. */
export const OnPhone = createContext(false)

export const useOnPhone = () => useContext(OnPhone)
