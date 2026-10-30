import { connect as tcp } from 'node:net'
import { expect, it } from 'vitest'
import { startNodeRelay } from '../../relay/src/node/server'
import { tempDir } from '../support/temp-dirs'
import { CLOSE } from '../../src/core/sync/protocol'
import { bytes, connect, createVault, enrolled, socketProtocols } from './client'
import { relaySuite } from './suite'

const secret = 'test-relay-secret-0123456789abcdef'

relaySuite('Node + SQLite', async () => {
  const relay = await startNodeRelay({ data: tempDir('devot-relay-node-'), secret })
  return { ...relay, secret }
})

it('keeps vaults across a restart, in one SQLite file per vault', async () => {
  const data = tempDir('devot-relay-restart-')
  const first = await startNodeRelay({ data, secret })
  const host = { ...first, secret }
  const vault = await createVault(host)
  const { socket } = await connect(host, vault.vault, vault.first.token)
  socket.send({ type: 'push', id: 'r', base: 0, kind: 'record', chunks: [4] }, [bytes(4, 5)])
  await socket.expect('pushed')
  socket.close()
  await first.close()

  const second = await startNodeRelay({ data, secret })
  const again = await connect({ ...second, secret }, vault.vault, vault.first.token)
  expect(again.welcome).toMatchObject({ epoch: vault.first.epoch, seq: 1 })
  again.socket.send({ type: 'pull', since: 0 })
  expect((await again.socket.expect('records')).payload).toEqual(bytes(4, 5))
  again.socket.close()
  await second.close()
})

it('closes a revoked device’s sockets with 4003', async () => {
  const relay = await startNodeRelay({ data: tempDir('devot-relay-revoke-'), secret })
  const host = { ...relay, secret }
  const vault = await createVault(host)
  const phone = await enrolled(host, vault)
  const mac = await connect(host, vault.vault, vault.first.token)
  const phoneSocket = await connect(host, vault.vault, phone.token)
  mac.socket.send({ type: 'revoke', device: phone.device })
  expect((await phoneSocket.socket.closed).code).toBe(CLOSE.revoked)
  mac.socket.close()
  await relay.close()
})

it('survives a socket that sends a frame over the payload limit', async () => {
  const relay = await startNodeRelay({ data: tempDir('devot-relay-oversize-'), secret })
  const host = { ...relay, secret }
  const vault = await createVault(host)
  const abuser = await connect(host, vault.vault, vault.first.token)
  abuser.socket.sendRaw(new Uint8Array(33 * 1024 * 1024))
  expect((await abuser.socket.closed).code).toBe(1009)

  const other = await connect(host, vault.vault, vault.first.token)
  other.socket.send({ type: 'time' })
  await other.socket.expect('time')
  other.socket.close()
  await relay.close()
})

it('survives a client that resets the connection while its upgrade is checked', async () => {
  const relay = await startNodeRelay({ data: tempDir('devot-relay-reset-'), secret })
  const host = { ...relay, secret }
  const vault = await createVault(host)
  const { port } = new URL(relay.url)
  const upgrade = [
    `GET /v1/vaults/${vault.vault}/socket HTTP/1.1`,
    'Host: relay',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}`,
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Protocol: ${socketProtocols(vault.first.token).join(', ')}`,
    '',
    '',
  ].join('\r\n')
  for (let i = 0; i < 200; i++) {
    await new Promise<void>((resolve) => {
      const raw = tcp(Number(port), '127.0.0.1', () =>
        raw.write(upgrade, () => {
          raw.resetAndDestroy()
          resolve()
        }),
      )
      raw.on('error', () => resolve())
    })
  }

  const other = await connect(host, vault.vault, vault.first.token)
  other.socket.send({ type: 'time' })
  expect((await other.socket.expect('time')).message).toMatchObject({ type: 'time' })
  other.socket.close()
  await relay.close()
})
