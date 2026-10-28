# Sync relay

The relay stores the latest encrypted state of every record of a vault and tells a vault's devices when something changed (docs/adr/0002-sync-latest-state-per-record.md). It never decrypts and never merges. Devot runs no hosted relay: each owner deploys their own (docs/adr/0004-sync-without-accounts.md), on Cloudflare's Workers Free plan or with Node on a server of their own. The code is in `relay/`; the wire format, which the app shares, is `src/core/sync/protocol.ts`.

## Deploy to your own Cloudflare account

You need a Cloudflare account on the Workers Free plan. Keep it free of a payment method: on the Free plan an exceeded limit makes a request fail and is never billed. The relay uses only a Worker and a Durable Object class on SQLite storage, no R2, KV, D1 or Queues.

1. From a checkout of this repository, install the relay's dependencies: `pnpm install --filter @devot/relay`.
2. In `relay/`, sign in: `pnpm exec wrangler login`.
3. Deploy: `pnpm exec wrangler deploy`. It prints the relay's URL, `https://devot-relay.<your subdomain>.workers.dev`. `relay/wrangler.toml` is the template; you may rename the Worker (`name`), but keep the `VAULTS` and `PAIRINGS` bindings, the `VaultObject` and `PairingObject` classes and their `v1` and `v2` migrations.
4. Give the relay its secret: `openssl rand -base64 32 | pnpm exec wrangler secret put RELAY_SECRET`. Until it has one, the relay answers every request with `E_RELAY_CONFIG`. Keep the secret in your password manager: Devot asks for it once, on the device that creates the vault.
5. Check it: `curl https://devot-relay.<your subdomain>.workers.dev/v1` answers `{"v":1,"type":"relay","protocol":1,"time":…}`.
6. Optional, with your own domain on Cloudflare: route the Worker there and add the Free plan's rate-limiting rule on the route (for example requests whose path starts with `/v1/`, 100 per 10 seconds per IP, block for 10 seconds).

To update, see [Update the relay](#update-the-relay). A new `RELAY_SECRET` makes every device token invalid; devices then enroll again with the vault key they hold.

## Run it with Node

Node 24 or later runs the same relay with one SQLite file per vault:

```sh
pnpm install --filter @devot/relay
RELAY_SECRET="$(openssl rand -base64 32)" RELAY_DATA=/var/lib/devot-relay PORT=8787 \
  node relay/src/node/main.ts
```

| Variable       | Default        | Meaning                                                 |
| -------------- | -------------- | ------------------------------------------------------- |
| `RELAY_SECRET` | (required)     | At least 32 characters; needed to create a vault        |
| `RELAY_DATA`   | `./relay-data` | Folder for the vaults' databases (`<vault ID>.sqlite`)  |
| `PORT`         | `8787`         | Port to listen on                                       |
| `HOST`         | `127.0.0.1`    | Address to listen on; leave it local behind a TLS proxy |
| `RELAY_QUOTA`  | `free`         | `free`: the quota cap below; `off`: no cap              |

A server of your own has none of the Workers Free limits, but the cap stays on by default: it is one of the cost guards every host keeps (`docs/architecture.md`, Sync and encryption), and it keeps a misbehaving device from filling the disk. Set `RELAY_QUOTA=off` to run without it.

The relay speaks plain HTTP: put a TLS proxy in front, such as Caddy (`devot-relay.example.com { reverse_proxy 127.0.0.1:8787 }`, which passes WebSockets through), and keep it running with your service manager. The relay is not a source of truth: if its folder is lost, devices upload their records again to a new vault. Pairings live in memory: a restart ends the codes on show, and a device shows a new one.

## Update the relay

Update the relay when Devot's release notes say so, and before you update the apps when you can. Data, `RELAY_SECRET` and device tokens stay as they are, and no device has to enroll again.

Pairing devices (docs/adr/0008-sync-device-pairing.md) needs a relay from this release or later. A relay from before answers a pairing with `E_SYNC_NOT_FOUND`; Devot then says the relay needs an update and changes nothing on either device. Joining with the recovery key works with an older relay too. An updated relay keeps serving devices that run an older Devot: every earlier route and message is unchanged.

To get images to sync (docs/adr/0003-sync-attachments-as-records.md) a relay from before this release must be updated; there is no data migration, and the relay's storage schema is unchanged. Update it the same way as for any release:

- **Cloudflare:** pull the repository, then in `relay/` run `pnpm install --filter @devot/relay` and `pnpm exec wrangler deploy`. The deploy applies the `v2` migration, which adds the `PairingObject` class next to your vaults and leaves them as they are. If you renamed the Worker or edited `wrangler.toml`, add the `PAIRINGS` binding and the `v2` migration from the template first. The secret and the URL stay.
- **Node:** pull the repository, run `pnpm install --filter @devot/relay`, and restart `node relay/src/node/main.ts` with the same `RELAY_SECRET` and `RELAY_DATA`. The vault files stay as they are.

Mixed versions keep working while you update:

- **A newer app with an older relay** syncs notes, notebooks and tags as before, without the quota cap. The relay's `welcome` does not say `quota`, so Settings > Sync tells you to update the relay. A relay older than the cap never refuses a push for quota; on Cloudflare a request past a free limit then fails until 00:00 UTC, which the app treats as being offline and tries again later. Nothing is lost.
- **A newer app with a relay from before attachments** (it has the quota cap but its `welcome` does not say `attachments`) sends no image: an attachment could take the room notes need, which only the new relay limits (see Attachments). Images stay on the device that added them, notes keep syncing, and Settings > Sync says how many images are not synced and that the relay needs an update. Update the relay and the images go on the next connection. A relay so old that it does not know file records answers `E_SYNC_BAD_MESSAGE` to one; the app treats that the same way and loses nothing.
- **An older app (1.0.5-beta2) with a newer relay** syncs as before. It does not send or read images: it skips the file records it pulls (they stay on the relay for the devices that read them), and the relay never sends it `E_SYNC_ATTACHMENTS_FULL`.
- **An older app (1.0.5-beta2) with a newer relay** also reads `E_SYNC_QUOTA` as a pause and tries again every hour, without the reset time.

## Quota

The relay keeps every vault inside 80% of each Workers Free limit it can count (docs/adr/0002-sync-latest-state-per-record.md, Staying inside the Workers Free plan). On the Free plan an exceeded limit makes requests fail rather than cost money; the cap keeps that from happening and tells the devices when they can go on. The limits are in `relay/src/quota.ts`. Read them again before each release.

| Workers Free limit      | Limit                                                                     | Cap (80%)           | Counted as                                                                        |
| ----------------------- | ------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------- |
| Rows written (SQLite)   | 100,000 a day, deletes included                                           | 80,000 a day        | `rowsWritten`, as the host's SQLite reports them                                  |
| Durable Object requests | 100,000 a day; a connection or call is 1, 20 incoming messages count as 1 | 80,000 a day        | `requests` + `messages` / 20                                                      |
| Workers requests        | 100,000 a day                                                             | within the above    | each HTTP call and socket connection is in `requests`, so the cap above covers it |
| Stored data (SQLite)    | 5 GB in total                                                             | 4,000,000,000 bytes | `storedBytes`, the records' sealed bytes                                          |
| Attachments (share)     | part of the stored data                                                   | 3,000,000,000 bytes | `fileBytes`, the sealed bytes of file records; see Attachments                    |
| Rows read (SQLite)      | 5,000,000 a day                                                           | not counted         | see Pulls                                                                         |
| Duration                | 13,000 GB-s a day                                                         | not counted         | the Hibernation API bills only while a message is handled                         |

- **Pushes:** before it writes, a push checks the counters. When today's rows written or requests are at their cap, or the push would take the stored bytes past theirs, the relay refuses it and writes nothing: `error` with `code: "E_SYNC_QUOTA"`, `limit` (`rowsWritten`, `requests` or `storedBytes`) and `until`, the next 00:00 UTC in milliseconds, when the daily counts reset. A push that does not add stored bytes (a smaller record, a purge) passes the storage cap; the reset does not free storage, so past that cap the app tries again each day until records shrink or are purged. The refused message is counted with the next write, like other refused messages.
- **Pulls** stay allowed, and so do `devices`, `revoke`, `time`, `usage`, connections and enrollment. A pull is one incoming message (1/20 of a request), writes one row (the counters row) and reads the records it returns and their chunks, about 3 rows a record; it adds no stored bytes. While pushes are refused, nothing new reaches the relay, so an up-to-date device has nothing to pull, and a paused app closes its socket until the reset. The 20% above the cap, 20,000 rows and 20,000 requests a day, lets a device that is still downloading the vault finish: each pull brings up to 100 records. Rows read are not counted: a full download of a 100,000-record vault reads about 300,000 rows, 6% of the daily limit.
- **The first upload of a large vault** costs at least 4 rows written a record (the record row, a chunk row, the counters row, and the counters row of the other devices' pulls), so about 20,000 records a day fit under the cap. A larger vault goes on over several days: the app shows how many records it has sent of the total, keeps its place across restarts and goes on after each reset.
- **What the app does:** it stops pushing, closes the socket and shows "Sync paused until <the reset in local time>" in its notice and in Settings > Sync; notes keep working on the device. A refusal for stored bytes does not stop the pass: the app still sends the records that fit (smaller ones, purges) and pauses after it. It connects again after the reset, at a random moment in the next minute, and pushes what waited. It never connects in between; it checks the time at least hourly, so a timer that fell behind while the computer slept still ends the pause.
- **Per vault:** the counters are per vault, and the Workers Free limits are per account. One vault per account, as the deploy steps above set up, keeps the two the same.
- **Stored bytes** count the records' sealed bytes, not SQLite's own overhead (row headers, index pages); the 20% left covers it.

## Attachments

Images sync as file records (`kind: "file"`) on the same relay, one record per image, cut into chunks like any record: an image of at most 10 MiB is a record of at most 11 MiB sealed, so 6 chunks (`E_SYNC_TOO_LARGE` past that). Every device downloads every file record (docs/adr/0003-sync-attachments-as-records.md).

- **The share:** file records may take 3,000,000,000 bytes (`FILE_SHARE_BYTES` in `relay/src/quota.ts`) of the stored bytes, so notes, notebooks and tags always keep about 1 GB under the cap above. A push that would take them past it is refused with `error`, `code: "E_SYNC_ATTACHMENTS_FULL"`, and nothing is written; pushes of notes, notebooks and tags, and every pull, go on. The app keeps the image on the device that added it, counts it in Settings > Sync ("N images are not synced") and sends it again after a purge frees room or on the next launch. A relay that runs with `RELAY_QUOTA=off` has no share.
- **Order of the checks:** the daily limits come first (they pause every push: `E_SYNC_QUOTA`), then the share (`E_SYNC_ATTACHMENTS_FULL`, files only), then the total stored bytes (`E_SYNC_QUOTA` with `limit: "storedBytes"`).
- **A purge frees the space:** the app replaces the file record with a tombstone (`purged`, no bytes, kept forever); the push replaces its chunks, so `storedBytes` and `fileBytes` fall by the image's size. A file record of at most 1 KiB (a tombstone) is never refused for the share, so a full share can always be emptied. Other devices pull the tombstone and remove the image.
- **`welcome`** says `attachments` (`on` or `off`) when the relay holds file records within the share. An app that does not see it sends no image (see Update the relay).

## Connect Devot

In Devot, open Settings > Sync, enter the relay's URL (https, or http to the same machine for a relay you run locally), then the relay's secret once, on the first device: Devot makes the vault key in the keychain, creates the vault on the relay and turns sync on. The secret goes into that one request and is not kept. Devot then shows the recovery key until you press I Saved It: keep it in your password manager or print it. On every other device, join instead (below): Set Up a New Vault is for the first device only.

To add another device, choose Show Pairing Code under Add a Device on a device that syncs. On the new device, scan the QR code, or type or paste the code under Join With a Code (with the relay's URL set). The code works once, for 10 minutes. A device can also join with the recovery key and the relay's URL, under Join With Recovery Key, when no other device is at hand. Devices lists the vault's devices; Remove takes one's token away (`revoke`). A removed device still holds the vault key, so whoever has it can enroll it again on purpose; Devot never does so on its own. Until Devot can change a vault's key, treat a lost device that held it as able to read the vault.

## Protocol

Version 1. Every message is an envelope `{"v": 1, "type": …}`; a relay refuses another version with `E_SYNC_PROTOCOL`.

**HTTP**

| Request                                                               | Body                          | Answer                                             |
| --------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| `GET /v1`                                                             |                               | `relay`: the protocol version and the relay's time |
| `POST /v1/vaults/<vault>` with `Authorization: Bearer <RELAY_SECRET>` | `create`: `verifier`, `label` | `enrolled`, for the creating device                |
| `POST /v1/vaults/<vault>/devices`                                     | `enroll`: `secret`, `label`   | `enrolled`                                         |
| `GET /v1/vaults/<vault>/socket` (WebSocket)                           |                               | `welcome`, then messages                           |

- The HTTP routes send no CORS headers, so a web view cannot call them with `fetch`: the app calls them from Rust.
- A vault ID is 16 to 64 characters of `A-Z a-z 0-9 _ -`, chosen at random by the client.
- **Enrollment:** the client derives a 32-byte enrollment secret from the vault key (#335). At creation it sends only the secret's verifier, `enrollmentVerifier(secret)`: SHA-256 over the label `devot-relay enrollment verifier v1` and the secret. A device enrolls by presenting the secret; the relay compares its verifier and never stores the secret. `label` is the client's name for the device, opaque to the relay (at most 256 characters; a client may encrypt it).
- `enrolled` carries the vault's `epoch`, the new `device` ID, its `token` and the relay's `time`. The relay keeps only the token's SHA-256.
- **Tokens:** `<device>.<random>.<mac>`, where the MAC is an HMAC-SHA-256 over the vault ID and the rest, keyed from `RELAY_SECRET`. The front (the Worker, or the Node server's HTTP layer) checks the MAC before anything reaches the vault's storage; the vault then checks the token's hash, so a revoked token fails there.
- **Socket:** the client offers two subprotocols, `devot-relay.1` and `devot-token.<token>` (a web view's WebSocket cannot set headers). A missing or forged token is refused over HTTP (401); a token the vault does not know, or a vault that does not exist, gets an `error` message and the close code 4001 (`E_SYNC_UNAUTHORIZED`) or 4004 (`E_SYNC_NO_VAULT`). 4004 means the relay has no such vault, for example after it lost its data: the client drops its token and Settings > Sync asks for the relay secret to create the vault again, which gives it a new epoch, and the client uploads again (ADR 0002, risk 8).

**Pairing** (docs/adr/0008-sync-device-pairing.md). The devices derive the pairing ID (22 characters of base64url) and a key from the pairing code; the relay never sees the code or the key. `offer` and `proof` are base64url of what the devices sealed under that key.

| Request                                                                   | Body                     | Answer                                             |
| ------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------- |
| `POST /v1/pairings/<pairing>` with `Authorization: Bearer <device token>` | `pair`: `vault`, `offer` | `pairing`: `state` `open`, `expires`, `time`       |
| `POST /v1/pairings/<pairing>/take`                                        | `take`                   | `offer`: `offer`, once                             |
| `POST /v1/pairings/<pairing>/confirm`                                     | `confirm`: `proof`       | `confirmed`, once, after a take                    |
| `POST /v1/pairings/<pairing>/status` with `Authorization: Bearer <token>` | `status`: `vault`        | `pairing`: `state`, `expires`, `time`, and `proof` |
| `POST /v1/pairings/<pairing>/close` with `Authorization: Bearer <token>`  | `close`: `vault`         | `closed`                                           |

- `pair`, `status` and `close` need the token of a device of `vault`, checked as a socket's is: the MAC at the front, then the token's hash in the vault (a removed device gets 401). `status` and `close` find only a pairing of that vault.
- A pairing's offer can be taken for 10 minutes (`PAIRING.ttlMs`) and once: `take` deletes it. `state` goes `open`, `taken`, `confirmed`; `proof` comes with `confirmed`. A take after the expiry, a second take or confirmation, and a pairing that is unknown or closed all get `E_SYNC_PAIRING_GONE` (404), so nobody learns which pairings exist. A pairing ID opened twice gets `E_SYNC_PAIRING_EXISTS` (409).
- **Kept:** the pairing ID, the vault ID, the opening device, the state, the offer until it is taken and the proof, for at most 1 minute past the expiry. On Cloudflare each pairing is a `PairingObject` whose alarm then deletes it; on Node they live in memory and every request sweeps the expired ones.
- An offer is at most 512 bytes and a proof 256.

**Frames.** A message without bytes is a JSON text frame. A message with chunks is one binary frame: a 4-byte big-endian length of the JSON header, the header, then the chunks back to back; the header's `chunks` lists each chunk's length. Raw bytes keep a push one message (one billed request) and avoid base64's third more.

**Messages.** Any client message may carry `rid`, a number the answer repeats.

| Client                                                  | Relay answers                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pull`: `since`                                         | `records`: `records` (`id`, `version`, `seq`, `kind`, `chunks`), `next`, `more`, with the chunks |
| `push`: `id`, `base`, `kind`, `chunks`, with the chunks | `pushed`: `id`, `version`, `seq`; or `rejected`: `id`, `version` (the current one)               |
| `devices`                                               | `devices`: `id`, `label`, `created`, `current` each                                              |
| `revoke`: `device`                                      | `revoked`: `device`; that device's sockets get `E_SYNC_REVOKED` and close with 4003              |
| `time`                                                  | `time`: the relay's time in milliseconds                                                         |
| `usage`                                                 | `usage`: the counters below                                                                      |

- On connecting, the relay sends `welcome`: its `time` (for the client's 5-minute clock check), the vault `epoch`, the current `seq`, the `device` and `quota` (`on` or `off`, whether it enforces the quota cap; a relay older than the cap leaves it out) and `attachments` (`on` or `off`, whether it holds file records within their share; a relay older than that leaves it out).
- **Push** is one SQLite transaction with compare-and-swap: when `base` is the stored version (0 for a new record), the relay replaces the record's chunks, sets the version to `base + 1`, gives it the next vault-wide `seq` and sends `changed`: `seq` to the vault's other connections. Otherwise it rejects with the current version and changes nothing. `kind` is `record` or `file` (an attachment, whose bytes count apart; docs/adr/0003-sync-attachments-as-records.md).
- **Pull** returns the records with `seq` greater than `since`, in `seq` order, in pages of at most 100 records and 16 MiB of chunks (a larger record comes alone). `next` is the `since` of the next pull; `more` says whether there is one.
- **Limits:** a chunk is at most 1,900,000 bytes, a push at most 16 chunks, a file record at most 11 MiB (one message stays under the Workers 32 MiB WebSocket limit), a message at most 31 MiB (`E_SYNC_TOO_LARGE`), an HTTP body at most 4 KiB. Each device may send 60 messages at once and 10 a second after that; past it the relay answers `E_SYNC_RATE` with `retryAfter` in milliseconds and does nothing else. Every message counts against the rate, malformed and oversized ones included. A vault holds at most 100 devices.
- **Errors** are `error`: `code` (`E_SYNC_BAD_MESSAGE`, `E_SYNC_PROTOCOL`, `E_SYNC_TOO_LARGE`, `E_SYNC_RATE`, `E_SYNC_QUOTA` with `limit` and `until`, `E_SYNC_ATTACHMENTS_FULL`, `E_SYNC_NO_DEVICE`, `E_SYNC_INTERNAL`); a socket stays open after one. A message from a revoked device, on a socket the host has not finished closing, gets `E_SYNC_REVOKED` again and nothing else. HTTP errors are the same envelope with a status.

**Counters.** One row per vault counts, for the current UTC day, the rows written (as the host's SQLite reports them, the counters row's own write included), the incoming messages and the requests (connections, creations and enrollments; refused messages and requests are added with the next write rather than with a write of their own), and in total the stored bytes of all records and of file records (`fileBytes`, which the attachment share above uses). A day's counts start from 0 with the first write after 00:00 UTC. `usage` answers with them and with `caps`, the quota cap's values (null when it is off). The quota cap above uses them.

## Tests

`tests/relay/suite.ts` is one suite that drives a relay over HTTP and WebSockets as a client would, pairing included; `tests/relay/vault.test.ts` and `pairing.test.ts` run the logic alone with a clock they move. The app's own client is tested against the Node relay in Rust (`src-tauri/src/sync/relay_tests.rs`, `pairing_relay_tests.rs`), some of it through a proxy that plays a relay which swaps, replays or forges messages. `tests/relay/node.test.ts` runs it against the Node host and `tests/relay/worker.test.ts` against the Worker and its Durable Object in workerd through Miniflare, built from the same entry and settings as `relay/wrangler.toml`. Nothing is deployed and no Cloudflare account is used. Both run in `pnpm test`.
