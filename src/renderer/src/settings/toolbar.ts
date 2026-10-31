import { createContext } from 'react'

/** The end of the Settings toolbar, where a pane may put its own buttons (through a portal). */
export const ToolbarEnd = createContext<HTMLElement | null>(null)
