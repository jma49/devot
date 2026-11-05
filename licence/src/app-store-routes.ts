/**
 * The licence exchange, App Store Server Notifications and the renewal check
 * (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md). The client's JWS only
 * names a transaction: the decisions use Apple's own answer. Logs carry codes and licence IDs,
 * never a JWS, a transaction ID or a key.
 */
import { MAX_TRANSACTION_JWS, verifyAppleJws } from './apple.ts'
import {
  type AppleAnswer,
  type AppleApi,
  type AppStoreConfig,
  type AppStoreEnvironment,
  isEnvironment,
  readTransaction,
  refusal,
  type Transaction,
} from './app-store.ts'
import { type LicenceCode, LicenceError } from './errors.ts'
import { APP_STORE_LICENSEE, instant, newLicenceId, type Signer, signLicence } from './format.ts'
import { json, readBody } from './http.ts'
import type { AppStoreCheck, Store } from './store.ts'

export interface AppStoreDeps {
  config: AppStoreConfig
  apple: AppleApi
  /** Signs the keys of sandbox purchases: the public test seed under kid `test`. */
  sandboxSigner: Signer
  /** Apple Root CA - G3 outside tests. */
  root?: Uint8Array
}

export const APP_STORE_LIMITS = {
  exchangeBytes: 16 * 1024,
  notificationBytes: 64 * 1024,
  exchangePerIp: 30,
  exchangePerTransaction: 10,
  windowSeconds: 3600,
  /** A licence's renewal asks Apple at most this often. */
  checkEveryMs: 86_400_000,
}

/** The notifications that take a licence away; every other type changes nothing. */
const REVOKING = new Set(['REFUND', 'REVOKE'])
const NOTIFICATION_TYPE = /^[A-Z_]{1,40}$/
const UUID = /^[0-9A-Fa-f-]{1,64}$/

interface Context {
  deps: AppStoreDeps
  store: Store
  /** The Worker's own signer: production purchases get keys signed with it. */
  signer: Signer
  now: () => Date
  log: (line: string) => void
  rateKey: (kind: string, value: string) => Promise<string>
}

export function appStoreRoutes(ctx: Context) {
  const { deps, store, now, log } = ctx
  const { config } = deps

  const readJws = async (jws: unknown, at = now()) =>
    readTransaction(await verifyAppleJws(jws, at, deps.root, MAX_TRANSACTION_JWS))

  /** The client's JWS: refused as the caller's. */
  async function claimed(jws: unknown): Promise<Transaction> {
    const transaction = await readJws(jws)
    if (!transaction) throw new LicenceError('E_APP_STORE_SIGNATURE')
    return transaction
  }

  /** Apple's own answer: one that fails verification is Apple's fault, not the caller's. */
  async function fromApple(answer: AppleAnswer): Promise<Transaction> {
    switch (answer.status) {
      case 'found': {
        const transaction = await readJws(answer.signedTransactionInfo)
        if (!transaction) throw new LicenceError('E_APP_STORE_UPSTREAM')
        return transaction
      }
      case 'not-found':
        throw new LicenceError('E_APP_STORE_NOT_FOUND')
      case 'unreachable':
        throw new LicenceError('E_APP_STORE_UNREACHABLE', answer.detail)
      case 'config':
        throw new LicenceError('E_LICENCE_CONFIG', answer.detail)
    }
  }

  /** The IP first, and the purchase only when the IP is under its limit, as /resend does. */
  async function limit(request: Request, environment: string, original: string): Promise<void> {
    const hour = Math.floor(now().getTime() / 1000 / APP_STORE_LIMITS.windowSeconds)
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const byIp = await store.hit(await ctx.rateKey('app-store-ip', ip), hour)
    const allowed =
      byIp <= APP_STORE_LIMITS.exchangePerIp &&
      (await store.hit(
        await ctx.rateKey('app-store-purchase', `${environment}:${original}`),
        hour,
      )) <= APP_STORE_LIMITS.exchangePerTransaction
    if (!allowed) {
      log('I_APP_STORE_LIMITED')
      throw new LicenceError('E_LICENCE_RATE_LIMITED')
    }
  }

  async function revoke(
    environment: AppStoreEnvironment,
    original: string,
    reason: string,
    notificationUuid?: string,
  ): Promise<void> {
    const revoked = await store.revokeAppStore(
      environment,
      original,
      instant(now()),
      notificationUuid,
    )
    log(revoked ? `I_APP_STORE_REVOKED ${revoked.licenceId} ${reason}` : 'I_APP_STORE_REPLAYED')
  }

  /** `POST /app-store/exchange {transaction}`: the purchase's one licence, `{key, id}`. */
  async function exchange(request: Request): Promise<Response> {
    const body = await readBody(request, APP_STORE_LIMITS.exchangeBytes)
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch {
      throw new LicenceError('E_LICENCE_BAD_REQUEST')
    }
    const jws = (value as { transaction?: unknown } | null)?.transaction
    if (typeof value !== 'object' || Array.isArray(value) || typeof jws !== 'string') {
      throw new LicenceError('E_LICENCE_BAD_REQUEST')
    }
    const named = await claimed(jws)
    const early = refusal(named, config)
    if (early) throw new LicenceError(early)
    if (named.revoked) throw new LicenceError('E_LICENCE_REVOKED')
    const environment = named.environment as AppStoreEnvironment
    await limit(request, environment, named.originalTransactionId)

    const current = await fromApple(await deps.apple.transaction(environment, named.transactionId))
    const refused = refusal(current, config)
    if (refused) throw new LicenceError(refused)
    if (
      current.environment !== environment ||
      current.originalTransactionId !== named.originalTransactionId ||
      current.transactionId !== named.transactionId
    ) {
      throw new LicenceError('E_APP_STORE_MISMATCH')
    }
    if (current.revoked) {
      await revoke(environment, current.originalTransactionId, 'EXCHANGE')
      throw new LicenceError('E_LICENCE_REVOKED')
    }
    const row = await store.exchange({
      environment,
      originalTransactionId: current.originalTransactionId,
      transactionId: current.transactionId,
      purchasedAt:
        current.originalPurchaseDate === null
          ? null
          : instant(new Date(current.originalPurchaseDate)),
      licenceId: newLicenceId(),
      at: instant(now()),
    })
    if (row.environment !== environment) throw new LicenceError('E_APP_STORE_MISMATCH')
    if (row.revokedAt || !row.issuedAt) throw new LicenceError('E_LICENCE_REVOKED', row.licenceId)
    const signer = environment === 'Production' ? ctx.signer : deps.sandboxSigner
    const key = await signLicence(signer, {
      id: row.licenceId,
      licensee: APP_STORE_LICENSEE,
      issuedAt: row.issuedAt,
    })
    log(`I_APP_STORE_EXCHANGED ${row.licenceId}`)
    return json({ key, id: row.licenceId }, 200)
  }

  const unverified = () => {
    log('E_APP_STORE_SIGNATURE notification')
    return json({ code: 'E_APP_STORE_SIGNATURE' }, 401)
  }

  /**
   * `POST /app-store/notifications`, App Store Server Notifications V2. 200 only once the write is
   * done, so Apple retries one that failed; anything that fails verification is 401 at once.
   */
  async function notification(request: Request): Promise<Response> {
    const body = await readBody(request, APP_STORE_LIMITS.notificationBytes)
    let signedPayload: unknown
    try {
      signedPayload = (JSON.parse(body) as { signedPayload?: unknown } | null)?.signedPayload
    } catch {
      return json({ code: 'E_LICENCE_BAD_REQUEST' }, 400)
    }
    if (typeof signedPayload !== 'string') return json({ code: 'E_LICENCE_BAD_REQUEST' }, 400)
    const payload = await verifyAppleJws(
      signedPayload,
      now(),
      deps.root,
      APP_STORE_LIMITS.notificationBytes,
    )
    if (!payload) return unverified()
    const data = payload['data'] as Record<string, unknown> | undefined
    const type = payload['notificationType']
    const uuid = payload['notificationUUID']
    if (
      typeof data !== 'object' ||
      data === null ||
      data['bundleId'] !== config.bundleId ||
      !isEnvironment(data['environment']) ||
      typeof type !== 'string' ||
      !NOTIFICATION_TYPE.test(type) ||
      typeof uuid !== 'string' ||
      !UUID.test(uuid)
    ) {
      return unverified()
    }
    const environment = data['environment']
    if (!REVOKING.has(type) && type !== 'REFUND_REVERSED') {
      log(`I_APP_STORE_NOTIFICATION ${type}`)
      return json({ received: true }, 200)
    }
    const transaction = await readJws(data['signedTransactionInfo'])
    if (
      !transaction ||
      transaction.bundleId !== config.bundleId ||
      transaction.environment !== environment
    ) {
      return unverified()
    }
    if (transaction.productId !== config.productPro) {
      log(`I_APP_STORE_NOTIFICATION ${type} other-product`)
      return json({ received: true }, 200)
    }
    if (type === 'REFUND_REVERSED') {
      // The licence stays revoked until the owner restores it by hand (docs/licensing.md).
      const row = await store.appStoreLicence(environment, transaction.originalTransactionId)
      log(`I_APP_STORE_REFUND_REVERSED ${row?.licenceId ?? 'none'}`)
      return json({ received: true }, 200)
    }
    await revoke(environment, transaction.originalTransactionId, type, uuid)
    return json({ received: true }, 200)
  }

  /** Why Apple's answer refuses a renewal, or null; revokes the licence when Apple has. */
  async function judged(
    answer: Extract<AppleAnswer, { status: 'found' | 'not-found' }>,
    due: AppStoreCheck,
    at: Date,
  ): Promise<LicenceCode | null> {
    if (answer.status === 'not-found') return 'E_APP_STORE_NOT_FOUND'
    const current = await readJws(answer.signedTransactionInfo, at)
    if (!current) return 'E_APP_STORE_UPSTREAM'
    if (
      current.originalTransactionId !== due.originalTransactionId ||
      current.environment !== due.environment
    ) {
      return 'E_APP_STORE_MISMATCH'
    }
    if (current.revoked) {
      await revoke(due.environment, due.originalTransactionId, 'RENEWAL')
      return 'E_LICENCE_REVOKED'
    }
    return refusal(current, config)
  }

  /**
   * At `/activate`, after the seat is granted: asks Apple about an App Store licence at most once
   * a day, whatever the answer. Throws to refuse the lease. A refusal is stored and refuses every
   * lease until a later check Apple answers well; only Apple being unreachable (or the Worker's
   * own token refused) lets a licence with no standing refusal through unchecked.
   */
  async function renewal(licenceId: string): Promise<void> {
    const at = now()
    const before = instant(new Date(at.getTime() - APP_STORE_LIMITS.checkEveryMs))
    const { due, refusal: standing } = await store.claimAppStoreCheck(
      licenceId,
      instant(at),
      before,
    )
    const refuse = (code: LicenceCode | null) => {
      if (code) throw new LicenceError(code, licenceId)
    }
    if (!due) return refuse(standing)
    const answer = await deps.apple.transaction(due.environment, due.transactionId)
    if (answer.status === 'unreachable' || answer.status === 'config') {
      const code = answer.status === 'unreachable' ? 'E_APP_STORE_UNREACHABLE' : 'E_LICENCE_CONFIG'
      log(`${code} ${licenceId} ${answer.detail}`)
      return refuse(standing)
    }
    const refused = await judged(answer, due, at)
    await store.settleAppStoreCheck(licenceId, refused)
    refuse(refused)
  }

  return { exchange, notification, renewal }
}
