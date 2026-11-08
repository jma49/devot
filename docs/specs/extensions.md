# Extensions

Part of the [architecture overview](../architecture.md).

- An internal, versioned extension API.
  Built-in preview renderers (and their islands) register through it (`PREVIEW_API_VERSION`; see the preview section's Extension point); commands and keymaps have their own registry (`src/renderer/src/commands/`).
  Built-in features written against it so far: math, Mermaid, emoji, alerts, embeds and the other preview renderers.
  Import, export and themes are built-in code.
- **Third-party plugins** (ADR 0005, `PLUGIN_API_VERSION` 1) contribute commands, menu items, keymaps, preview renderers and import and export formats, each with a permission the user approves on install.
  No permission reaches the network, other notes, storage or Tauri.
  - **Package:** a folder with `devot-plugin.json` (ID, name, version, API version, main script, permissions, contributions), or a `.zip` of one, at most 256 files and 20 MiB.
    Rust reads it whole and checks it (`src-tauri/src/plugins/`), the page checks the manifest again (`src/core/plugins/manifest.ts`); both run `tests/fixtures/plugins/manifests.json`.
  - **Install:** Settings > Plugins > Install from Folder or Install from Archive picks a package in a native panel; the sheet lists what it asks for, and Install approves it all (Cancel, which has the keyboard, installs nothing).
    Rust writes it to a new folder and renames it into `<app data>/plugins/<id>/`, replacing an older version whole, and records it as on with those permissions in `plugins.json` (granted permissions the manifest on disk no longer asks for do not count).
    The pane turns plugins on and off, lists their permissions and removes them.
    Nothing is downloaded; plugins never sync and backups leave them out.
  - **Sandbox:** only the main window runs plugins.
    Each enabled plugin gets a hidden `<iframe sandbox="allow-scripts">` on `devot-plugin://localhost/<id>/`, which Rust serves for enabled plugins only: Devot's container page (`src-tauri/plugin-frame/`), which frames the plugin's page in another sandboxed frame and lets that one page load, so the plugin can never navigate.
    The plugin's page runs Devot's runtime, then the plugin's script, under `default-src 'none'` with scripts, styles, images, fonts and media from its own folder and every connection, frame, worker and form refused; WebRTC is off in every main window's web view (WebKit's `PeerConnectionEnabled` preference), as are resource hints (preconnect, preload, prefetch and DNS-prefetch), which would otherwise reach the network outside the policy; the runtime removes WebRTC too and refuses child frames and hint links (also through the `document.body` and table `caption`/`tHead`/`tFoot` setters), through DOM methods it keeps before the plugin's script runs.
    A preconnect connects synchronously on insertion, so the native preference is the guarantee and the runtime guard is defence in depth.
    Both frames have opaque origins, so a plugin shares no storage, cookies or DOM with the app or another plugin, and Tauri's IPC and invoke key are in the main frame only.
    The main window's policy only gains `devot-plugin:` in `frame-src`.
  - **Protocol** (`src/core/plugins/protocol.ts`, version 1): the main window hands each frame a `MessagePort` and binds it to that plugin (`src/renderer/src/plugins/host.ts`).
    Plugins call `note.read`, `note.replace` (the text read and the new text; refused when the note changed since), `ui.show` and `ui.hide`; the host calls `command.run`, `preview.render`, `import.convert` and `export.convert`.
    Every call is checked for its shape, a known method, its permission and, for the note and panel calls, that one of the plugin's commands is running or its panel is open; refusals and failures are answered and logged as codes with the plugin's ID.
    At most 64 calls wait per plugin; a plugin answers within 5 s (a drawing), 30 s (a conversion) or 60 s (a command).
  - **Edits** go through the core as Yjs diffs (`NoteService.applyPluginEdit`, `textEdits`), with the text before kept as a version, and the editor applies the update as one undo step.
  - **Contributions:** commands in the palette under the plugin's name; a keymap's key works in the whole window when it is a valid shortcut with Command or Control that no app command, reserved key or earlier plugin (by ID) uses, and is dropped and logged otherwise; menu items in the Plugins menu, which Rust builds from the manifests (with Plugin Settings… last) and whose picks reach the window as `devot://plugin-action`; preview renderers draw fenced blocks of their language as Markdown the preview renders and sanitizes like note text, without plugin renderers (a block without an answer stays code; exported and printed pages show it as code); import formats (File > Import and the palette) turn the files Rust reads from a native panel (UTF-8, 5 MiB each, 20 at a time) into notes in the notebook shown; export formats (File > Export and the palette) turn the open note into text Rust writes whole where the save panel says.
    Rust rebuilds these menu items on the main thread after an install, a removal, a plugin turned on or off and a licence change, and swaps their actions in one step, so a pick during a rebuild finds an action or nothing.
  - **UI:** a plugin shows its frame only from one of its commands (`ui.show`), in a sheet titled with its name, with Close; the frames stay in that sheet while it is closed, so showing one never reloads it.
    Closing tells the plugin (`ui.hidden`).
  - **Tests:** `tests/ui/plugins-sandbox.spec.ts` (a hostile plugin cannot reach Tauri, the main window, another plugin, the network or a note without permission), `tests/ui/plugins.spec.ts` (each contribution point), `tests/ui/plugin-settings.spec.ts`, `tests/ui-csp/csp.spec.ts` (a plugin under the production policy), `src/renderer/src/plugins/host.test.ts`, `src/core/plugins/protocol.test.ts`, `tests/core/plugin-*.test.ts`, and Rust's `plugins` tests (packages, install, serving, menus).
    The UI tests serve the same pages from `src-tauri/plugin-frame/` (`tests/ui/plugins.ts`).
