# Devot

A local-first Markdown note-taking app for macOS 26 and later, built with Tauri. Your notes live in a SQLite database on your Mac; every feature works without an account or a network connection.

**Status:** milestone 1 (phase 1, the macOS MVP) is complete. There are no binary releases yet, no signed or notarised builds (local builds are ad-hoc signed) and no automatic updates: build it from source (see Development). Sync, AI edit proposals and iOS come in phases 2 and 3 (`docs/architecture.md`, Phases).

## What you get

- **Organise:** nestable notebooks, tags, note statuses (none, active, on hold, completed, dropped), pinning and a Trash.
- **Write:** a Markdown editor with a safe live preview, math, Mermaid diagrams and emoji built in, pasted images and other attachments, and a distraction-free mode.
- **Connect:** `[[` note links with a link index, and full-text search.
- **Look:** light and dark themes, and an option for an opaque sidebar. A local activity heatmap shows when you write; usage events stay on your device.
- **Bring notes in and out:** import a Markdown folder; export to Markdown or HTML; print; keep a Markdown mirror folder up to date (below).
- **Stay safe:** automatic daily local backups with restore (Devot > Backups…), and local logs that carry codes and IDs, never note content.
- **Work with AI, on your terms:** devot-mcp gives Claude and other MCP clients read access (search, read) and note creation, only in notebooks you allow (below).
- **Crash reports (optional):** off unless a build is made with a Sentry DSN (below).

## Development

Requires macOS 26 or later (Apple Silicon or Intel), the Xcode command line tools (`xcode-select --install`), Node 24+, pnpm 12 (`npm install -g pnpm@12`) and Rust through rustup (`brew install rustup` or [rustup.rs](https://rustup.rs), then `rustup default stable`). Make sure `cargo` is on your `PATH`; with Homebrew's rustup, add `$(brew --prefix rustup)/bin`.

```sh
pnpm install                          # also installs the git hooks (lefthook)
pnpm exec playwright install webkit   # once, for the UI tests
pnpm dev                              # run the app with hot reload
pnpm check                            # everything CI runs, plus the dependency audit
```

Debug builds (`pnpm dev`, `pnpm build:debug`) keep their data in `~/Library/Application Support/io.github.jma49.devot.dev`, apart from the release app's `io.github.jma49.devot`, so development never touches the notes of an installed Devot. Scripts that start the app never use the release folder (`docs/architecture.md`, App data folder).

| Script                          | What it does                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm build`                    | Release build: `src-tauri/target/release/bundle/macos/Devot.app`                   |
| `pnpm ui:dev` / `pnpm ui:build` | The UI alone, in a browser                                                         |
| `pnpm mcp:build`                | Build devot-mcp into `dist-mcp/devot-mcp.mjs` (see below)                          |
| `pnpm ui:release`               | The UI for a release build; uploads source maps to Sentry when set up (see below)  |
| `pnpm sentry:debug-files`       | Upload the release build's debug symbols to Sentry when set up                     |
| `pnpm test` / `pnpm test:watch` | Vitest                                                                             |
| `pnpm test:ui`                  | Playwright UI tests (WebKit, IPC mocked)                                           |
| `pnpm tokens` / `tokens:check`  | Compile design tokens into CSS and TS / fail if the output is stale                |
| `pnpm smoke:quit`               | Real-app check that quitting right after typing saves (macOS, needs Accessibility) |
| `pnpm rust:check`               | cargo fmt, clippy, tests and cargo-deny                                            |
| `pnpm deps:audit`               | `pnpm audit` for known vulnerabilities in the npm dependencies (high and above)    |
| `pnpm lint`                     | oxlint, including the architecture boundary rules                                  |
| `pnpm format`                   | oxfmt                                                                              |
| `pnpm typecheck`                | TypeScript for tooling, tests, the core and the UI                                 |

`pnpm smoke:quit` runs the debug bundle (`pnpm build:debug --bundles app`) on the debug builds' data folder, never on an installed Devot's: it starts the app with HOME in a temporary folder in which only that folder is real, so a bundle built before debug builds had a folder of their own opens a new database there, and the script stops. Each check starts from an empty database: a dev database that is there first is copied aside with SQLite's online backup (into `smoke-backups/` in that folder) and put back at the end, and the script refuses to start while another process has it open.

## Layout

| Path                     | Contents                                                      |
| ------------------------ | ------------------------------------------------------------- |
| `src/renderer`           | React UI (runs in the webview)                                |
| `src/core`               | Core library: plain TypeScript, no Tauri, no Node built-ins   |
| `src/mcp`                | devot-mcp (Node): the MCP tools and the better-sqlite3 store  |
| `src-tauri`              | Rust app: commands, storage, native macOS code (`src/native`) |
| `src-tauri/capabilities` | Which window may call which command                           |
| `tests`                  | Security tests (Vitest) and UI tests (Playwright)             |
| `design`                 | Design tokens, the icon map and the app icon source           |
| `docs`                   | Architecture and decisions                                    |

## Contributing

Fork the repository, work on a branch and open a pull request with a Conventional Commits title (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`). CI must pass before a pull request is merged; `pnpm check` runs the same checks locally. Changes reach `main` only through pull requests, and the `pre-push` hook blocks direct pushes. The rules every change follows are in `CLAUDE.md`; see also `docs/architecture.md`, Quality. Report security problems privately, as `SECURITY.md` describes.

## Crash reports (optional)

Builds report crashes to Sentry only when they are made with a DSN (`DEVOT_SENTRY_DSN`); a build without one, such as any build from a fresh clone, sends nothing and starts no crash reporter. Copy `.env.example` to `.env.local` (git-ignored) and set:

- `DEVOT_SENTRY_DSN`: turns on reports of Rust panics, UI errors and native crashes (a native crash is sent on the next launch).
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` (all three or none): `pnpm build` then uploads the UI's source maps and the app's debug symbols to Sentry. They never ship in the app.

Environment variables win over `.env.local`. Details: `docs/architecture.md`, Crash reporting and logs.

To measure what crash reporting costs at launch and when idle, build the app with and without a DSN and run `bash scripts/perf/launch-cost.sh <Devot.app>` on each (steps in the same section). It runs the app on a temporary data folder, never an installed Devot's.

## Markdown mirror

Settings > Markdown Mirror (or Choose Markdown Mirror Folder… in the command palette) keeps a folder you pick up to date with every note as a Markdown file, laid out like an export: a folder per notebook, a file per note, images in an `attachments` folder. Editors, `grep`, Git, Spotlight and agents can then read your notes without an export, and importing the folder gives the same notes back. Templates and the Trash are left out.

The folder is written by Devot and never read back: edit notes in Devot. A mirrored file you change elsewhere is never overwritten: Devot renames it to `<name> (edited outside Devot).md`, tells you, and writes its own version. Files Devot did not write are never changed. Include Attachments (on by default) decides whether images are copied too. If the folder goes missing (an unplugged drive) or cannot be written, the mirror pauses and resumes by itself once it can. If the list of files Devot wrote there (`.devot-mirror.json`) goes missing or is damaged, the mirror pauses until you choose the folder again (or put the file back); files that still hold what Devot wrote are then taken back, so nothing is written twice.

## Claude and other MCP clients (devot-mcp)

devot-mcp lets Claude Code, Claude Desktop and other MCP clients search, read and create Devot notes. It is a small Node program that clients start over stdio; it reads Devot's database directly, so it works whether Devot is open or not. Notes it creates appear in an open Devot within a second.

**Only notebooks with Allow AI Access on are visible.** Right-click a notebook in the sidebar and choose Allow AI Access; a sparkle marks the notebooks that have it. The switch is per notebook: a sub-notebook needs its own. Notes in the Trash and notes in no notebook are never visible.

Tools: `list_notebooks`, `search_notes` (full text, with snippets), `read_note` (Markdown and metadata) and `create_note` (in an allowed notebook, by ID or exact name).

Build it once from this checkout (and again after pulling changes):

```sh
pnpm install
pnpm mcp:build        # writes dist-mcp/devot-mcp.mjs
```

Run Devot once before using it, so the database exists and is up to date; devot-mcp never creates or upgrades the database itself. It reads the release app's `~/Library/Application Support/io.github.jma49.devot/devot.sqlite`; pass `--db <path>` to use another file, such as a debug build's in `io.github.jma49.devot.dev`.

**Claude Code:**

```sh
claude mcp add --scope user devot -- node "$PWD/dist-mcp/devot-mcp.mjs"
```

Run it from the repository root. `claude mcp list` shows whether it connected.

**Claude Desktop:** add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (Settings > Developer > Edit Config), with absolute paths, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "devot": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/devot/dist-mcp/devot-mcp.mjs"]
    }
  }
}
```

Use the Node that ran `pnpm install` (`which node` prints its path): better-sqlite3 is a native module built for that version. devot-mcp writes its logs (codes and IDs only, never note text) to stderr; errors returned to the client start with a code such as `E_STORAGE_SCHEMA_TOO_OLD`.
