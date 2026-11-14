# Menu bar mode

Part of the [architecture overview](../architecture.md).

Settings > General > Keep in Menu Bar (`menuBar` in the editor settings, off by default; `src-tauri/src/menu_bar.rs`, desktop only) keeps Devot running in the menu bar.

- **While it is on:** a menu bar icon shows, a template image of the dove (`design/app-icon/menu-bar.svg`, drawn by `pnpm app-icon` into `src-tauri/icons/menu-bar/template.png`, 36 px for the 18 pt status item, compiled in with `include_image!`), so macOS tints it for the menu bar's appearance.
  A click on it opens quick capture; its menu (right click or Control-click) has New Quick Note, Open Devot and Quit Devot.
  Control-Option-Command-N opens quick capture from any app (`QUICK_CAPTURE_SHORTCUT`, registered in Rust through the global shortcut plugin, no window is granted the plugin's commands; the registry reserves the key as `QUICK_CAPTURE_KEY` so no command takes it, and a policy test keeps the two alike).
  Turning the setting on or off applies at once, on the main thread; an icon that cannot be shown leaves the mode off (`W_MENU_BAR_ICON_FAILED`), and a shortcut another app holds is logged (`W_QUICK_CAPTURE_SHORTCUT_FAILED`) with the icon still working.
- **Closing the last main window shown hides it** rather than quitting (`exit::on_window_event`; with several main windows see Several main windows): its core keeps running with every unsaved edit, the page saves as it does when it goes out of sight (`visibilitychange`), and a quit from anywhere (the app menu, the icon's Quit Devot) runs the save handshake as before (see Saving and quitting).
  A window that cannot be hidden quits as before.
  Open Devot (the frontmost main window), a click on the Dock icon (`RunEvent::Reopen`), a `devot://` link (behind Settings when Settings is open, which holds links until it closes) and Settings > General > Show Backups bring it back; turning the mode off shows it if it is hidden, and so does a quit the UI calls off (`app_exit_cancel`), since the notice that says why is in the main window.
  The Dock icon stays.
- **Quick capture** (`quick-capture.html`, `src/renderer/src/quickCapture/`): a small window with a title, a body, a notebook (the notebooks the main window publishes for Settings, `notebookChoices.ts`; the default notebook first, see Editor settings) and Save (Command-Return) and Cancel (Escape, which keeps the text).
  While a save is on its way the fields are read-only and Cancel and Escape do nothing, so no text is typed after what was sent and no draft outlives a note that was made.
  Return in the title goes to the body.
  It starts no core and is granted no note command (`capabilities/quick-capture.json`): it hands the note to Rust (`quick_capture_save`, title, body and notebook checked against `note_put`'s limits), which emits it to the main window (`devot://quick-capture`) with a request ID and waits up to 15 s for the answer (`quick_capture_done`, main window only, a code or nothing).
  The main window claims the request (`quick_capture_claim`) before its core writes anything: one Rust gave up on cannot be claimed, so a timed-out capture is never made (`E_QUICK_CAPTURE_TIMEOUT`, try again), while a claimed one that times out may still appear (`E_QUICK_CAPTURE_LATE`, the window says to look for it before saving again).
  The main window's core makes the note (`captureNote`, `src/core/capture.ts`: refuses an empty capture and a notebook that is gone, then saves before it answers; a save that fails after the note is made leaves it pending in the core like any unsaved edit, so the capture is never sent twice), records `note.created` from `quick_capture` and refreshes its lists.
  On success the window empties and closes (`quick_capture_close`); on failure it keeps the text, says what failed and logs the code.
  What is typed is kept as a draft in the webview's local storage on every change (`devot.quickCapture.draft`, cleared once the note is saved), so closing the window or quitting first loses nothing.
- **Capture links** (`devot://capture?title=…&text=…&url=…`, `src-tauri/src/capture_link.rs`, `src/renderer/src/quickCapture/prefill.ts`): Shortcuts (Open URL), a launcher or a bookmarklet in the browser opens quick capture with the text filled in, with or without Keep in Menu Bar.
  The link never makes a note: the owner saves it with Save, as any capture, or cancels.
  Each field is optional but one must hold something, comes at most once and is percent-encoded (`+` is a space); any other field, a fragment or bytes that are not UTF-8 refuse the link (`E_URL_CAPTURE`, `E_URL_CAPTURE_EMPTY`).
  The title becomes one trimmed line clipped to the title limit; the text keeps its lines and tabs and loses other control characters; `url` must be an http or https address of at most 2,048 bytes (`E_URL_CAPTURE_SOURCE`) and ends the body on a line of its own after a blank line.
  Rust holds up to four links the window has not taken (`W_CAPTURE_LINK_DROPPED` past that), opens the window and tells it (`devot://quick-capture-prefill`); the window takes them when it loads and on each event (`quick_capture_prefill_take`, the quick capture window only), so a link that opens it or reaches it already open is never lost.
  A window that is empty takes the link's title and text; one that holds text keeps it, keeps its title, and gets the link's title (when it differs) and text after its body, past a blank line.
  While a save is on its way the window takes nothing; once the save succeeds it takes what came meanwhile and stays open with it as a capture of its own instead of closing, and a save that fails takes it into the text it kept.
  Neither the link nor its text is logged.
- **Share menu** (`src-tauri/macos/DevotShare`, an app extension in `Contents/PlugIns`; docs/releasing.md, Share menu extension): Devot appears in the Share menu of Safari, Notes and any app that shares text or a web page.
  The extension shows nothing itself: it turns what was shared into a capture link and opens it, so quick capture is where the owner edits, saves or cancels it, as for any link.
  The shared title becomes the title, the shared text (each text, past a blank line) the text, and the first http or https address `url`; any other address is left out, and a text that only repeats the address is dropped.
  A text too long for the link (256 KiB) is cut at its end; a share with nothing left cancels with `E_SHARE_NOTHING`.
  The extension is sandboxed, reads nothing but the share and logs nothing.

## Background start

A Devot an AI tool started (`src-tauri/src/background.rs`, ADR 0012): `--devot-background` as the first argument.
The app sets the accessory activation policy and builds its main window hidden and unfocused, so there is no Dock icon, no window and no focus taken, while the core runs and answers.
A second launch with the flag, one that lost a race to start, is ignored by the running Devot.

- **The menu bar item** shows while it runs that way (the dove, as menu bar mode's).
  A click opens its menu: two disabled lines, "Running in the background for AI tools" and "Quits after 10 minutes without a request", then Open Devot and Integrations Settings…, then Quit Devot.
  With Keep in Menu Bar on, that mode's icon serves instead.
  Turning the setting on or off while it runs that way decides again (`background::menu_bar_icon_changed`), so exactly one item shows.
  When that mode's icon cannot be shown, the background item shows instead.
  The Status row of Settings > Integrations > AI Tools says the same and then has Quit Devot.
  Both run the normal quit handshake (see Saving and quitting).
- **Opening it:** Open Devot, launching Devot from Finder or the `devot` command, a `devot://` link, or any main window taking the focus makes it an ordinary Devot: the activation policy goes back, the item goes, and the main window shows.
  Settings opened from the item does not, so it can say what is running.
- **Quitting by itself:** a thread checks every 30 s.
  After 10 minutes without an MCP call (`Gate::last_mcp_call`), with no call on its way and no window ever shown, it asks the main window to save (`devot://background-idle-check`, `background_idle_answer`) and stays if anything could not be saved or no answer comes in 5 s; the quit guard would let a second quit go without those edits.
  Records waiting to sync delay it for up to 10 minutes more.
  Any window shown ends this for good, and the item stays until the owner quits.
- **The rest is as ever:** the data folder's lock, the licence, sync (the hidden main window runs the engine), backups.
  A launch that cannot open its notes logs its code and shows no alert; opening Devot shows why.
  Its main window, with no core, answers the idle check with nothing unsaved, so it quits by itself as any other background launch does.
