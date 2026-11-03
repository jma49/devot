# MCP runs through a bridge in the app's own binary

AI tools reach Devot through `devot --cli mcp`: a small Rust bridge in the app's binary that serves MCP over stdio and calls the running app's local HTTP API on 127.0.0.1 with a token of its own. The app's core stays the only write path. This replaces the separate Node program `devot-mcp`, which wrote the database itself from a checkout, and rejects bundling a runtime to ship it: that took the installed app from 22 MB to 120 MB.

```
Claude Code, Codex, Claude Desktop
  -> stdio MCP
  -> devot --cli mcp (no database, no notes)
  -> 127.0.0.1 with the bridge's token
  -> the running app's main window core
```

## Consequences

**AI tools need the app running, or able to start.** Notes open to AI only while a Devot runs. When none does, the bridge starts one in the background if the owner allows that (below). `initialize` and `tools/list` never start anything: a client that merely starts its MCP servers does not start Devot. Only a tool call does.

**Writes are not one storage transaction.** A call's steps commit one by one in the window's storage, as the HTTP API's always have (`docs/architecture.md`, Local HTTP API), where the Node program had one transaction. A failure between steps can leave part of a call written. Every write still goes in as Yjs operations with the old text in History.

**The access rule is unchanged.** Notebooks stay closed to AI until the owner allows each one by hand; the bridge sees only what the AI service shows it. An empty list answers with `E_MCP_NO_AI_ACCESS` and a hint that says what to do and nothing about what notebooks exist.

**The licence now covers MCP.** Writes pass the HTTP API's licence check: once the trial is over without a licence, reads work and writes answer `E_LICENCE_REQUIRED`. The Node program was not covered because it was not shipped; the bridge is part of the shipped app, and read-only mode is the same for every way in.

## Decisions

**The token.** The bridge has its own keychain item (the app identifier as service, account `mcp-bridge-token`), separate from the HTTP API's. The same signed binary reads it, so no config file, argument, environment variable or log ever holds it, and Connect writes only a path and `--cli mcp`. Rotating or never making the HTTP API's token cannot break the bridge. The app makes the token when MCP is first turned on. A token replaced meanwhile is read again once.

**Read-only or read and write** is the owner's choice in Settings > Integrations > AI Tools, stored in `<app data>/mcp-access.json` and enforced by the listener (`E_HTTP_READ_ONLY`), so a bridge cannot change it. It applies at once, with no new token. The default is read and write, which is what MCP has always been here, with each notebook closed until it is allowed; Connect's dialog does not ask again.

**The HTTP API's switch stays apart.** Allow AI Tools has its own switch. Connect turns it on and says so first. One listener serves both, and each token gets in only while its own switch is on: with MCP on and the HTTP API off, the port is open, the HTTP API's token is refused, and Settings shows that API as off. Others gain nothing by surprise. Each holder has its own rate limit, so a script cannot lock a tool out.

**Not sending the token to a stranger.** Any local user can bind `127.0.0.1:27484` while Devot is closed, and a client's first request carries its token. So Devot publishes its port and process ID in a file in this user's private folder (`single_instance`), once it holds the port and a main window takes calls, and withdraws it when it stops. The bridge sends its token only when that file names a live process and the data folder is locked. A port Devot holds cannot be held by anyone else. The file also ends the 15 s stall a call would suffer before the window listens.

**Authorship.** The bridge sends the client's `initialize` name and a session made once per run as headers (`X-Devot-Client`, percent-encoded; `X-Devot-Session`, shaped as an authorship ID). Rust checks them and honours them for the bridge's token alone, so a write shows "Claude Code (MCP)" per ADR 0007. The kind follows the token; a client never sets it, and an HTTP API token cannot claim a name.

**Tools live in one file.** `src-tauri/mcp/tools.json` holds the eight tools as the Node server declared them, generated from it before it was removed. A test holds its limits to the core's. Rust checks arguments against it and leaves out properties it does not name, as the Node server's schemas did.

**Background start**, approved by the owner on these conditions:

- Settings > Integrations says so plainly, near Connect and before connecting, and shows whether Devot is running that way now. Connect's dialog says it again.
- `open -g -a Devot --args --devot-background`, so Launch Services owns the process and it outlives the client. The app sets the accessory activation policy before it builds a window: no Dock icon, no window, no focus taken, and the main window built hidden, so its core answers.
- A menu bar item shows while it runs that way, with Open Devot, Integrations Settings… and Quit Devot; Settings has Quit Devot too. Both run the normal quit handshake, so pending saves are flushed. In menu bar mode, that mode's icon already holds both.
- Start in the Background turns it off: the bridge answers `E_MCP_BACKGROUND_START_OFF` and starts nothing. While it is on, the next call after a quit starts Devot again, and the wording says so.
- Opening Devot in any usual way (Finder, the Dock, the `devot` command, a link) shows its window and it is an ordinary Devot from then on.
- A failure answers with a code: `E_MCP_START_FAILED`, `E_MCP_START_TIMEOUT` after 20 s, `E_MCP_NOT_READY` when it runs but takes no calls. A launch that cannot open its notes logs its code and exits without an alert, so no dialog comes from nowhere; opening Devot shows why.

**A background Devot the owner never opened quits by itself** after 10 minutes without an MCP call, with no window ever shown and no call on its way. It first asks the main window to save, and stays if anything could not be saved: the quit guard would otherwise let the second quit go without those edits. Records waiting to sync delay it for up to 10 minutes more, then it quits: they are safe on disk and the next launch sends them, and a relay that is away must not keep it running for ever. Any window shown ends this for good, and the menu bar item stays until the owner quits.

**The Node program is gone** from the product and the repository: `src/mcp`, its packaging, `pnpm mcp:build`, and the dependencies only it used (`@modelcontextprotocol/sdk`, `zod`). `better-sqlite3` is a test dependency now, its adapter in `tests/support`. `AiStorage`'s transaction path remains in the core for the tests that use it; removing it is separate work.

## Considered

- **Keep Node, bundled:** rejected for size, a second SQLite driver and release changes.
- **A separate helper binary:** more to sign, notarize and update, for nothing the app's own binary cannot do. `--cli` stops before anything of the app starts.
- **Stdio to the app over the single-instance socket:** avoids a port, but gives the bridge a second, private API to keep beside the HTTP API's guards.
- **Reusing the HTTP API's token and switch:** turning on MCP would expose that API to anything holding its token, and rotating it would break connected tools.
- **Never quitting by itself:** would leave a Devot running for days after one question, for an owner who may not notice its icon.

## Not verified by automated tests

The real app's activation policy, Launch Services' reopen and the hidden window's web view answering are macOS behaviours no CI job exercises. WebKit may throttle a hidden page: the existing menu bar mode already relies on it answering, and calls time out with a code if it does not. `docs/releasing.md` has the check to run on a signed build.
