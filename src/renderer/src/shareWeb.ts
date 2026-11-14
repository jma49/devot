// Share on Web (docs/specs/share-on-web.md, In the app): the sheet's phases in one union, the
// commands Rust answers, and the page it seals. Each answer is matched to the request that asked
// for it, so a slow reply never lands in a later phase.
import { invoke } from './ipc'
import type { MessageKey } from './i18n'

export const LIFETIMES = [1, 7, 30] as const
export type Lifetime = (typeof LIFETIMES)[number]
export const DEFAULT_LIFETIME: Lifetime = 7

/** What Rust tells the window about a share: never its token. */
export interface Shared {
  url: string
  expiresAt: number
}

export type ShareTask = 'share' | 'update' | 'stop'

export type SharePhase =
  | { kind: 'loading'; request: number }
  | { kind: 'unshared'; lifetime: Lifetime; error: MessageKey | null }
  | {
      kind: 'working'
      request: number
      task: ShareTask
      lifetime: Lifetime
      shared: Shared | null
    }
  | {
      kind: 'shared'
      shared: Shared
      error: MessageKey | null
      copied: boolean
    }

export type ShareEvent =
  | { kind: 'load'; request: number }
  | { kind: 'status'; request: number; shared: Shared | null }
  | { kind: 'statusFailed'; request: number; code: string }
  | { kind: 'lifetime'; lifetime: Lifetime }
  | { kind: 'start'; request: number; task: ShareTask }
  | { kind: 'done'; request: number; shared: Shared | null }
  | { kind: 'failed'; request: number; code: string }
  | { kind: 'copied' }

export const initialSharePhase = (request: number): SharePhase => ({
  kind: 'loading',
  request,
})

const ERRORS: Readonly<Record<string, MessageKey>> = {
  E_SHARE_TOO_LARGE: 'shareWeb.error.tooLarge',
  E_EXPORT_TOO_LARGE: 'shareWeb.error.tooLarge',
  E_SHARE_RATE_LIMITED: 'shareWeb.error.busy',
  E_SHARE_BUSY: 'shareWeb.error.busy',
  E_SHARE_KEYCHAIN_FAILED: 'shareWeb.error.keychain',
}

export function shareError(code: string): MessageKey {
  if (code.startsWith('E_NET_')) return 'shareWeb.error.offline'
  return ERRORS[code] ?? 'shareWeb.error.failed'
}

const settled = (
  shared: Shared | null,
  lifetime: Lifetime,
  error: MessageKey | null,
): SharePhase =>
  shared ? { kind: 'shared', shared, error, copied: false } : { kind: 'unshared', lifetime, error }

export function shareStep(phase: SharePhase, event: ShareEvent): SharePhase {
  switch (event.kind) {
    case 'load':
      return { kind: 'loading', request: event.request }
    case 'status':
      if (phase.kind !== 'loading' || phase.request !== event.request) return phase
      return settled(event.shared, DEFAULT_LIFETIME, null)
    case 'statusFailed':
      if (phase.kind !== 'loading' || phase.request !== event.request) return phase
      return {
        kind: 'unshared',
        lifetime: DEFAULT_LIFETIME,
        error: shareError(event.code),
      }
    case 'lifetime':
      return phase.kind === 'unshared' ? { ...phase, lifetime: event.lifetime, error: null } : phase
    case 'start':
      if (phase.kind === 'unshared' && event.task === 'share') {
        return {
          kind: 'working',
          request: event.request,
          task: 'share',
          lifetime: phase.lifetime,
          shared: null,
        }
      }
      if (phase.kind === 'shared' && event.task !== 'share') {
        return {
          kind: 'working',
          request: event.request,
          task: event.task,
          lifetime: DEFAULT_LIFETIME,
          shared: phase.shared,
        }
      }
      return phase
    case 'done':
      if (phase.kind !== 'working' || phase.request !== event.request) return phase
      return settled(event.shared, phase.lifetime, null)
    case 'failed':
      if (phase.kind !== 'working' || phase.request !== event.request) return phase
      return settled(phase.shared, phase.lifetime, shareError(event.code))
    case 'copied':
      return phase.kind === 'shared' ? { ...phase, copied: true, error: null } : phase
  }
}

export const shareStatus = (noteId: string) => invoke<Shared | null>('web_share_status', { noteId })

export const stopSharing = (noteId: string) => invoke<null>('web_share_stop', { noteId })

/** `page` is the note as its HTML export: the page and the images Rust puts in. */
export const publishShare = (
  noteId: string,
  page: {
    title: string
    html: string
    images: readonly { placeholder: string; fileId: string }[]
  },
  lifetime: Lifetime,
) =>
  invoke<Shared>('web_share_publish', {
    noteId,
    title: page.title,
    html: page.html,
    images: page.images,
    lifetime,
  })
