# Licence Worker

The licence Worker sells Devot's licence through Stripe Checkout, signs licence keys, mails them, sends them again on request and publishes the list of revoked licences (docs/adr/0006-source-available-and-sold-once.md). It is the one hosted service Devot runs, on the owner's Cloudflare account with a D1 database. It never sees notes and stores no email address: Stripe holds the buyer's address, and the Worker signs a key again from its row whenever it shows or mails one. The code is in `licence/`; the app checks keys offline against the formats below (The app).

## What it does

| Route                                     | What it does                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /buy`                                | Creates a Checkout Session for `STRIPE_PRICE_LICENCE` and redirects to it (303)                                                                                           |
| `GET /renew?licence=<id>`                 | The same for `STRIPE_PRICE_RENEWAL`, with the licence ID in the session's metadata; an unknown ID gets `E_LICENCE_UNKNOWN` (404), a revoked one `E_LICENCE_REVOKED` (410) |
| `POST /stripe/webhook`                    | Checks `Stripe-Signature`, then issues, renews or revokes (below); answers 500 when something failed, so Stripe retries                                                   |
| `GET /done?session_id=<id>`               | Stripe's success page: the key, an Open in Devot link (`devot://licence?key=<key>`, URL-encoded) and a link to `/resend`; 202 while the payment is pending                |
| `GET /resend`, `POST /resend` (`email=…`) | A form, and the answer to it: every live licence bought with that address is mailed to it                                                                                 |
| `GET /revoked`                            | The signed revocation list (`text/plain`, cacheable for 5 minutes)                                                                                                        |

- **Sessions** are in payment mode, for one unit of the Price, with `customer_creation=always`, so every purchase has a Stripe Customer that `/resend` finds by its address. Their metadata says `kind` (`licence` or `renewal`) and, for a renewal, `licence`. A session without that metadata is not the Worker's (the Stripe account may sell other things) and is left alone. With `MANAGED_PAYMENTS=true` the session sets `managed_payments[enabled]=true`, which makes Stripe the merchant of record ([Managed Payments](https://docs.stripe.com/payments/managed-payments), [Build a Checkout integration](https://docs.stripe.com/payments/managed-payments/set-up)); otherwise it sets `automatic_tax[enabled]=true` (Stripe Tax). The success URL is the Worker's own `/done`; `CANCEL_URL`, when set, is where Checkout's back link goes.
- **Issuing.** `checkout.session.completed` with `payment_status: paid` (or, for a payment method that settles later, `checkout.session.async_payment_succeeded`) issues a licence: a new random ID, `updatesUntil` one year after the day of the purchase (UTC; 29 February counts to 1 March). One D1 transaction writes the licence and the session's purchase row, keyed by the session ID, so a session issues at most one licence however often Stripe retries. The key is then mailed to the address the buyer gave Checkout. The purchase is marked mailed just before the mail goes, so `/done` and the webhook, or two deliveries of one event, send it once; when the mail fails, the mark is cleared, the webhook answers 500 and Stripe's retry sends the mail, not a second licence.
- **`/done` before the webhook.** When the buyer reaches `/done` first, the Worker retrieves the session from Stripe and, if it is paid, issues the licence itself through the same transaction, then mails it after answering. The webhook that follows finds the session fulfilled.
- **Renewing** sets `updatesUntil` to one year after the later of today and the old `updatesUntil`, once per renewal session, and mails the new key, which keeps the licence's ID and `issuedAt`. A renewal paid for a licence revoked in the meantime is recorded but neither extends nor mails anything (`E_LICENCE_REVOKED` in the log); refund it by hand.
- **The licensee** in a key is the email address of the Stripe Customer of the licence's first purchase. When that Customer is deleted or has no address, it is the address of the session being shown or mailed (a renewal's, or the one `/resend` matched); when there is none either, the answer is `E_LICENCE_NO_CUSTOMER` (409). Ed25519 signatures are deterministic, so the same row, signing key and licensee always give the same key; changing the Customer's address in Stripe changes the key signed from then on, and the old key stays valid.
- **Revoking.** Each purchase row keeps its PaymentIntent ID. `charge.refunded` with `refunded: true` (a full refund) and `charge.dispute.closed` with `status: lost` revoke the licence whose first purchase that PaymentIntent paid. The PaymentIntent is kept as revoked either way (`revoked_payments`, IDs only), so when the refund arrives before the purchase is recorded, the licence is issued revoked and never mailed (`I_LICENCE_PAYMENT_REVOKED <payment intent>` when the refund matched no licence, then `E_LICENCE_REVOKED <licence> <session>`). A refunded renewal revokes nothing (see Revoking by hand). `/revoked` lists the IDs of every revoked licence.
- **`/resend`** looks up the Stripe Customers with that address (as typed and in lower case, compared without case), finds every licence any of their purchases paid for or renewed, leaves out revoked ones and mails the keys in one message to the address. It answers at once with the same page whether or not anything was found, and does the lookup after answering. It sends at most 3 times an hour per address and 10 times an hour per IP (`CF-Connecting-IP`); past that it answers the same page and sends nothing. The counters are D1 rows keyed by an HMAC of the address or IP, not the address or IP itself.
- **Errors** carry a code: `E_LICENCE_BAD_REQUEST`, `E_LICENCE_CONFIG` (a secret or variable is missing; 503), `E_LICENCE_METHOD`, `E_LICENCE_NOT_FOUND`, `E_LICENCE_UNKNOWN`, `E_LICENCE_REVOKED`, `E_LICENCE_SESSION_UNKNOWN`, `E_LICENCE_UNPAID`, `E_LICENCE_NO_CUSTOMER` (409), `E_LICENCE_STRIPE` (Stripe failed or did not answer; 502), `E_LICENCE_MAIL` (with Resend's error name, such as `validation_error`, `rate_limit_exceeded` or `daily_quota_exceeded`, or `network` or `http_<status>` when there is none), `E_LICENCE_TOO_LARGE`, `E_LICENCE_WEBHOOK_SIGNATURE`, `E_LICENCE_INTERNAL`. Pages show the code; the webhook answers `{"code": …}`.
- **Logs** are one line per event, a code and IDs only: `I_LICENCE_ISSUED <licence> <session>`, `I_LICENCE_RENEWED`, `I_LICENCE_MAILED`, `I_LICENCE_REVOKED <licence> refund|dispute`, `I_LICENCE_PAYMENT_REVOKED <payment intent> refund|dispute`, `I_LICENCE_RESENT <licences>`, `I_LICENCE_RESEND_LIMITED` and the error codes. Never an address or a key.

## Formats

### Licence key

`devot1.<payload>.<signature>`, about 270 characters for a short address.

- `<payload>` is base64url without padding (RFC 4648 section 5) of the payload's UTF-8 JSON.
- `<signature>` is base64url without padding of the 64-byte Ed25519 signature (RFC 8032) over the ASCII bytes of `devot1.<payload>`, the text before the second dot.

The payload is one JSON object, written in this order:

| Field          | Value                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| `id`           | 16 random bytes, base64url without padding (22 characters)                  |
| `kid`          | the signing key's ID, a short string such as `2026-10`                      |
| `plan`         | `pro`                                                                       |
| `licensee`     | the buyer's email address                                                   |
| `issuedAt`     | when the licence was first issued, RFC 3339 in UTC to the second (`…T…:…Z`) |
| `updatesUntil` | the last release date the licence covers, `YYYY-MM-DD` in UTC               |

To check a key:

1. It is at most 1024 characters and splits on `.` into exactly three parts, the first `devot1`.
2. Both other parts decode as canonical base64url without padding; the signature is 64 bytes.
3. The payload decodes as UTF-8 (strictly; no byte order mark) to a JSON object with the six fields above, each a string of the shape given, `plan` exactly `pro`. Fields added later are ignored. Otherwise: `E_LICENCE_MALFORMED`.
4. `kid` names a public key the app holds, else `E_LICENCE_UNKNOWN_KID`.
5. The signature verifies over the key's own bytes `devot1.<payload>` (never re-encode the JSON), else `E_LICENCE_SIGNATURE`.

`verifyLicence` in `licence/src/format.ts` is the reference.

### Revocation list

`devot1rev.<payload>.<signature>`, the same scheme with the prefix `devot1rev`, signed by the same key. The payload is `{"kid": …, "issuedAt": …, "ids": [...]}`: the signing key's ID, when the list was made (RFC 3339, UTC, to the second) and the IDs of all revoked licences in sorted order. The list grows by about 33 characters per revoked licence. The prefix is part of the signed bytes, so a licence key never passes as a list, nor a list as a key. `verifyRevocations` is the reference.

### Signing keys

- The private key is the 32-byte Ed25519 seed, base64url without padding, in the Wrangler secret `LICENCE_SIGNING_KEY`. Its ID is the variable `LICENCE_KID`.
- The public key is the raw 32-byte Ed25519 public key, base64url without padding. The app holds one per `kid`, so a new key ships in a release before the Worker signs anything with it.
- `pnpm --filter @devot/licence keygen` prints a new pair and writes nothing to disk.
- `pnpm --filter @devot/licence issue <email>` signs a complimentary licence with the seed in `LICENCE_SIGNING_KEY` and the kid in `LICENCE_KID`, prints it and writes nothing (Complimentary licences).

### Test vectors

`licence/test-vectors.json` holds a test-only key pair (seed and public key) from a fixed seed with the kid `test`, valid keys with their payloads (bought, renewed, a non-ASCII licensee), invalid keys with the code each must fail with (a tampered payload, another key's signature, an unknown kid, a wrong prefix, a missing signature, the revocation list given as a key), and a revocation list with a tampered copy. The Worker's tests check that the format produces exactly this file and that each entry verifies as stated; the app's Rust tests read it too. `pnpm --filter @devot/licence test-vectors` writes it again. Never ship the test key in a release.

## Deploy to the owner's Cloudflare account

You need a Cloudflare account (the **Workers Free** plan is enough: the Worker uses only a D1 database and outbound `fetch` calls, no Durable Objects, Queues or Cron Triggers), a domain on Cloudflare to send from, a [Resend](https://resend.com) account and a Stripe account. Nothing here deploys by itself: run each step yourself.

1. From a checkout of this repository: `pnpm install --filter @devot/licence`, then in `licence/` sign in: `pnpm exec wrangler login`.
2. Create the database: `pnpm exec wrangler d1 create devot-licence`, and add the `database_id` it prints to the `[[d1_databases]]` block of `licence/wrangler.toml`. Then create its tables: `pnpm exec wrangler d1 migrations apply devot-licence --remote`.
3. Set up Resend (below): add and verify the sending domain, make an API key and store it with `pnpm exec wrangler secret put RESEND_API_KEY`. Until the domain is verified, mail fails with `E_LICENCE_MAIL validation_error`.
4. Make the signing key: `pnpm keygen`. Store the seed in your password manager and offline, then `pnpm exec wrangler secret put LICENCE_SIGNING_KEY` and paste it. Choose its kid (for example `2026-10`). Add the public key and kid to the app (The app, Adding a signing key) and release it before you sell.
5. Set up Stripe (below) and set its two secrets: `pnpm exec wrangler secret put STRIPE_SECRET_KEY` and `pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET`.
6. Fill in `[vars]` in `licence/wrangler.toml` (none is secret; see the table) and deploy: `pnpm exec wrangler deploy`. It prints the Worker's URL, `https://devot-licence.<your subdomain>.workers.dev`; you may route it to your own domain instead.
7. Check it: `curl https://<the Worker>/revoked` answers a `devot1rev.` list. Until every secret and variable is set, every route answers `E_LICENCE_CONFIG`.

To update, pull the repository, apply any new migration (`pnpm exec wrangler d1 migrations apply devot-licence --remote`) and run `pnpm exec wrangler deploy` again.

**Secrets** (`wrangler secret put`; never in a file):

| Secret                  | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| `LICENCE_SIGNING_KEY`   | the Ed25519 seed from `pnpm keygen`                         |
| `STRIPE_SECRET_KEY`     | a restricted key: Checkout Sessions Write, Customers Read   |
| `STRIPE_WEBHOOK_SECRET` | the webhook endpoint's signing secret (`whsec_…`)           |
| `RESEND_API_KEY`        | a Resend key with sending access to the one domain (`re_…`) |

**Variables** (`[vars]` in `licence/wrangler.toml`):

| Variable               | Value                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `LICENCE_KID`          | the signing key's ID, as the app knows it                                              |
| `STRIPE_PRICE_LICENCE` | the licence's one-time Price ID (`price_…`)                                            |
| `STRIPE_PRICE_RENEWAL` | the renewal's one-time Price ID                                                        |
| `MANAGED_PAYMENTS`     | `true` for Managed Payments (the default), anything else for Stripe Tax                |
| `MAIL_FROM`            | the sender address, on the verified Resend domain (for example `licence@devot.online`) |
| `CANCEL_URL`           | optional: where Checkout's back link goes, such as the website's Buy page              |

## Resend

The Worker posts each message to Resend's [Send Email](https://resend.com/docs/api-reference/emails/send-email) endpoint (`https://api.resend.com/emails`) with `fetch`, no SDK, and the key as a bearer token.

1. Create a Resend account and, under Domains, add the domain you send from (for example `devot.online`). Resend shows its DNS records (SPF, DKIM and, if you want it, DMARC). Add them in the Cloudflare dashboard under the domain's DNS, then press Verify. Do not proxy these records.
2. Under API Keys, create a key with the Sending access permission restricted to that domain, and store it as `RESEND_API_KEY`.
3. Set `MAIL_FROM` to an address on that domain, such as `licence@devot.online`.

**Plan limits.** The free plan sends 3,000 emails a month, at most 100 a day, from one domain. Past a limit Resend answers 429 (`daily_quota_exceeded` or `monthly_quota_exceeded`) and the Worker logs `E_LICENCE_MAIL <name>`. The buyer loses nothing: the key is on `/done`, the webhook answers 500 so Stripe retries the mail (the daily quota resets, so a retry the next day sends it), and `/resend` mails it again once there is room. Upgrade the Resend plan if sales ever near the limits.

**Idempotency.** Every message carries an `Idempotency-Key` header. Resend keeps a key for 24 hours and answers a repeat of it with the first response without sending again; a key is 1 to 256 characters ([Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys)). The key is `issued/<session>` or `renewed/<session>` for a purchase, so a retried send of one purchase's mail within 24 hours mails once; `/resend` uses `resend/<keyed hash of the address>/<attempt in the window>/<window>`, which is unique for each allowed request and holds no address. A `409 concurrent_idempotent_requests` is retried later like any other failure. The claim-before-send mark in D1 still comes first and covers retries after the 24 hours.

**Errors.** A failed send throws `E_LICENCE_MAIL <name>`, where the name is Resend's error `name` ([Errors](https://resend.com/docs/api-reference/errors)) if it is a plain lowercase word, else `http_<status>`; a network failure gives `network`. The message, response body, address and key are never logged. Every failure clears the claim and makes the webhook answer 500, so Stripe retries; the same goes for 429 and 5xx.

## Stripe

Do everything first in a [sandbox](https://docs.stripe.com/sandboxes), with its own keys, Prices and webhook endpoint, against a Worker deployed under another name (`pnpm exec wrangler deploy --name devot-licence-sandbox`, with its own D1 database) or the same Worker before launch. Pay with the test card `4242 4242 4242 4242`; refund and dispute test payments in the sandbox's Dashboard to see a licence revoked. To go live, create the same objects in live mode and replace the three secrets and the two Price IDs.

1. **Product and Prices.** Create one Product, "Devot", with a product tax code labelled Eligible for Managed Payments (one for downloadable software). Give it two one-time Prices: the licence and the renewal. Put their IDs in `STRIPE_PRICE_LICENCE` and `STRIPE_PRICE_RENEWAL`. The Price's tax behaviour decides whether tax is added on top or included.
2. **Managed Payments.** Apply for it and turn it on under Settings > Managed Payments. An account Stripe has not admitted sets `MANAGED_PAYMENTS = "false"`: Checkout then uses Stripe Tax, and you register for tax wherever it is required before selling there.
3. **Restricted key.** Under Developers > API keys, create a restricted key with Checkout Sessions: Write and Customers: Read, nothing else, and put it in `STRIPE_SECRET_KEY`. The Worker pins API version `2026-09-30.endive` on every request (`licence/src/stripe.ts`); Managed Payments needs `2025-03-31.basil` or later.
4. **Webhook endpoint.** Under Developers > Webhooks, add `https://<the Worker>/stripe/webhook` with API version `2026-09-30.endive` and the events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded` and `charge.dispute.closed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`. The Worker accepts a signature up to 5 minutes old.
5. **Website.** The Buy page links to `https://<the Worker>/buy`. Prices, the refund policy and the terms of sale belong to the website and Stripe.

## Revoking by hand

A refunded renewal does not revoke the licence; neither does anything Stripe does not report as a full refund or a lost dispute. In `licence/`:

```sh
# The licence a purchase paid for, by its PaymentIntent (pi_…) or Checkout Session (cs_…)
pnpm exec wrangler d1 execute devot-licence --remote \
  --command "SELECT licence_id, kind FROM purchases WHERE payment_intent = 'pi_…'"

# Revoke it
pnpm exec wrangler d1 execute devot-licence --remote \
  --command "UPDATE licences SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = '<licence ID>'"

# Take back a refunded renewal's year instead
pnpm exec wrangler d1 execute devot-licence --remote \
  --command "UPDATE licences SET updates_until = date(updates_until, '-1 year') WHERE id = '<licence ID>'"
```

Setting `revoked_at` back to `NULL` restores a licence. Devices drop a revoked licence the next time they fetch `/revoked`. Taking back a year changes only the keys the Worker signs from then on: a device that holds the longer key keeps it, since nothing checks a key online.

## Complimentary licences

To give someone a licence without a purchase, sign one on your own machine. In `licence/`:

```sh
# Paste the seed when asked; it stays out of your shell history and every file.
read -rs LICENCE_SIGNING_KEY && export LICENCE_SIGNING_KEY
LICENCE_KID=2026-10 pnpm --filter @devot/licence issue friend@example.com
unset LICENCE_SIGNING_KEY
```

It prints the licence ID, the last release date it covers (one year after today, UTC, as a purchase), the key and its `devot://licence` link. It writes nothing to disk and records nothing in D1, so the Worker never knows it: `/resend` does not find it, `/renew` answers `E_LICENCE_UNKNOWN` (issue another one instead), and only you hold a copy. Keep the licence ID if you may need to revoke it. A wrong or missing seed or kid answers `E_LICENCE_CONFIG`, a missing address `E_LICENCE_BAD_REQUEST`; neither prints the seed.

To revoke a complimentary licence, add a revoked row for its ID, so `/revoked` lists it:

```sh
pnpm exec wrangler d1 execute devot-licence --remote \
  --command "INSERT INTO licences (id, session_id, customer_id, issued_at, updates_until, revoked_at) VALUES ('<licence ID>', 'complimentary-<licence ID>', 'complimentary', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), date('now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
```

The row has no purchase, so nothing mails, renews or shows it; deleting it restores the licence.

## The app

`src-tauri/src/licence/` checks keys exactly as Formats says (`ed25519-dalek`, strict verification), keeps the key in the keychain beside the AI keys and reports one state: none, valid, updates ended, revoked or invalid (with its code). With a production key in the build, sync refuses to create a vault or connect, and AI refuses to send, unless the state is valid (`E_LICENCE_REQUIRED`). docs/architecture.md (Licences) has the details.

### Adding a signing key

The app trusts the public keys in `PRODUCTION` in `src-tauri/src/licence/keys.rs`, by kid. After `pnpm keygen`, add the pair it printed:

```rust
pub(crate) const PRODUCTION: &[(&str, &str)] = &[("2026-10", "<the public key keygen printed>")];
```

Release that build before the Worker signs anything with the key. While `PRODUCTION` is empty nothing is gated: a release made before your keys exist works as before, with sync and AI open to everyone. The first release with a key gates sync and AI. The test key (kid `test`, from `licence/test-vectors.json`) is trusted only by test and debug builds, never by a release, and a test fails if a production entry reuses it or does not decode to an Ed25519 key. To drop a leaked key, remove its entry and release.

### Updates a licence covers

The release workflow sets `DEVOT_RELEASE_DATE` (`YYYY-MM-DD`, UTC) when it builds, from the same moment it writes as the update feed's `pub_date`; a value of another shape fails the build. A licence whose `updatesUntil` is before that date shows "updates ended" and unlocks nothing in that build; a build without the variable (local and dev builds) counts as covered. The device's clock plays no part.

### Revocations

The app keeps the last revocation list that verified in `<app data>/licence-revocations.txt` (the list as signed; it is public) and verifies it again whenever it reads it. A list older than the one kept (`issuedAt`) is ignored. The updater's schedule fetches `/revoked` once a day (also in a build without the updater key, while the build gates sync and AI and a licence is held): the list whole, over https, with no query or identifying header, then `apply_revocations`. A failure is logged by its code and changes nothing. docs/architecture.md (Updates) has the details.

### What users see

- **Updating:** when the licence is valid for this build but an update was released after its `updatesUntil`, the main window says so before downloading (sync and AI stay locked after updating until a renewal) and offers Renew, Download Anyway and Skip This Version; automatic downloads never fetch it. Skipping is remembered for that version only.
- **Settings > Licence:** whether sync and AI are unlocked, in a sentence for each state; who the licence is for, its ID and the last release it covers; a field to paste a key (Add Licence, or Replace Licence once one is there); Remove Licence…, which asks first; Buy a Licence (`https://licence.devot.online/buy`), or Renew (`/renew?licence=<id>`) for a licence whose updates ended. A key that fails says why, with its code, and changes nothing. A build without a production key says it checks no licence.
- **Sync and AI:** Settings > Sync and Settings > AI say a licence is needed, with Buy (or Renew). Edit with AI opens saying so and sends nothing; Suggest Next Edit says so when asked by key, and a pause asks nothing. A device that syncs stops at its next connect, and the main window's notice says why, with Buy.
- **`devot://licence?key=<key>`** (from `/done` or the email): Devot comes forward and adds the licence to a device that holds none. On a device that holds one, it asks first, and says when the key is the same licence renewed. A key that fails says why.

## Rotating the signing key

1. Make a new pair with `pnpm keygen` and ship its public key under a new kid in a release (The app, Adding a signing key).
2. Once that release is out, `wrangler secret put LICENCE_SIGNING_KEY` with the new seed, set `LICENCE_KID` to the new kid and deploy. New keys, renewals, `/resend` and `/revoked` use it from then on; existing keys keep verifying under the old kid.
3. If the old key leaked, a release drops the old kid, and buyers get keys under the new one through `/resend`.

## Tests

`tests/licence/` runs in `pnpm test`, with nothing deployed and no network: `mail.test.ts` checks the Resend mailer against a recording `fetch` (request, headers, idempotency key, error mapping), `format.test.ts` checks the formats and the test vectors, `webhook.test.ts` the signature scheme against Node's own HMAC, `stripe.test.ts` the Stripe client against a fake `fetch`, `store.test.ts` the SQL on a real D1 database in workerd through Miniflare, `app.test.ts` every route on that database with a fake Stripe and a recording mailer, `issue.test.ts` the complimentary licences `issue` signs, and `worker.test.ts` the bundled Worker in workerd, built from the same entry and settings as `licence/wrangler.toml`, with Stripe answered by the test.
