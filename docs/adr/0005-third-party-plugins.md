# Third-party plugins run in a sandboxed frame and ask for each permission

A plugin is a folder of static files with a manifest. The user installs it from a folder or a `.zip` archive they pick; nothing is downloaded and there is no marketplace. It runs in the main window inside two nested sandboxed iframes with opaque origins, under a policy that blocks every network request, and reaches Devot only through a versioned message protocol on a private `MessagePort`. Every call is checked against the permissions the user approved when installing it.

## Package and manifest

- A package is a folder holding `devot-plugin.json` at its top, or a `.zip` archive of such a folder (at the archive's root or in its one top folder). At most 256 files, 5 MiB each and 20 MiB in all, eight folders deep; names are ASCII letters, digits, `.`, `_` and `-`, never starting with `.`; `__devot` is reserved. Links, encrypted or absolute archive entries and `..` refuse the whole package.
- The manifest (at most 64 KiB of JSON):
  - `id`: lowercase letters and digits in parts joined by `.` or `-` (`com.example.word-count`), at most 64 characters; `devot` and `devot.*` are reserved.
  - `name` (1 to 60 characters, one line), `version` (`major.minor.patch`), optional `description` (300) and `author` (100).
  - `apiVersion`: the extension API version it was written for (`PLUGIN_API_VERSION`, 1 now). Another version is refused, never run in a mode it was not written for.
  - `main`: the script the plugin's page runs, a `.js` file in the package.
  - `permissions`: what it asks for, from the list below, each once.
  - `contributes`: `commands` (`id`, `title`), `menus` (`command`), `keymaps` (`command`, `key`), `previewRenderers` (`id`, `language`), `importFormats` (`id`, `title`, `extensions`) and `exportFormats` (`id`, `title`, `extension`). A contribution needs its permission, and menus and keymaps name one of the plugin's commands.
- Rust checks the manifest when installing and every time it lists plugins (`src-tauri/src/plugins/manifest.rs`); the page checks it again with the same rules (`src/core/plugins/manifest.ts`). Both run one table of cases (`tests/fixtures/plugins/manifests.json`).

## Permissions

The user sees each requested permission, in words, before installing, and approves them all or cancels. API version 1 has no permission for the network, storage outside the plugin's page, other notes or Tauri.

| Permission  | Lets the plugin                                                                          |
| ----------- | ---------------------------------------------------------------------------------------- |
| `note.read` | read the open note's title and text, while one of its commands runs or its panel is open |
| `note.edit` | replace the open note's text, at the same times                                          |
| `commands`  | add commands to the command palette                                                      |
| `menus`     | add its commands to the Plugins menu                                                     |
| `keymaps`   | give its commands keyboard shortcuts                                                     |
| `preview`   | draw code blocks of its languages in the preview (it gets those blocks' text)            |
| `import`    | turn files of its formats into notes (it gets the files the user picks)                  |
| `export`    | turn the open note into a file of its formats (it gets that note)                        |

A later version adds a permission only with the protocol change that needs it; a network permission would name its hosts in the manifest and become the frame's `connect-src`.

## Where plugins live

- `<app data>/plugins/<id>/` holds a plugin's files as installed; `<app data>/plugins.json` records, per plugin, whether it is on and the permissions the user granted. Neither syncs nor goes into backups; the notes database never holds a plugin.
- Installing reads the package whole into memory, checks it, and shows the manifest for approval; only then is it written to a new folder and renamed into place (a plugin with the same ID is replaced, after approval of the new version's permissions). Settings > Plugins installs, turns plugins on and off, shows their permissions and removes them.
- Plugins load in the main windows only, each window running its own copy; a Plugins menu pick goes to the front one. The Settings, note and quick capture windows never run one.

## How a plugin runs

- Rust serves plugins on their own scheme, `devot-plugin://localhost/<id>/`, and only for a plugin that is installed and on. The main window's `frame-src` allows that scheme; nothing else of the main window's policy changes, and it never gets `'unsafe-eval'` or `'unsafe-inline'`.
- The main window frames `devot-plugin://localhost/<id>/`, a container page of Devot's own (`src-tauri/plugin-frame/`), in `<iframe sandbox="allow-scripts">`. The container frames the plugin's page, `<id>/__devot/frame.html`, in another `sandbox="allow-scripts"` iframe; its own policy lets that one frame load that one page only. So a plugin's page can never navigate anywhere (the parent's `frame-src` governs a frame's navigations), cannot open windows, submit forms or move the top window.
- The plugin's page loads Devot's runtime and then its `main` script, under `default-src 'none'; script-src`, `style-src`, `img-src`, `font-src` and `media-src` limited to the plugin's own folder (plus `data:` and `blob:` images and media), and `connect-src`, `frame-src`, `worker-src`, `object-src`, `form-action` and `base-uri` all `'none'`. The runtime also removes WebRTC, which no policy governs, before the plugin's script runs.
- Both frames have opaque origins: they share nothing with the app or each other (no storage, cookies or DOM), and cannot reach the main window's globals. Tauri puts its IPC scripts and invoke key in the main frame only, so a frame cannot call a Tauri command.
- The main window hands the container a `MessagePort` once it loads, and the container hands it to the plugin's page. The host binds the port to the plugin it framed, so a message is always that plugin's, whatever it claims; the runtime and the container take a port only from their parent, once.

## Protocol (version 1)

- Messages are plain objects with `devot: 1`. A call is `{ devot, kind: 'call', seq, method, params }`; its answer `{ devot, kind: 'result', seq, ok, value }` or `{ ..., ok: false, code }`. The host sends events as `{ devot, kind: 'event', name }`.
- Plugin to host: `note.read`, `note.replace` (`{ base, markdown }`: the text it read and the new text; refused with `E_PLUGIN_NOTE_CHANGED` when the note changed since), `ui.show` (`{ height }`), `ui.hide`. Host to plugin: `command.run`, `preview.render` (`{ renderer, source }`, answers Markdown), `import.convert` (`{ format, name, text }`, answers `{ title, markdown }`), `export.convert` (`{ format, title, markdown }`, answers the file's text).
- The host checks every message (`src/core/plugins/protocol.ts`): its shape and size, a known method, the permission behind it and, for the note methods, that one of the plugin's commands is running or its panel is open. Anything else is answered with a code (`E_PLUGIN_METHOD_UNKNOWN`, `E_PLUGIN_PERMISSION_DENIED`, `E_PLUGIN_NOT_ACTIVE`) and logged with the plugin's ID, never its content. A plugin has at most 64 calls waiting and answers within a limit (5 s to draw, 30 s to convert, 60 s for a command).
- An edit goes through the core like every other write that has only the new text: the difference is applied as Yjs operations (`textEdits`), the text before is kept as a version, and the editor applies the update as one undo step.

## Contributions

- Commands show in the palette under the plugin's name. A keymap's key works in the whole window when it is a valid shortcut with Command or Control that no app command, reserved key or earlier plugin uses; otherwise it is dropped and logged.
- Menu items go in the Plugins menu of the menu bar, which Rust builds from the installed plugins' manifests, never from the page; its last item, Plugin Settings…, opens Settings.
- A preview renderer gets the text of each fenced code block of its language and answers Markdown, which the preview renders and sanitizes like note text (so it never adds a script), without running plugin renderers again. A block without an answer in time shows as code. Exported and printed pages show such blocks as code.
- Import and export formats show in File > Import and File > Export and in the palette. Rust shows the panels for the format's extensions, reads the picked files (UTF-8, 5 MiB each, 20 at a time) and writes the exported file whole; the plugin only converts text.

## UI

A plugin has no UI unless it asks while one of its commands runs: `ui.show` opens a sheet in the main window, titled with the plugin's name, with a Close button, showing the plugin's frame (only its page draws inside). Close (or Escape while the keyboard is outside the plugin's frame, which keeps the keys pressed in it) hides it and the plugin is told (`ui.hidden`). The frame is never moved in the page, so showing it never reloads the plugin.

## Consequences

- `docs/architecture.md`, Extensions: the extension API now covers commands, menus, keymaps, preview renderers and import and export formats for plugins; the built-in features keep their internal registries.
- A malicious-plugin suite (`tests/ui/plugins-sandbox.spec.ts`) checks that a plugin cannot reach Tauri, the main window, another plugin, the network or a note without its permission; contract tests cover each contribution point.
- No network permission, persistent storage or note other than the open one in version 1; each needs its own decision.
