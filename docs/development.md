# Developing Devot

How to build, run and test Devot from a checkout. The rules every change follows are in `CLAUDE.md`; the architecture and agreed decisions are in `docs/architecture.md`; how releases are made is in `docs/releasing.md`.

## Requirements

- macOS 26 or later (Apple Silicon or Intel) and the Xcode command line tools (`xcode-select --install`), which are enough to run and test. A bundle with the layered app icon (`pnpm build`, `pnpm build:debug`) needs the full Xcode 26 or later: the command line tools have no `actool`, so the bundler only logs an error and leaves `Assets.car` out, and macOS 26 may then show the flat `icon.icns` in a box (`architecture.md`, Design system).
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

| Script                          | What it does                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm build`                    | Release build: `src-tauri/target/release/bundle/macos/Devot.app`                          |
| `pnpm ui:dev` / `pnpm ui:build` | The UI alone, in a browser                                                                |
| `pnpm mcp:build`                | Build devot-mcp into `dist-mcp/devot-mcp.mjs`                                             |
| `pnpm ui:release`               | The UI for a release build; uploads source maps to Sentry when set up                     |
| `pnpm sentry:debug-files`       | Upload the release build's debug symbols to Sentry when set up                            |
| `pnpm test` / `pnpm test:watch` | Vitest                                                                                    |
| `pnpm test:fast`                | Vitest without the benchmarks and builds (`*.bench.test.ts`); what the pre-push hook runs |
| `pnpm test:ui`                  | Playwright UI tests (WebKit, IPC mocked)                                                  |
| `pnpm bench`                    | Renderer performance baseline into `docs/benchmarks/results.json` (WebKit, IPC mocked)    |
| `pnpm bench:app`                | Launch time and memory of a built Devot.app (macOS, needs Accessibility)                  |
| `pnpm tokens` / `tokens:check`  | Compile design tokens into CSS and TS / fail if the output is stale                       |
| `pnpm app-icon`                 | Make the app icon images in `src-tauri/icons/` from `design/app-icon/` (macOS)            |
| `pnpm smoke:quit`               | Real-app check that quitting right after typing saves (macOS, needs Accessibility)        |
| `pnpm rust:check`               | cargo fmt, clippy, tests and cargo-deny                                                   |
| `pnpm deps:audit`               | `pnpm audit` for known vulnerabilities in the npm dependencies (high and above)           |
| `pnpm lint`                     | oxlint, including the architecture boundary rules                                         |
| `pnpm format`                   | oxfmt                                                                                     |
| `pnpm typecheck`                | TypeScript for tooling, tests, the core and the UI                                        |

### smoke:quit

`pnpm smoke:quit` runs the debug bundle (`pnpm build:debug --bundles app`) on the debug builds' data folder, never on an installed Devot's: it starts the app with HOME in a temporary folder in which only that folder is real, so a bundle built before debug builds had a folder of their own opens a new database there, and the script stops. Each check starts from an empty database: a dev database that is there first is copied aside with SQLite's online backup (into `smoke-backups/` in that folder) and put back at the end, and the script refuses to start while another process has it open.

### bench

`pnpm bench` and `pnpm bench:app` measure speed and memory; method, machine and numbers are in `docs/benchmarks/README.md`. They are run locally before a release and are not CI jobs (the budgets CI enforces stay in the UI tests).

## iOS

The iPhone app is at an early stage: it builds and starts with the desktop interface; the phone layout comes later. The Xcode project is `src-tauri/gen/apple` (regenerate with `pnpm tauri ios init`), and `src-tauri/tauri.ios.conf.json` holds what differs from the Mac app.

```sh
brew install xcodegen cocoapods
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
xcodebuild -downloadPlatform iOS                 # the simulator, once
pnpm tauri ios build --debug --target aarch64-sim  # src-tauri/gen/apple/build/arm64-sim/Devot.app
pnpm tauri ios dev                               # run on a simulator or a connected iPhone
```

Menus, updates, the Settings window, folder pickers and the single-instance socket are desktop only (`cfg(desktop)`); their commands are not registered on a phone. Running on your own iPhone needs a signing team: add your Apple ID in Xcode > Settings > Accounts, then set `bundle.iOS.developmentTeam` or `APPLE_DEVELOPMENT_TEAM`. A free personal team works for your own device; its profile lasts seven days.

SF Symbols are drawn through UIKit on a phone (`src-tauri/src/native/ios.rs`), so both icon styles work there. Its tests run inside a booted simulator, from `src-tauri`: `CARGO_TARGET_AARCH64_APPLE_IOS_SIM_RUNNER="xcrun simctl spawn booted" cargo test --target aarch64-apple-ios-sim --lib native::` (the filter leaves out desktop-only tests that start processes or open sockets, which fail in the simulator). CI has no iOS job, so run them by hand after changing `ios.rs`. The notebook icon catalog is checked against macOS 26 only: on iOS before 26 (the app runs from 15) a newer symbol name can be missing, and the notebook shows the default icon.

`libc` is held at 0.2.189 in `Cargo.lock`: 0.2.190 limits the `_dyld_*` functions to macOS, and `backtrace` 0.3.76 (through Sentry) still calls them on iOS. Lift the hold once `backtrace` has a release that builds for iOS with the newer `libc`.

## Stacked pull requests

Stack only changes that depend on each other: the same tokens, the same stylesheet, the same module. Independent work still branches from `main` and runs in parallel.

- **Start a layer**: branch from the layer below and open the PR with `gh pr create --base <lower-branch>`. CI runs on every pull request whatever its base.
- **Merge bottom-up**: squash-merge each layer after its CI is green. Then run `scripts/stack/restack.sh <merged-branch> <next-branch> [<further-branch> ...]`: it rebases the next layer onto `main` without the commits the squash replaced, then each further layer onto its rebased parent, points the next PR at `main` and pushes with `--force-with-lease`. Wait for CI on the rebased layer before merging it. `--dry-run` prints the commands only. If the merged branch was deleted, the script reads its last commit from the PR; `--old-tip <sha>` gives it explicitly.
- **Conflicts**: the script stops with exit 1 and leaves the rebase in progress. Resolve it, run `git rebase --continue`, push, and run the script again for the layers that are not rebased yet.
- **Release**: before a beta, line the release's PRs up as one stack. Build the QA debug app from the top layer and device-check once, merge bottom-up, then tag from `main` (`docs/releasing.md`).

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

## README clips

The animated WebP files in `docs/images/` are the website's recordings of the real app. The website repo's media pipeline ([jma49/devot-site](https://github.com/jma49/devot-site)) records them; the README versions are converted from its 2x frames at 15 frames per second, 1280 px wide for the hero and 800 px for the rest, then encoded as lossy, looping WebP:

```sh
ffmpeg -framerate 30 -i frames/%05d.png -vf "fps=15,scale=800:-2:flags=lanczos" tmp/%04d.png
img2webp -loop 0 -lossy -q 90 -m 6 -d 67 tmp/*.png -o docs/images/write.webp
```

Each file stays under 2.5 MB; `tests/policy/readme-images.test.ts` checks that every image the README references exists and fits.

## Crash reporting in local builds

Builds report crashes to Sentry only when they are made with a DSN. Copy `.env.example` to `.env.local` (git-ignored) and set:

- `DEVOT_SENTRY_DSN`: turns on reports of Rust panics, UI errors and native crashes (a native crash is sent on the next launch).
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` (all three or none): `pnpm build` then uploads the UI's source maps and the app's debug symbols to Sentry. They never ship in the app.

Environment variables win over `.env.local`. Details: `docs/architecture.md`, Crash reporting and logs.

To measure what crash reporting costs at launch and when idle, build the app with and without a DSN and run `bash scripts/perf/launch-cost.sh <Devot.app>` on each (steps in the same section). It runs the app on a temporary data folder, never an installed Devot's.
