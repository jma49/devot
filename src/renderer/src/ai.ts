// Features go through createAiGenerator, so the access rule is checked before anything is sent.
import type { AiTransport } from '../../core/aiProvider'
import { Channel, invoke } from './ipc'

export const aiTransport: AiTransport = {
  generate: (input) => invoke<unknown>('ai_generate', { request: input }),
  stream: (input, onText) => {
    const channel = new Channel<string>((text) => {
      if (typeof text === 'string') onText(text)
    })
    return invoke<unknown>('ai_stream', { request: input, onText: channel })
  },
}
