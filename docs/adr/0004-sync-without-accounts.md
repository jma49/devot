# Sync needs no account: each owner runs their own relay

Devot runs no hosted service. Sync goes through a relay the owner deploys themselves (a Cloudflare account on the Workers Free plan, or Node + SQLite on a server), and its URL is a client setting. Devices join a vault by pairing (QR code), which hands over the vault key and the relay's access token; pairing is the only identity sync needs. Accounts (#4) and web sharing (#11) wait until a hosted service is decided.

## Why

- The free limits in ADR 0002 (5 GB, 100k rows written a day) belong to one Cloudflare account. They hold one person's devices, not every user of the app; a shared relay would need a paid plan, billing, accounts, account deletion and abuse handling.
- Notes never pass through an account. An account would add an identity and a plan, nothing the relay needs to store records.
- Hosting what users publish (#11) carries abuse and takedown work that only a hosted service takes on.

## Consequences

- Phase 2 sync: device pairing by QR code and a recovery key; the relay keeps per-device token hashes (ADR 0002, Abuse) and needs nothing else to know a device.
- A guide and a template deploy the relay to the owner's Cloudflare account (`wrangler deploy`) or run it with Node.
- The entitlements interface (#5) stays: every feature is available, and a later account source can fill it.
- `docs/architecture.md`, Product: accounts are not part of phase 2; sync's identity is pairing.

## Amended

ADR 0006 adds one hosted service, the licence Worker, which sells and reissues licences and never sees notes. Sync still needs no account.
