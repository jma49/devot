# Sync relay

The relay stores the latest encrypted state of every record of a vault and tells a vault's devices when something changed (docs/adr/0002-sync-latest-state-per-record.md). It never decrypts and never merges. Devot runs no hosted relay: each owner deploys their own (docs/adr/0004-sync-without-accounts.md), on Cloudflare's Workers Free plan or with Node on a server of their own. A hosted relay for people who would rather not run one may come later as a separate, billed storage service, not part of the license (docs/adr/0011-optional-hosted-sync-is-a-service-not-a-license-feature.md); none exists today. The code is in `relay/`; the wire format, which the app shares, is `src/core/sync/protocol.ts`.

## Deploy to your own Cloudflare account

You need a Cloudflare account on the Workers Free plan. Keep it free of a payment method: on the Free plan an exceeded limit makes a request fail and is never billed. The relay uses only a Worker, a Durable Object class on SQLite storage and two Workers Rate Limiting bindings, no R2, KV, D1 or Queues.

1. From a checkout of this repository, install the relay's dependencies: `pnpm install --filter @devot/relay`.
2. In `relay/`, sign in: `pnpm exec wrangler login`.
3. Deploy: `pnpm exec wrangler deploy`. It prints the relay's URL, `https://devot-relay.<your subdomain>.workers.dev`. `relay/wrangler.toml` is the template; you may rename the Worker (`name`), but keep the `VAULTS` and `PAIRINGS` bindings, the `VaultObject` and `PairingObject` classes and their `v1` and `v2` migrations, and the `ANONYMOUS_PER_ADDRESS` and `ANONYMOUS_ALL` rate limits (change their `namespace_id` only if another Worker in your account uses the same number).
4. Give the relay its secret: `openssl rand -base64 32 | pnpm exec wrangler secret put RELAY_SECRET`. Until it has one, the relay answers every request with `E_RELAY_CONFIG`. Keep the secret in your password manager: Devot asks for it once, on the device that creates the vault.
5. Check it: `curl https://devot-relay.<your subdomain>.workers.dev/v1` answers `{"v":1,"type":"relay","protocol":1,"time":…}`.

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

A server of your own has none of the Workers Free limits, but the cap stays on by default: it is one of the cost guards every host keeps (`docs/specs/sync-and-encryption.md`), and it keeps a misbehaving device from filling the disk. Set `RELAY_QUOTA=off` to run without it.

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
- **An older app (1.0.5-beta2) with a newer relay** syncs as before. It does not send or read images: it skips the file records it pulls (they stay on the relay for the devices that read them), and the relay never sends it `E_SYNC_ATTACHMENTS_FULL`. Once updated, the app pulls again from the start, so the images it skipped arrive.
- **A newer app with a relay from before key rotation** (its `welcome` does not say `rotation`) cannot change the vault key: Devot refuses before it makes anything (`E_SYNC_RELAY_OUTDATED`) and the vault syncs on. Update the relay to change the key; the `retirement` table is made by the first retire, so nothing migrates.
- **A relay from before clearing** wipes the vaults it retired earlier once updated: on Cloudflare at their next connection, under Node at its start.
  The `standing` table is made on first need, so nothing migrates.
- **An older app with a retired vault** gets `E_SYNC_VAULT_ROTATED` to every push and pull, which it does not know: it reports a relay failure and tries again later, writing nothing. Its notes stay; once updated it asks to join the new vault.
- **An older app (1.0.5-beta2) with a newer relay** also reads `E_SYNC_QUOTA` as a pause and tries again every hour, without the reset time.

## Quota

The relay keeps every vault inside 80% of each Workers Free limit it can count (docs/adr/0002-sync-latest-state-per-record.md, Staying inside the Workers Free plan). On the Free plan an exceeded limit makes requests fail rather than cost money; the cap keeps that from happening and tells the devices when they can go on. The limits are in `relay/src/quota.ts`. Read them again before each release.

| Workers Free limit      | Limit                                                                     | Cap (80%)           | Counted as                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Rows written (SQLite)   | 100,000 a day, deletes included                                           | 80,000 a day        | `rowsWritten`, as the host's SQLite reports them                                                                           |
| Durable Object requests | 100,000 a day; a connection or call is 1, 20 incoming messages count as 1 | 80,000 a day        | `requests` + `messages` / 20                                                                                               |
| Workers requests        | 100,000 a day                                                             | within the above    | each HTTP call and socket connection is in `requests`, so the cap above covers it while the vault stays loaded (see Pulls) |
| Stored data (SQLite)    | 5 GB in total                                                             | 4,000,000,000 bytes | `storedBytes`, the records' sealed bytes                                                                                   |
| Attachments (share)     | part of the stored data                                                   | 3,000,000,000 bytes | `fileBytes`, the sealed bytes of file records; see Attachments                                                             |
| Rows read (SQLite)      | 5,000,000 a day                                                           | not counted         | see Pulls                                                                                                                  |
| Duration                | 13,000 GB-s a day                                                         | not counted         | the Hibernation API bills only while a message is handled                                                                  |

- **Pushes:** before it writes, a push checks the counters. When today's rows written or requests are at their cap, or the push would take the stored bytes past theirs, the relay refuses it and writes nothing: `error` with `code: "E_SYNC_QUOTA"`, `limit` (`rowsWritten`, `requests` or `storedBytes`) and `until`, the next 00:00 UTC in milliseconds, when the daily counts reset. A push that does not add stored bytes (a smaller record, a purge) passes the storage cap; the reset does not free storage, so past that cap the app tries again each day until records shrink or are purged. The refused message is counted with the next write, like other refused messages.
- **Pulls** stay allowed, and so do `devices`, `revoke`, `time`, `usage`, connections and enrollment. A pull is one incoming message (1/20 of a request), writes no row of its own (it is counted with the next write) and reads the records it returns and their chunks, about 3 rows a record; it adds no stored bytes. While pushes are refused, nothing new reaches the relay, so an up-to-date device has nothing to pull, and a paused app closes its socket until the reset. The 20% above the cap, 20,000 rows and 20,000 requests a day, lets a device that is still downloading the vault finish: each pull brings up to 100 records. Reads and connections never write a row on their own, so a client that loops on them cannot run the account past the rows-written limit. They do count as requests, but only in memory until the next write: a vault that sees nothing else is evicted and forgets them, so a loop of connections can still use up the daily requests without the cap noticing. Revoking the device stops it. Rows read are not counted: a full download of a 100,000-record vault reads about 300,000 rows, 6% of the daily limit.
- **The first upload of a large vault** costs at least 3 rows written a record (the record row, a chunk row and the counters row), so about 26,000 records a day fit under the cap. A larger vault goes on over several days: the app shows how many records it has sent of the total, keeps its place across restarts and goes on after each reset.
- **What the app does:** it stops pushing, closes the socket and shows "Sync paused until <the reset in local time>" in its notice and in Settings > Sync; notes keep working on the device. A refusal for stored bytes does not stop the pass: the app still sends the records that fit (smaller ones, purges) and pauses after it. It connects again after the reset, at a random moment in the next minute, and pushes what waited. It never connects in between; it checks the time at least hourly, so a timer that fell behind while the computer slept still ends the pause.
- **Per vault:** the counters are per vault, and the Workers Free limits are per account. One vault per account, as the deploy steps above set up, keeps the two the same.
- **Stored bytes** count the records' sealed bytes, not SQLite's own overhead (row headers, index pages); the 20% left covers it.

### Storage in the app

Settings > Sync, on the Mac and on the iPhone, shows what the relay holds: notes and other records (the stored bytes less the file bytes), images (`fileBytes`), the total (`storedBytes`) and the room left. The figures and the limits come from the relay's own `usage` answer, never from a table in the app, so they are right for any host:

- `caps` with `storedBytes` (and `fileBytes`, the share for images): the app shows "N of the cap" and the room left. Images can use the smaller of their own share's room and the total's. A relay without a share for images (before attachments) shows images without a limit.
- `caps: null` (`RELAY_QUOTA=off`): the app shows the figures and says the relay runs without a storage cap, so only its own disk limits it. It warns about nothing.
- No `caps` (a relay from before the cap): the app shows the figures and says the relay does not say what it may hold.
- An error `E_SYNC_BAD_MESSAGE` (a relay from before `usage`) shows "update your relay"; an unreachable relay shows that the relay cannot be reached, with Try Again.

Only stored bytes and the images' share are shown: the daily limits (rows written, requests) are not, because they reset at 00:00 UTC and the pause notice already covers them (see Quota, What the app does).

**Warnings.** After sync settles, the main window reads `usage` (at most every 15 minutes, and again when the status changes) and puts a notice up when a cap's band goes up from the one last told: at 80% of the stored bytes or of the images' share, and at the cap. It does not repeat while the band stays, including across launches (the last band told is kept per relay in the window's storage); a drop is remembered without a word and the band is told again if it returns. A relay with no cap, or that does not say, never gets one. The words at the cap say what is not syncing (new and changed notes and images, or only images), what still works (everything on this device, notes from other devices, and notes when only images are full) and what to do: remove images or notes you no longer need, or use a larger server. A push refused with `E_SYNC_QUOTA` for `storedBytes` or `E_SYNC_ATTACHMENTS_FULL` keeps its own notice and note in Settings, which say the same.

## Attachments

Images sync as file records (`kind: "file"`) on the same relay, one record per image, cut into chunks like any record: an image of at most 10 MiB is a record of at most 11 MiB sealed, so 6 chunks (`E_SYNC_TOO_LARGE` past that). Every device downloads every file record (docs/adr/0003-sync-attachments-as-records.md).

- **The share:** file records may take 3,000,000,000 bytes (`FILE_SHARE_BYTES` in `relay/src/quota.ts`) of the stored bytes, so notes, notebooks and tags always keep about 1 GB under the cap above. A push that would take them past it is refused with `error`, `code: "E_SYNC_ATTACHMENTS_FULL"`, and nothing is written; pushes of notes, notebooks and tags, and every pull, go on. The app keeps the image on the device that added it, counts it in Settings > Sync ("N images are not synced") and sends it again after a purge frees room or on the next launch. A relay that runs with `RELAY_QUOTA=off` has no share.
- **Order of the checks:** the daily limits come first (they pause every push: `E_SYNC_QUOTA`), then the share (`E_SYNC_ATTACHMENTS_FULL`, files only), then the total stored bytes (`E_SYNC_QUOTA` with `limit: "storedBytes"`).
- **A purge frees the space:** the app replaces the file record with a tombstone (`purged`, no bytes, kept forever); the push replaces its chunks, so `storedBytes` and `fileBytes` fall by the image's size. A file record of at most 1 KiB (a tombstone) is never refused for the share, so a full share can always be emptied. Other devices pull the tombstone and remove the image.
- **`welcome`** says `attachments` (`on` or `off`) when the relay holds file records within the share. An app that does not see it sends no image (see Update the relay).

## Connect Devot

In Devot, open Settings > Sync. A device that is not in a vault first asks one question: is this your first device, or are you adding another one? Only the answer's steps show, so a second vault cannot be made by mistake. On the first device, enter the relay's URL (https, or http to the same machine for a relay you run locally), then the relay's secret once: Devot makes the vault key in the keychain, creates the vault on the relay and turns sync on. Nothing in Welcome or the first launch asks about sync. The secret goes into that one request and is not kept. Devot then shows the recovery key until you press I Saved It: keep it in your password manager or print it. On every other device, join instead (below): Set Up a New Vault is for the first device only.

To add another device, choose Show Pairing Code under Add a Device on a device that syncs. On the new device, answer that you are adding another device, then scan the QR code, or paste the link it holds (it carries the relay's address, which Devot asks you to confirm), or type the code under Join With a Code with the relay's URL set. The code alone does not name the relay: its format is fixed (docs/adr/0008-sync-device-pairing.md), so Copy Link beside the code on a Mac copies the link, which does. iPhone has no secret clipboard yet and leaves the button out. The code works once, for 10 minutes. A device can also join with the recovery key and the relay's URL, under Join With Recovery Key, when no other device is at hand. Devices lists the vault's devices; Remove takes one's token away (`revoke`). A removed device still holds the vault key, so whoever has it can enroll it again on purpose; Devot never does so on its own. Until Devot can change a vault's key, treat a lost device that held it as able to read the vault.
Leave This Vault forgets the vault key and the token on the device it is chosen on, and keeps its notes there; nothing changes on the relay or the other devices, and the device can join a vault again with a pairing code or a recovery key.

## Protocol

Version 1. Every message is an envelope `{"v": 1, "type": …}`; a relay refuses another version with `E_SYNC_PROTOCOL`.

**HTTP**

| Request                                                                      | Body                          | Answer                                             |
| ---------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| `GET /v1`                                                                    |                               | `relay`: the protocol version and the relay's time |
| `POST /v1/vaults/<vault>` with `Authorization: Bearer <RELAY_SECRET>`        | `create`: `verifier`, `label` | `enrolled`, for the creating device                |
| `POST /v1/vaults/<vault>/devices`                                            | `enroll`: `secret`, `label`   | `enrolled`                                         |
| `POST /v1/vaults/<vault>/retire` with `Authorization: Bearer <RELAY_SECRET>` | `retire`: `successor`         | `retired`: `successor` (see Retire below)          |
| `GET /v1/vaults/<vault>/socket` (WebSocket)                                  |                               | `welcome`, then messages                           |

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

- `pair`, `status` and `close` need the token of a device of `vault`, checked as a socket's is: the MAC at the front, then the token's hash in the vault (a removed device gets 401). `status` and `close` find only a pairing that device opened; to any other device, of that vault or another, it is gone.
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

- On connecting, the relay sends `welcome`: its `time` (for the client's 5-minute clock check), the vault `epoch`, the current `seq`, the `device` and `quota` (`on` or `off`, whether it enforces the quota cap; a relay older than the cap leaves it out) and `attachments` (`on` or `off`, whether it holds file records within their share; a relay older than that leaves it out), `rotation: 'on'` on a relay that can retire a vault, and `retired`: the successor's ID once the vault is retired.
- **Retire** (docs/adr/0017-sync-key-rotation.md) ends a vault whose key was changed. It is an HTTP route with the relay secret (above), never a socket message, so no device token retires a vault. `successor` is the new vault's ID, other than this vault's, and must be a vault the relay holds that is not retired itself (409, `E_SYNC_NO_SUCCESSOR`). The vault's connections get `changed`. The first retire is kept in a `retirement` table of its own; a retire naming the same successor answers `retired` again, and one naming another gets `E_SYNC_VAULT_ROTATED` with the kept `successor`. From then on the vault answers `push`, `pull` and enrolling (409) with `E_SYNC_VAULT_ROTATED` and `successor`; tokens still open a socket, and `devices` and `revoke` still work. The relay then wipes the vault's records (Clearing the relay below).
- **Push** is one SQLite transaction with compare-and-swap: when `base` is the stored version (0 for a new record), the relay replaces the record's chunks, sets the version to `base + 1`, gives it the next vault-wide `seq` and sends `changed`: `seq` to the vault's other connections. Otherwise it rejects with the current version and changes nothing. `kind` is `record` or `file` (an attachment, whose bytes count apart; docs/adr/0003-sync-attachments-as-records.md).
- **A record's `id`** is opaque to the relay: Devot sends each record's store name, derived from its ID with a key only the vault's devices hold (docs/adr/0016-store-names-hide-record-ids.md), so the relay never sees record IDs or when records were made.
- **Pull** returns the records with `seq` greater than `since`, in `seq` order, in pages of at most 100 records and 16 MiB of chunks (a larger record comes alone). `next` is the `since` of the next pull; `more` says whether there is one.
- **Limits:** a chunk is at most 1,900,000 bytes, a push at most 16 chunks, a file record at most 11 MiB (one message stays under the Workers 32 MiB WebSocket limit), a message at most 31 MiB (`E_SYNC_TOO_LARGE`), an HTTP body at most 4 KiB. Each device may send 60 messages at once and 10 a second after that; past it the relay answers `E_SYNC_RATE` with `retryAfter` in milliseconds and does nothing else. Every message counts against the rate, malformed and oversized ones included. A vault holds at most 100 devices. On Cloudflare, the routes that need no token (`take`, `confirm`, enrolling and retiring) are refused before any Durable Object is reached (429, `E_SYNC_RATE` with `retryAfter`) past three limits: 30 requests at once from one address and one every 10 seconds after that, counted in each Worker instance's memory; then 5 a minute from one address and 20 a minute from all addresses together, counted by Cloudflare's Rate Limiting for every instance in a Cloudflare location (`relay/wrangler.toml`, `retryAfter` 60 seconds); a `take`, `confirm`, `status` or `close` for a pairing whose object never held one writes nothing to it. The limit on all addresses is what protects a relay reachable only at its `workers.dev` address, where no zone rule applies: a loop spread over many addresses can then cost the Durable Object allowance at most 20 requests a minute in each location it reaches, and while it runs pairing and enrolling wait, but devices that are already enrolled keep syncing. Every request still counts against the Workers Free plan's daily requests, which no limit inside the Worker can prevent. A relay deployed from a `wrangler.toml` without the rate limits keeps only the in-memory limit.
- **Errors** are `error`: `code` (`E_SYNC_BAD_MESSAGE`, `E_SYNC_PROTOCOL`, `E_SYNC_TOO_LARGE`, `E_SYNC_RATE`, `E_SYNC_QUOTA` with `limit` and `until`, `E_SYNC_ATTACHMENTS_FULL`, `E_SYNC_NO_DEVICE`, `E_SYNC_VAULT_ROTATED` with `successor`, `E_SYNC_INTERNAL`); a socket stays open after one. A message from a revoked device, on a socket the host has not finished closing, gets `E_SYNC_REVOKED` again and nothing else. HTTP errors are the same envelope with a status.

**Counters.** One row per vault counts, for the current UTC day, the rows written (as the host's SQLite reports them, the counters row's own write included), the incoming messages and the requests (connections, creations and enrollments; refused messages, reads (`pull`, `devices`, `time`, `usage`, a `revoke` of an unknown device) and connections are added with the next write rather than with a write of their own; they are lost if the Durable Object is evicted first), and in total the stored bytes of all records and of file records (`fileBytes`, which the attachment share above uses). A day's counts start from 0 with the first write after 00:00 UTC. `usage` answers with them and with `caps`, the quota cap's values (null when it is off). The quota cap above uses them.

### Clearing the relay

The relay clears two kinds of vault on its own (docs/adr/0017-sync-key-rotation.md, Clearing the relay); no app sends anything for it.

- **A retired vault is wiped**: right after the retire, its records and their chunks are deleted, the oldest first, in slices of at most 1,000 rows, within a quarter of the daily rows cap (`WIPE_SHARE` in `relay/src/vault.ts`); what does not fit waits for 00:00 UTC.
  The rows it deletes, a request per slice and the bytes it frees go into the counters.
  The vault row, the devices, the `retirement` row and the counters stay, so old tokens still learn the successor and the old key still enrolls nowhere.
- **An abandoned vault is dropped**: one with no record, at most one device, no retirement and never named a successor, that no device connected to for 90 days (`ORPHAN_AGE_MS`).
  That is what a successor left by a lost rotation race, or whose token was lost, looks like.
  A socket still open at the sweep counts as a connection, and so does a retire's check that the vault may be its successor, so neither a device on an empty library nor a retire under way loses it.
  All its storage goes, and a later connection gets `E_SYNC_NO_VAULT` (4004).
  The relay keeps the last connection, at most once a day and only for such a vault, in a `standing` table, which also holds the vault a retire named it the successor of.
- **On Cloudflare** the vault's Durable Object alarm sweeps it; **under Node** the relay sweeps every vault file at start and every hour, and a retired vault at once.

## Tests

`tests/relay/suite.ts` is one suite that drives a relay over HTTP and WebSockets as a client would, pairing included; `tests/relay/vault.test.ts` and `pairing.test.ts` run the logic alone with a clock they move. The app's own client is tested against the Node relay in Rust (`src-tauri/src/sync/relay_tests.rs`, `pairing_relay_tests.rs`), some of it through a proxy that plays a relay which swaps, replays or forges messages. `tests/relay/node.test.ts` runs it against the Node host and `tests/relay/worker.test.ts` against the Worker and its Durable Object in workerd through Miniflare, built from the same entry and settings as `relay/wrangler.toml`. Nothing is deployed and no Cloudflare account is used. Both run in `pnpm test`.
