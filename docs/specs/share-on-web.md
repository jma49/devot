# Share on Web

Part of the [architecture overview](../architecture.md).
The decision is ADR 0019 (`docs/adr/0019-share-on-web-as-an-encrypted-page-without-accounts.md`).

## The sealed page

- **Plaintext:** UTF-8 JSON `{ "v": 1, "title": <note title>, "html": <the page> }`, where the page is the note's HTML export (`htmlDocument` in `src/core/htmlExport.ts`) with its attachments inlined as `data:` URIs.
- **Envelope:** the 4 ASCII bytes `DVS1`, a 12-byte random nonce, then the AES-256-GCM ciphertext and its 16-byte tag, with the 4 bytes `DVS1` as associated data.
- **Key:** 32 random bytes for each share, written in the link's fragment as unpadded base64url (43 characters).
  An update seals the new page under the same key with a new nonce, so the link stays the same.
- **Vectors:** `tests/fixtures/share-vectors.json` holds keys, nonces, plaintexts and the bytes they seal to; the viewer's `openEnvelope` and the app's sealing both run them.

## The Worker (`share/`)

- `POST /v1/shares`: the body is the envelope (`application/octet-stream`, 10 MiB at most), `Devot-Lifetime` is `1`, `7` or `30` (days).
  It answers 201 with `{ "id", "token", "expiresAt" }`: a 128-bit ID and a 256-bit token, both base64url; KV keeps the envelope under the ID with the token's SHA-256 and the expiry as metadata and the lifetime as its time to live.
- `PUT /v1/shares/<id>` with `Authorization: Bearer <token>` replaces the envelope and keeps the expiry (204); `DELETE /v1/shares/<id>` deletes it (204).
  A wrong token and an unknown ID both answer 404, so a token cannot be tried against IDs.
- `GET /v1/shares/<id>`: the envelope, `no-store`, or 404.
- `GET /s/<id>`: the viewer page; it answers the same for every well-formed ID, so it tells nobody whether a page exists.
- **Errors** are JSON `{ "error": <code> }`: `E_SHARE_TOO_LARGE` (413), `E_SHARE_LIFETIME_INVALID` and `E_SHARE_BODY_INVALID` (400), `E_SHARE_NOT_FOUND` (404), `E_SHARE_RATE_LIMITED` (429).
  Logs carry codes and IDs, never a token or bytes of a page.
- **Limits:** `CREATE_PER_ADDRESS` (5 a minute for each address) on creates, `WRITES_ALL` (60 a minute for each location) on every create, update and delete.
- **Headers:** every answer has `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; the viewer has its own Content-Security-Policy (below).

## The viewer

- `share/src/app.ts` routes the requests (`worker.ts` is the entry), and `share/src/viewer.ts` builds the page, its stylesheet and its script; the script carries `openEnvelope` as written in TypeScript, so the function the tests run is the one the browser runs.
- It reads the key from `location.hash`, fetches `/v1/shares/<id>`, opens the envelope with Web Crypto and puts the page in an `<iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox">` through `srcdoc`, with a `<base target="_blank">` so links open in a new tab.
  The frame runs no script: the sandbox gives it none and it inherits the viewer's policy.
  `allow-same-origin` lets the viewer size the frame to the page.
- **Policy:** `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
  Inline styles are allowed for the exported page's own `<style>`; no script can run to use them.
- **States:** opening, the page, a link without a key (`missingKey`), a page that is gone (`gone`: expired, deleted or never made), and one that cannot be opened (`broken`: a wrong key or damaged bytes).
  Text is English and lives in `share/src/messages.ts`.
- The page title becomes the document's title; the viewer adds `noindex`.

## In the app

The note menu's Share on Web… opens a sheet for one note that is not a template (`ShareWebSheet.tsx`).
Before a note is shared, the sheet warns that anyone with the link can read the note, offers a lifetime of a day, a week or a month, and Share.
A shared note shows its link, read-only, when it expires, and Copy Link, Update Page and Stop Sharing.
The sheet's phases are one union (`shareWeb.ts`), and each answer from Rust is matched to the request that asked for it.
The window renders the page as it does for Export as HTML, and Rust puts in the images (`export::page_with_images`).
Rust seals and uploads the page (`web_share/seal.rs`, `web_share/client.rs`, through `net.rs`) and keeps each share's ID, token and key in the Keychain under `web-share-<note ID>`; the window sees only the link and when it expires.
Update Page seals the note again under the same key, so the link stays the same; if the Worker no longer has the page, the note is shared anew.
A share that has expired is forgotten when it is next read.
The commands `web_share_status`, `web_share_publish` and `web_share_stop` are declared in `build_commands.rs`, granted in `capabilities/main.json`, and check their arguments; one share command runs at a time (`E_SHARE_BUSY`).

## Deploying

- The KV namespace `devot-share-SHARES` and the custom domain `share.devot.online` are set in `share/wrangler.toml`; the app's default share host is that name.
- Deploy from `share/` with `pnpm deploy`, which needs `wrangler login` on the devot.online account.
