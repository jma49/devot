// Refuses a request before it reaches Rust unless the user asked for it and every source notebook allows AI access.

import { TEMPLATES_BOOK_ID } from './books'
import type { Entitlements } from './entitlements'
import type { BookRecord } from './storage'

export const AI_API_PROVIDERS = ['anthropic', 'openai'] as const
export type AiApiProviderId = (typeof AI_API_PROVIDERS)[number]
export const AI_CLI_PROVIDERS = ['claudeCli', 'codexCli'] as const
export type AiCliProviderId = (typeof AI_CLI_PROVIDERS)[number]
export const AI_PROVIDERS = [...AI_API_PROVIDERS, ...AI_CLI_PROVIDERS] as const
export type AiProviderId = (typeof AI_PROVIDERS)[number]

export const isCliProvider = (value: AiProviderId): value is AiCliProviderId =>
  value === 'claudeCli' || value === 'codexCli'

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiGenerateInput {
  provider?: AiProviderId
  system?: string
  /** Starts with the user; Rust checks the limits. */
  messages: readonly AiMessage[]
  maxTokens?: number
  /** Gives up sooner than Rust's own limit (never later). */
  timeoutSecs?: number
}

export type AiStop = 'end' | 'maxTokens' | 'other'

export interface AiGenerated {
  provider: AiProviderId
  model: string
  text: string
  stop: AiStop
  usage: { inputTokens: number; outputTokens: number } | null
}

/** Runs one request in Rust (the `ai_generate` command); resolves with what Rust answered, rejects with its error code. */
export interface AiTransport {
  generate(input: AiGenerateInput): Promise<unknown>
  /** As `generate`, with the answer's text handed to `onText` piece by piece as it arrives (`ai_stream`). */
  stream?(input: AiGenerateInput, onText: (text: string) => void): Promise<unknown>
}

export interface AiTrigger {
  /** The user started it (a command, a button); never a timer, a sync or a note's own content. */
  by: 'user'
  /** The notebooks whose notes the request carries text from; empty for text the user typed. */
  books: readonly string[]
}

export interface AiGenerator {
  /**
   * E_AI_NOT_TRIGGERED, E_LICENCE_REQUIRED, E_AI_ACCESS_DENIED, a code from Rust, or E_AI_RESPONSE_INVALID.
   * With `onText`, the answer streams where the transport can: each piece of its text as it comes.
   */
  generate(
    input: AiGenerateInput,
    trigger: AiTrigger,
    onText?: (text: string) => void,
  ): Promise<AiGenerated>
}

export interface AiGeneratorOptions {
  storage: { listBooks(): Promise<readonly BookRecord[]> }
  transport: AiTransport
  /** Rust refuses without a licence too; this only spares the request. */
  entitlements?: Entitlements
}

const STOPS: readonly unknown[] = ['end', 'maxTokens', 'other']
const isProvider = (value: unknown): value is AiProviderId =>
  typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value)

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function asAiGenerated(value: unknown): AiGenerated | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { provider, model, text, stop, usage } = value as Record<string, unknown>
  if (!isProvider(provider) || typeof model !== 'string' || typeof text !== 'string') {
    return undefined
  }
  if (!STOPS.includes(stop)) return undefined
  let counted: AiGenerated['usage'] = null
  if (usage !== null && usage !== undefined) {
    const { inputTokens, outputTokens } = usage as Record<string, unknown>
    if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
    counted = { inputTokens, outputTokens }
  }
  return { provider, model, text, stop: stop as AiStop, usage: counted }
}

/** The notebooks AI features may read: Allow AI Access on, Templates never (it may carry the switch from a Devot that showed it as a plain notebook). */
export function allowedBookIds(books: readonly BookRecord[]): Set<string> {
  return new Set(
    books.filter((b) => b.aiAccess === true && b.id !== TEMPLATES_BOOK_ID).map((b) => b.id),
  )
}

export function createAiGenerator(options: AiGeneratorOptions): AiGenerator {
  const { storage, transport, entitlements } = options
  return {
    async generate(input, trigger, onText) {
      if ((trigger as { by?: unknown }).by !== 'user') throw new Error('E_AI_NOT_TRIGGERED')
      if (entitlements && !entitlements.has('aiProviders')) throw new Error('E_LICENCE_REQUIRED')
      if (trigger.books.length > 0) {
        const allowed = allowedBookIds(await storage.listBooks())
        if (!trigger.books.every((id) => allowed.has(id))) throw new Error('E_AI_ACCESS_DENIED')
      }
      const answer =
        onText && transport.stream
          ? await transport.stream(input, onText)
          : await transport.generate(input)
      const generated = asAiGenerated(answer)
      if (!generated) throw new Error('E_AI_RESPONSE_INVALID')
      return generated
    },
  }
}

export type AiKeyState = 'set' | 'unset' | 'unknown' | 'unavailable'

/** One provider as Settings shows it: never the key, only whether one is stored. */
export interface AiProviderView {
  endpoint: string
  model: string
  defaultEndpoint: string
  defaultModel: string
  key: AiKeyState
}

export type AiCliState = 'ready' | 'signedOut' | 'notInstalled'

export interface AiCliProviderView {
  state: AiCliState
  model: string
}

export interface AiCliViews {
  claudeCli: AiCliProviderView
  codexCli: AiCliProviderView
}

export interface AiCliSettings {
  model: string
}

export interface AiSettingsView {
  active: AiProviderId
  /** Next edit suggestions after a pause in typing, not only on their key. */
  suggestOnIdle: boolean
  anthropic: AiProviderView
  openai: AiProviderView
  cli?: AiCliViews
}

/** What Settings changes: the key goes in through its own command. */
export type AiSettingsChange = Pick<AiSettingsView, 'active' | 'suggestOnIdle'> &
  Record<AiApiProviderId, Pick<AiProviderView, 'endpoint' | 'model'>> &
  Partial<Record<AiCliProviderId, AiCliSettings>>

function asCliProviderView(value: unknown): AiCliProviderView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { state, model } = value as Record<string, unknown>
  if (
    (state !== 'ready' && state !== 'signedOut' && state !== 'notInstalled') ||
    typeof model !== 'string'
  ) {
    return undefined
  }
  return { state, model }
}

function asCliViews(value: unknown): AiCliViews | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { claudeCli, codexCli } = value as Record<string, unknown>
  const c = asCliProviderView(claudeCli)
  const x = asCliProviderView(codexCli)
  if (!c || !x) return undefined
  return { claudeCli: c, codexCli: x }
}

function asProviderView(value: unknown): AiProviderView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { endpoint, model, defaultEndpoint, defaultModel, key } = value as Record<string, unknown>
  if (
    typeof endpoint !== 'string' ||
    typeof model !== 'string' ||
    typeof defaultEndpoint !== 'string' ||
    typeof defaultModel !== 'string' ||
    (key !== 'set' && key !== 'unset' && key !== 'unknown' && key !== 'unavailable')
  ) {
    return undefined
  }
  return { endpoint, model, defaultEndpoint, defaultModel, key }
}

export function asAiSettingsView(value: unknown): AiSettingsView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { active, suggestOnIdle, anthropic, openai, cli } = value as Record<string, unknown>
  const a = asProviderView(anthropic)
  const o = asProviderView(openai)
  if (!isProvider(active) || !a || !o) return undefined
  if (cli !== undefined) {
    const parsedCli = asCliViews(cli)
    if (!parsedCli) return undefined
    return {
      active,
      suggestOnIdle: suggestOnIdle === true,
      anthropic: a,
      openai: o,
      cli: parsedCli,
    }
  }
  return { active, suggestOnIdle: suggestOnIdle === true, anthropic: a, openai: o }
}
