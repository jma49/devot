# The iPhone app is sold on the App Store with an in-app purchase, and the licence key still unlocks it

Status: accepted. Amends ADR 0006, ADR 0009 and ADR 0011.

The iPhone app goes on the App Store as a free download. A non-consumable in-app purchase, Devot Pro, unlocks it, and a free non-consumable in-app purchase, the 30-day Trial, starts its trial. The Mac stays as ADR 0006 and ADR 0009 describe: FSL-1.1-MIT, a 30-day trial kept in the keychain, and a licence sold once through the licence Worker. The two are joined both ways, and both ship in the first App Store release:

- a Mac licence key unlocks the iPhone by taking one of its three seats, as on a Mac;
- an iPhone purchase gets a Mac licence key: the app sends the purchase's signed transaction to the licence Worker, which checks it with Apple and signs an ordinary licence key (the **licence exchange**).

The iPad follows later; the first release is iPhone-only.

## Context

ADR 0006, Risk 3, left iOS open: App Store rules may require the licence to be sold as an in-app purchase. They do. App Review Guideline 3.1.1 says features are unlocked through in-app purchase, names licence keys among the mechanisms an app may not use to unlock them, and lets an app that is not a subscription offer a free time-limited trial as a non-consumable item at price tier 0 named like "30-day Trial". Guideline 3.1.3(b), Multiplatform Services, lets an app that works across platforms unlock what was bought elsewhere, provided the same unlock is also sold as an in-app purchase, and the app must not point iPhone users to another way to pay. Enter Licence Key rests on 3.1.3(b) (Risks 1).

The owner's requirement for the exchange is that it opens no loophole in security or authorisation: a purchase yields at most one licence, only a real purchase of the full unlock yields one, and a refund takes it away.

## Decision

### Products

| Product      | Type                   | Product ID                    | Price    |
| ------------ | ---------------------- | ----------------------------- | -------- |
| Devot Pro    | non-consumable         | `io.github.jma49.devot.pro`   | US$29.99 |
| 30-day Trial | non-consumable, tier 0 | `io.github.jma49.devot.trial` | free     |

- Family Sharing stays off for both. Apple does not let it be turned off once it is on.
- The product IDs are fixed here because App Store Connect never lets an ID be reused. The owner creates both products.
- The owner chose price parity: Devot Pro costs US$29.99, the App Store price nearest the Mac licence's US$29.90 on the website. Other storefronts take Apple's equivalents for that price.

### What unlocks the iPhone

In an App Store build (a release build marked for the App Store, below), editing, sync and AI (the plan's features, ADR 0006) are unlocked by any one of:

1. **an App Store purchase:** a current, verified Devot Pro transaction, bought by this Apple account (`ownershipType` purchased, never family shared), not revoked, for this app's bundle ID. It takes no seat: Apple already ties it to one Apple account, and the Mac key it can get has its own three seats;
2. **a licence with an active seat,** exactly as on a Mac (ADR 0009): pasted in Settings > Licence or opened as `devot://licence?key=…`, activated with the Worker, renewed every 30 days, and read-only again once it is revoked or its lease ends;
3. **a running trial purchase:** the 30-day Trial was bought, and fewer than 30 days have passed since its `originalPurchaseDate`.

Otherwise the iPhone is read-only under the same rules as the Mac after its trial (ADR 0006): notes can be read, searched, copied and exported, and nothing else.

- The trial's start comes from Apple's signed transaction, so reinstalling or restoring on another iPhone with the same Apple account does not start it again. The keychain's latest time seen (ADR 0006, The trial) still applies: setting the clock back more than an hour before it ends the trial. A new Apple account gets a new trial; that is accepted, like erasing the Mac's keychain item.
- The keychain trial is not used in App Store builds, and its keychain record is never created there. It stays for the Mac and for iPhone development builds installed from a Mac; a TestFlight build is an App Store build.
- StoreKit checks each transaction's signature on the device; only a `verified` result counts, and Rust then checks the product ID, bundle ID, ownership type and revocation date of what the bridge reports. Rust does not check Apple's certificate chain again on the device: a patched build skips any such check, which ADR 0006, Risk 1, accepts.
- The app listens to StoreKit's transaction updates from launch, so a purchase made on another device, a refund or a revocation reaches it while it runs, and it reads the current entitlements again at each launch and on Restore Purchases.
- Several iPhones signed in to the same Apple account are all unlocked by one purchase. That is how App Store purchases work, and it is accepted.

### What the iPhone shows

- **The welcome and purchase sheet,** before the trial and when it ends: the trial's length, what is locked when it ends, and the price of Devot Pro as StoreKit gives it. Its actions are Start 30-day Trial, Buy Devot Pro, Restore Purchases and Enter Licence Key.
- **Settings:** the Licence row, Restore Purchases, and once an App Store purchase is held, Get a Mac Licence Key.
- **No way to pay outside the App Store:** an App Store build shows no link to `/buy` or to the website's prices, and no price other than StoreKit's. A test enforces this for every phone surface.
- **Manage Devices stays, without the website.** The Worker's pages link to devot.online in their header and footer, and the website sells the Mac licence and shows its price, so the phone opens `/devices?from=app` instead, in Safari. With `from=app` the Worker serves `/devices`, its form posts and its error answers with no link to devot.online or `/buy`; without it they are unchanged. A test over the Worker's pages checks that the flagged page links nowhere outside `/devices`.

### The licence exchange

`POST /app-store/exchange` on the licence Worker, with `{ "transaction": "<JWS>" }`: the signed transaction StoreKit returned for the Devot Pro purchase (`jwsRepresentation`). The answer is `{ "key": "devot1…", "id": "<licence id>" }`.

The Worker, in this order:

1. Refuses a body over 16 KB, or one that is not a JSON object with a `transaction` string (`E_LICENCE_BAD_REQUEST`).
2. Verifies the client's JWS: ES256, an `x5c` chain of three certificates that ends in Apple Root CA - G3, which the Worker holds pinned in its source; the leaf and intermediate carry Apple's App Store receipt-signing OIDs (`1.2.840.113635.100.6.11.1`, `1.2.840.113635.100.6.2.1`); every certificate is valid at the JWS's `signedDate` or now, because StoreKit may return a transaction signed long ago and Apple's answer (step 5) decides anyway. A JWS that fails is refused (`E_APP_STORE_SIGNATURE`) without any request to Apple. A bare transaction ID is never accepted: Apple's transaction IDs are numbers that can be guessed, and accepting them would let anyone fetch a key for someone else's purchase.
3. Checks the client's JWS before spending anything on it: `productId` is Devot Pro (`E_APP_STORE_PRODUCT`), `bundleId` is the app's, `inAppOwnershipType` is `PURCHASED` (`E_APP_STORE_FAMILY_SHARED`) and `type` is non-consumable. A genuine JWS for the free Trial is refused here and costs no request to Apple.
4. Counts the request against the rate limits (below), the caller's IP first and the JWS's `originalTransactionId` only when the IP is under its limit, before it calls Apple.
5. Asks Apple for the transaction itself: App Store Server API, Get Transaction Info, by the JWS's `transactionId`, at the host of the JWS's `environment` (`api.storekit.itunes.apple.com` for production, `api.storekit-sandbox.itunes.apple.com` for sandbox), authorised with a JWT the Worker signs with the In-App Purchase key (ES256, `kid` the key ID, `iss` the issuer ID, `aud` `appstoreconnect-v1`, `bid` the bundle ID, five minutes). The decisions use Apple's answer, whose signed transaction is verified as in step 2; the client's JWS only says which transaction to ask about, and its `originalTransactionId` must match Apple's. Apple answering 404 refuses (`E_APP_STORE_NOT_FOUND`); an answer that fails verification is Apple's fault, not the caller's, and refuses with `E_APP_STORE_UPSTREAM` (503); a network failure, a 5xx or a 429 refuses with `E_APP_STORE_UNREACHABLE` and issues nothing.
6. Requires, in Apple's answer, the same checks as step 3, which are the deciding ones: `bundleId` is the app's; `productId` is Devot Pro (never the Trial); `type` is non-consumable; `inAppOwnershipType` is `PURCHASED` (`FAMILY_SHARED` is refused); there is no `revocationDate` (`E_LICENCE_REVOKED`); `environment` matches the JWS.
7. **The environment decides the signing key.** A production transaction gets a key signed with the production licence key. A sandbox transaction (Xcode, TestFlight, App Review and sandbox testers all buy in sandbox, at no cost) gets a key signed with the public test seed under kid `test` (`licence/test-vectors.json`), which needs no secret: release builds do not hold the `test` public key (`keys.rs` keeps it to tests and debug builds), and `payable()` already treats `test` as the kid that is never production. Neither `test` nor any other sandbox kid is in the production Worker's `publicKeys`: `licenceFor` trusts any kid in that ring, so the Worker leaves `test` out of it, even when `LICENCE_KEYS` lists it, unless it signs under `test` itself. A sandbox key is therefore refused by `/activate`, `/deactivate` and `/devices` (`E_LICENCE_UNKNOWN_KID`) and by every release build, while App Review still sees the row show a key.
8. **One key per purchase.** `app_store_licences` (a new D1 table) has `(environment, original_transaction_id)` as its primary key and a unique `licence_id`, with the latest transaction ID, the purchase date (NULL when Apple's answer has none), `issued_at`, `checked_at`, `check_refusal` and `revoked_at`. The Worker inserts the row with a new licence ID if none exists for that environment (`INSERT … ON CONFLICT DO NOTHING`) and then reads it, so two requests at once still make one row. A row whose environment differs from Apple's answer is refused. A repeated exchange returns the same licence ID and, because Ed25519 signatures are deterministic and the key is signed again from the row, the same key while the signing kid is unchanged; after a key rotation (docs/licensing.md) it is the same licence signed under the new kid, and the earlier key keeps verifying through `LICENCE_KEYS`. A revoked row is refused.
9. Signs the key: the usual format and plan, `issuedAt` from the row, and `licensee` the fixed label `App Store purchase` (below).

The key can be got again from the iPhone at any time, as many times as wanted. The Worker sends no email, because it has no address; the iPhone sheet shows the key with Copy and Share, and Share's text carries the key and its `devot://licence?key=…` link, so AirDrop or Messages to a Mac opens it there. There is no Open in Devot button: on the iPhone the link would open this same app and offer to add the key here, and the iPhone never adds it. Share shows only where `navigator.share` exists.

### The key's licensee

App Store buyers give no email address. `licensee` stays a required, non-empty string, and an exchanged key carries the fixed text `App Store purchase`. `format.rs` and `format.ts` do not change, so every key already sold still verifies and an exchanged key verifies in every Mac version already released. The text cannot be an email address, so it never names a person, and newer apps show it as "Bought on the App Store" from the message catalogue (a constant beside the format in both languages). Mac versions already released show the raw text: Settings > Licence's Licensed To and the prompt before a link replaces a key (`licenceView.ts`) read `App Store purchase`, which is accepted. The key no longer shows whose it is, which ADR 0006, Risk 6, counted as a brake on sharing; the three seats are the brake instead.

### Refunds and revocations

- **App Store Server Notifications V2** go to `POST /app-store/notifications`, set for both environments in App Store Connect. The Worker refuses a body over 64 KB, verifies `signedPayload` and the `signedTransactionInfo` inside it as in step 2 (`signedPayload` nests a whole transaction JWS and may carry `signedRenewalInfo`, so it may be as large as the body; a transaction JWS is capped at 16 KB), and checks `data.bundleId` and `data.environment`; a notification acts only on rows of its own environment.
- `REFUND` and `REVOKE` revoke the licence of that environment's `originalTransactionId`: its row's `revoked_at` is set and its ID joins `/revoked`, so the Mac (and any iPhone holding that key) becomes read-only at its next daily check, and `/activate` refuses it. A notification for a transaction that has no licence yet still records the revocation, so a later exchange is refused, as `revoked_payments` does for Stripe.
- `REFUND_REVERSED` is logged and changes nothing: the row stays revoked, so a later exchange of that purchase is refused too, until the owner clears `revoked_at` by hand (docs/licensing.md, Revoking by hand, gains this restore step). `TEST` and every other type answer 200 and do nothing.
- The Worker answers 200 only after the database write, so Apple retries a notification that failed. Revoking twice is harmless.
- **A missed notification is caught at a lease renewal.** A device renews its lease once it is within 7 days of its end (`REFRESH_BEFORE_MS`), so about 23 days after the last renewal; a refund whose notification never arrived is caught up to about 23 days later, not daily. `/activate` for a licence that came from the App Store asks Apple for the stored transaction only after `store.activate` has granted the seat, and at most once per licence a day (`checked_at`, set at every attempt whatever the answer): device IDs are made by the client, so asking before the seat or on every call would let anyone spend the In-App Purchase key's quota and force the unreachable path. A `revocationDate` revokes the licence and refuses without a lease. A 404 (`E_APP_STORE_NOT_FOUND`), an answer for another purchase or environment (`E_APP_STORE_MISMATCH`), one that fails verification (`E_APP_STORE_UPSTREAM`) or one that fails step 6's checks refuses without a lease, and its code is stored in `check_refusal`: every later `/activate` of that licence, from any device, is refused with it, without asking Apple again that day, until a later check that Apple answers well (or a new exchange of the purchase) clears it. Only a network failure, a 5xx or a 429 counts as unreachable: then `E_APP_STORE_UNREACHABLE` is logged and the lease is issued, because notifications stay the main path, unless a refusal stands, which then still refuses.
- **The refund window.** Between an exchange and a refund, a Mac that stays offline keeps working until its lease ends, at most 30 days, the same as after a Stripe chargeback under ADR 0009. This is accepted.
- **On the iPhone,** a refunded or revoked purchase leaves StoreKit's current entitlements; the app sees it through transaction updates or at its next launch and becomes read-only unless a licence seat or a running trial holds.
- **A Mac licence used on the iPhone** is revoked as everywhere else: the iPhone fetches `/revoked` on the same daily schedule as the Mac, and its lease is not renewed.

### Storage, routes and the existing tables

- `app_store_licences` is a new table; `licences` and its Stripe columns do not change. Every read of a licence by ID (`/activate`, `/deactivate`, `/devices`, `/revoked`) goes through one store function that reads both tables, so an App Store licence is activated, freed and revoked exactly like a Stripe one. Sandbox rows never enter `/revoked`.
- No email, no name, no key and no notes are stored, as before. Apple's transaction IDs stay in D1 only.

### Rate limits

The existing `rate_limits` table, with keyed hashes: `/app-store/exchange` allows 30 requests an hour per IP and 10 an hour per `originalTransactionId`, counted after the JWS and its fields check out and before Apple is asked, so a forged request costs one signature check and nothing else. As `/resend` does, the IP is counted first and the transaction only when the IP is under its limit, so an over-limit IP cannot spend a buyer's allowance. A refused request says `E_LICENCE_RATE_LIMITED`. The notification route is not rate-limited, because Apple must be able to retry, but a body over 64 KB is refused and anything that fails verification is answered 401 at once. `/activate`'s question to Apple is bounded by the seat and the daily `checked_at`, not by a rate limit.

### Secrets and configuration

- Wrangler secrets: `APP_STORE_KEY` (the In-App Purchase key's `.p8`, PKCS #8), `APP_STORE_KEY_ID`, and `APP_STORE_ISSUER_ID`. The sandbox signs with the public test seed, so it needs no secret. Variables: `APP_STORE_BUNDLE_ID` and `APP_STORE_PRODUCT_PRO`.
- They are not added to the Worker's required list: without them the App Store routes answer `E_LICENCE_CONFIG` (503) and everything Stripe sells keeps working.
- The `.p8` can only read this app's transactions and history, never sign a licence. If it leaks, the owner revokes it in App Store Connect and sets a new one; no licence changes.

### Logs

Codes and IDs only, as ADR 0006 requires: the code and the licence ID, never the JWS, a transaction ID, the licensee, a key or note content. `I_APP_STORE_EXCHANGED <licence id>`, `I_APP_STORE_REVOKED <licence id> <notification type>`, `E_APP_STORE_SIGNATURE`, `E_APP_STORE_PRODUCT`, `E_APP_STORE_FAMILY_SHARED`, `E_APP_STORE_NOT_FOUND`, `E_APP_STORE_MISMATCH`, `E_APP_STORE_UNREACHABLE`, `E_APP_STORE_UPSTREAM`. The app logs the same codes and never the JWS.

### The native bridge

StoreKit 2 has a Swift interface only. A small Swift package (`src-tauri/apple/DevotStore/`), built into the iOS Xcode project, wraps it and exports a C ABI (`@_cdecl` functions). It asks for the two products, buys one, restores (`AppStore.sync()`), reads the current entitlements, listens to transaction updates, and finishes a transaction once Rust has recorded it. It decides nothing: it returns each verified transaction's fields and its JWS as UTF-8 JSON through a callback, which Rust copies and returns to Swift to free.

- Every `extern "C"` declaration and call is in `src-tauri/src/native/ios.rs`, the one iOS module allowed `unsafe`, each block with a `SAFETY` comment, and a call that fails gives the caller's fallback rather than a crash.
- Rust sees the store through a trait (`AppStore`): the FFI implementation on iOS and a fake everywhere else, so the entitlement rules are tested with plain Rust tests.
- The Swift package is tested with a StoreKit configuration file (`DevotStore.storekit`) holding both products, through StoreKit Test, on the macOS CI runner: purchase, the trial's date, a refund and Ask to Buy's pending state.

### App Store builds

A release build is an App Store build when the release workflow sets the distribution at build time (beside `DEVOT_RELEASE_BUILD`); `keys.rs`' `gates()` is unchanged. Only that build reads StoreKit, uses the trial purchase and hides every outside purchase link; a development build installed from a Mac keeps the keychain trial and the licence alone. The first release sets the device family to iPhone only.

## Threat model

| Attack                                                                             | Defence                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forge a signed transaction                                                         | JWS verified against the pinned Apple Root CA - G3 with Apple's OIDs, then the transaction fetched from Apple's own API with the Worker's key; decisions use Apple's answer.                                      |
| Send a guessed or harvested transaction ID                                         | A bare ID is never accepted; only an Apple-signed JWS names a transaction, and it is obtainable only from the purchaser's StoreKit.                                                                               |
| Exchange the free Trial for a key                                                  | `productId` must be Devot Pro, checked on the client's JWS before Apple is asked and again on Apple's answer.                                                                                                     |
| Use a transaction of another app                                                   | `bundleId` must be this app's, on the JWS and on Apple's answer.                                                                                                                                                  |
| Buy free in sandbox (TestFlight, sandbox testers, Xcode) and take a production key | The environment chooses the signing key: sandbox gets kid `test`, which no release trusts and the production Worker's ring leaves out; Xcode's local signatures fail the chain check.                             |
| Exchange the same purchase again for more keys or seats                            | One row per environment and `originalTransactionId`, unique licence ID, insert-or-read in one step: a repeat returns the same licence, which has three seats.                                                     |
| Two exchanges at once                                                              | The primary key makes the second insert a no-op; both read the one row.                                                                                                                                           |
| A leaked JWS or key is replayed by someone else                                    | It yields only that purchase's one key, capped at three seats; the buyer frees seats on `/devices`. A leaked JWS is equivalent to a leaked key, which ADR 0009 already caps.                                      |
| Use a family member's purchase                                                     | Family Sharing is off for the product; `FAMILY_SHARED` is refused by the Worker and not counted by the iPhone.                                                                                                    |
| Exchange, then refund                                                              | `REFUND` notification revokes the licence and lists it in `/revoked`; a missed one is caught at a lease renewal, within about 23 days; the iPhone loses the entitlement.                                          |
| Refund, then exchange                                                              | Apple's answer carries `revocationDate`, and the notification already recorded the revocation: refused.                                                                                                           |
| Forge or replay a refund notification                                              | The signed payload and its transaction are verified; a genuine one only revokes what Apple refunded; it acts only on rows of its environment.                                                                     |
| Flood the exchange to spend the Worker's or Apple's quota                          | Body cap, local JWS and field checks before any request to Apple, rate limits per hashed IP and per transaction.                                                                                                  |
| Set the clock back to extend the trial                                             | The trial starts at Apple's signed purchase date, and the keychain's latest time seen ends it when the clock goes back more than an hour.                                                                         |
| Reinstall or restore to get a new trial                                            | The trial purchase is a non-consumable that restores with the Apple account; a new Apple account gets a new trial, which is accepted.                                                                             |
| Patch StoreKit or the check out of a jailbroken or self-built app                  | Out of scope, as ADR 0006, Risk 1: a build from source gates nothing anyway. The exchange is server-side, so a patched app gets no Mac key.                                                                       |
| Drive `/activate`'s Apple check with made-up device IDs to spend the key's quota   | Apple is asked only after a seat is granted, at most once per licence a day; only a network failure, a 5xx or a 429 counts as unreachable. A refusal is stored and refuses every device until Apple answers well. |
| Mix a sandbox and a production row of one purchase                                 | Rows are keyed by environment; a row whose environment differs from Apple's answer is refused.                                                                                                                    |
| Reach the website's price from the phone through Manage Devices                    | The phone opens `/devices?from=app`, which links nowhere outside `/devices`.                                                                                                                                      |
| Steal the In-App Purchase `.p8`                                                    | It reads transactions only and signs no licence; revoke it in App Store Connect.                                                                                                                                  |
| Steal the licence signing key                                                      | As ADR 0006, Risk 5. The sandbox signs with the public test seed, which no release and no production ring trusts.                                                                                                 |
| Read personal data from logs                                                       | Logs carry codes and licence IDs only, never a JWS, a transaction ID, a key or the licensee.                                                                                                                      |
| Point iPhone users to an outside purchase                                          | App Store builds show no outside link or price; a test checks every phone surface.                                                                                                                                |

## Consequences

- ADR 0006: the licence is now sold in two places, the Worker (Stripe) and the App Store, and Risk 3 is settled here. An exchanged key's `licensee` is `App Store purchase`, not an email. In App Store builds, the trial is the trial purchase.
- ADR 0009: an iPhone unlocked by its own App Store purchase takes no seat. A licence used on the iPhone takes one, as before.
- ADR 0011: on the iPhone, any service a hosted sync would sell must also be sold as an in-app purchase (Guideline 3.1.1), so a hosted service, if it ever comes, needs an auto-renewing subscription in the App Store beside the Worker's billing. This ADR changes nothing else in ADR 0011.
- docs/licensing.md gains the exchange, the notifications, the new table and secrets, the sandbox's use of the test seed, and the restore step after `REFUND_REVERSED`; docs/releasing.md gains the App Store build and upload.
- **Owner-only steps:** the Paid Apps agreement, tax and banking; the app record; the two products, with Family Sharing off and the Devot Pro price; the In-App Purchase key and the App Store Connect API key for uploads; the notification URLs for both environments; sandbox testers; the privacy answers and export compliance; App Review notes that explain Guideline 3.1.3(b) for Enter Licence Key, with a production licence key (a complimentary one, docs/licensing.md) for App Review to test it with; the final submit.
- **Tickets:** the Swift bridge and StoreKit 2; entitlements in App Store builds; the App Store build configuration; the licence exchange, refunds and Get a Mac Licence Key. The bridge, the build configuration and the Worker's side of the exchange can start at once; entitlements and the Get a Mac Licence Key row need the bridge.

## Risks

1. **App Review may reject Enter Licence Key.** Guideline 3.1.1 lists licence keys among the unlock mechanisms it forbids; the defence is Guideline 3.1.3(b), Multiplatform Services, which allows it because Devot Pro is also sold in the app. The review notes say so and give App Review a production licence key to try, and the sheet offers the in-app purchase first. If App Review still rejects it, the App Store build ships without Enter Licence Key (and without opening `devot://licence` links): the iPhone is unlocked only by Devot Pro or the trial purchase. A Mac buyer then gets the iPhone's 30-day trial and read-only after it, or buys Devot Pro; the Mac key keeps its three seats on Macs, and the exchange still gives iPhone buyers a Mac key.
2. **Apple's service is a dependency of the exchange,** not of the iPhone's own unlock: while Apple's API is down, a buyer cannot get a Mac key, and the iPhone still works.
3. **Apple keeps a share of each App Store sale,** and both channels sell the same unlock.

## Rejected

- **Trusting the client's JWS alone.** It is signed by Apple, but a JWS can be old and does not show a later refund; asking Apple for the transaction gives the current state.
- **Binding the exchange to `appAccountToken`.** It is inside the JWS, so a leaked JWS carries it, and an iPhone that restored the purchase does not know a secret set by the one that bought it. It adds no proof of ownership beyond the JWS itself.
- **Binding it to `deviceVerification` (the device's vendor identifier).** It would send a device identifier to the Worker to stop a JWS leak, which costs no more than a key leak already capped by seats.
- **Requiring a recent `signedDate`.** StoreKit may return a cached transaction, and a replay yields only the same key.
- **A separate sandbox signing key.** It would add a secret and a kid to keep out of every ring; the public test seed is already the key no release trusts.
- **Making `licensee` optional.** Every Mac version already released refuses a key without it.
- **Counting the iPhone's own purchase as a seat.** Apple ties it to the account; a seat would add an online step and change nothing for the Mac key's three seats.
- **Keeping the keychain trial in App Store builds.** Guideline 3.1.1 asks for the trial purchase, which also survives a reinstall.
- **A Tauri mobile plugin for StoreKit.** The entitlement decision belongs to Rust's licence module, which also enforces it; a C ABI keeps the boundary in the one module where `unsafe` is allowed, and the plugin layer adds nothing the bridge needs.
