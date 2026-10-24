// Features go through createAiGenerator, so the access rule is checked before anything is sent.
import type { AiTransport } from '../../core/aiProvider'
import { invoke } from './ipc'

export const aiTransport: AiTransport = {
  generate: (input) => invoke<unknown>('ai_generate', { request: input }),
}
