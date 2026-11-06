# AI

Part of the [architecture overview](../architecture.md).

- **MCP first, through a bridge** (ADR 0012, `src-tauri/src/mcp_bridge/`, desktop only): Claude Code, Codex and Claude Desktop run `Devot.app/Contents/MacOS/devot --cli mcp` over stdio.
  It stops in `main` before anything of the app starts: no data folder is opened, no database, no window, no Dock icon.
  It holds no note: each tool call is one request of the local HTTP API (or two, when an empty answer may mean no notebook allows AI), so the running app's core is the only write path.
  Tools: `list_notebooks` (in the sidebar's order), `search_notes` (full text, the app's query rules, a snippet per hit), `read_note` (Markdown snapshot and metadata), `list_tags` (the tags on visible notes, with counts), `create_note` (title, Markdown, a notebook by ID or exact name), `update_note`, `append_to_note`, `trash_note` and `create_notebook` (see Writes).
  Their titles, schemas and read-only and destructive annotations are `src-tauri/mcp/tools.json`, which Rust compiles in and checks arguments against, leaving out properties it does not name (`E_MCP_ARGS_INVALID` names the path and never a value); `tests/core/mcp-tools.test.ts` holds its limits to the core's.
  MCP is JSON-RPC, one message a line (`protocol.rs`), protocol versions 2024-10-07 to 2025-11-25. stdout carries MCP messages only; logs go to stderr as codes and IDs (`I_MCP_NOTE_CREATED|UPDATED|APPENDED|TRASHED <id>`, `I_MCP_NOTEBOOK_CREATED <id>`, `W_MCP_TOOL_FAILED <tool> <code>`).
  A failure answers `<code>: <hint>`, never note content; an empty `list_notebooks`, `search_notes` or `list_tags` with no notebook allowed adds `code: E_MCP_NO_AI_ACCESS` and a hint, which says what to do and nothing about what notebooks exist.
  It adds no crate to the tree (`toml`, for Codex's config, was already there through Tauri).
- **Access and the token:** Settings > Integrations > AI Tools (`http_api/mcp_access.rs`, `<app data>/mcp-access.json`: `enabled`, off by default, turned on by Connect, which says so first; `scope`, read and write by default, enforced by the listener at once; `backgroundStart`, on by default).
  The token is its own keychain item (account `mcp-bridge-token`), made when access is first turned on, read by the bridge itself and never written to a config file, an argument or a log.
  The HTTP API's switch stays apart: each listener takes one holder's token, each only while its own switch is on, and each has its own rate limit (see Local HTTP API).
- **The bridge's socket** (`Server::start_bridge`, ADR 0012): `<identifier>.mcp.sock` in this user's private folder (`single_instance`, 0700, owner checked), mode 0600, with the HTTP API's routes and guards (Host `localhost`; Origin and `Sec-Fetch-*` refused).
  It accepts a connection only when the peer runs as this user (`getpeereid`; `SO_PEERCRED` on Linux; `atomic_file::peer_uid`), and the bridge connects only to a socket this user owns and checks the peer the same way before it writes a byte (`E_MCP_PEER_REFUSED`), so the token never reaches another user's process.
  It takes only the bridge's token, and bodies up to six times the Markdown limit plus 1 MiB (`BRIDGE_MAX_BODY`), the worst JSON escaping of a note the core accepts; the decoded limits are unchanged.
  It opens once MCP is on and a main window takes calls (`http_api_listening`) and closes when MCP is turned off, when a quit begins, and on `RunEvent::Exit`, which every way out reaches, an Apple Event's quit (logout, another app) among them.
  One that a crash or a kill left is removed as soon as the next launch holds the data folder, and replaced when it binds.
  The bridge counts Devot ready only when something answers on the socket: a socket nobody listens on while the folder is held reads as a Devot still starting, and the bridge keeps polling within its wait (a connection that sends nothing gets no answer and no log line).
  From the moment a quit begins, calls are refused before they reach the core (`E_APP_QUITTING`); the bridge waits a second and asks again, up to three times.
- **When Devot is not running** (`mcp_bridge/start.rs`): only a tool call asks, never `initialize` or `tools/list`.
  With access off it answers `E_MCP_ACCESS_OFF`; with Start in the Background off, `E_MCP_BACKGROUND_START_OFF`, starting nothing.
  Otherwise it runs `open -g -a <bundle> --args --devot-background` and waits up to 20 s (`E_MCP_START_FAILED`, `E_MCP_START_TIMEOUT`); see Background start.
  Bridges that start at once take turns on `<identifier>.mcp-start.lock` in the private folder, so only one runs `open`: a second would reach a Devot that is still starting as a reopen, which shows its window.
  A request that may have been made is never sent twice: a connection lost after sending answers `E_MCP_CONNECTION_LOST`, and only a replaced token or a rate limit is retried, once.
- **Picking up changes:** Rust polls `PRAGMA data_version` on the app's own connection every second, for any other writer on the file (`src-tauri/src/watch.rs`); it changes only when another connection commits, so the app's own saves are ignored.
  A change emits `devot://db-changed`.
  The window first has the note service take in what was written (`mergeStored` in `src/core/notes.ts`): every note it holds in memory reads its stored copy back, its Yjs document takes the stored state in and each metadata field keeps the newer HLC, so the next save keeps the other's changes instead of writing its own copy over them, and a note whose stored copy lost edits of its own is saved again; a note deleted for good is dropped.
  The others stay in memory: letting one go there could lose an edit that had just loaded it (a pin from a batch change, say), so each outside change reads back every note held.
  The open editor takes in the merged state (nobody's undo step) and the title field a rename.
  Then the window saves pending edits and reloads its lists.
  The window hears of a change within a second; a note saved in that second does not go over the change either: storage refuses the write, since the note's body version moved on, and the note takes the stored copy in and is written again (see Body versions in Data model), so the editor's replica gets what the other wrote when the window then hears of it, and the title field a rename the note took in that way (`mergeStored` reports it as one it took in itself).
- **Access control:** each notebook has an "Allow AI access" switch (`books.ai_access`, schema v8; a local field that is not synced, so each device decides what AI may read: `src/core/sync/records.ts`), off by default and set from the notebook context menu.
  MCP, the local HTTP API and every other AI feature only see notebooks with the switch on (`src/core/ai.ts`).
  The switch is not inherited: a sub-notebook needs its own.
  AI sees only live notes filed directly in such a notebook; notes in the Trash, in no notebook or in a deleted notebook never show, and reading any other ID fails exactly like an unknown one (`E_NOTE_NOT_FOUND`).
- **Creating notes:** `create_note` goes through the AI service's note service with the core's own HLC node: the body is applied to the new note's Yjs document as operations, never written as a snapshot.
  It never compacts history (`compact: false` on its note service): the main window's own service does.
- **Writes:** MCP writes directly; nothing waits for acceptance.
  Every write goes through the core (`src/core/ai.ts`) and needs the note (and any notebook it names) to be visible as above: a hidden note answers `E_NOTE_NOT_FOUND`, a hidden notebook `E_BOOK_NOT_FOUND`.
  A call's steps are not one storage transaction (see Local HTTP API).
  Once the trial is over without a licence, writes answer `E_LICENCE_REQUIRED` and reads still work.
  - `update_note` changes the title, the body, the notebook (only to one that allows AI access), the tags and the status, any of them at once.
    The body is the whole new Markdown or a list of exact passages to replace in turn (each must occur exactly once in the body as the ones before left it: `E_AI_PATCH_NOT_FOUND`, `E_AI_PATCH_AMBIGUOUS`).
    It goes in as the text difference applied as Yjs operations, never as a snapshot, so it merges with the app's copy of the note like any outside write (see the Body versions item and Undo: the open editor takes it without moving the caret or the selection and without entering the undo history).
    Before the change, the body as stored is kept as a version unless the history already ends with it (`keepBaseline`), so each edit leaves the text it replaced in Revision History; title, notebook and status changes are recorded as events as usual.
    Tags are the note's whole list by name: a name no tag has yet becomes a tag, tags left out are taken off.
    Tag names are unique, so a name an existing tag has (in any case) puts that tag on the note, wherever else it is used.
    A whole body AI sends, or all patches of a call together, may be at most 1 MB (`MAX_AI_BODY_BYTES`); a patched note may be as large as any note.
  - `append_to_note` adds text without rewriting the body (issue #477): at the end of the section under `heading` (matched by its text in any case; the section ends before the next heading of the same or a higher level; a heading the note does not have is `E_HEADING_NOT_FOUND`, 409) or of the note, or at its start with `position: prepend`; the text takes a line of its own unless `separator` is `none` (`src/core/append.ts`, the rule the `devot append` command shares; see Command line).
    A blank text is `E_APPEND_TEXT_EMPTY`.
    It goes in as a write of the whole body like `update_note`, so the text before is kept as a version and the write is recorded with its writer.
  - `trash_note` moves a note to the Trash (never purges), keeping its history; the owner restores or empties it.
  - `create_notebook` makes a notebook at the top level or inside an allowed one, with Allow AI Access on, so AI can use what it made; a name an allowed notebook already has is refused (`E_BOOK_NAME_TAKEN`), since tools name notebooks by exact name.
  - `list_tags` lists only tags on visible notes, so it never lists a tag used only in hidden notebooks.
    Tag names are unique, so `update_note` refuses (`E_TAG_NAME_INVALID`, before writing anything) a name only hidden notebooks use instead of putting that tag on the note; a client that guesses names can tell that refusal from a new name's success.
  - Edits from the app's own AI features are proposals the user accepts first (see Edit with AI); only MCP writes directly.
- **Authorship** (#372, ADR 0007; see Data model): the MCP bridge, the local HTTP API and an accepted Edit with AI proposal record each write with its writer: MCP as the client named itself in `initialize`, one session per run of the bridge (`X-Devot-Client` and `X-Devot-Session`, checked in Rust and honoured for the bridge's token alone, `routes::client`, then `writerOfCall` in `src/core/httpApi.ts`), the HTTP API as `http`, one session per start of the main window's core, and each Edit with AI sheet as `aiEdit`.
  Logs carry codes, note IDs, write IDs and kinds (`I_AUTHORSHIP_WRITE`, `I_AUTHORSHIP_UNDONE`, `I_AUTHORSHIP_CLEARED`, `W_AUTHORSHIP_RECORD_INVALID`), never a client name or text; the app's go to the local log from the core worker (as info lines) and the page, and `log_write` takes write IDs, kinds and counts only under these codes.
  The UI always names a writer with its kind ("Claude Code (MCP)", "HTTP API", "Edit with AI"; `authorshipLabels.ts`).
  - **Gutter** (View > Show Authorship, the `authorship` setting, on by default; a check item in Rust's menu): the editor marks the lines agents wrote, one mark per run of lines with the same writes, read from the replica's own document (`editor/authorship.ts`).
    The text is attributed once per change to the document and only the marks in the viewport are drawn.
    The marks are buttons in a group of their own beside the text, outside CodeMirror's gutters (hidden from assistive technology): each is named "Written by <writers>, <time>", shows that on hover or focus, selects the agents' text on its lines when chosen, and the arrow keys move between them.
    They show in Edit and Split; the history bar's overlay covers them with the panes.
  - **Review notice** (`AuthorshipNotice.tsx`): above the panes, so the history bar's overlay never covers it (inert while a version shows), when the open note has unseen writes: how many and by whom, Review Changes, one Undo All per writer and Dismiss.
    Review Changes steps through the unseen writes' places in document order (`reviewSteps`: an inserted run, a deletion point, or both), selects and scrolls to each, with Previous, Next (also the arrow keys) and Done; Keep and a per-step Undo (ADR 0007) are not built yet.
    Undo All runs `NoteService.undoAgentWrites` as an owner edit over every write of that writer on the note, seen ones too, so its button gives the count when that is more than the notice names; the editor takes it as one undo step, and a notice says when deleted text was too old to put back.
    Undo All is off once the trial is over without a license; Review Changes and Dismiss are not.
    When Done, Dismiss or Undo All takes away the control with the keyboard, the editor gets it.
    Note windows show the gutter but no notice, and do not mark writes seen.
  - **List and sidebar** (`agentWrites.ts`): a row or board card of a note with an unseen write shows a mark and "changed by <writer>" (the newest).
    The sidebar's Agents section lists the MCP clients and the HTTP API of this device's rows, newest first, each with its unseen count; choosing one filters the list to the notes it changed (a filter like Status and Tags, not kept across launches; search in that view keeps to them).
    The window reads its rows again when the lists reload, when a write of its core changed a note's rows (`reportingNoteWrites`; storage is given rows only then), when another window's save did (`authored` on the relay's `saved`), and after rows are marked seen; the owner's own saves read nothing.
  - **Clear Authorship** (the note context menu and the More menu, for a note with records, after a confirmation): `NoteService.clearAuthorship` in one transaction, which the open editor takes in; a write another device made that the clear had not seen counts as cleared until its session writes again (see ADR 0007).
- **The pane** (`IntegrationsSection.tsx`, `McpAccessSection.tsx`): an intro line, then the AI Tools card: Allow AI Tools, Notebooks (how many allow AI access, with Choose… for the main window's picker), Access (Read and Write or Read Only), Start in the Background, and Status ("Open as usual.", or "Running in the background for AI tools." with Quit Devot), with a footnote on the idle quit and on starts turned off, led while no notebook allows AI access by one that says so and how to choose them (Choose… is the action; nothing opens on its own).
  Then one Clients card: a row each for Claude Code, Codex and Claude Desktop with its state (a dot and a word: connected green, a moved or foreign entry amber, a file Devot leaves alone red) and its buttons at the trailing edge, and Set Up by Hand, collapsed, holding every configuration to copy, Other MCP Clients' among them.
  The Local HTTP API section follows.
- **Connecting clients** (`src-tauri/src/mcp_clients.rs`): Settings > Integrations offers Connect, Reconnect (the entry names a moved copy of Devot), Replace (a `devot` entry this feature did not write) and Disconnect for Claude Code (`~/.claude.json`), Codex (`~/.codex/config.toml`) and Claude Desktop (`claude_desktop_config.json`), honouring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
  Claude Code rewrites its file all the time, so when its CLI is installed (on PATH, or where Homebrew, npm and its own installer put it, since a GUI app's PATH is short) Devot runs `claude mcp add --scope user devot -- <bridge> --cli mcp` and `claude mcp remove --scope user devot` instead, each argument passed as it is with no shell, with Homebrew's and the system's folders on the child's PATH so an npm install finds `node`, its output never read, stopped after 30 s (`E_MCP_CLI_FAILED`, `E_MCP_CLI_TIMEOUT`); an entry already there is removed first, since `add` refuses a taken name.
  The dialog shows that command, and Claude Code can stay open.
  Without the CLI, Devot edits the file as for the others.
  The page names a client, never a file.
  A dialog shows the exact file and text first.
  JSON goes through raw values in their order; TOML is changed by replacing Devot's lines and parsing the result to prove nothing else changed, and an entry written another way is refused.
  Each write is atomic, keeps the file's permissions, keeps the file as it was at `<file>.devot-backup`, and refuses a file that does not parse (`E_MCP_CONFIG_UNPARSABLE`).
  Devot's own writes go one at a time.
  Connect and Disconnect carry the file's revision as Settings showed it (`missing`, or its SHA-256), and the file is read again just before the rename: a file that changed since it was shown is refused (`E_MCP_CONFIG_CHANGED`) and Settings reads it again.
  No lock exists that the clients honour, so the dialog asks to quit a running client first.
  A config that is a link to a file that is gone is refused (`E_MCP_CONFIG_LINK_DANGLING`) rather than replaced by a file; a link to a file that is there is written through, and stays a link.
  Disconnect removes only Devot's entry.
  Connect is disabled from a disk image or a translocated copy (`E_MCP_APP_NOT_INSTALLED`).
  Copy-ready configs stay for every client and for other MCP clients, under Set Up by Hand.
  The extension button writes a small `.mcpb` (a launcher, `src-tauri/mcp/devot-mcp.sh`, and an icon, no server) and opens it (Install Extension).
  `docs/mcp-plugin/` holds the layout for a directory plugin later, with the same launcher; nothing is published.
- **Models:** embeddings run locally (vectors stored with `sqlite-vec`), so semantic search works offline and keeps content local; the runtime (in the UI worker or in Rust) is chosen in phase 2.
  Generation goes through a provider interface (below).
  Nothing is sent to a cloud model unless the user triggers it, and only text from notebooks that allow AI access.
- **Providers:** `src-tauri/src/ai` defines the `Provider` interface: a provider turns one provider-agnostic request (an optional system prompt, messages that start with the user, a token cap) into its own HTTP request, and its response into text, a stop reason (`end`, `maxTokens`, `other`) and token counts.
  Two implementations ship.
  `anthropic` (the default) is the Anthropic Messages API (`POST {endpoint}/v1/messages`, `x-api-key`; default endpoint `https://api.anthropic.com`, default model `claude-sonnet-5-5`).
  `openai` is OpenAI-compatible chat completions (`POST {endpoint}/chat/completions`, bearer key, `max_completion_tokens`; default endpoint `https://api.openai.com/v1`, no default model: the user names one).
  Both are non-streaming: Edit with AI waits for the whole reply.
  A refusal, a missing text or a shape the provider does not keep answers with a code.
  - **Where things live:** Rust holds everything that must not reach the web view.
    The endpoint and model of each provider, the active provider and whether suggestions are also asked for on a pause (`suggestOnIdle`) are in `<app data>/ai-settings.json` (`settings.rs`): on this device only, never synced, never in backups.
    The key is a macOS keychain item per provider (`keychain.rs`: the app identifier as service, `ai-key-<provider>` as account; a build without a keychain refuses with `E_AI_KEYCHAIN_UNAVAILABLE` and keeps no key elsewhere).
    The page can set or remove a key (`ai_key_set`, `ai_key_clear`) but never read it: `ai_settings_get` says only `set`, `unset`, `unknown` (the keychain could not be read, so Save Key and Remove Key stay usable) or `unavailable` (no keychain in this build).
    Whether a key exists is checked without reading it, so Settings never loads a secret or triggers an access prompt; only a request reads it.
    Requests ignore proxy environment variables, so a key goes only to the endpoint the user set.
    A key belongs to the origin (scheme, host and port) it was entered for: `ai_settings_set` that moves a provider's endpoint to another origin removes that provider's key first (a key the keychain will not remove refuses the change with its code), so the user enters it again for the new server; a new path on the same server keeps it.
    A key is checked as a header value (visible ASCII, no spaces, at most 512 characters).
  - **Endpoints:** https, or http to this Mac only (a model server on `localhost`, `127.0.0.1` or `::1`), with no credentials, query or fragment, so a key never travels over plain http to another machine.
    Only the Settings window can change an endpoint, so the web view cannot send a key anywhere else.
    The request goes out from Rust (`transport.rs`, the system TLS stack, 180 s, responses capped at 8 MiB), redirects are never followed (a key goes only to the endpoint set), and the endpoint is not restricted to public hosts, since the user chose it.
    The CSP is unchanged: the web view makes no request to a provider.
  - **Commands:** `ai_generate` (main window), `ai_settings_get` (main and Settings windows: the main window reads it for Suggest Next Edit), `ai_settings_set`, `ai_key_set` and `ai_key_clear` (Settings window).
    `ai_generate` names no endpoint, key or model: Rust reads them.
    It validates the request (1 to 100 messages starting with the user, none empty, at most 2 MiB of text in all, 1 to 32,000 output tokens) before it reads the key, so a bad request sends nothing; with no key it answers `E_AI_KEY_MISSING` and sends nothing.
    Before all of that, a build that gates AI answers `E_LICENCE_REQUIRED` without a valid license (see Licences).
  - **Errors and logs** are codes: `E_AI_AUTH_FAILED` (401, 403), `E_AI_RATE_LIMITED` (429), `E_AI_REQUEST_REJECTED` (400, 413, 422), `E_AI_NOT_FOUND` (404), `E_AI_PROVIDER_UNAVAILABLE` (5xx), `E_AI_HTTP` (other statuses, redirects included), `E_AI_NETWORK_FAILED`, `E_AI_TIMEOUT`, `E_AI_RESPONSE_INVALID`, `E_AI_RESPONSE_TOO_LARGE`, `E_AI_REFUSED`, `E_AI_MODEL_MISSING`.
    The log line holds the provider and the status, never a prompt, an answer, a header or a key; an error never quotes the response body, which can echo the prompt.
  - **The access rule** is in the core (`src/core/aiProvider.ts`, `createAiGenerator`), so every AI feature has the same one in front of it, whichever provider is active.
    A request needs a trigger `{ by: 'user', books }`: anything else (a timer, a sync, a note's own content) is refused with `E_AI_NOT_TRIGGERED`, and every notebook the text comes from must have Allow AI Access on (Templates and sub-notebooks of an allowed notebook do not count), or the request is refused with `E_AI_ACCESS_DENIED` before it reaches Rust.
    The renderer's transport is `src/renderer/src/ai.ts`.
  - **Settings > AI** (the AI pane): the active provider, the Suggest When I Pause switch (see Next edit suggestions), and for each provider its endpoint, model and key (a password field that is cleared once the key is saved, with Save Key and Remove Key).
    Endpoint and model are stored when the field is left or on Return; Rust refuses a bad value with its code and the field shows the stored value again.
  - **Tests:** `src-tauri/src/ai/tests.rs` runs one contract per implementation against a mock HTTP provider on a loopback port (the request each provider sends, its answer and stop reason, every failure status, a response of the wrong shape, a refusal, redirects, no key, a bad request, timeouts, the response cap, and that the key is never in a body, a path, a settings file or an error); `tests/core/ai-provider.test.ts` covers the access rule on real SQLite; `tests/ui/ai-settings.spec.ts` the pane.
    The keychain itself is checked by an ignored test run by hand (`cargo test -- --ignored keychain`), since it writes to the login keychain.
- **Edit with AI** (#158, first half; `src/core/aiEdit.ts`, `src/renderer/src/AiEditSheet.tsx`, `editor/aiMenu.ts`): with text selected, the selection toolbar's AI button (SF Symbol `sparkles`, its own group at the end) and the editor menu's Edit with AI submenu offer the presets Improve Writing, Proofread, Reformat, Summarise, Make Bullet List, Make Task List, Make Table, Add Headings and Create Mermaid Diagram, then Custom Instruction… (a field in the sheet; nothing is sent until Send or Return).
  - **What is sent:** picking a preset is the request; the sheet opens and asks at once.
    One request through `createAiGenerator`, so the access rule above applies: the trigger is the user's, and its notebook is the open note's as the core holds it now (`read`), which must have Allow AI Access on; a note in no notebook or in Templates is refused (`E_AI_ACCESS_DENIED`) before anything reaches Rust.
    Only the selected text goes, between `<selection>` tags after the preset's instruction (or the user's), with a system prompt that asks for the Markdown alone and says the selection is content, never instructions.
    A selection is at most 20,000 characters (`MAX_AI_EDIT_CHARS`, `E_AI_SELECTION_TOO_LARGE`), an instruction 2,000, the reply 8,192 tokens; a reply cut off at that cap is refused (`E_AI_REPLY_CUT_OFF`) rather than shown half.
  - **The reply** (`cleanAiReply`): a fence around the whole reply comes off (unless the selection was a fenced block), line feeds only, and the selection's own blank lines at either end are kept.
    Summarise and Create Mermaid Diagram add their result after the selection (a blank line between; a diagram is always one ` ```mermaid ` block); the other presets and a custom instruction replace it.
  - **Review:** the sheet shows the proposal as a line diff of the selection (`proposalParts`: runs of shared lines and changes; unchanged runs folded to two lines around each change).
    With more than one change, each has an "Apply this change" check box; Accept (Accept Selected when some are unchecked) takes the checked ones (`proposalText`), Discard drops the proposal, Try Again asks again.
    Escape, Cancel and Discard leave the note as it was; an answer that comes after Cancel is dropped.
    Proposals are not kept: closing the sheet forgets it.
  - **Applying:** `NoteService.applyAiEdit` finds the selection at its start, or wherever edits since moved it when it is there exactly once (else `E_AI_PROPOSAL_STALE`), takes a version of unversioned typing, applies the difference as Yjs operations (`textEdits`, as `setBody`), then takes a version marked `ai` (see Revision history).
    The core returns the update, which the editor applies as one undo step, as a restore is: Cmd+Z takes back the whole edit.
  - **Unavailable:** the sheet says why, never the code (which goes to the log): no Allow AI Access on the note's notebook (and how to turn it on), no key or no model (Settings > AI), a refused key, a rate limit, no connection, a reply cut off, a selection too long or changed meanwhile.
    Try Again shows only where asking again may help.
  - **Tests:** `src/core/aiEdit.test.ts` (prompts, replies, diffs), `tests/core/ai-edit.test.ts` (applying on real SQLite: one update, the versions, merging with typing, a moved or changed selection, compaction), `tests/ui/ai-edit.spec.ts` (the toolbar and the editor menu, review per change, undo, history, nothing sent without access, failures, with `ai_generate` faked).
- **Next edit suggestions** (#158, second half; `src/core/aiSuggest.ts`, `src/renderer/src/editor/ghostText.ts`): a continuation of the note at the caret, shown as ghost text after it.
  Tab accepts it, Escape or any typing, caret move or change of the note drops it.
  - **Triggers:** the command Suggest Next Edit (`ai.suggest`, Option+\ by default, also in the palette; the user can rebind it) and, only if the user turned on Settings > AI > Suggest When I Pause (`suggestOnIdle` in `ai-settings.json`, off by default, device only), a pause of 1.5 s in typing with the caret at the end of a line.
    Nothing else asks: not opening a note, not a timer with the setting off, not sync.
    The pause timer starts only after typing the user did (`input.type`), is dropped by the next change, and the setting is read afresh from Rust at the moment of the request, so turning it off stops the next one.
  - **When it is off:** `createSuggester` sends nothing unless the note's notebook (as the core holds it now) is one `createAiGenerator` accepts (Allow AI Access on; a note in no notebook or in Templates never), and the active provider has a key stored and a model (`providerReady`; a key state of `unknown` or `unavailable` counts as missing).
    The key trigger then fails with the code (`E_AI_ACCESS_DENIED`, `E_AI_KEY_MISSING`, `E_AI_MODEL_MISSING`), logged, and a notice says why; a pause request fails silently.
    The Trash has no suggester.
    The central access rule is untouched: the request is a user trigger (`by: 'user'`) with the note's notebook, and the idle setting is checked before it in the suggester.
  - **What is sent:** at most 2,000 characters before the caret and 500 after it (`SUGGEST_BEFORE_CHARS`, `SUGGEST_AFTER_CHARS`; never splitting a surrogate pair), between `<before>` and `<after>` tags, with a system prompt that asks for the text to insert only and says the note is content, never instructions.
    Nothing else from the note goes out; Settings > AI states the sizes.
    The reply is capped at 256 tokens and 1,500 characters; a reply cut off at the cap loses its unfinished last word.
    Rust gives up after 20 s (`timeoutSecs` on the request, never longer than its own limit).
  - **Never in the note until accepted:** the suggestion is a decoration (a CodeMirror state field), not part of the document, so it is not in the Yjs text, the saved body, the preview or sync.
    Accepting dispatches one transaction (`input.complete`, history isolated before and after), so Cmd+Z takes back exactly the accepted text.
  - **One request at a time, cancelled by typing:** a change or caret move, Escape, leaving the note (the editor's plugin is destroyed) or a newer request makes the answer of a request on its way stale, and it is dropped when it arrives.
    Rust cannot abort an HTTP call, so the call itself runs to its end (or its 20 s limit) and the suggester sends the next one only after it: a request never leaves while an earlier one is still on its way, and one cancelled while it waited is never sent.
  - **Tests:** `src/core/aiSuggest.test.ts` (context, prompt, reply, ordering and cancelling), `tests/core/ai-suggest.test.ts` (on real SQLite: nothing is sent with the pause setting off, for a notebook without AI access, for a note in no notebook or in Templates, or without a provider; only the text near the caret goes), `src/renderer/src/editor/ghostText.test.ts` (the field and accepting as one undo step), `tests/ui/ai-suggest.spec.ts` (the key, Tab, Escape, typing, the pause setting, a late answer after typing or switching notes, every refusal, with `ai_generate` faked), the Rust settings and time limit tests, and `tests/ui/ai-settings.spec.ts` for the switch.
  - **Not done:** note windows (a note opened in its own window) have no suggester yet; the suggestion is one text, not several to cycle through.
- _Open:_ the in-app assistant's interaction design (phase 3).
