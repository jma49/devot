import { createIslandRegistry } from './islands'
import { mermaidIsland, plantumlIsland, markmapIsland } from './mermaid'
import { keptDrawingIsland, pluginIsland } from './pluginDrawing'

/** The islands the preview and Write mode draw. */
export const islands = createIslandRegistry([
  mermaidIsland,
  plantumlIsland,
  markmapIsland,
  pluginIsland,
  keptDrawingIsland,
])
