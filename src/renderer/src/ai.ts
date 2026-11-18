// Features go through createAiGenerator, so the access rule is checked before anything is sent.
import type { AiTransport } from '../../core/aiProvider'
import { Channel, invoke } from './ipc'

/**
 * A random stream number in 1 to 2^53 - 1: Rust names a stream by its window and this number, and a number counted
 * from 1 would come again after a reload, where a late cancel for the old stream could stop the new one.
 */
export function newStreamId(
  fill: (words: Uint32Array<ArrayBuffer>) => ArrayLike<number> = (words) =>
    crypto.getRandomValues(words),
): number {
  for (;;) {
    const words = fill(new Uint32Array(2))
    const id = (words[0]! & 0x1fffff) * 2 ** 32 + words[1]!
    if (id !== 0) return id
  }
}

export const aiTransport: AiTransport = {
  generate: (input) => invoke<unknown>('ai_generate', { request: input }),
  stream: async (input, onText, signal) => {
    if (signal?.aborted) throw new Error('E_AI_CANCELLED')
    const streamId = newStreamId()
    const channel = new Channel<string>((text) => {
      if (typeof text === 'string' && !signal?.aborted) onText(text)
    })
    const onAbort = () => {
      void invoke('ai_stream_cancel', { streamId }).catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await invoke<unknown>('ai_stream', { request: input, onText: channel, streamId })
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  },
}
