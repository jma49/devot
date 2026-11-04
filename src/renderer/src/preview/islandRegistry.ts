import { createIslandRegistry } from './islands'
import { mermaidIsland } from './mermaid'

/** The islands the preview and Write mode draw. */
export const islands = createIslandRegistry([mermaidIsland])
