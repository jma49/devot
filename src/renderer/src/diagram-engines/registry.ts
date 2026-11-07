// Each engine is a classic script of its own (scripts/vite/mermaid-frame.ts) with its own copy of
// this module, so the engines it registers are kept on the frame's window, where the frame finds them.
import type { DiagramKind, FailureReason, RenderRequest } from '../preview/mermaid-protocol'

export type Drawing = { type: 'rendered'; svg: string } | { type: 'failed'; reason: FailureReason }

export type DrawingEngine = (request: RenderRequest) => Promise<Drawing>

const ENGINES = Symbol.for('devot.diagram-engines')

type Host = { [ENGINES]?: Partial<Record<DiagramKind, DrawingEngine>> }

export function registerEngine(kind: DiagramKind, engine: DrawingEngine): void {
  const host = globalThis as Host
  host[ENGINES] = { ...host[ENGINES], [kind]: engine }
}

export function registeredEngine(kind: DiagramKind): DrawingEngine | undefined {
  return (globalThis as Host)[ENGINES]?.[kind]
}
