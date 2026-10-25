# Devot is source-available under FSL and sold once, with a licence checked offline

The repository stays public under the Functional Source License 1.1 with MIT as the future licence (FSL-1.1-MIT). Devot works fully for a three-day trial; after it, notes are read-only until a licence is added. A licence bought once through Stripe unlocks everything on all of the buyer's devices, in every version of Devot, forever. There is no renewal. The licence is a signed key that the app checks offline, so there is still no account (ADR 0004). This amends ADR 0004: Devot runs one small hosted service, the licence Worker, which never sees notes.

## Source licence

- `LICENSE` holds FSL-1.1-MIT. `package.json`, `relay/package.json` and `src-tauri/Cargo.toml` say `FSL-1.1-MIT`.
- Anyone may read, build, change and redistribute Devot for any purpose but a competing use: offering it, or something that substitutes for it, in a commercial product or service. Each release becomes MIT two years after it is published.
- Versions up to v1.0.4 were published under MIT and stay MIT.
- The licence grants no right to the Devot name or icon.
- The repository stays public because a private one would:
  - lose the free CI minutes, which a month of work here exceeds many times over;
  - lose the `main` ruleset, which needs a paid GitHub plan on a private repository;
  - break the update feed (`src-tauri/src/updates.rs` reads this repository's releases) and the relay guide (`docs/sync-relay.md` deploys from a checkout);
  - hide the code that shows the encryption does what ADR 0002 says.

## The trial, and what the licence unlocks

- **The trial:** three days (72 hours) from the first launch of a build that checks licences (one with a production key), so someone updating from a build that checked none gets their three days then. While it runs, everything works, sync and AI included. A valid licence overrides it at any time.
  - Its start and the latest time seen are kept in the keychain beside the licence, which outlives a reinstall. Setting the clock back more than an hour before the latest time seen ends the trial rather than extending it. Erasing the keychain item gives a new trial: that is accepted, as builds without the check are (Risks).
  - A build without a production key never starts the clock and gates nothing.
- **After the trial, without a licence, Devot is read-only:** notes can be read, searched, copied and exported (`localNotes`, always free), but no note, notebook, tag, attachment, template or trash entry can be created, changed or deleted, nothing can be imported, and sync and AI are locked. Settings, window state, the licence itself, backups of existing data, exports and the Markdown mirror keep working. Rust refuses every write of user content (`E_LICENCE_REQUIRED`), and a note being saved as the trial ends is still written for a few minutes, so nothing typed is lost.
- **The licence unlocks:**
  - editing (`editing`);
  - sync (`sync`);
  - AI with the user's own provider keys (`aiProviders`), including edit proposals and next edit suggestions;
  - local semantic search once it ships (`semanticSearch`).
- A licence names a plan (`pro`), not a list of features, so a paid feature added later reaches every licence.
- The devot-mcp CLI writes the database itself and is not covered; it is not shipped.

## The licence

- **Format:** `devot1.<payload>.<signature>`, both parts base64url. The payload is JSON:
  - `id`: 128 random bits;
  - `kid`: the signing key's ID;
  - `plan`: `pro`;
  - `licensee`: the buyer's email address;
  - `issuedAt`.
- **Nothing in a key ends.** A valid key unlocks every version. Fields a version does not know are ignored, so a later field never breaks an older app. A paid upgrade, if Devot ever sells one, needs a new key format and its own ADR.
- **Size:** the key is about 260 characters for a short address, short enough for an email, a deep link and a paste.
- **Signature:** Ed25519. The app holds the public key of each `kid`, so a new signing key ships in a release before anything is signed with it.
- **Checking:** Rust verifies the key (`src-tauri/src/licence/`), keeps it in the keychain beside the vault key and the AI keys, and reports its state:
  - none;
  - valid;
  - revoked;
  - invalid.
- **Where Rust enforces it:** without a valid licence once the trial is over, the database refuses every write of user content, the sync service refuses to connect and the AI client refuses to send (`E_LICENCE_REQUIRED`). The UI reads the same state, the trial's included, through an `EntitlementSource`, makes notes read-only and shows locked features with Buy.
- **Offline:** nothing checks a licence or the trial online. A licence works offline forever, so `OFFLINE_GRACE_MS` and `confirmedAt` go; they belonged to an account that does not exist.
- **Adding a licence:** paste it in Settings > Licence, or open `devot://licence?key=<key>` (from the purchase page or the email). A link always asks before it replaces a licence the device already holds. A key that fails to verify is refused with its code and never logged.

## Buying

- **The Worker:** `licence/` is a Cloudflare Worker deployed to the owner's account, with a D1 database. The database holds one row per licence: ID, Stripe Checkout Session ID, Stripe customer ID, issued at and revoked at. Beside it, one row per paid session keeps the session, customer and PaymentIntent IDs, so a session fulfils once and a refund finds its licence; a refunded or lost PaymentIntent is kept too, so a refund that arrives before its purchase is recorded still revokes the licence; and `/resend` keeps its rate-limit counters under keyed hashes. It stores no email (Stripe holds it), no key (it signs one again from the row) and no notes.
- **Routes:**
  - `GET /buy` creates a Checkout Session for the licence's Price and redirects to it.
  - `POST /stripe/webhook` checks `Stripe-Signature`. On `checkout.session.completed` with `payment_status: paid` (or `checkout.session.async_payment_succeeded` for a payment that settles later), it issues the licence and emails it. A session issues at most one licence, so Stripe's retries are harmless.
  - `GET /done?session_id=<id>` shows the key with an Open in Devot button (the deep link), so a lost email loses nothing. When the buyer arrives before the webhook, it retrieves the paid session and issues the licence itself.
  - `POST /resend` takes an email address and mails every licence of that address's Stripe customers. It always answers the same way, so it never tells whether an address bought anything, and it is rate-limited per address and per IP.
  - `GET /revoked` returns the signed list of revoked licence IDs.
- **Tax and disputes:** Checkout uses Stripe Managed Payments, which makes Stripe the merchant of record: it handles sales tax and VAT, fraud and disputes. An account Stripe has not admitted to Managed Payments uses Stripe Tax instead, and the owner registers for tax wherever it is required before selling there. One Worker variable chooses between the two.
- **Secrets:** the Ed25519 signing key, a restricted Stripe key and the webhook's signing secret are Wrangler secrets that the owner sets. The repository holds only public keys. The licence's one Price lives in Stripe; the Worker knows its ID.
- **Email** goes out through Resend's HTTP API from the owner's domain (free plan: 3,000 a month, 100 a day), so the Worker runs on Workers Free.
- **Selling page:** the website links to `/buy`. Prices, the refund policy and the terms of sale belong to the website and Stripe, not to this repository.

## Revocation

- A refund or a lost dispute revokes the licence (Stripe's `charge.refunded` and `charge.dispute.closed` events).
- The app downloads `/revoked` whole with each update check (at most once a day), so the Worker never learns which licence a device holds. The list is signed with the licence key and grows by about 33 characters per revoked licence (docs/licensing.md, Formats).
- A device that never comes online keeps a revoked licence working. That is accepted.

## Risks

1. **Builds without the check.** FSL lets anyone build Devot from source without the licence check and publish such builds free of charge, as long as they are not sold and do not use Devot's name. What is sold is the signed and notarised app, its updates and the time it saves. Nothing is obfuscated.
2. **Every release turns MIT after two years,** including its sync and AI code. A licence pays for every version to come, so income comes from new buyers only.
3. **iOS.** Outside the US storefront, App Store rules may require the licence to be sold as an in-app purchase as well. This is decided in its own ADR when iOS ships.
4. **The Worker is a service.** While it is down nobody can buy, resend or fetch revocations. Installed apps keep working, because the check is offline.
5. **The signing key.**
   - If it is lost, no licence can be issued until a new `kid` ships in a release.
   - If it leaks, anyone can make licences. A release then drops the old `kid`, and `/resend` reissues every licence under the new one.
   - The owner keeps an offline copy beside the Wrangler secret.
6. **The email in the key** shows whose licence it is, which discourages sharing. It is personal data, so logs and error messages carry the licence ID only.

## Consequences

- ADR 0004 now says "one hosted service: the licence Worker". Sync still has no account, and a licence is not an identity for sync.
- `docs/architecture.md` changes:
  - Product: source-available under FSL-1.1-MIT, a three-day trial, then read-only until a licence is added;
  - Billing: the licence source and the trial;
  - CI: "free for a public repository" still holds.
- **Tickets, in order:**
  1. The licence change: `LICENSE`, the three manifests and the docs.
  2. The licence Worker: D1, Stripe Checkout and webhooks, email, `/resend`, `/revoked`, and a guide (`docs/licensing.md`).
  3. The app:
     - a Rust `licence` module with its keychain entry and commands;
     - the `devot://licence` deep link;
     - enforcement in sync and AI;
     - the entitlements source;
     - Settings > Licence.
  4. The updater: fetching revocations.
  5. The website's Buy page (devot-site).
- The sync work already planned is unchanged; the device-pairing ADR takes the next free number.

## Amended

Issue #360 settled that a licence is bought once and unlocks sync and AI in every version, with no renewal: the key carries no date that ends it, the Worker sells one Price, and the updater offers every update the same way to everyone.

Issue #362 replaced "free but for sync and AI" and "there is no trial" with the three-day trial and the read-only mode after it, described above.
