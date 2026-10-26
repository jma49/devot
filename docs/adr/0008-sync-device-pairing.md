# Devices pair with a one-time code that carries a 128-bit secret; the relay holds only a sealed offer

A device that already syncs shows a pairing code: 128 random bits, as 32 characters to type or paste, and as a QR code that adds the relay's address. The code never reaches the relay. Both devices derive from it the pairing's ID, which the relay sees, and a key, which it does not. The existing device seals the vault's ID and key under that key and leaves the sealed offer on the relay for 10 minutes. The new device takes it once, opens it, enrolls with the relay on its own and returns a sealed confirmation. The recovery key, shown once when the vault is made, does the same job without another device: entered with the relay's address, it restores the vault and enrolls the device. This settles the design question of #336 (ADR 0004 left it open).

## What exists

- A vault is a random ID and a 256-bit key in the keychain. Records are sealed under a key derived from it, so whoever holds the vault key can read every record (`src-tauri/src/sync/vault.rs`).
- A device enrolls with the relay by presenting the enrollment secret, which any holder of the vault key derives. The relay keeps only its verifier and gives the device a token of its own (`client::enroll`; docs/sync-relay.md). So a new device needs the vault ID and key, and nothing else, to join.
- The recovery key format (`recovery.rs`): the vault ID and key with a version byte and a checksum, 85 characters of Crockford base32.

## What the code carries

- **The pairing secret `S`:** 16 bytes from the OS random source, new for each code.
- **Text form (to type or paste):** `version (1) || S (16) || checksum (3)` in Crockford base32, which is exactly 32 characters, shown in eight groups of four. The checksum is the first three bytes of SHA-256 over a label and the rest, so a mistyped code is refused before anything goes out. Reading it forgives case, spaces, hyphens and the look-alikes, like the recovery key.
- **QR form:** `devot://pair?relay=<relay URL>&code=<32 characters>`. The joining device needs the relay's address, and a phone should not have to type it. The text form leaves the address out to stay short: the joining device takes it from Settings > Sync's Relay field. A pasted link is read too. A link for another relay than the one already set is refused (`E_SYNC_PAIRING_RELAY`), so a code cannot quietly move a device to another relay.
- A Mac without a camera types or pastes the text form. A phone scans the QR code, or pastes the text. Scanning inside Devot on iOS is a follow-up. Until then the system camera reads the link, but Devot does not yet act on a `devot://pair` link.

## How the vault key travels

From `S`, both devices derive with HKDF-SHA256 (salt `devot/sync/pairing/v1`, one label per use):

- **the pairing ID:** 16 bytes as base64url. The relay files the pairing under it. It reveals nothing about `S`;
- **the pairing key `K`:** 32 bytes for AES-256-GCM.

Then:

1. **Open.** The existing device seals the **offer** under `K`: `version || expires (ms, its own clock) || vault ID || vault key`. The additional data is a label and the pairing ID. It sends the pairing ID, the vault ID and the offer to the relay with its own device token. The relay checks the token as it does for a socket (the MAC at the front, then the token's hash in the vault) and keeps the offer until the code expires.
2. **Take.** The new device sends the pairing ID. The relay hands the offer out once, deletes it and marks the pairing taken. The new device opens the offer with `K`, refuses one whose `expires` has passed (allowing the engine's 5 minutes of clock difference), and keeps the vault in its keychain.
3. **Enroll.** The new device enrolls with the relay through the existing `enroll` request, which gives it its own token.
4. **Confirm.** The new device seals its new device ID under `K` (another label) and sends it. The existing device polls the pairing's state every 2 seconds. When the confirmation opens under `K`, it shows the device as paired and closes the pairing on the relay.

Why this holds against the relay:

- **It cannot read the key.** The offer and the confirmation are sealed under `K`, which comes from `S`, and `S` never goes to the relay. The relay stores the offer, so it could try to guess `S` offline, but 128 random bits put that out of reach. That is why the code carries a full-strength secret rather than a few words.
- **It cannot substitute or swap.** A forged offer, an offer from another pairing, or a confirmation passed off as an offer fails authentication: the additional data binds each message to its pairing ID and its role. The joining device keeps nothing from an offer that does not open (`E_SYNC_PAIRING_AUTH`). So a relay cannot slip a vault of its own onto the device, which would make the device upload its notes there. A forged confirmation does not open either, so the existing device never reports a pairing that did not happen.
- **It cannot replay.** An old offer opens only under its own `K`, and its sealed `expires` makes it useless after the code's lifetime, even if the relay keeps it.
- **It gets no device of its own through pairing.** Only a holder of `S` can open the offer. A relay can always add rows to its own device table, but a device without the vault key can neither read a record nor write one that the vault's devices accept (records fail `E_SYNC_CHUNK_AUTH`). The enrollment secret reaches the relay at enrollment, as it already did (ADR 0004). It is the relay's own access check and does not reveal the vault key.

### Why not a PAKE

A PAKE (SPAKE2, CPace) would allow a code of six to eight characters: each guess needs a live exchange, and the code dies after one. Against this design:

- it needs a dependency Devot does not have, and the Rust PAKE crates have had less review than RustCrypto's AES-GCM and HKDF, which sync already uses;
- both devices must be online at once, through extra round trips on the relay;
- the relay could still make one online guess on every pairing.

A 32-character code costs some typing in the rare case without a camera or clipboard; the recovery key is 85 characters and is typed the same way. If a shorter code is needed later, a PAKE can replace the open and take steps without changing what the devices keep.

## Expiry and one-time use

- **Lifetime:** 10 minutes. The relay refuses `take` after `expires` (`E_SYNC_PAIRING_GONE`). It refuses a second `take` and a second confirmation the same way.
- **Enforced by the relay:** it gives the offer out once and deletes it then. It keeps the rest of the pairing (vault ID, creating device, state, the sealed confirmation) for at most 1 minute past `expires`, for the existing device's last poll. A Durable Object alarm, or a sweep on the Node host, deletes it then.
- **Enforced by the devices:** the existing device makes a new `S` for every code, stops polling at `expires`, closes the pairing on its first valid confirmation, on Cancel and when Settings closes, and accepts one confirmation. The joining device refuses an expired offer and keeps nothing from one that does not open.

## What the new device learns about the relay token

Nothing. The offer holds the vault ID and key only. The new device enrolls with the enrollment secret it derives itself and gets a token of its own. The relay keeps that token's hash, as for every device. No device ever sees another device's token, so removing one device (revoking its token) leaves the others alone.

## Recovery key

- Shown once, in Settings > Sync, when turning sync on makes the vault, with Copy and a hint to keep it in a password manager or print it. It is never shown again; a device that holds the vault can pair new devices instead.
- **Join with the recovery key:** the key and the Relay field restore the vault into a keychain that holds none (or holds this same vault), enroll the device and turn sync on.

## Rules on both joins

- A device that already holds another vault refuses to join (`E_SYNC_VAULT_EXISTS`): a key that may be the only copy is never replaced. Joining the vault it already holds (a removed device that is let back in) is allowed.
- Pairing and joining are sync actions and need the licence (`E_LICENCE_REQUIRED`), as creating the vault and connecting do. Listing and removing devices do not need it: taking access away is never locked.
- Key material stays in Rust. The page sees the code to show (text and QR), its expiry, the outcome, and the recovery key once.

## Compatibility

- **Relay protocol:** still version 1. Pairing adds HTTP routes under `/v1/pairings/` and leaves every existing route and message as it was, so older clients keep working against an updated relay.
- **Older relay:** a relay from before pairing answers the new routes with `E_SYNC_NOT_FOUND`. The client reports that as `E_SYNC_RELAY_OUTDATED`, and Settings asks the owner to update the relay. Nothing is kept or changed on either device. Joining with the recovery key uses only the existing enrollment, so it works with an older relay too.
- **Cloudflare:** pairings live in their own Durable Object class (`PairingObject`, one object per pairing, on SQLite storage, migration `v2`), so `wrangler deploy` adds it next to the vaults without touching them.

## Consequences

- docs/sync-relay.md documents the routes and how an owner updates their relay. docs/architecture.md and GLOSSARY.md name the pairing code, the offer and the recovery key.
- Follow-ups: scanning the QR code inside Devot on iOS; acting on a `devot://pair` link (it should only fill in the join form, never join on its own); device names that tell two Macs apart (encrypted under the vault key so the relay does not see them); a way to leave a vault on purpose.
