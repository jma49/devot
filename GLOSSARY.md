# Glossary

Terms the code and the docs use with one meaning each.

## Sync

- **Relay:** the server that stores each record's latest encrypted state and tells a vault's devices when something changed. Each owner runs their own (docs/adr/0004-sync-without-accounts.md, docs/sync-relay.md). It never decrypts.
- **Relay secret:** the relay's own secret (`RELAY_SECRET`). Creating a vault on the relay needs it; Devot sends it in that one request and never keeps it.
- **Vault:** what a set of devices syncs: a random vault ID, which the relay knows, and a 256-bit vault key, which it never sees. The vault key lives in each device's keychain.
- **Record:** one note, notebook, tag or attachment, sealed under a key derived from the vault key (docs/adr/0002-sync-latest-state-per-record.md).
- **Enrollment secret:** derived from the vault key; a device presents it to the relay to become one of the vault's devices. The relay keeps only its verifier. It reveals nothing about the vault key.
- **Device token:** what the relay gives a device when it enrolls, kept in that device's keychain. The relay keeps its hash. Removing a device revokes its token.
- **Pairing code:** a one-time code a syncing device shows (as text and as a QR code) for 10 minutes, to bring the vault to a new device. It carries a 128-bit pairing secret that never reaches the relay (docs/adr/0008-sync-device-pairing.md).
- **Pairing ID:** derived from the pairing secret; the relay files the pairing under it.
- **Offer:** the vault ID and key, with an expiry, sealed under the key derived from the pairing secret. The relay holds it until the new device takes it, once.
- **Confirmation:** the new device's device ID, sealed under the same key, which tells the showing device the pairing worked.
- **Recovery key:** the vault ID and key as 85 characters with a checksum, shown once when the vault is made. With the relay's address, it lets a device join when no other device is at hand.
- **Joining:** a device takes a vault from a pairing code or the recovery key, keeps it in its keychain and enrolls. A device never replaces a vault it holds with another one.
