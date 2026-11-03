# Relay protocol on CloudKit: mapping and test plan (inferred unless marked verified)

## Mapping

| Relay                                                          | CloudKit private DB, one custom zone `devot-<vaultId>`                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| record `(id, version, chunks)`                                 | one `CKRecord` per Devot record: fields `version`, `kind`, `chunkCount`; chunks of <=1.9 MB as `CKAsset` fields (assets are outside the 1 MB data limit, verified); a sealed record under ~900 KB may sit in one `Data` field                                                                                                             |
| push + `base_version` CAS                                      | `CKModifyRecordsOperation` with `.ifServerRecordUnchanged`; `serverRecordChanged` carries the server record, so `rejected{version}` is read from it. The change tag is opaque: keep `version` as a Devot field, use the tag only as the guard                                                                                             |
| `seq`, `pull(since)`                                           | `CKFetchRecordZoneChangesOperation` with a `CKServerChangeToken`. The cursor is opaque bytes, not a number: `PullPage.next`, `Welcome.seq`, `sync_state.since` and `SyncEvent.changed.seq` change type. `changeTokenExpired` means full refetch                                                                                           |
| `changed(seq)`                                                 | `CKDatabaseSubscription` (silent push). Delivery to a closed Developer ID app is unverified; always fetch on launch, wake and window focus                                                                                                                                                                                                |
| pairing offer (10 min, take once)                              | a record in a `pairing` zone, saved and taken with `ifServerRecordUnchanged` + delete; expiry is the sealed `expires` plus a client sweep (no server alarm); polling replaced by the subscription. Same iCloud account is the only audience: decide whether it also replaces the code (changes ADR 0004's "pairing is the only identity") |
| `E_SYNC_QUOTA` until 00:00 UTC                                 | gone. `requestRateLimited`/`zoneBusy`/`serviceUnavailable` + `retryAfterSeconds` map to `paused{until: now+retryAfter}` (fits `PushResult.paused`)                                                                                                                                                                                        |
| `E_SYNC_STORAGE_FULL`, 3 GB attachment share                   | `quotaExceeded` in the private DB = the user's iCloud storage full (verified): no reset time, resumes when space is freed; same shape as `STORAGE_FULL`. The 3 GB share (ADR 0003) has no basis: attachments compete with the user's own iCloud quota                                                                                     |
| epoch                                                          | a `Meta` record holding a random epoch. A deleted zone (`zoneNotFound`, or zone deleted in `fetchDatabaseChanges`), expired token or a different Apple ID => new epoch, versions to 0, upload again (existing path)                                                                                                                       |
| purge tombstones, kept forever                                 | ordinary records with `purged: true`, never CloudKit deletes (a deletion is only seen from a still-valid token). Nulling asset fields orphans assets for server cleanup (verified)                                                                                                                                                        |
| operation limits                                               | 400 items / 2 MB per request without assets (`limitExceeded`, verified); `CKSyncEngine` page says 250 records per batch: batch at <=200 and halve on `limitExceeded`                                                                                                                                                                      |
| signed out / restricted                                        | `accountStatus` != `.available` => sync paused with a code, local work continues; observe `CKAccountChanged`                                                                                                                                                                                                                              |
| moving relay <-> CloudKit                                      | same as moving relay: new transport = new epoch, re-upload. Transport is per vault, not per device (a mixed fleet would not converge); the pairing offer gets a version bump carrying it                                                                                                                                                  |
| builds without Devot's container (`.local`, `.dev`, forks, CI) | detect the entitlement before touching `CKContainer` (it raises an ObjC exception, `guarded`/`catch` is mandatory) and report `E_SYNC_CLOUDKIT_UNAVAILABLE`; relay stays                                                                                                                                                                  |

## Seam vs core

`SyncTransport` (`src/core/sync/transport.ts`) already hides sockets and sealing. Changes needed in `src/core/sync`:
cursor type (`number` -> opaque string) in `PullPage`, `Welcome`, `SyncEvent`, `sync_state`; `PulledRecord.seq` optional;
`Welcome.time` (clock-skew check) from the device clock or a CloudKit server date field; quota variants
(`paused` without a fixed 00:00 UTC, `full` for iCloud); pairing in `pairing.rs` behind a trait. The engine's
CAS, merge, tombstone and epoch logic stays. Rust: a `CloudKitTransport` beside `client.rs`/`service.rs`.

## Rust/ObjC under the unsafe rules

`CKSyncEngine` (macOS 14+/iOS 17+, requires CloudKit + remote-notification entitlements, verified) owns scheduling, batching
and state; it fits poorly with the engine's own CAS push loop and is probably Swift-only (unverified). Prefer
`CKDatabase` operations through `objc2-cloud-kit` (not yet checked for coverage) with `block2` completions, all
inside `native/macos.rs` and `native/ios.rs` with SAFETY comments; fall back to a small Swift C-ABI shim if the
bindings fall short. Every call wrapped in `guarded`, each guarded by the entitlement check.

## Signing and release changes (not made)

Developer ID + iCloud needs an embedded provisioning profile and restricted entitlements; `docs/releasing.md`
and `scripts/release/macos-sign.sh` currently require "no entitlements" on every Mach-O (`E_SIGN_ENTITLEMENTS`), the
app has none, and CI holds no profile secret. Needed: profile secret, entitlements on the main executable only, an
explicit App ID (iOS has only a wildcard profile today), `bundle.macOS.files` (inferred) for the profile, iOS entitlements file.

## Size

Roughly 3-5 weeks of one developer: transport + native 1.5-2k lines, engine/cursor/pairing changes ~500, signing and
release ~300, tests ~1.5k, plus an ADR superseding the "no hosted service/accounts" framing (ADR 0004).

## Test plan (needs the owner's account; throwaway Apple ID)

1. 100,000 records (mixed 1 KB-1 MB): first upload time, request count, `requestRateLimited` frequency, `retryAfter` values, resume after kill mid-upload; new device first download time and memory.
2. Several GB of images (10 MiB each, 6 chunks): upload throughput, `quotaExceeded` point on a 5 GB free account, asset staging cleanup (move to app container), resume.
3. iCloud full: `quotaExceeded` code, notice, resume after freeing space; local edits never lost.
4. Signed out / restricted / account switch: each `accountStatus`, sign out mid-sync, switch Apple ID (new epoch, no cross-account upload without consent).
5. Mac background delivery: Developer ID app closed, running idle, asleep: does the silent push arrive, latency, catch-up on wake.
6. CAS: two Macs write one record offline then online; stale tag rejected; merge converges.
7. Environment: Production schema deploy; Developer ID build against Development vs Production.
8. Zone deleted from iCloud settings; token expiry; relay -> CloudKit -> relay moves.
