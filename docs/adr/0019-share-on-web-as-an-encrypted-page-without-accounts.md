# Share on Web is an encrypted page on a Devot Worker, without an account

Status: accepted. Amends ADR 0004 for web sharing (#11).

A note is shared as one sealed page: the app renders the note as its HTML export does, with its images inside, seals the page with AES-256-GCM under a key made for that share, and uploads only the sealed bytes to a share Worker that Devot runs.
The link is `https://share.devot.online/s/<id>#<key>`.
The key lives only in the link's fragment, which browsers never send to a server, so the Worker stores and serves bytes it cannot read.
Whoever holds the link can read the note; nobody else can, Devot included.
Creating a share hands the app a random token; the Worker keeps only its SHA-256 and lets only that token update or delete the page.
Every page expires after 1, 7 or 30 days, the owner's choice; nothing lives longer.

## Why

- ADR 0004 left web sharing until a hosted service was decided, because hosting what users publish brings abuse and takedown work.
  A page that only the link's holder can read is not published to the web: search engines cannot index it, the Worker cannot read it and so cannot serve it to anyone the owner did not send the link to.
  Abuse is bounded by size, rate and expiry, not by moderation.
- No account: the token is the owner's identity for one page, as pairing is sync's identity (ADR 0004).
  Losing the device loses the token, and the page still ends at its expiry.
- Sealing in the app, not in the Worker, keeps the promise sync makes: no Devot server ever holds a note in the clear.
- The page is the HTML export (`src/core/htmlExport.ts`, images inlined by Rust), so it shows what the preview shows, sanitized and without scripts, and needs no renderer on the web.

## What the Worker does

- `POST /v1/shares` stores sealed bytes (at most 10 MiB) for the chosen lifetime and answers the page's ID, the token and the expiry.
- `PUT /v1/shares/<id>` and `DELETE /v1/shares/<id>` replace or delete it, with the token as a bearer credential; the lifetime is kept on an update.
- `GET /v1/shares/<id>` serves the sealed bytes; `GET /s/<id>` serves the viewer, which reads the key from the fragment, fetches the bytes, opens them in the browser (Web Crypto) and shows the page in a sandboxed frame that runs no script.
- Storage is Workers KV with a time to live, so an expired page is gone without a sweep.

## Cost guards

- A page is at most 10 MiB sealed; a request with more is refused before it is read whole.
- Writes are rate-limited per address and across the Worker (Cloudflare's rate limiting binding, counted per location before KV is touched).
- Every value has a time to live of at most 30 days, so storage is bounded by what was written in the last month.
- Reads are cached nowhere: the bytes are `no-store`, so a deleted page is gone at once.

## Rejected

- **An account and public pages** (the first plan of #11): needs sign-in, deletion, moderation and takedowns, and the server would hold notes in the clear.
- **Sealing in the Worker or a server-held key:** the Worker could read every page.
- **The owner's own relay as the host:** most owners use iCloud and run no relay, and a relay holds a vault's records, not public pages.
- **A key derived from the token:** one secret would both read and delete; sending the link to a reader would let them take the page down.

## Consequences

- `docs/architecture.md`, Product: Share on Web no longer waits for accounts; Devot runs a share Worker beside the licence Worker, and neither ever sees a note in the clear.
- The Worker is `share/`, tested in workerd through Miniflare like the relay and the licence Worker, and deployed by the owner of devot.online.
- The page format is fixed by test vectors (`tests/fixtures/share-vectors.json`) that the viewer and the app's sealing both run.
- The app keeps each share's ID, token and key on the device that made it (the Keychain), so Copy Link, Update Page and Stop Sharing work there; another device sees no share.
- Spec: [Share on Web](../specs/share-on-web.md).
