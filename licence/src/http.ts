import { LicenceError } from './errors.ts'

export function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function readBody(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('Content-Length') ?? 0)
  if (declared > limit) throw new LicenceError('E_LICENCE_TOO_LARGE')
  const reader = request.body?.getReader()
  if (!reader) return ''
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      throw new LicenceError('E_LICENCE_TOO_LARGE')
    }
    parts.push(value)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    body.set(part, at)
    at += part.length
  }
  return new TextDecoder().decode(body)
}
