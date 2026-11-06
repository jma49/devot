# Updates

Part of the [architecture overview](../architecture.md).

- **The updater** (`src-tauri/src/updates.rs`, `docs/releasing.md`): Tauri's updater reads a channel feed in the repository's `updater` release (`beta.json` for a prerelease build, `stable.json` otherwise) 30 seconds after launch, then daily (hourly on the beta channel) and on Check for Updates.
  A build without the updater's public key has no updater.
  Rust holds the status and sends `devot://update-status` (with a revision) to every window; with `autoDownloadUpdates` on (the default) a found update downloads in the background and Restart to Update installs it.
- **Revocations:** the same scheduler thread fetches `<license site>/revoked` once a day, 30 seconds after launch and then when due, also in a build without the updater key, as long as the build gates and a license that verifies is held.
  It downloads the list whole through `net::get` (https, public hosts only as `net.rs` defines them, a time cap and a size cap of 1 MiB; the system TLS stack, and the environment's proxy or else the macOS system HTTPS proxy) with no query, cookie or license-specific header, so the Worker never learns which license a device holds.
  `License::apply_revocations` verifies it and ignores one older than the list kept.
  A failure is logged as `W_LICENCE_REVOCATIONS_FETCH_FAILED <code>` (or `W_LICENCE_REVOCATIONS_REFUSED <code>` when the list does not verify) and changes nothing; a successful fetch waits a day, while a failed one is tried again at the scheduler's next 15-minute wake, and each further failure in a row waits twice as long, never more than a day (`schedule::retry_after`); a success ends the backoff.
  With no license held there is nothing to fetch, which is no failure.
  `net` reads the system proxy itself (`net::proxy`, from SCDynamicStore): the HTTPS proxy and its bypass list, with loopback always direct.
  An automatic configuration (PAC file or auto-discovery) is not run, so with only that on the fetch goes direct: running one needs a JavaScript engine and a fetch of the script, usually from the local network `net` refuses.
- **Tests:** Rust unit tests for the status the page reads and the revocation fetch (against a server on this machine, and with a fake transport for the failures); `tests/ui/updates.spec.ts` for the notices.
  A license plays no part in what the updater offers: a valid license unlocks every version.
