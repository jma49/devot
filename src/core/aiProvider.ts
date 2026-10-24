// Refuses a request before it reaches Rust unless the user asked for it and every source notebook allows AI access.

import { TEMPLATES_BOOK_ID } from './books'
import type { BookRecord } from './storage'

export const AI_PROVIDERS = ['anthropic', 'openai'] as const
export type AiProviderId = (typeof AI_PROVIDERS)[number]

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
}

/** Why a request is made. */
export interface AiTrigger {
  /** The user started it (a command, a button); never a timer, a sync or a note's own content. */
  by: 'user'
  /** The notebooks whose notes the request carries text from; empty for text the user typed. */
  books: readonly string[]
}

export interface AiGenerator {
  /** E_AI_NOT_TRIGGERED, E_AI_ACCESS_DENIED, a code from Rust, or E_AI_RESPONSE_INVALID. */
  generate(input: AiGenerateInput, trigger: AiTrigger): Promise<AiGenerated>
}

export interface AiGeneratorOptions {
  storage: { listBooks(): Promise<readonly BookRecord[]> }
  transport: AiTransport
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

export function createAiGenerator(options: AiGeneratorOptions): AiGenerator {
  const { storage, transport } = options
  return {
    async generate(input, trigger) {
      if ((trigger as { by?: unknown }).by !== 'user') throw new Error('E_AI_NOT_TRIGGERED')
      if (trigger.books.length > 0) {
        // Templates may carry the switch from a Devot that showed it as a plain notebook; it never counts.
        const allowed = new Set(
          (await storage.listBooks())
            .filter((b) => b.aiAccess === true && b.id !== TEMPLATES_BOOK_ID)
            .map((b) => b.id),
        )
        if (!trigger.books.every((id) => allowed.has(id))) throw new Error('E_AI_ACCESS_DENIED')
      }
      const generated = asAiGenerated(await transport.generate(input))
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

export interface AiSettingsView {
  active: AiProviderId
  anthropic: AiProviderView
  openai: AiProviderView
}

/** What Settings changes: the key goes in through its own command. */
export type AiSettingsChange = Pick<AiSettingsView, 'active'> &
  Record<AiProviderId, Pick<AiProviderView, 'endpoint' | 'model'>>

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
  const { active, anthropic, openai } = value as Record<string, unknown>
  const a = asProviderView(anthropic)
  const o = asProviderView(openai)
  if (!isProvider(active) || !a || !o) return undefined
  return { active, anthropic: a, openai: o }
}
