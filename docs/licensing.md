# License Worker

The license Worker sells Devot's license through Stripe Checkout, signs license keys, mails them, sends them again on request and publishes the list of revoked licences (docs/adr/0006-source-available-and-sold-once.md). It is the one hosted service Devot runs, on the owner's Cloudflare account with a D1 database. It never sees notes and stores no email address: Stripe holds the buyer's address, and the Worker signs a key again from its row whenever it shows or mails one. The code is in `licence/`; the app checks keys offline against the formats below (The app).

## What it does

| Route                                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /buy`                                       | Creates a Checkout Session for `STRIPE_PRICE_LICENCE` and redirects to it (303); past 10 an hour from one IP, 429 `E_LICENCE_RATE_LIMITED` with `Retry-After`                                                                                                                                                                                                                                                                                                                                            |
| `POST /stripe/webhook`                           | Checks `Stripe-Signature`, then issues or revokes (below); answers 500 when something failed, so Stripe retries                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /done?session_id=<id>`                      | Stripe's success page: the key, Copy, Open in Devot (`devot://license?key=<key>`, URL-encoded), the manual way and a link to `/resend`; 202 and a page that reloads itself every 5 s while the payment is pending, at most 60 times (`check=<n>` in the reload URL), then stops with a Check Again link, so a forgotten tab does not keep asking Stripe. The waiting page has a Stop checking link (WCAG 2.2.1), and a delayed payment Stripe reports as failed answers `E_LICENCE_UNPAID` (402) instead |
| `GET /resend`, `POST /resend` (`email=…`)        | A form, and the answer to it: every live license bought with that address is mailed to it                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /revoked`                                   | The signed revocation list (`text/plain`, cacheable for 5 minutes)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /assets/license.css`, `GET /assets/copy.js` | The pages' stylesheet and the Copy button's script (cacheable for 5 minutes); served even before the secrets are set                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /activate`                                 | Takes or refreshes a device's seat and answers with a signed lease (Activation)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /deactivate`                               | Frees a device's seat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /devices`, `POST /devices`                  | The page a buyer uses to list the seats on a key and free one, for a device they no longer have; with `?from=app` (the iPhone's Manage Devices) the page, its forms and its errors link nowhere outside `/devices`                                                                                                                                                                                                                                                                                       |
| `POST /app-store/exchange`                       | Exchanges an App Store purchase of Devot Pro for its one license key (The App Store)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /app-store/notifications`                  | App Store Server Notifications V2: a refund or revocation revokes the purchase's license (The App Store)                                                                                                                                                                                                                                                                                                                                                                                                 |

- **Sessions** are in payment mode, for one unit of the Price, with `customer_creation=always`, so every purchase has a Stripe Customer that `/resend` finds by its address. Their metadata says `kind: license`. A session without it is not the Worker's (the Stripe account may sell other things) and is left alone. With `MANAGED_PAYMENTS=true` the session sets `managed_payments[enabled]=true`, which makes Stripe the merchant of record ([Managed Payments](https://docs.stripe.com/payments/managed-payments), [Build a Checkout integration](https://docs.stripe.com/payments/managed-payments/set-up)); otherwise it sets `automatic_tax[enabled]=true` (Stripe Tax). The success URL is the Worker's own `/done`; `CANCEL_URL`, when set, is where Checkout's back link goes.
- **Issuing.** `checkout.session.completed` with `payment_status: paid` (or, for a payment method that settles later, `checkout.session.async_payment_succeeded`) issues a license with a new random ID. One D1 transaction writes the license and the session's purchase row, keyed by the session ID, so a session issues at most one license however often Stripe retries. The key is then mailed to the address the buyer gave Checkout. A sender claims the purchase's mail before calling Resend and marks it mailed only once Resend accepts it, so `/done` and the webhook, or two deliveries of one event, send it once; while a claim is in flight the webhook answers 500, so Stripe retries, and a claim whose sender is cut off can be taken again after a minute. When the mail fails the claim is dropped, the webhook answers 500 and Stripe's retry sends the mail, not a second license. A test-mode purchase (`livemode: false`) is refused unless the Worker signs under the test kid, so a sandbox Worker given the production seed cannot hand out production-valid keys.
- **`/done` before the webhook.** When the buyer reaches `/done` first, the Worker retrieves the session from Stripe and, if it is paid, issues the license itself through the same transaction, then mails it after answering. The webhook that follows finds the session fulfilled.
- **The licensee** in a key is the email address of the Stripe Customer of the license's purchase. When that Customer is deleted or has no address, it is the address of the session being shown or mailed (or the one `/resend` matched); when there is none either, the answer is `E_LICENCE_NO_CUSTOMER` (409). Ed25519 signatures are deterministic, so the same row, signing key and licensee always give the same key; changing the Customer's address in Stripe changes the key signed from then on, and the old key stays valid.
- **Revoking.** Each purchase row keeps its PaymentIntent ID. `charge.refunded` with `refunded: true` (a full refund) and `charge.dispute.closed` with `status: lost` revoke the license that PaymentIntent paid for. The PaymentIntent is kept as revoked either way (`revoked_payments`, IDs only), so when the refund arrives before the purchase is recorded, the license is issued revoked and never mailed (`I_LICENCE_PAYMENT_REVOKED <payment intent>` when the refund matched no license, then `E_LICENCE_REVOKED <license> <session>`). `/revoked` lists the IDs of every revoked license.
- **`/resend`** stores a keyed hash of the buyer's lower-cased address with each purchase and finds every live license bought with the address through it, whatever capitals Stripe stored or the buyer types; it also looks up Stripe's Customers (as typed and in lower case, compared without case) for purchases recorded before the hash was kept, leaves out revoked ones and mails the keys in one message to the address. It answers at once with the same page whether or not anything was found, and does the lookup after answering. It sends at most 3 times an hour and 6 times a day per address, 10 times an hour per IP (`CF-Connecting-IP`), and 25 times a day in all, well under Resend's 100 a day so purchase mails keep room; an address's counters rise only while the IP is under its limit, so one IP cannot lock buyers out of their own recovery. Past a limit it answers the same page and sends nothing. The counters are D1 rows keyed by an HMAC of the address or IP, not the address or IP itself.
- **Errors** carry a code: `E_LICENCE_BAD_REQUEST`, `E_LICENCE_CONFIG` (a secret or variable is missing; 503), `E_LICENCE_METHOD`, `E_LICENCE_NOT_FOUND`, `E_LICENCE_REVOKED`, `E_LICENCE_SESSION_UNKNOWN`, `E_LICENCE_UNPAID` (402), `E_LICENCE_NO_CUSTOMER` (409), `E_LICENCE_STRIPE` (Stripe failed or did not answer; 502), `E_LICENCE_MAIL` (with Resend's error name, such as `validation_error`, `rate_limit_exceeded` or `daily_quota_exceeded`, or `network` or `http_<status>` when there is none), `E_LICENCE_TOO_LARGE`, `E_LICENCE_WEBHOOK_SIGNATURE`, `E_LICENCE_INTERNAL`. Pages show the code; the webhook answers `{"code": …}`.
- **Pages and the email.** Every page (`/done`, the waiting page, `/resend` and its answer, error pages) carries the optical dove and Devot's colours from the system theme's tokens (`licence/src/brand.ts`). Marks up to 32 px use the simplified cut from `design/app-icon/dove-small.svg`; larger marks use `design/app-icon/dove.svg`, with the existing light and dark inks. Pages follow `prefers-color-scheme`; nothing loads from elsewhere: no fonts, images or third-party scripts. Every HTML answer sends `Content-Security-Policy: default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`; the stylesheet and script come from the fixed `/assets/` routes, so no page has inline script or style. The Copy button shows only where the clipboard works. An error page gives a plain sentence and the code, never a stack or an address. The license email has an HTML part (inline styles, the dove as inline SVG, darkened where the mail client honours `prefers-color-scheme`) and a plain-text part with the same content: each key and its Open in Devot link, what the license unlocks (all of Devot, in every version, nothing to renew; read-only after the 30-day trial without one), the manual way (Devot > Settings > License), a full refund within 30 days of buying by replying, and support by replying. Replies go to `REPLY_TO` when set, else to `MAIL_FROM`, so that address must be read: refunds are made by hand in the Stripe Dashboard. All text is in `licence/src/messages.ts`; keys and addresses are always HTML-escaped.
- **Logs** are one line per event, a code and IDs only: `I_LICENCE_ISSUED <license> <session>`, `I_LICENCE_MAILED`, `I_LICENCE_REVOKED <license> refund|dispute`, `I_LICENCE_PAYMENT_REVOKED <payment intent> refund|dispute`, `I_LICENCE_RESENT <licences>`, `I_LICENCE_RESEND_LIMITED`, `E_LICENCE_UNPAID <session>` (a delayed payment Stripe reports as failed, and the answer `/done` gives it) and the error codes. Never an address or a key.

## Formats

### License key

`devot1.<payload>.<signature>`, about 260 characters for a short address.

- `<payload>` is base64url without padding (RFC 4648 section 5) of the payload's UTF-8 JSON.
- `<signature>` is base64url without padding of the 64-byte Ed25519 signature (RFC 8032) over the ASCII bytes of `devot1.<payload>`, the text before the second dot.

The payload is one JSON object, written in this order:

| Field      | Value                                                                 |
| ---------- | --------------------------------------------------------------------- |
| `id`       | 16 random bytes, base64url without padding (22 characters)            |
| `kid`      | the signing key's ID, a short string such as `2026-10`                |
| `plan`     | `pro`                                                                 |
| `licensee` | the buyer's email address                                             |
| `issuedAt` | when the license was issued, RFC 3339 in UTC to the second (`…T…:…Z`) |

A valid key unlocks all of Devot (editing, sync and AI) in every version, and nothing in it ends; without one, Devot is read-only once its 30-day trial ends. A paid upgrade, if there ever is one, needs a new key format and its own ADR.

To check a key:

1. It is at most 1024 characters and splits on `.` into exactly three parts, the first `devot1`.
2. Both other parts decode as canonical base64url without padding; the signature is 64 bytes.
3. The payload decodes as UTF-8 (strictly; no byte order mark) to a JSON object with the five fields above, each a string of the shape given, `plan` exactly `pro`. Fields it does not know are ignored. Otherwise: `E_LICENCE_MALFORMED`.
4. `kid` names a public key the app holds, else `E_LICENCE_UNKNOWN_KID`.
5. The signature verifies over the key's own bytes `devot1.<payload>` (never re-encode the JSON), else `E_LICENCE_SIGNATURE`.

`verifyLicence` in `licence/src/format.ts` is the reference.

### Revocation list

`devot1rev.<payload>.<signature>`, the same scheme with the prefix `devot1rev`, signed by the same key. The payload is `{"kid": …, "issuedAt": …, "ids": [...]}`: the signing key's ID, when the list was made (RFC 3339, UTC, to the second) and the IDs of all revoked licences in sorted order. The list grows by about 33 characters per revoked license. The prefix is part of the signed bytes, so a license key never passes as a list, nor a list as a key. `verifyRevocations` is the reference.

### Activation lease

`devot1dev.<payload>.<signature>`, the same scheme with the prefix `devot1dev`, signed by the same key. The payload is `{"id", "device", "kid", "issuedAt", "expiresAt"}`: the license ID, the device's random ID (16 random bytes, base64url without padding, 22 characters, made once and kept in the keychain), the signing key's ID, when the seat was taken and when the lease ends (30 days later). The prefix is part of the signed bytes, so a lease never passes as a key or a list, nor the other way round. The app verifies the lease offline against the same public keys and requires `id` and `device` to match its own, so a lease copied from another device is worthless. `verifyActivation` in `licence/src/format.ts` is the reference.

A license has `MAX_DEVICES` seats (3 by default). `POST /activate {key, device, label}` takes one, or refreshes the one that device holds; a licence whose seats are all taken answers `E_LICENCE_DEVICE_LIMIT` (409). `POST /deactivate {key, device}` frees one. The `/devices` page does the same from a browser: paste the key, see the seats, remove a device the buyer no longer has.

### Signing keys

- The private key is the 32-byte Ed25519 seed, base64url without padding, in the Wrangler secret `LICENCE_SIGNING_KEY`. Its ID is the variable `LICENCE_KID`.
- The public key is the raw 32-byte Ed25519 public key, base64url without padding. The app holds one per `kid`, so a new key ships in a release before the Worker signs anything with it.
- `pnpm --filter @devot/license keygen` prints a new pair and writes nothing to disk.
- `pnpm --filter @devot/license issue [--id <license ID>] <email>` signs a complimentary license with the seed in `LICENCE_SIGNING_KEY` and the kid in `LICENCE_KID`, under a new ID or the one `--id` gives, prints it and writes nothing (Complimentary licences).

### Test vectors

`licence/test-vectors.json` holds a test-only key pair (seed and public key) from a fixed seed with the kid `test`, valid keys with their payloads (bought, a non-ASCII licensee, a field this version does not know), invalid keys with the code each must fail with (a tampered payload, another key's signature, an unknown kid, a wrong prefix, a missing signature, the revocation list given as a key), and a revocation list with a tampered copy. The Worker's tests check that the format produces exactly this file and that each entry verifies as stated; the app's Rust tests read it too. `pnpm --filter @devot/license test-vectors` writes it again. Never ship the test key in a release.

## Deploy to the owner's Cloudflare account

You need a Cloudflare account (the **Workers Free** plan is enough: the Worker uses only a D1 database and outbound `fetch` calls, no Durable Objects, Queues or Cron Triggers), a domain on Cloudflare to send from, a [Resend](https://resend.com) account and a Stripe account. Nothing here deploys by itself: run each step yourself.

1. From a checkout of this repository: `pnpm install --filter @devot/license`, then in `licence/` sign in: `pnpm exec wrangler login`.
2. Create the database: `pnpm exec wrangler d1 create devot-license`, and add the `database_id` it prints to the `[[d1_databases]]` block of `licence/wrangler.toml`. Then create its tables: `pnpm exec wrangler d1 migrations apply devot-license --remote`.
3. Set up Resend (below): add and verify the sending domain, make an API key and store it with `pnpm exec wrangler secret put RESEND_API_KEY`. Until the domain is verified, mail fails with `E_LICENCE_MAIL validation_error`.
4. Make the signing key: `pnpm keygen`. Store the seed in your password manager and offline, then `pnpm exec wrangler secret put LICENCE_SIGNING_KEY` and paste it. Choose its kid (for example `2026-10`). Add the public key and kid to the app (The app, Adding a signing key) and release it before you sell.
5. Set up Stripe (below) and set its two secrets: `pnpm exec wrangler secret put STRIPE_SECRET_KEY` and `pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET`.
6. Fill in `[vars]` in `licence/wrangler.toml` (none is secret; see the table) and deploy: `pnpm exec wrangler deploy`. It prints the Worker's URL, `https://devot-license.<your subdomain>.workers.dev`; you may route it to your own domain instead.
7. Check it: `curl https://<the Worker>/revoked` answers a `devot1rev.` list. Until every secret and variable is set, every route answers `E_LICENCE_CONFIG`.

To update, pull the repository, apply any new migration (`pnpm exec wrangler d1 migrations apply devot-license --remote`) and run `pnpm exec wrangler deploy` again.

**Secrets** (`wrangler secret put`; never in a file):

| Secret                  | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| `LICENCE_SIGNING_KEY`   | the Ed25519 seed from `pnpm keygen`                         |
| `STRIPE_SECRET_KEY`     | a restricted key: Checkout Sessions Write, Customers Read   |
| `STRIPE_WEBHOOK_SECRET` | the webhook endpoint's signing secret (`whsec_…`)           |
| `RESEND_API_KEY`        | a Resend key with sending access to the one domain (`re_…`) |

For the App Store routes, three more; until all three are set those routes answer `E_LICENCE_CONFIG` (503) and everything else works as before:

| Secret                | Value                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `APP_STORE_KEY`       | the In-App Purchase key's `.p8` file, as App Store Connect gives it (PEM) |
| `APP_STORE_KEY_ID`    | that key's Key ID                                                         |
| `APP_STORE_ISSUER_ID` | the Issuer ID shown above the In-App Purchase keys                        |

**Variables** (`[vars]` in `licence/wrangler.toml`):

| Variable                | Value                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LICENCE_KID`           | the signing key's ID, as the app knows it                                                                                                                                                 |
| `STRIPE_PRICE_LICENCE`  | the license's one-time Price ID (`price_…`)                                                                                                                                               |
| `MANAGED_PAYMENTS`      | `true` for Managed Payments (the default), anything else for Stripe Tax                                                                                                                   |
| `MAIL_FROM`             | the sender address (shown as `Devot <address>`), on the verified Resend domain (for example `licence@devot.online`)                                                                       |
| `REPLY_TO`              | optional: an address that receives replies, sent as Resend's `reply_to` on every license mail; set it when the sending domain receives no mail. Empty or unset: no Reply-To               |
| `MAX_DEVICES`           | how many devices one licence may activate at once (default `3`; Activation)                                                                                                               |
| `LICENCE_KEYS`          | optional: older public keys, by kid, as a JSON object (`{"2026-10":"<base64url>"}`), so licences signed by them can still activate after a rotation; empty or unset: only the current key |
| `CANCEL_URL`            | optional: where Checkout's back link goes, such as the website's Buy page                                                                                                                 |
| `APP_STORE_BUNDLE_ID`   | the iPhone app's bundle ID, `io.github.jma49.devot`                                                                                                                                       |
| `APP_STORE_PRODUCT_PRO` | Devot Pro's product ID, `io.github.jma49.devot.pro`                                                                                                                                       |

## Resend

The Worker posts each message to Resend's [Send Email](https://resend.com/docs/api-reference/emails/send-email) endpoint (`https://api.resend.com/emails`) with `fetch`, no SDK, and the key as a bearer token.

1. Create a Resend account and, under Domains, add the domain you send from (for example `devot.online`). Resend shows its DNS records (SPF, DKIM and, if you want it, DMARC). Add them in the Cloudflare dashboard under the domain's DNS, then press Verify. Do not proxy these records.
2. Under API Keys, create a key with the Sending access permission restricted to that domain, and store it as `RESEND_API_KEY`.
3. Set `MAIL_FROM` to an address on that domain, such as `licence@devot.online`.

**Plan limits.** The free plan sends 3,000 emails a month, at most 100 a day, from one domain. Past a limit Resend answers 429 (`daily_quota_exceeded` or `monthly_quota_exceeded`) and the Worker logs `E_LICENCE_MAIL <name>`. The buyer loses nothing: the key is on `/done`, the webhook answers 500 so Stripe retries the mail (the daily quota resets, so a retry the next day sends it), and `/resend` mails it again once there is room. Upgrade the Resend plan if sales ever near the limits.

**Idempotency.** Every message carries an `Idempotency-Key` header. Resend keeps a key for 24 hours and answers a repeat of it with the first response without sending again; a key is 1 to 256 characters ([Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys)). The key is `issued/<session>` for a purchase, so a retried send of one purchase's mail within 24 hours mails once; `/resend` uses `resend/<keyed hash of the address>/<attempt in the window>/<window>`, which is unique for each allowed request and holds no address. A `409 concurrent_idempotent_requests` is retried later like any other failure. The claim and the sent mark in D1 come first: the claim holds for a minute and only Resend's acceptance sets the sent mark, so a retried send after the claim's sender was cut off does not depend on the 24-hour window.

**Errors.** A failed send throws `E_LICENCE_MAIL <name>`, where the name is Resend's error `name` ([Errors](https://resend.com/docs/api-reference/errors)) if it is a plain lowercase word, else `http_<status>`; a network failure gives `network`. The message, response body, address and key are never logged. Every failure clears the claim and makes the webhook answer 500, so Stripe retries; the same goes for 429 and 5xx.

## Stripe

Do everything first in a [sandbox](https://docs.stripe.com/sandboxes), with its own keys, Price and webhook endpoint, against a Worker deployed under another name (`pnpm exec wrangler deploy --name devot-license-sandbox`, with its own D1 database) or the same Worker before launch. Pay with the test card `4242 4242 4242 4242`; refund and dispute test payments in the sandbox's Dashboard to see a license revoked. **A sandbox Worker must sign with the test-vectors seed under `LICENCE_KID=test`, never the production seed.** The Worker refuses a test-mode session (`livemode: false`) unless it signs under that kid, but a sandbox given the production seed would otherwise hand out keys every release build accepts for good. If the same Worker and D1 database served the sandbox before launch, clear its `purchases` and `licences` rows before going live. To go live, use the production seed and kid, create the same objects in live mode and replace the three secrets and the Price ID.

1. **Product and Price.** Create one Product, "Devot", with a product tax code labelled Eligible for Managed Payments (one for downloadable software). Give it one one-time Price, the license, and put its ID in `STRIPE_PRICE_LICENCE`. The Price's tax behaviour decides whether tax is added on top or included.
2. **Managed Payments.** Apply for it and turn it on under Settings > Managed Payments. An account Stripe has not admitted sets `MANAGED_PAYMENTS = "false"`: Checkout then uses Stripe Tax, and you register for tax wherever it is required before selling there.
3. **Restricted key.** Under Developers > API keys, create a restricted key with Checkout Sessions: Write and Customers: Read, nothing else, and put it in `STRIPE_SECRET_KEY`. The Worker pins API version `2026-09-30.endive` on every request (`licence/src/stripe.ts`); Managed Payments needs `2025-03-31.basil` or later.
4. **Webhook endpoint.** Under Developers > Webhooks, add `https://<the Worker>/stripe/webhook` with API version `2026-09-30.endive` and the events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded` and `charge.dispute.closed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`. The Worker accepts a signature up to 5 minutes old.
5. **Website.** The Buy page links to `https://<the Worker>/buy`. Prices, the refund policy and the terms of sale belong to the website and Stripe; the website's refund policy must match the 30-day full refund the license email promises (`mail.refund` in `licence/src/messages.ts`).

## The App Store

An App Store build sells Devot Pro as an in-app purchase (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md). The Worker gives each purchase one license key, a Mac licence key like any other, and revokes it when Apple refunds or revokes the purchase.

- **The exchange.** `POST /app-store/exchange` with `{"transaction": "<JWS>"}`, the signed transaction StoreKit gave the iPhone for the purchase, answers `{"key": "devot1…", "id": "<license ID>"}`. The body is at most 16 KB. The Worker checks the JWS (below) only to learn which transaction to ask about: it refuses one for another bundle or product, the Trial (`io.github.jma49.devot.trial`, whatever the variables say), a family-shared purchase (`E_APP_STORE_FAMILY_SHARED`, 403) or one already revoked, then counts the rate limits, then asks Apple's App Store Server API for the transaction (Get Transaction Info, on the production or the sandbox host as the JWS says) and decides on Apple's answer alone, checked the same way. Apple's answer must name the same transaction, original transaction and environment (`E_APP_STORE_MISMATCH`, 409). A revoked answer revokes the purchase's license and is refused (`E_LICENCE_REVOKED`, 410). Otherwise the purchase's row is made or read, keyed by environment and original transaction ID, so one purchase has one license however often it is exchanged, and the key is signed again from the row: Ed25519 is deterministic, so a retry gets the same key. The key's licensee is the fixed text `App Store purchase` (`APP_STORE_LICENSEE` in `licence/src/format.ts`, `src-tauri/src/licence/format.rs` and `src/renderer/src/licence.ts`); Apple shares no buyer's name or address, and none is stored.
- **Apple's signatures.** Every JWS from Apple, the iPhone's, Apple's answer and each notification with the transaction inside it, must be ES256 with an `x5c` of exactly three certificates: a P-256 leaf with Apple's receipt-signing OID (`1.2.840.113635.100.6.11.1`) and no CA flag, a CA intermediate with Apple's WWDR OID (`1.2.840.113635.100.6.2.1`), and Apple Root CA - G3 byte for byte as pinned in `licence/src/apple.ts` (SHA-256 `63343abf…3e9179`, from https://www.apple.com/certificateauthority/). Each certificate must be signed by the next, the chain valid at the payload's `signedDate` or now, and the JWS signed by the leaf. A transaction JWS is at most 16 KB; a notification's `signedPayload`, which nests one and may carry `signedRenewalInfo`, may fill the 64 KB body. Anything else, or anything malformed, is `E_APP_STORE_SIGNATURE` for the iPhone's JWS (400) and a notification (401), and `E_APP_STORE_UPSTREAM` (503) for Apple's own answer, which no caller can change.
- **Apple's API.** The Worker signs a token for each call with the In-App Purchase key (ES256, `aud: appstoreconnect-v1`, the bundle ID, five minutes) and gives Apple 10 seconds. A 404 is `E_APP_STORE_NOT_FOUND` (404); 429, 5xx, a timeout or a network failure is `E_APP_STORE_UNREACHABLE` (503); 401 or 403 means the key is wrong, and is `E_LICENCE_CONFIG` (503).
- **Sandbox purchases** (TestFlight and Xcode's sandbox accounts) get keys signed with the public test-vectors seed under kid `test`, never the Worker's own key, so they never unlock a release build: the production Worker leaves `test` out of the keys `/activate` takes, even when `LICENCE_KEYS` lists it, and leaves sandbox rows out of `/revoked`. The same original transaction ID in both environments makes two separate rows.
- **Notifications.** App Store Server Notifications V2 post `{"signedPayload": …}` to `/app-store/notifications` (at most 64 KB). The payload and the transaction inside it are checked as above, for this bundle and the notification's environment; anything that fails answers 401, so a forged notification changes nothing and a real one Apple retries. `REFUND` and `REVOKE` for Devot Pro revoke the purchase's license; a refund that arrives before any exchange makes a revoked row, so the purchase is never exchanged. Each notification's UUID is kept, so a replay changes nothing (`I_APP_STORE_REPLAYED`). Nothing a notification says ever un-revokes a license, whatever order notifications arrive in: `REFUND_REVERSED` is logged (`I_APP_STORE_REFUND_REVERSED <license>`) and the owner restores the license by hand (Revoking by hand). Every other type answers 200 and changes nothing.
- **Renewal.** At `/activate`, once a seat is granted to an App Store license, the Worker asks Apple about its purchase at most once a day (`checked_at`). A revoked purchase revokes the license and refuses the lease. A 404, a mismatched answer, one that fails verification or one that fails the exchange's checks refuses the lease and is stored (`check_refusal`): every `/activate` of that license, from any device, is refused with the same code without asking Apple again that day, until a later check Apple answers well, or a new exchange, clears it. Apple unreachable, or the Worker's own key refused, logs and grants the lease, since no buyer can cause either, unless a refusal stands.
- **Rate limits.** An hour's exchanges: 30 per IP, then 10 per purchase, counted only while the IP is under its limit, as `/resend` counts, so one IP cannot lock a buyer out (`E_LICENCE_RATE_LIMITED`, 429).
- **Storage.** `app_store_licences` (environment, original transaction ID, license ID, the latest transaction ID, purchase, issue, check and revocation times) and `app_store_notifications` (UUID and time), both from `licence/migrations/0005_app_store.sql`. No key, JWS, address or name is stored.
- **Logs:** `I_APP_STORE_EXCHANGED <license>`, `I_APP_STORE_REVOKED <license> REFUND|REVOKE|EXCHANGE|RENEWAL`, `I_APP_STORE_REPLAYED`, `I_APP_STORE_REFUND_REVERSED <license>|none`, `I_APP_STORE_NOTIFICATION <type>`, `I_APP_STORE_LIMITED`, `E_APP_STORE_SIGNATURE notification`, `E_APP_STORE_UNREACHABLE <license> <detail>` and the error codes. Never a JWS, a transaction ID or a key.

**Setting it up** (the owner, once):

1. In App Store Connect, under Users and Access > Integrations > In-App Purchase, generate a key. Download its `.p8` (it downloads only once) and note its Key ID and the Issuer ID above the list.
2. In `licence/`, store them, the key from its file so it is never pasted or printed: `pnpm exec wrangler secret put APP_STORE_KEY < AuthKey_<Key ID>.p8`, then `pnpm exec wrangler secret put APP_STORE_KEY_ID` and `pnpm exec wrangler secret put APP_STORE_ISSUER_ID`. Keep the `.p8` in your password manager and delete the download. No GitHub secret is needed: only the Worker uses this key.
3. Apply the migration and deploy: `pnpm exec wrangler d1 migrations apply devot-license --remote`, then `pnpm exec wrangler deploy`. `APP_STORE_BUNDLE_ID` and `APP_STORE_PRODUCT_PRO` are in `licence/wrangler.toml`; a deployment from its own config (such as `-c wrangler.owner.toml`) must copy both into its `[vars]`, or every App Store route answers `E_LICENCE_CONFIG` (503).
4. In App Store Connect, under the app's App Information > App Store Server Notifications, set both the Production Server URL and the Sandbox Server URL to `https://licence.devot.online/app-store/notifications`, Version 2. App Store Connect has no button that sends a test notification: request one from the App Store Server API (`POST /inApps/v1/notifications/test` on `api.storekit-sandbox.itunes.apple.com` and on `api.storekit.itunes.apple.com`), with a token signed by the In-App Purchase key, and read Apple's delivery result from `GET /inApps/v1/notifications/test/<token>`. The Worker logs `I_APP_STORE_NOTIFICATION TEST`. A forged post to the URL answers 401 `E_APP_STORE_SIGNATURE`.

**Testing in the sandbox** (a TestFlight build and a sandbox Apple Account): buy Devot Pro, then Settings > Get a Mac License Key shows a key whose ID the logs show as `I_APP_STORE_EXCHANGED`; asking again shows the same key. As it should, a release build on a Mac refuses it (`E_LICENCE_UNKNOWN_KID`), and the production Worker gives it no seat; only a development build reads it. Refund the purchase from the sandbox account's purchase history: the notification logs `I_APP_STORE_REVOKED <license> REFUND`, and Get a Mac License Key then answers `E_LICENCE_REVOKED`. Then buy Devot Pro again with the same account and open Get a Mac License Key: if Apple gave the new purchase a new `originalTransactionId`, it gets a new license (`I_APP_STORE_EXCHANGED` with a new ID); if Apple reused the refunded one, the buyer is refused with `E_LICENCE_REVOKED` and the license must be restored by hand (Revoking by hand) until the Worker handles a repurchase. Buying the Trial never shows the row, and a family-shared purchase is refused.

## Revoking by hand

Nothing Stripe does not report as a full refund or a lost dispute revokes a license. In `licence/`:

```sh
# The license a purchase paid for, by its PaymentIntent (pi_…) or Checkout Session (cs_…)
pnpm exec wrangler d1 execute devot-license --remote \
  --command "SELECT licence_id FROM purchases WHERE payment_intent = 'pi_…'"

# Revoke it
pnpm exec wrangler d1 execute devot-license --remote \
  --command "UPDATE licences SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = '<license ID>'"
```

Setting `revoked_at` back to `NULL` restores a license. Devices drop a revoked license the next time they fetch `/revoked`.

An App Store purchase's license is in `app_store_licences`. After a `REFUND_REVERSED` notification (or to revoke one by hand), find it by the license ID the logs give and set `revoked_at`:

```sh
# Restore it; a timestamp in place of NULL revokes it
pnpm exec wrangler d1 execute devot-license --remote \
  --command "UPDATE app_store_licences SET revoked_at = NULL WHERE licence_id = '<license ID>'"
```

## Complimentary licences

To give someone a license without a purchase, sign one on your own machine. In `licence/`:

```sh
# Paste the seed when asked; it stays out of your shell history and every file.
read -rs LICENCE_SIGNING_KEY && export LICENCE_SIGNING_KEY
LICENCE_KID=2026-10 pnpm --filter @devot/license issue friend@example.com
unset LICENCE_SIGNING_KEY
```

It prints the license ID, the key and its `devot://license` link. It writes nothing to disk and records nothing in D1, so the Worker never knows it: `/resend` does not find it, and only you hold a copy. Keep the license ID if you may need to revoke it. A wrong or missing seed or kid answers `E_LICENCE_CONFIG`, a missing address `E_LICENCE_BAD_REQUEST`; neither prints the seed.

To renew a complimentary license, for example to correct its address or to sign it with a new kid, add `--id <license ID>` with the ID it already has: the new key carries the same ID, so revoking that ID still revokes both keys. An ID that is not 22 base64url characters answers `E_LICENCE_BAD_REQUEST`.

To revoke a complimentary license, add a revoked row for its ID, so `/revoked` lists it:

```sh
pnpm exec wrangler d1 execute devot-license --remote \
  --command "INSERT INTO licences (id, session_id, customer_id, issued_at, revoked_at) VALUES ('<license ID>', 'complimentary-<license ID>', 'complimentary', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
```

The row has no purchase, so nothing mails or shows it; deleting it restores the license.

## The app

`src-tauri/src/licence/` checks keys exactly as Formats says (`ed25519-dalek`, strict verification), keeps the key in the keychain beside the AI keys and reports one state: none, valid, revoked or invalid (with its code). A valid license unlocks every version; the build's date plays no part.

In the release workflow's build, the first launch begins a 30-day trial, kept in the keychain beside the license (its start and the latest time seen), so reinstalling does not start it again and setting the clock back more than an hour ends it. While it runs everything works. Once it is over, unless the state is valid, notes are read-only: every write of user content is refused, sync refuses to create a vault or connect, and AI refuses to send (`E_LICENCE_REQUIRED`, or `E_LICENCE_UNREADABLE` when the keychain would not give the license or the trial). A note's text being saved as the trial ends is still written for five minutes. docs/specs/licences.md has the details.

### Seats

Keys sold before seats existed are not reissued: a key whose `issuedAt` is before 2026-11-01, when the Worker cannot be reached, starts a 30-day migration window, kept in the same item, during which everything works. A key sold after that date gets no window, and a refusal from the Worker (a full seat count, a revoked licence, a rate limit) never starts one: a device the seat limit turns away is read-only. A window opens only on the device's first attempt for that key, and the item remembers every licence tried (at most 32): pasting the key again, removing and re-adding it, swapping in another key and back, or going offline after a refusal does not restart it. A seat item that cannot be read locks the device (`E_LICENCE_ACTIVATION_UNREADABLE`) rather than counting as no seats at all; one that does not parse can be replaced by pasting the key again, removing the licence or Retry Activation. The first successful activation replaces the window with a lease. Settings > License shows the seats in use (`2 of 3 devices`) and links to `/devices`; the device's label is `Devot for macOS` or `Devot for iPhone`.

### App Store builds

An iPhone release build compiled with `DEVOT_DISTRIBUTION=app-store` beside `DEVOT_RELEASE_BUILD=1` is an App Store build (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md; `src-tauri/src/distribution.rs`). `build.rs` refuses any other value, and the marker on a Mac; every other build, the Mac's and an iPhone development build's, behaves as above. In an App Store build:

- **What unlocks it:** Devot Pro (`io.github.jma49.devot.pro`) bought by this Apple account, a licence key with a live seat, or a running trial. StoreKit verified every transaction it reports; the app then counts only one for this bundle, in Apple's store or its sandbox, bought by this account (never family shared) and not revoked (`licence/purchases.rs`). Nothing unlocks until the current entitlements are read at launch (`E_APP_STORE_UNREAD`); a read that fails keeps what was held and is tried again every minute. A refund or revocation that arrives as a transaction update ends Devot Pro at once, unless a seat or the trial holds; a note's text being saved then is still written for five minutes. A purchase refunded while the app was closed is missing from the next launch's entitlements, and so is gone.
- **The trial** is the free Trial purchase (`io.github.jma49.devot.trial`): it runs 30 days from its `originalPurchaseDate`, so reinstalling or another device of the same Apple account does not start it again, and it never counts as Devot Pro. The latest time seen is kept in the keychain item `app-store-trial`, written only once the Trial is bought; a clock set back more than an hour ends it. A clock behind the purchase date does not run the trial yet, and does not end it either. The keychain trial (`trial`) is never read or written in this build.
- **No outside purchase:** Buy opens the purchase sheet (Start 30-day Trial while the trial is available, Buy Devot Pro at StoreKit's price, Restore Purchases, Enter License Key). `open_external` refuses `devot.online` and its subdomains with `E_URL_OUTSIDE_PURCHASE`, except `https://licence.devot.online/devices?from=app`, which Manage Devices opens.
- **Get a Mac License Key** shows in Settings while Devot Pro is held. `store_mac_key` takes no argument: Rust sends the signed transaction of the Devot Pro purchase the licence holds, never one from a window, to `/app-store/exchange`, checks that the answer is a key for the license it names with the App Store licensee, and gives the window the key and its ID. The sheet shows the key with Copy Key and Share (the key and its `devot://licence?key=` link, for the Mac); the iPhone never adds it. Logs: `I_APP_STORE_MAC_KEY <license>`, `W_APP_STORE_MAC_KEY <code>`.
- **Licence keys** are taken while `APP_STORE_TAKES_LICENCE_KEYS` is on, the one switch for ADR 0014, Risks 1. Off, `licence_set` and `devot://license` links answer `E_LICENCE_KEYS_OFF` and the windows hide the key field and Enter License Key.
- **Logs:** `I_APP_STORE_ENTITLEMENTS pro=<bool>`, `W_APP_STORE_UNVERIFIED <code>`, `W_APP_STORE_LISTEN <code>`, `W_APP_STORE_FINISH <code>`, `W_APP_STORE_RESTORE <code>` (the sync failed; the entitlements read after it still decides); `I_APP_STORE_PURCHASE_STARTED <pro|trial>` before StoreKit's sheet, then `I_APP_STORE_PURCHASE <pro|trial> <purchased|pending|cancelled>` or `W_APP_STORE_PURCHASE <pro|trial> <code>`; every bridge call but a purchase answers `E_APP_STORE_NO_REPLY` when StoreKit does not reply within its limit (30 s, or 5 minutes for Restore Purchases).

### Adding a signing key

The app trusts the public keys in `PRODUCTION` in `src-tauri/src/licence/keys.rs`, by kid. After `pnpm keygen`, add the pair it printed:

```rust
pub(crate) const PRODUCTION: &[(&str, &str)] = &[("2026-10", "<the public key keygen printed>")];
```

Release that build before the Worker signs anything with the key. Only the release workflow's build (`DEVOT_RELEASE_BUILD=1`) with a production key gates anything: while `PRODUCTION` is empty, and in every debug or local build, nothing is gated and no trial starts, so anyone who builds Devot from source can use all of it. The first release with a key starts each device's trial at its first launch, and gates editing, sync and AI once the trial is over. The test key (kid `test`, from `licence/test-vectors.json`) is trusted only by test and debug builds, never by a release, and a test fails if a production entry reuses it or does not decode to an Ed25519 key. To drop a leaked key, remove its entry and release.

### Revocations

The app keeps the last revocation list that verified in `<app data>/license-revocations.txt` (the list as signed; it is public) and verifies it again whenever it reads it. A list older than the one kept (`issuedAt`) is ignored. The updater's schedule fetches `/revoked` once a day (also in a build without the updater key, while the build gates and a license is held): the list whole, over https, with no query or identifying header, then `apply_revocations`. A failure is logged by its code and changes nothing. docs/specs/updates.md has the details.

### What users see

- **Updating:** every update is offered and installed the same way, whatever the license; a valid license keeps working in the new version.
- **The trial:** everything works for 30 days. Settings > License shows when it ends and the time left. Once, when less than a day is left, the main window says the trial ends today or tomorrow at its time, with Buy a License and Add License; dismissed, it never comes back.
- **After the trial, without a license:** notes are read-only. They can be read, searched, copied and exported; the editor, the title, notebook, status and tags take no change, the commands, menu items and buttons that would make, move, tag, delete, import or restore anything are gone or disabled (File > Import says the trial has ended instead of opening its panel), nothing can be dragged, and quick capture keeps its text but saves nothing. One bar in the main and note windows says the trial has ended and notes are read-only, with Buy a License and Add License (Settings > License). If the trial ends while a note is open, what was typed is saved first.
- **Settings > License:** whether editing, sync and AI are unlocked, in a sentence for each state, and the trial's end; who the license is for and its ID; a field to paste a key (Add License, or Replace License once one is there); Remove License…, which asks first; Buy a License (`https://licence.devot.online/buy`) unless the license is valid. A key that fails says why, with its code, and changes nothing. A build without a production key says it checks no license.
- **Sync and AI:** Settings > Sync and Settings > AI say a license is needed, and that the trial has ended, with Buy. Edit with AI is not offered; Suggest Next Edit says so when asked by key, and a pause asks nothing. A device that syncs stops at its next connect, and the main window's notice says why, with Buy.
- **Seats:** with a key held, Settings > License shows how many devices are in use and offers Manage Devices (`https://licence.devot.online/devices`), where a device the buyer no longer has can be removed. A device that has not been activated, or whose lease ran out, says so and offers Retry Activation.
- **`devot://license?key=<key>`** (from `/done` or the email): Devot comes forward and adds the license to a device that holds none. On a device that holds another, it asks first, naming both licensees and license IDs; the license it holds already changes nothing. A key that fails says why.

## Rotating the signing key

1. Make a new pair with `pnpm keygen` and ship its public key under a new kid in a release (The app, Adding a signing key).
2. Once that release is out, `wrangler secret put LICENCE_SIGNING_KEY` with the new seed, set `LICENCE_KID` to the new kid, move the old kid and its public key into `LICENCE_KEYS` (so licences signed by it can still activate) and deploy. New keys, `/resend` and `/revoked` use the new key from then on; existing keys keep verifying under the old kid.
3. If the old key leaked, a release drops the old kid and `LICENCE_KEYS` drops it too; buyers get keys under the new one through `/resend`, and every device activates again with the new key.

## Tests

`tests/licence/` runs in `pnpm test`, with nothing deployed and no network: `mail.test.ts` checks the Resend mailer against a recording `fetch` (request, headers, idempotency key, error mapping), `format.test.ts` checks the formats and the test vectors, `webhook.test.ts` the signature scheme against Node's own HMAC, `stripe.test.ts` the Stripe client against a fake `fetch`, `store.test.ts` the SQL on a real D1 database in workerd through Miniflare, `app.test.ts` every route on that database with a fake Stripe and a recording mailer, `devices.test.ts` activation, the seat limit, deactivation and the `/devices` page on that database, `issue.test.ts` the complimentary licences `issue` signs, `apple.test.ts` the JWS and certificate checks against chains the test makes (Apple's root stays pinned in the source; the test passes its own), `app-store.test.ts` the exchange, notifications, renewal and rate limits on that database with a fake App Store Server API, and `worker.test.ts` the bundled Worker in workerd, built from the same entry and settings as `licence/wrangler.toml`, with Stripe answered by the test.
