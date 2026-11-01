# License Worker

The license Worker sells Devot's license through Stripe Checkout, signs license keys, mails them, sends them again on request and publishes the list of revoked licences (docs/adr/0006-source-available-and-sold-once.md). It is the one hosted service Devot runs, on the owner's Cloudflare account with a D1 database. It never sees notes and stores no email address: Stripe holds the buyer's address, and the Worker signs a key again from its row whenever it shows or mails one. The code is in `licence/`; the app checks keys offline against the formats below (The app).

## What it does

| Route                                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /buy`                                       | Creates a Checkout Session for `STRIPE_PRICE_LICENCE` and redirects to it (303)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /stripe/webhook`                           | Checks `Stripe-Signature`, then issues or revokes (below); answers 500 when something failed, so Stripe retries                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /done?session_id=<id>`                      | Stripe's success page: the key, Copy, Open in Devot (`devot://license?key=<key>`, URL-encoded), the manual way and a link to `/resend`; 202 and a page that reloads itself every 5 s while the payment is pending, at most 60 times (`check=<n>` in the reload URL), then stops with a Check Again link, so a forgotten tab does not keep asking Stripe. The waiting page has a Stop checking link (WCAG 2.2.1), and a delayed payment Stripe reports as failed answers `E_LICENCE_UNPAID` (402) instead |
| `GET /resend`, `POST /resend` (`email=…`)        | A form, and the answer to it: every live license bought with that address is mailed to it                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /revoked`                                   | The signed revocation list (`text/plain`, cacheable for 5 minutes)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /assets/license.css`, `GET /assets/copy.js` | The pages' stylesheet and the Copy button's script (cacheable for 5 minutes); served even before the secrets are set                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /activate`                                 | Takes or refreshes a device's seat and answers with a signed lease (Activation)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /deactivate`                               | Frees a device's seat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /devices`, `POST /devices`                  | The page a buyer uses to list the seats on a key and free one, for a device they no longer have                                                                                                                                                                                                                                                                                                                                                                                                          |

- **Sessions** are in payment mode, for one unit of the Price, with `customer_creation=always`, so every purchase has a Stripe Customer that `/resend` finds by its address. Their metadata says `kind: license`. A session without it is not the Worker's (the Stripe account may sell other things) and is left alone. With `MANAGED_PAYMENTS=true` the session sets `managed_payments[enabled]=true`, which makes Stripe the merchant of record ([Managed Payments](https://docs.stripe.com/payments/managed-payments), [Build a Checkout integration](https://docs.stripe.com/payments/managed-payments/set-up)); otherwise it sets `automatic_tax[enabled]=true` (Stripe Tax). The success URL is the Worker's own `/done`; `CANCEL_URL`, when set, is where Checkout's back link goes.
- **Issuing.** `checkout.session.completed` with `payment_status: paid` (or, for a payment method that settles later, `checkout.session.async_payment_succeeded`) issues a license with a new random ID. One D1 transaction writes the license and the session's purchase row, keyed by the session ID, so a session issues at most one license however often Stripe retries. The key is then mailed to the address the buyer gave Checkout. A sender claims the purchase's mail before calling Resend and marks it mailed only once Resend accepts it, so `/done` and the webhook, or two deliveries of one event, send it once; while a claim is in flight the webhook answers 500, so Stripe retries, and a claim whose sender is cut off can be taken again after a minute. When the mail fails the claim is dropped, the webhook answers 500 and Stripe's retry sends the mail, not a second license. A test-mode purchase (`livemode: false`) is refused unless the Worker signs under the test kid, so a sandbox Worker given the production seed cannot hand out production-valid keys.
- **`/done` before the webhook.** When the buyer reaches `/done` first, the Worker retrieves the session from Stripe and, if it is paid, issues the license itself through the same transaction, then mails it after answering. The webhook that follows finds the session fulfilled.
- **The licensee** in a key is the email address of the Stripe Customer of the license's purchase. When that Customer is deleted or has no address, it is the address of the session being shown or mailed (or the one `/resend` matched); when there is none either, the answer is `E_LICENCE_NO_CUSTOMER` (409). Ed25519 signatures are deterministic, so the same row, signing key and licensee always give the same key; changing the Customer's address in Stripe changes the key signed from then on, and the old key stays valid.
- **Revoking.** Each purchase row keeps its PaymentIntent ID. `charge.refunded` with `refunded: true` (a full refund) and `charge.dispute.closed` with `status: lost` revoke the license that PaymentIntent paid for. The PaymentIntent is kept as revoked either way (`revoked_payments`, IDs only), so when the refund arrives before the purchase is recorded, the license is issued revoked and never mailed (`I_LICENCE_PAYMENT_REVOKED <payment intent>` when the refund matched no license, then `E_LICENCE_REVOKED <license> <session>`). `/revoked` lists the IDs of every revoked license.
- **`/resend`** stores a keyed hash of the buyer's lower-cased address with each purchase and finds every live license bought with the address through it, whatever capitals Stripe stored or the buyer types; it also looks up Stripe's Customers (as typed and in lower case, compared without case) for purchases recorded before the hash was kept, leaves out revoked ones and mails the keys in one message to the address. It answers at once with the same page whether or not anything was found, and does the lookup after answering. It sends at most 3 times an hour and 6 times a day per address, 10 times an hour per IP (`CF-Connecting-IP`), and 25 times a day in all, well under Resend's 100 a day so purchase mails keep room; an address's counters rise only while the IP is under its limit, so one IP cannot lock buyers out of their own recovery. Past a limit it answers the same page and sends nothing. The counters are D1 rows keyed by an HMAC of the address or IP, not the address or IP itself.
- **Errors** carry a code: `E_LICENCE_BAD_REQUEST`, `E_LICENCE_CONFIG` (a secret or variable is missing; 503), `E_LICENCE_METHOD`, `E_LICENCE_NOT_FOUND`, `E_LICENCE_REVOKED`, `E_LICENCE_SESSION_UNKNOWN`, `E_LICENCE_UNPAID` (402), `E_LICENCE_NO_CUSTOMER` (409), `E_LICENCE_STRIPE` (Stripe failed or did not answer; 502), `E_LICENCE_MAIL` (with Resend's error name, such as `validation_error`, `rate_limit_exceeded` or `daily_quota_exceeded`, or `network` or `http_<status>` when there is none), `E_LICENCE_TOO_LARGE`, `E_LICENCE_WEBHOOK_SIGNATURE`, `E_LICENCE_INTERNAL`. Pages show the code; the webhook answers `{"code": …}`.
- **Pages and the email.** Every page (`/done`, the waiting page, `/resend` and its answer, error pages) carries the dove and Devot's colours from the system theme's tokens (`licence/src/brand.ts`, kept equal to `design/tokens` and `design/app-icon` by a test) and follows `prefers-color-scheme`; nothing loads from elsewhere: no fonts, images or third-party scripts. Every HTML answer sends `Content-Security-Policy: default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`; the stylesheet and script come from the fixed `/assets/` routes, so no page has inline script or style. The Copy button shows only where the clipboard works. An error page gives a plain sentence and the code, never a stack or an address. The license email has an HTML part (inline styles, the dove as inline SVG, darkened where the mail client honours `prefers-color-scheme`) and a plain-text part with the same content: each key and its Open in Devot link, what the license unlocks (all of Devot, in every version, nothing to renew; read-only after the three-day trial without one), the manual way (Devot > Settings > License), a full refund within 30 days of buying by replying, and support by replying. Replies go to `REPLY_TO` when set, else to `MAIL_FROM`, so that address must be read: refunds are made by hand in the Stripe Dashboard. All text is in `licence/src/messages.ts`; keys and addresses are always HTML-escaped.
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

A valid key unlocks all of Devot (editing, sync and AI) in every version, and nothing in it ends; without one, Devot is read-only once its three-day trial ends. A paid upgrade, if there ever is one, needs a new key format and its own ADR.

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
- `pnpm --filter @devot/license issue <email>` signs a complimentary license with the seed in `LICENCE_SIGNING_KEY` and the kid in `LICENCE_KID`, prints it and writes nothing (Complimentary licences).

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

**Variables** (`[vars]` in `licence/wrangler.toml`):

| Variable               | Value                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LICENCE_KID`          | the signing key's ID, as the app knows it                                                                                                                                                 |
| `STRIPE_PRICE_LICENCE` | the license's one-time Price ID (`price_…`)                                                                                                                                               |
| `MANAGED_PAYMENTS`     | `true` for Managed Payments (the default), anything else for Stripe Tax                                                                                                                   |
| `MAIL_FROM`            | the sender address (shown as `Devot <address>`), on the verified Resend domain (for example `licence@devot.online`)                                                                       |
| `REPLY_TO`             | optional: an address that receives replies, sent as Resend's `reply_to` on every license mail; set it when the sending domain receives no mail. Empty or unset: no Reply-To               |
| `MAX_DEVICES`          | how many devices one licence may activate at once (default `3`; Activation)                                                                                                               |
| `LICENCE_KEYS`         | optional: older public keys, by kid, as a JSON object (`{"2026-10":"<base64url>"}`), so licences signed by them can still activate after a rotation; empty or unset: only the current key |
| `CANCEL_URL`           | optional: where Checkout's back link goes, such as the website's Buy page                                                                                                                 |

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

## Complimentary licences

To give someone a license without a purchase, sign one on your own machine. In `licence/`:

```sh
# Paste the seed when asked; it stays out of your shell history and every file.
read -rs LICENCE_SIGNING_KEY && export LICENCE_SIGNING_KEY
LICENCE_KID=2026-10 pnpm --filter @devot/license issue friend@example.com
unset LICENCE_SIGNING_KEY
```

It prints the license ID, the key and its `devot://license` link. It writes nothing to disk and records nothing in D1, so the Worker never knows it: `/resend` does not find it, and only you hold a copy. Keep the license ID if you may need to revoke it. A wrong or missing seed or kid answers `E_LICENCE_CONFIG`, a missing address `E_LICENCE_BAD_REQUEST`; neither prints the seed.

To revoke a complimentary license, add a revoked row for its ID, so `/revoked` lists it:

```sh
pnpm exec wrangler d1 execute devot-license --remote \
  --command "INSERT INTO licences (id, session_id, customer_id, issued_at, revoked_at) VALUES ('<license ID>', 'complimentary-<license ID>', 'complimentary', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
```

The row has no purchase, so nothing mails or shows it; deleting it restores the license.

## The app

`src-tauri/src/licence/` checks keys exactly as Formats says (`ed25519-dalek`, strict verification), keeps the key in the keychain beside the AI keys and reports one state: none, valid, revoked or invalid (with its code). A valid license unlocks every version; the build's date plays no part.

With a production key in the build, the first launch begins a three-day trial (72 hours), kept in the keychain beside the license (its start and the latest time seen), so reinstalling does not start it again and setting the clock back more than an hour ends it. While it runs everything works. Once it is over, unless the state is valid, notes are read-only: every write of user content is refused, sync refuses to create a vault or connect, and AI refuses to send (`E_LICENCE_REQUIRED`). A note's text being saved as the trial ends is still written for five minutes. The separate devot-mcp CLI writes the database itself and is not covered (it is not shipped). docs/architecture.md (Licences) has the details.

### Seats

Keys sold before seats existed are not reissued: a key whose `issuedAt` is before 2026-11-01, when the Worker cannot be reached, starts a 30-day migration window, kept in the same item, during which everything works. A key sold after that date gets no window, and a refusal from the Worker (a full seat count, a revoked licence, a rate limit) never starts one: a device the seat limit turns away is read-only. A window opens only on the device's first attempt for that key, and the item remembers every licence tried (at most 32): pasting the key again, removing and re-adding it, swapping in another key and back, or going offline after a refusal does not restart it. A seat item that cannot be read locks the device (`E_LICENCE_ACTIVATION_UNREADABLE`) rather than counting as no seats at all; one that does not parse can be replaced by pasting the key again, removing the licence or Retry Activation. The first successful activation replaces the window with a lease. Settings > License shows the seats in use (`2 of 3 devices`) and links to `/devices`; the device's label is `Devot for macOS` or `Devot for iPhone`.

### Adding a signing key

The app trusts the public keys in `PRODUCTION` in `src-tauri/src/licence/keys.rs`, by kid. After `pnpm keygen`, add the pair it printed:

```rust
pub(crate) const PRODUCTION: &[(&str, &str)] = &[("2026-10", "<the public key keygen printed>")];
```

Release that build before the Worker signs anything with the key. While `PRODUCTION` is empty nothing is gated and no trial starts: a release made before your keys exist works as before, with everything open to everyone. The first release with a key starts each device's three-day trial at its first launch, and gates editing, sync and AI once the trial is over. The test key (kid `test`, from `licence/test-vectors.json`) is trusted only by test and debug builds, never by a release, and a test fails if a production entry reuses it or does not decode to an Ed25519 key. To drop a leaked key, remove its entry and release.

### Revocations

The app keeps the last revocation list that verified in `<app data>/license-revocations.txt` (the list as signed; it is public) and verifies it again whenever it reads it. A list older than the one kept (`issuedAt`) is ignored. The updater's schedule fetches `/revoked` once a day (also in a build without the updater key, while the build gates and a license is held): the list whole, over https, with no query or identifying header, then `apply_revocations`. A failure is logged by its code and changes nothing. docs/architecture.md (Updates) has the details.

### What users see

- **Updating:** every update is offered and installed the same way, whatever the license; a valid license keeps working in the new version.
- **The trial:** everything works for three days. Settings > License shows when it ends and the time left. Once, when less than a day is left, the main window says the trial ends today or tomorrow at its time, with Buy a License and Add License; dismissed, it never comes back.
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

`tests/licence/` runs in `pnpm test`, with nothing deployed and no network: `mail.test.ts` checks the Resend mailer against a recording `fetch` (request, headers, idempotency key, error mapping), `format.test.ts` checks the formats and the test vectors, `webhook.test.ts` the signature scheme against Node's own HMAC, `stripe.test.ts` the Stripe client against a fake `fetch`, `store.test.ts` the SQL on a real D1 database in workerd through Miniflare, `app.test.ts` every route on that database with a fake Stripe and a recording mailer, `devices.test.ts` activation, the seat limit, deactivation and the `/devices` page on that database, `issue.test.ts` the complimentary licences `issue` signs, and `worker.test.ts` the bundled Worker in workerd, built from the same entry and settings as `licence/wrangler.toml`, with Stripe answered by the test.
