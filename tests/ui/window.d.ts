// Globals single specs set on the page and read back; the shared ones are TestWindow (fixtures.ts).
interface Window {
  __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown
  __TAURI_INTERNALS__: { invoke(command: string, args: Record<string, unknown>): Promise<unknown> }
  alertsAdded: number
  allowed: number
  answers: { seq: number; code?: string }[]
  beforeReload?: boolean
  closeMenu: () => void
  devot: {
    note: { read(): Promise<unknown>; replace(e: unknown): Promise<unknown> }
    commands: { handle(id: string, fn: () => never): void }
  }
  devotAnswerSave?: () => void
  /** The copy's and the dim's opacity as the reopened one took them over (removed them). */
  devotBefore?: { copy: number | null; dim: number | null }
  devotClipboard?: string
  devotClosing?: unknown
  devotCopyTop: number
  devotDevicesFails?: string
  devotFades?: number
  devotFinishSync: () => void
  devotFlight?: string
  devotFrame: number
  devotFrames: { editor: string; preview: string }[]
  /** Frame times from a click on, until `done`. */
  devotFrameTimes: { times: number[]; done: boolean }
  devotHeld: { answer: () => void; event: () => void }[]
  devotInitialEditorSettings: unknown
  devotKeyMs: number[]
  devotKeys: { work: number; frame: number }[]
  devotLastUpdate: number
  devotMarker?: boolean
  devotMediaQueries: number
  devotMeasured: number
  /** What capture links bring, a batch for each `quick_capture_prefill_take` (quick-capture.spec.ts). */
  devotPrefills?: { title: string; body: string }[][]
  devotPreviewKeys: number[]
  devotNoteWrites: number
  devotOffAtFrame: number
  devotPairing: string
  devotPairingFails?: string | undefined
  devotPastedHtml?: string
  devotPlugins: unknown[]
  devotReleaseHttpApi(): void
  devotReleaseImport(): void
  devotReleaseLicenceSet(): void
  devotRelease?: (text: string) => void
  devotRendered: string[]
  devotRenders: Record<string, number>
  devotRepeats: boolean[]
  devotRescueFirst?: boolean
  devotSamples: number[][]
  devotSampling: boolean
  devotShown: string[]
  devotStrangerEnrolled: boolean
  devotSuggestOnIdle?: boolean
  devotSyncAtFrame: { frame: number; shown: string }[]
  devotThumb?: string
  devotThumbSeen?: boolean
  devotWatch: { shownBeforeReady?: boolean; readyAt?: number }
  dragCards: string[][]
  releaseBackup(): void
  releaseImport(): void
  releaseRebuild?: (notes: number) => void
  releaseSymbols: (png: string) => void
  said: string[]
  seenKeys: [string, boolean, boolean][]
  stolen: MessagePort
}
