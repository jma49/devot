// No imports: scripts/ci/ui-graph.ts reads this without installed packages.

/** The classic script src/renderer/mermaid.html loads, served and emitted by scripts/vite/mermaid-frame.ts. */
export const MERMAID_FRAME_SCRIPT = 'mermaid-frame.js'

/** The module that script is built from, relative to the repository. */
export const MERMAID_FRAME_ENTRY = 'src/renderer/src/mermaid-frame.ts'

/** The diagram engines the frame loads on demand, each as a classic script of its own. */
export const DIAGRAM_ENGINES = ['mermaid', 'plantuml', 'markmap'] as const

export type DiagramEngine = (typeof DIAGRAM_ENGINES)[number]

/** The name the frame asks for an engine's script by (src/renderer/src/mermaid-frame.ts). */
export const engineScript = (engine: DiagramEngine) => `mermaid-frame-${engine}.js`

export const engineEntry = (engine: DiagramEngine) =>
  `src/renderer/src/diagram-engines/${engine}.ts`
