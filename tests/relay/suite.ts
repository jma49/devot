import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLOSE, LIMITS, SUBPROTOCOL, toBase64Url } from '../../src/core/sync/protocol'
import {
  bytes,
  connect,
  createVault,
  enroll,
  enrolled,
  postJson,
  randomId,
  type RelayHost,
  socketProtocols,
  socketUrl,
  TestSocket,
  upgradeStatus,
} from './client'

// One suite for every relay host (docs/adr/0002-sync-latest-state-per-record.md,
// Consequences): each host test file passes a function that starts its relay.

export function relaySuite(name: string, start: () => Promise<RelayHost>): void {
  describe(`relay on ${name}`, () => {
    let host: RelayHost
    beforeAll(async () => {
      host = await start()
    })
    afterAll(async () => {
      await host?.close()
    })

    describe('HTTP', () => {
      it('answers its protocol version and time without a vault', async () => {
        const res = await fetch(`${host.url}/v1`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as Record<string, unknown>
        expect(body).toMatchObject({ v: 1, type: 'relay', protocol: 1 })
        expect(Math.abs(Number(body['time']) - Date.now())).toBeLessThan(60_000)
      })

      it('answers unknown paths with E_SYNC_NOT_FOUND', async () => {
        const res = await fetch(`${host.url}/v2/anything`)
        expect(res.status).toBe(404)
        expect(await res.json()).toMatchObject({ code: 'E_SYNC_NOT_FOUND' })
      })

      it('creates a vault only with the relay secret, once', async () => {
        const vault = randomId()
        const body = { v: 1, type: 'create', verifier: toBase64Url(bytes(32, 1)), label: 'a' }
        const url = `${host.url}/v1/vaults/${vault}`
        expect(await postJson(url, body)).toMatchObject({
          status: 401,
          body: { code: 'E_SYNC_UNAUTHORIZED' },
        })
        expect(
          await postJson(url, body, { authorization: `Bearer ${host.secret}x` }),
        ).toMatchObject({ status: 401 })
        const auth = { authorization: `Bearer ${host.secret}` }
        const created = await postJson(url, body, auth)
        expect(created.status).toBe(200)
        expect(created.body).toMatchObject({ v: 1, type: 'enrolled' })
        expect(typeof created.body['epoch']).toBe('string')
        expect(typeof created.body['token']).toBe('string')
        expect(await postJson(url, body, auth)).toMatchObject({
          status: 409,
          body: { code: 'E_SYNC_VAULT_EXISTS' },
        })
      })

      it('refuses malformed creation bodies and vault IDs', async () => {
        const auth = { authorization: `Bearer ${host.secret}` }
        const url = `${host.url}/v1/vaults/${randomId()}`
        for (const body of [
          'not json',
          { v: 1, type: 'create', verifier: 'short', label: 'a' },
          { v: 1, type: 'create', verifier: toBase64Url(bytes(32, 1)), label: 'x'.repeat(300) },
          { v: 1, type: 'enroll', verifier: toBase64Url(bytes(32, 1)), label: 'a' },
        ]) {
          expect((await postJson(url, body, auth)).status).toBe(400)
        }
        expect(
          await postJson(`${host.url}/v1/vaults/short`, { v: 1, type: 'create' }, auth),
        ).toMatchObject({ status: 404 })
        expect(
          await postJson(url, { v: 2, type: 'create', verifier: '', label: '' }, auth),
        ).toMatchObject({ status: 400, body: { code: 'E_SYNC_PROTOCOL' } })
        const big = { v: 1, type: 'create', verifier: 'A'.repeat(LIMITS.maxHttpBodyBytes) }
        expect(await postJson(url, big, auth)).toMatchObject({
          status: 413,
          body: { code: 'E_SYNC_TOO_LARGE' },
        })
      })

      it('enrolls a device that presents the enrollment secret, and no other', async () => {
        const vault = await createVault(host)
        const wrong = await postJson(`${host.url}/v1/vaults/${vault.vault}/devices`, {
          v: 1,
          type: 'enroll',
          secret: toBase64Url(bytes(32, 9)),
          label: 'x',
        })
        expect(wrong).toMatchObject({ status: 403, body: { code: 'E_SYNC_ENROLL_DENIED' } })
        const ok = await enroll(host, vault)
        expect(ok.status).toBe(200)
        expect(ok.body['epoch']).toBe(vault.first.epoch)
        expect(ok.body['device']).not.toBe(vault.first.device)
      })

      it('answers enrollment in a vault that does not exist with E_SYNC_NO_VAULT', async () => {
        const res = await postJson(`${host.url}/v1/vaults/${randomId()}/devices`, {
          v: 1,
          type: 'enroll',
          secret: toBase64Url(bytes(32, 1)),
          label: 'x',
        })
        expect(res).toMatchObject({ status: 404, body: { code: 'E_SYNC_NO_VAULT' } })
      })
    })

    describe('connecting', () => {
      it('welcomes a device with the relay time, the vault epoch and seq', async () => {
        const vault = await createVault(host)
        const { socket, welcome } = await connect(host, vault.vault, vault.first.token)
        expect(socket.protocol).toBe(SUBPROTOCOL)
        expect(welcome).toMatchObject({
          v: 1,
          epoch: vault.first.epoch,
          seq: 0,
          device: vault.first.device,
        })
        expect(Math.abs(Number(welcome['time']) - Date.now())).toBeLessThan(60_000)
        socket.send({ type: 'time', rid: 4 })
        const time = (await socket.expect('time')).message
        expect(time['rid']).toBe(4)
        expect(Math.abs(Number(time['time']) - Date.now())).toBeLessThan(60_000)
        socket.close()
      })

      it('refuses at the front, over HTTP, a missing or forged token and a missing subprotocol', async () => {
        const vault = await createVault(host)
        const url = socketUrl(host, vault.vault)
        const token = vault.first.token
        const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA')
        expect(await upgradeStatus(url, [SUBPROTOCOL])).toBe(401)
        expect(await upgradeStatus(url, socketProtocols(forged))).toBe(401)
        expect(await upgradeStatus(url, ['devot-token.' + token])).toBe(400)
        // A token for another vault fails its check too.
        const other = await createVault(host)
        expect(await upgradeStatus(socketUrl(host, other.vault), socketProtocols(token))).toBe(401)
        expect(await upgradeStatus(url, socketProtocols(token))).toBe(101)
      })

      it('closes the socket of a device the vault does not know with 4001', async () => {
        const vault = await createVault(host)
        const { socket } = await connect(host, vault.vault, vault.first.token)
        socket.send({ type: 'revoke', device: vault.first.device })
        await socket.closed
        const again = await TestSocket.open(
          socketUrl(host, vault.vault),
          socketProtocols(vault.first.token),
        )
        expect((await again.expect('error')).message['code']).toBe('E_SYNC_UNAUTHORIZED')
        expect((await again.closed).code).toBe(CLOSE.unauthorized)
      })
    })

    describe('push and pull', () => {
      it('stores a push as version 1 at the next seq and pulls it back byte for byte', async () => {
        const vault = await createVault(host)
        const { socket } = await connect(host, vault.vault, vault.first.token)
        const a = bytes(1000, 1)
        const b = bytes(10, 2)
        socket.send(
          { type: 'push', rid: 1, id: 'note-1', base: 0, kind: 'record', chunks: [1000, 10] },
          [a, b],
        )
        expect((await socket.expect('pushed')).message).toMatchObject({
          rid: 1,
          id: 'note-1',
          version: 1,
          seq: 1,
        })
        socket.send({ type: 'pull', rid: 2, since: 0 })
        const page = await socket.expect('records')
        expect(page.message).toMatchObject({
          rid: 2,
          records: [{ id: 'note-1', version: 1, seq: 1, kind: 'record', chunks: [1000, 10] }],
          next: 1,
          more: false,
        })
        expect(page.payload).toEqual(new Uint8Array([...a, ...b]))
        socket.close()
      })

      it('compare-and-swap: a push on a stale version is rejected with the current version', async () => {
        const vault = await createVault(host)
        const second = await enrolled(host, vault)
        const one = await connect(host, vault.vault, vault.first.token)
        const two = await connect(host, vault.vault, second.token)
        one.socket.send({ type: 'push', id: 'n', base: 0, kind: 'record', chunks: [1] }, [
          bytes(1, 1),
        ])
        expect((await one.socket.expect('pushed')).message).toMatchObject({ version: 1, seq: 1 })
        expect((await two.socket.expect('changed')).message).toMatchObject({ seq: 1 })
        two.socket.send({ type: 'push', rid: 7, id: 'n', base: 0, kind: 'record', chunks: [1] }, [
          bytes(1, 2),
        ])
        expect((await two.socket.expect('rejected')).message).toMatchObject({
          rid: 7,
          id: 'n',
          version: 1,
        })
        two.socket.send({ type: 'push', id: 'n', base: 1, kind: 'record', chunks: [1] }, [
          bytes(1, 3),
        ])
        expect((await two.socket.expect('pushed')).message).toMatchObject({ version: 2, seq: 2 })
        expect((await one.socket.expect('changed')).message).toMatchObject({ seq: 2 })
        one.socket.send({ type: 'push', id: 'n', base: 5, kind: 'record', chunks: [1] }, [
          bytes(1, 4),
        ])
        expect((await one.socket.expect('rejected')).message).toMatchObject({ version: 2 })
        one.socket.send({ type: 'pull', since: 1 })
        const page = await one.socket.expect('records')
        expect(page.message['records']).toEqual([
          { id: 'n', version: 2, seq: 2, kind: 'record', chunks: [1] },
        ])
        expect(page.payload).toEqual(bytes(1, 3))
        one.socket.close()
        two.socket.close()
      })

      it('sends changed only to the vault’s other connections', async () => {
        const vault = await createVault(host)
        const other = await createVault(host)
        const a = await connect(host, vault.vault, vault.first.token)
        const b = await connect(host, vault.vault, vault.first.token)
        const elsewhere = await connect(host, other.vault, other.first.token)
        a.socket.send({ type: 'push', id: 'r', base: 0, kind: 'record', chunks: [1] }, [
          bytes(1, 0),
        ])
        await a.socket.expect('pushed')
        expect((await b.socket.expect('changed')).message).toMatchObject({ seq: 1 })
        expect(await a.socket.hasMessage(100)).toBe(false)
        expect(await elsewhere.socket.hasMessage(0)).toBe(false)
        for (const s of [a, b, elsewhere]) s.socket.close()
      })

      it('a smaller push replaces the record’s chunks whole', async () => {
        const vault = await createVault(host)
        const { socket } = await connect(host, vault.vault, vault.first.token)
        socket.send({ type: 'push', id: 'r', base: 0, kind: 'record', chunks: [3, 3, 3] }, [
          bytes(3, 1),
          bytes(3, 2),
          bytes(3, 3),
        ])
        await socket.expect('pushed')
        socket.send({ type: 'push', id: 'r', base: 1, kind: 'record', chunks: [2] }, [bytes(2, 9)])
        await socket.expect('pushed')
        socket.send({ type: 'pull', since: 0 })
        const page = await socket.expect('records')
        expect(page.message['records']).toEqual([
          { id: 'r', version: 2, seq: 2, kind: 'record', chunks: [2] },
        ])
        expect(page.payload).toEqual(bytes(2, 9))
        socket.close()
      })

      it('pages a pull by size and resumes after the last seq it returned', async () => {
        const vault = await createVault(host)
        const { socket } = await connect(host, vault.vault, vault.first.token)
        const size = LIMITS.maxChunkBytes
        const count = Math.ceil(LIMITS.pullPageBytes / size) + 1
        for (let i = 0; i < count; i++) {
          socket.send({ type: 'push', id: `r${i}`, base: 0, kind: 'record', chunks: [size] }, [
            bytes(size, i),
          ])
          await socket.expect('pushed')
        }
        const seen: number[] = []
        let since = 0
        let pages = 0
        for (;;) {
          socket.send({ type: 'pull', since })
          const page = await socket.expect('records')
          pages++
          const records = page.message['records'] as { seq: number }[]
          expect(page.payload.length).toBeLessThanOrEqual(LIMITS.pullPageBytes)
          seen.push(...records.map((r) => r.seq))
          since = Number(page.message['next'])
          if (!page.message['more']) break
        }
        expect(pages).toBeGreaterThan(1)
        expect(seen).toEqual(Array.from({ length: count }, (_, i) => i + 1))
        socket.send({ type: 'pull', since })
        expect((await socket.expect('records')).message).toMatchObject({
          records: [],
          next: since,
          more: false,
        })
        socket.close()
      })

      it('refuses pushes outside the limits and malformed messages, and stays open', async () => {
        const vault = await createVault(host)
        const { socket } = await connect(host, vault.vault, vault.first.token)
        const tooBig = LIMITS.maxChunkBytes + 1
        const cases: [object, Uint8Array[], string][] = [
          [
            { type: 'push', id: 'r', base: 0, kind: 'record', chunks: [tooBig] },
            [bytes(tooBig, 0)],
            'E_SYNC_TOO_LARGE',
          ],
          [
            {
              type: 'push',
              id: 'r',
              base: 0,
              kind: 'record',
              chunks: Array(LIMITS.maxChunks + 1).fill(1),
            },
            Array.from({ length: LIMITS.maxChunks + 1 }, () => bytes(1, 0)),
            'E_SYNC_TOO_LARGE',
          ],
          [
            { type: 'push', id: 'r', base: 0, kind: 'record', chunks: [2] },
            [bytes(3, 0)],
            'E_SYNC_BAD_MESSAGE',
          ],
          [
            { type: 'push', id: 'r', base: 0, kind: 'record', chunks: [] },
            [],
            'E_SYNC_BAD_MESSAGE',
          ],
          [
            { type: 'push', id: 'r', base: 0, kind: 'record', chunks: [0] },
            [bytes(1, 0)],
            'E_SYNC_BAD_MESSAGE',
          ],
          [
            { type: 'push', id: 'bad id!', base: 0, kind: 'record', chunks: [1] },
            [bytes(1, 0)],
            'E_SYNC_BAD_MESSAGE',
          ],
          [
            { type: 'push', id: 'r', base: -1, kind: 'record', chunks: [1] },
            [bytes(1, 0)],
            'E_SYNC_BAD_MESSAGE',
          ],
          [
            { type: 'push', id: 'r', base: 0, kind: 'image', chunks: [1] },
            [bytes(1, 0)],
            'E_SYNC_BAD_MESSAGE',
          ],
          [{ type: 'pull', since: 'x' }, [], 'E_SYNC_BAD_MESSAGE'],
          [{ type: 'teleport' }, [], 'E_SYNC_BAD_MESSAGE'],
        ]
        for (const [message, chunks, code] of cases) {
          socket.send({ rid: 3, ...message }, chunks)
          expect((await socket.expect('error')).message).toMatchObject({ rid: 3, code })
        }
        socket.sendRaw('{"v":9,"type":"pull","since":0}')
        expect((await socket.expect('error')).message['code']).toBe('E_SYNC_PROTOCOL')
        socket.sendRaw('garbage')
        expect((await socket.expect('error')).message['code']).toBe('E_SYNC_BAD_MESSAGE')
        socket.sendRaw(new Uint8Array(LIMITS.maxMessageBytes + 1))
        expect((await socket.expect('error')).message['code']).toBe('E_SYNC_TOO_LARGE')
        socket.send({ type: 'pull', since: 0 })
        expect((await socket.expect('records')).message['records']).toEqual([])
        socket.close()
      })

      it('limits each device’s message rate', async () => {
        const vault = await createVault(host)
        const { socket } = await connect(host, vault.vault, vault.first.token)
        const sent = 100
        for (let i = 0; i < sent; i++) socket.send({ type: 'time', rid: i })
        const replies = await Promise.all(Array.from({ length: sent }, () => socket.next()))
        const limited = replies.filter((r) => r.message['code'] === 'E_SYNC_RATE')
        expect(limited.length).toBeGreaterThan(0)
        expect(Number(limited[0]?.message['retryAfter'])).toBeGreaterThan(0)
        expect(replies.filter((r) => r.message['type'] === 'time').length).toBeGreaterThan(0)
        socket.close()
      })
    })

    describe('devices', () => {
      it('lists the vault’s devices and revokes one, closing its sockets', async () => {
        const vault = await createVault(host, 'mac')
        const phone = await enrolled(host, vault, 'phone')
        const mac = await connect(host, vault.vault, vault.first.token)
        const phoneSocket = await connect(host, vault.vault, phone.token)
        mac.socket.send({ type: 'devices', rid: 1 })
        const list = (await mac.socket.expect('devices')).message['devices'] as {
          id: string
          label: string
          current: boolean
        }[]
        expect(list.map((d) => [d.id, d.label, d.current]).sort()).toEqual(
          [
            [vault.first.device, 'mac', true],
            [phone.device, 'phone', false],
          ].sort(),
        )
        mac.socket.send({ type: 'revoke', rid: 2, device: phone.device })
        expect((await mac.socket.expect('revoked')).message).toMatchObject({
          rid: 2,
          device: phone.device,
        })
        // The notice comes before the close: a client stops on it. (workerd may end the closed
        // connection only once the object idles, so the suite does not wait for that here.)
        expect((await phoneSocket.socket.expect('error')).message['code']).toBe('E_SYNC_REVOKED')
        // Whatever still reaches the relay on the revoked socket is refused.
        phoneSocket.socket.send(
          { type: 'push', id: 'late', base: 0, kind: 'record', chunks: [1] },
          [bytes(1, 9)],
        )
        phoneSocket.socket.send({ type: 'revoke', device: vault.first.device })
        mac.socket.send({ type: 'pull', since: 0 })
        expect((await mac.socket.expect('records')).message['records']).toEqual([])
        const refused = await TestSocket.open(
          socketUrl(host, vault.vault),
          socketProtocols(phone.token),
        )
        expect((await refused.expect('error')).message['code']).toBe('E_SYNC_UNAUTHORIZED')
        expect((await refused.closed).code).toBe(CLOSE.unauthorized)
        mac.socket.send({ type: 'revoke', rid: 3, device: phone.device })
        expect((await mac.socket.expect('error')).message).toMatchObject({
          rid: 3,
          code: 'E_SYNC_NO_DEVICE',
        })
        mac.socket.send({ type: 'devices' })
        expect((await mac.socket.expect('devices')).message['devices']).toHaveLength(1)
        mac.socket.close()
      })
    })

    describe('counters', () => {
      it('count rows written, incoming messages, requests and stored bytes, files apart', async () => {
        const vault = await createVault(host)
        const { socket } = await connect(host, vault.vault, vault.first.token)
        socket.send({ type: 'usage' })
        const before = (await socket.expect('usage')).message
        expect(before['day']).toBe(new Date().toISOString().slice(0, 10))
        expect(before).toMatchObject({ storedBytes: 0, fileBytes: 0 })
        expect(Number(before['requests'])).toBeGreaterThanOrEqual(2)

        socket.send({ type: 'push', id: 'note', base: 0, kind: 'record', chunks: [100, 50] }, [
          bytes(100, 1),
          bytes(50, 1),
        ])
        await socket.expect('pushed')
        socket.send({ type: 'push', id: 'img', base: 0, kind: 'file', chunks: [70] }, [
          bytes(70, 2),
        ])
        await socket.expect('pushed')
        socket.send({ type: 'push', id: 'note', base: 1, kind: 'record', chunks: [30] }, [
          bytes(30, 3),
        ])
        await socket.expect('pushed')
        socket.send({ type: 'usage' })
        const after = (await socket.expect('usage')).message
        expect(after).toMatchObject({ storedBytes: 100, fileBytes: 70 })
        expect(Number(after['messages']) - Number(before['messages'])).toBe(4)
        // Each push writes at least its record row, its chunk rows and the counters row.
        expect(Number(after['rowsWritten']) - Number(before['rowsWritten'])).toBeGreaterThanOrEqual(
          4 + 3 + 3,
        )
        socket.close()
      })
    })
  })
}
