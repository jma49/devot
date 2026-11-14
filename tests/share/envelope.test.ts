import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { openEnvelope } from '../../share/src/envelope'
import { MESSAGES } from '../../share/src/messages'
import { VIEWER_SCRIPT, viewerPage } from '../../share/src/viewer'

interface Vector {
  name: string
  key: string
  nonce: string
  plaintext: string
  envelope: string
}
const { cases } = JSON.parse(readFileSync('tests/fixtures/share-vectors.json', 'utf8')) as {
  cases: Vector[]
}
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'))

describe('the sealed page', () => {
  it.each(cases)('opens $name back to its plaintext', async (vector) => {
    const page = await openEnvelope(bytes(vector.envelope), vector.key)
    const { title, html } = JSON.parse(vector.plaintext) as { title: string; html: string }
    expect(page).toEqual({ title, html })
  })

  it('seals each vector as the format says: magic, nonce, then AES-256-GCM over the magic', async () => {
    for (const vector of cases) {
      const key = await crypto.subtle.importKey('raw', bytes(vector.key), 'AES-GCM', false, [
        'encrypt',
      ])
      const magic = new TextEncoder().encode('DVS1')
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: bytes(vector.nonce), additionalData: magic },
        key,
        new TextEncoder().encode(vector.plaintext),
      )
      expect(Buffer.from([...magic, ...bytes(vector.nonce), ...new Uint8Array(sealed)])).toEqual(
        Buffer.from(bytes(vector.envelope)),
      )
    }
  })

  it('opens nothing with a wrong or malformed key, or damaged bytes', async () => {
    const [vector] = cases
    const envelope = bytes(vector!.envelope)
    const other = cases[1]!.key
    expect(await openEnvelope(envelope, other)).toBeNull()
    expect(await openEnvelope(envelope, vector!.key.slice(1))).toBeNull()
    expect(await openEnvelope(envelope, `${vector!.key.slice(0, 42)}!`)).toBeNull()
    const flipped = envelope.slice()
    flipped[20]! ^= 1
    expect(await openEnvelope(flipped, vector!.key)).toBeNull()
    const renamed = envelope.slice()
    renamed[3] = 0x32
    expect(await openEnvelope(renamed, vector!.key)).toBeNull()
    expect(await openEnvelope(envelope.slice(0, 31), vector!.key)).toBeNull()
  })

  it('refuses a plaintext of another version or shape, even sealed under the right key', async () => {
    const key = new Uint8Array(32).fill(7)
    const keyText = Buffer.from(key).toString('base64url')
    const seal = async (plain: string) => {
      const nonce = new Uint8Array(12)
      const magic = new TextEncoder().encode('DVS1')
      const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: magic },
        cryptoKey,
        new TextEncoder().encode(plain),
      )
      return new Uint8Array([...magic, ...nonce, ...new Uint8Array(sealed)])
    }
    for (const plain of [
      '{"v":2,"title":"","html":""}',
      '{"v":1,"title":1,"html":""}',
      '[]',
      'x',
    ]) {
      expect(await openEnvelope(await seal(plain), keyText)).toBeNull()
    }
  })
})

describe('the viewer', () => {
  it('ships the tested opener inside its script, which parses as a classic script', () => {
    expect(VIEWER_SCRIPT).toContain(openEnvelope.toString())
    expect(() => new Function(VIEWER_SCRIPT)).not.toThrow()
  })

  it('opens the vectors with the copy of the opener the browser gets', async () => {
    const context: Record<string, unknown> = { crypto, atob, TextDecoder, Uint8Array, JSON }
    runInNewContext(
      `${VIEWER_SCRIPT.split('\n')
        .slice(3, -2)
        .join('\n')
        .replace(/^const status[\s\S]*$/m, '')}; globalThis.opener = openEnvelope`,
      context,
    )
    const opener = context['opener'] as typeof openEnvelope
    for (const vector of cases) {
      expect((await opener(bytes(vector.envelope), vector.key))?.title).toBe(
        (JSON.parse(vector.plaintext) as { title: string }).title,
      )
    }
  })

  it('frames the page with no script and keeps the ID out of reach of markup', () => {
    const html = viewerPage('AAAAAAAAAAAAAAAAAAAAAA')
    expect(html).toMatch(
      /<iframe [^>]*sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"/,
    )
    expect(html).not.toMatch(/allow-scripts/)
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(viewerPage('"><script>')).toContain('data-share="&#34;&#62;&#60;script&#62;"')
    expect(html).not.toMatch(/<script>|\sstyle=|\son[a-z]+=/)
    expect(html).toContain(MESSAGES.opening.replace('…', '…'))
  })
})
