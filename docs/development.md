# Developing Devot

How to build, run and test Devot from a checkout. The rules every change follows are in `CLAUDE.md`; the architecture and agreed decisions are in `docs/architecture.md`; how releases are made is in `docs/releasing.md`.

## Requirements

- macOS 26 or later (Apple Silicon or Intel) and the Xcode command line tools (`xcode-select --install`).
- Node 24+ and pnpm 12 (`npm install -g pnpm@12`).
- Rust through rustup (`brew install rustup` or [rustup.rs](https://rustup.rs), then `rustup default stable`). Make sure `cargo` is on your `PATH`; with Homebrew's rustup, add `$(brew --prefix rustup)/bin`.

## Getting started

```sh
pnpm install                          # also installs the git hooks (lefthook)
pnpm exec playwright install webkit   # once, for the UI tests
pnpm dev                              # run the app with hot reload
pnpm check                            # everything CI runs, plus the dependency audit
```

Debug builds (`pnpm dev`, `pnpm build:debug`) keep their data in `~/Library/Application Support/io.github.jma49.devot.dev`, apart from the release app's `io.github.jma49.devot`, so development never touches the notes of an installed Devot. Scripts that start the app never use the release folder (`docs/architecture.md`, App data folder).

## Scripts

| Script                          | What it does                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm build`                    | Release build: `src-tauri/target/release/bundle/macos/Devot.app`                   |
| `pnpm ui:dev` / `pnpm ui:build` | The UI alone, in a browser                                                         |
| `pnpm mcp:build`                | Build devot-mcp into `dist-mcp/devot-mcp.mjs`                                      |
| `pnpm ui:release`               | The UI for a release build; uploads source maps to Sentry when set up              |
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

### smoke:quit

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
| `docs`                   | Architecture, decisions and the release process               |

## Crash reporting in local builds

Builds report crashes to Sentry only when they are made with a DSN. Copy `.env.example` to `.env.local` (git-ignored) and set:

- `DEVOT_SENTRY_DSN`: turns on reports of Rust panics, UI errors and native crashes (a native crash is sent on the next launch).
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` (all three or none): `pnpm build` then uploads the UI's source maps and the app's debug symbols to Sentry. They never ship in the app.

Environment variables win over `.env.local`. Details: `docs/architecture.md`, Crash reporting and logs.

To measure what crash reporting costs at launch and when idle, build the app with and without a DSN and run `bash scripts/perf/launch-cost.sh <Devot.app>` on each (steps in the same section). It runs the app on a temporary data folder, never an installed Devot's.
