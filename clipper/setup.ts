import type { ApiClient, Notebook } from './client'

export type Check = 'connection' | 'origin' | 'token' | 'write' | 'notebooks'
export interface CheckResult {
  passed: Check[]
  failed?: { check: Check; code: string }
  notebooks: number
}
const failing: Record<string, Check> = {
  E_CLIP_CONNECTION: 'connection',
  E_CLIP_SETTINGS: 'token',
  E_HTTP_ORIGIN_REFUSED: 'origin',
  E_HTTP_TOKEN_MISSING: 'token',
  E_HTTP_TOKEN_INVALID: 'token',
  E_HTTP_READ_ONLY: 'write',
  E_CLIP_NOTEBOOKS: 'notebooks',
}

const code = (error: unknown) => (error instanceof Error ? error.message : 'E_CLIP_API')

/** Runs the setup checks in the order the API applies its guards, stopping at the first that fails. */
export async function check(api: ApiClient): Promise<CheckResult> {
  const passed: Check[] = []
  let notebooks: Notebook[] = []
  try {
    notebooks = await api.notebooks()
    passed.push('connection', 'origin', 'token')
    await api.checkWrite()
    passed.push('write')
    if (!notebooks.length) throw new Error('E_CLIP_NOTEBOOKS')
    passed.push('notebooks')
    return { passed, notebooks: notebooks.length }
  } catch (error) {
    const failed = code(error)
    const step = failing[failed] ?? (passed.length ? 'write' : 'connection')
    const order: Check[] = ['connection', 'origin', 'token', 'write', 'notebooks']
    return {
      passed: order.slice(0, order.indexOf(step)),
      failed: { check: step, code: failed },
      notebooks: notebooks.length,
    }
  }
}
