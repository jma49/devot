# Local HTTP API

Part of the [architecture overview](../architecture.md).

Other tools (launchers, scripts, editor integrations) can read and write notes while Devot runs, through a local HTTP API (`src-tauri/src/http_api/`, desktop only).
Settings > Integrations > Local HTTP API turns it on (off by default), sets its port and shows its token.
The MCP bridge reaches the same routes and guards on a Unix socket of its own, with a token of its own (see AI, ADR 0012): this port opens only while the HTTP API's switch is on, and the bridge's token is refused on it.
Every request passes these guards before anything reaches the notes:

- **Where it listens:** `127.0.0.1` only, on the port in Settings (27484 by default; 1024 to 65535), never on another interface.
  The settings are `<app data>/http-api.json` (`enabled`, `port`, `scope`): on this device only, never synced, never in backups.
  A port another program holds leaves it on but not listening, and Settings says why (`E_HTTP_API_PORT_IN_USE`); the next change, or the next launch, tries again.
  It starts at launch when on (off the launch's thread, since it reads the keychain) and stops when turned off; a request already being answered finishes.
- **Reading a request:** HTTP/1.1 (or 1.0), one request a connection (`Connection: close`), read by hand to small limits: a head of at most 16 KiB and 64 headers (`E_HTTP_HEADERS_TOO_LARGE`, 431), the whole request within 10 s (`E_HTTP_TIMEOUT`, 408), at most 8 connections at once (`E_HTTP_API_BUSY`, 503).
  A header that must be single and comes twice is refused (`E_HTTP_BAD_REQUEST`).
- **DNS rebinding and browsers:** the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (`E_HTTP_HOST_REFUSED`, 403); a request with an `Origin` header, whatever its value (`E_HTTP_ORIGIN_REFUSED`), or a `Sec-Fetch-Site` or `Sec-Fetch-Dest` header (`E_HTTP_BROWSER_REFUSED`) is refused, since only a browser sends them and no page script can set them.
  `Sec-Fetch-Mode` alone is no sign of a browser (Node's `fetch` sends it) and passes.
  No response ever carries a CORS header, so a web page can never read one; every response is `application/json` with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **Token:** every request carries the per-install token as `Authorization: Bearer <token>` (`E_HTTP_TOKEN_MISSING`, `E_HTTP_TOKEN_INVALID`, 401 with `WWW-Authenticate: Bearer`), compared in constant time.
  The token (`dvt_` and 32 random bytes in base64url) is a generic password in the keychain (service the app identifier, account `http-api-token`), never in a file or a log; it is made the first time the API is turned on.
  Settings reads it only when asked to show or copy it (`http_api_token_reveal`, the Settings window only); its status line otherwise says only whether one is stored.
  New Token, or choosing another access, makes a new one: the old one stops working at once, without a restart.
  A build without a keychain cannot turn the API on.
- **Scope:** the token grants read or read and write (`scope`, Read Only by default), chosen when it is made: changing the access in Settings makes a new token.
  A write with a read-only token is refused (`E_HTTP_READ_ONLY`, 403).
- **Rate limit:** 30 requests at once and 10 a second after that, for the token (`E_HTTP_RATE_LIMITED`, 429, with `Retry-After`).
  Refused requests do not use it up, so a page flooding the port cannot lock a tool out.
- **JSON only, size limits, validation in Rust:** a call that takes a body needs `Content-Type: application/json` (`E_HTTP_JSON_REQUIRED`, 415) and a `Content-Length` (no chunked bodies: `E_HTTP_LENGTH_REQUIRED`, 411) of at most 2 MiB (`E_HTTP_BODY_TOO_LARGE`, 413, refused before the body is read); one that takes none is refused with a body (`E_HTTP_BODY_UNEXPECTED`).
  Rust parses the body as an object of exactly the fields the call has (`E_HTTP_BODY_INVALID`) and checks them to the MCP tools' limits (`routes.rs`: Markdown at most 1 MB, `MAX_AI_BODY_BYTES`, else `E_NOTE_BODY_TOO_LARGE`; 1 to 50 patches; at most 50 tags; a query of 1 to 1,000 characters and a limit of 1 to 50, `E_HTTP_QUERY_INVALID`).
  A path that names no note ID answers like an unknown note (`E_NOTE_NOT_FOUND`).
  The core checks everything again to its own limits.
- **Errors and logs:** an error is `{"error": "<code>"}`, never content; the status follows the code (`E_NOTE_NOT_FOUND` and `E_BOOK_NOT_FOUND` 404, `E_BOOK_NAME_TAKEN`, `E_BOOK_AMBIGUOUS` and the patch codes 409, other codes of the core 400, `E_STORAGE_BUSY` 503).
  Each request is logged by its call, status, code and note ID (`I_HTTP_API_REQUEST notes.update 200 <id>`, `W_HTTP_API_REQUEST …`; a note made is logged by its new ID); requests refused before they name a call are logged as `W_HTTP_API_REFUSED <status> <code>`, at most 20 at once and one a second after that, so a flood cannot fill the log.

**Calls** (the contract with the core is `tests/support/http-api-calls.json`, which both the Rust router and the core's handler are tested against):

| Request                                                                               | Call                                    | Answer                                                                          |
| ------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /v1/notebooks`                                                                   | `notebooks.list`                        | `{ notebooks: [{ id, name, notes }] }`, in the sidebar's order                  |
| `POST /v1/notebooks` `{ name, parent? }`                                              | `notebooks.create` (write)              | 201 `{ id, name }`                                                              |
| `GET /v1/tags`                                                                        | `tags.list`                             | `{ tags: [{ name, notes }] }`                                                   |
| `GET /v1/notes?q=<query>&limit=<1-50>`                                                | `notes.search` (the app's query syntax) | `{ results: [{ id, title, notebook, updatedAt, snippet }] }`                    |
| `POST /v1/notes` `{ title, markdown, notebook }`                                      | `notes.create` (write)                  | 201 `{ id, title, notebook }`                                                   |
| `GET /v1/notes/<id>`                                                                  | `notes.read`                            | `{ id, title, notebook, status, pinned, tags, createdAt, updatedAt, markdown }` |
| `PATCH /v1/notes/<id>` `{ title?, markdown? \| patches?, notebook?, tags?, status? }` | `notes.update` (write)                  | the note as `GET` answers it                                                    |
| `POST /v1/notes/<id>/append` `{ text, heading?, position?, separator? }`              | `notes.append` (write)                  | the note as `GET` answers it                                                    |
| `DELETE /v1/notes/<id>`                                                               | `notes.trash` (write; never purges)     | `{ id, title, trashed: true }`                                                  |

Times are ISO strings; a notebook is named by ID or exact name.
These calls are what the MCP tools make (see AI): the bridge reaches the same listener with a token of its own.

- **Through the core:** Rust writes and reads no notes itself.
  A checked call goes to the main window as an event (`devot://http-api`, `{ id, op, note, args }`) and Rust waits up to 15 s for the answer (`http_api_done`, main window only: the JSON, or a code; anything else becomes `E_HTTP_API_FAILED`).
  No answer in time answers `E_HTTP_API_TIMEOUT` (504); a write the window finishes after that still lands.
  Tauri sends an event no window listens for without an error, so a call made while the main window is not listening (still starting, or reloading) also waits the 15 s and times out (`E_HTTP_API_UNAVAILABLE`, 503, is only for an event that could not be sent).
  The window runs calls one at a time (`src/renderer/src/httpApiHost.ts`); its core first saves pending edits, so a call reads and changes what the editor shows, then runs it through the AI service (`src/core/httpApi.ts`, `createAiService` in the worker with its own note service on the window's storage, and the AI queries made of the plain storage calls, `aiStorageOver`).
  So access follows Allow AI Access exactly as for every AI tool (see Access control: a note in a notebook without it answers `E_NOTE_NOT_FOUND`, a notebook `E_BOOK_NOT_FOUND`), bodies go in as Yjs operations of the text difference, metadata by HLC under this install's node, and the body as it was is kept in History first.
  After a write the window takes it in as a change from outside (`devot:db-changed`, see Picking up changes): the notes in memory that the write changed merge the stored copy, the open editor takes it without an undo step (see Merging and history), and the lists reload.
  A `notes.append`, or a `notes.update` without `tags`, changes that one note and nothing else (`notesOnlyWritten` in `src/core/httpApi.ts`), so the window reads only that note's list row again; any other write reloads the lists.
  The Markdown mirror follows the writes like any other.
  A call's steps are not one storage transaction: the window's storage commits each Rust storage call on its own and has no transaction across calls.
  So a failure between two steps (`E_STORAGE_BUSY`, say) can leave part of a call written: `POST /v1/notes` an empty note with its title (a retry makes a second one), `PATCH` the body written and not the tags or the notebook.
  `tests/core/lineage.test.ts` checks that an API write while the editor types merges with another device's edit, each change once.
- **Tests:** `src-tauri/src/http_api/tests.rs` runs each guard over a real socket (no token or a wrong one, a wrong `Host`, any `Origin`, oversize heads and bodies, the rate limit, a read-only token, non-JSON, slow and surplus connections), checks that no response has a CORS header, that the log holds no content or token, and that every request of the contract routes to its call; `tests/core/http-api.test.ts` runs every call of the contract on real SQLite through storage without AI queries, as the app's, and checks what a hidden notebook leaves unseen; `tests/ui/http-api-settings.spec.ts` covers Settings.
