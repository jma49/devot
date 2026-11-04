// No imports: scripts/ci/ui-graph.ts reads this without installed packages.

/** The classic script src/renderer/mermaid.html loads, served and emitted by scripts/vite/mermaid-frame.ts. */
export const MERMAID_FRAME_SCRIPT = 'mermaid-frame.js'

/** The module that script is built from, relative to the repository. */
export const MERMAID_FRAME_ENTRY = 'src/renderer/src/mermaid-frame.ts'
