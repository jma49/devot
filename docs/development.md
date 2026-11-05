# Developing Devot

How to build, run and test Devot from a checkout. The rules every change follows are in `CLAUDE.md`; the architecture and agreed decisions are in `docs/architecture.md`; how releases are made is in `docs/releasing.md`.

## Requirements

- macOS 26 or later (Apple Silicon or Intel) and the Xcode command line tools (`xcode-select --install`), which are enough to run and test. A bundle with the layered app icon (`pnpm build`, `pnpm build:debug`) needs the full Xcode 26 or later: the command line tools have no `actool`, so the bundler only logs an error and leaves `Assets.car` out, and macOS 26 may then show the flat `icon.icns` in a box (`architecture.md`, Design system).
- Node 24+ and pnpm 12 (`npm install -g pnpm@12`).
- Rust through rustup (`brew install rustup` or [rustup.rs](https://rustup.rs)). `src-tauri/rust-toolchain.toml` pins the release CI uses, with clippy, rustfmt and the iOS simulator target; run `rustup toolchain install` in `src-tauri` once (and again after the pin changes), and every `cargo` there uses it. Make sure `cargo` is on your `PATH`; with Homebrew's rustup, add `$(brew --prefix rustup)/bin`.

## Getting started

```sh
pnpm install                          # also installs the git hooks (lefthook)
pnpm exec playwright install webkit   # once, for the UI tests
pnpm dev                              # run the app with hot reload
pnpm check                            # everything CI runs, plus the dependency audit
```

A build you make yourself checks no license: everything works without one (`README.md`, License). To make an app you can keep in Applications, follow Building locally in `docs/releasing.md`.

Debug builds (`pnpm dev`, `pnpm build:debug`) keep their data in `~/Library/Application Support/io.github.jma49.devot.dev`, apart from the release app's `io.github.jma49.devot`, so development never touches the notes of an installed Devot. A release build made here (`pnpm build`) keeps its data and keychain items in `io.github.jma49.devot.local`: only the release workflow builds with `DEVOT_RELEASE_BUILD=1`, which names them after the installed app. Scripts that start the app never use the release folder (`docs/architecture.md`, App data folder).

## Scripts

| Script                          | What it does                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm build`                    | Release build: `src-tauri/target/release/bundle/macos/Devot.app`                                             |
| `pnpm ui:dev` / `pnpm ui:build` | The UI alone, in a browser                                                                                   |
| `pnpm ui:release`               | The UI for a release build; uploads source maps to Sentry when set up                                        |
| `pnpm sentry:debug-files`       | Upload the release build's debug symbols to Sentry when set up                                               |
| `pnpm test` / `pnpm test:watch` | Vitest                                                                                                       |
| `pnpm test:fast`                | Vitest without the benchmarks and builds (`*.bench.test.ts`); what the pre-push hook runs                    |
| `pnpm test:policy`              | Policy and token tests, which also read the docs; what docs-only pushes and pull requests run                |
| `pnpm test:ui`                  | Playwright UI tests (WebKit, IPC mocked)                                                                     |
| `pnpm bench`                    | Renderer performance baseline into `docs/benchmarks/results.json` (WebKit, IPC mocked)                       |
| `pnpm bench:app`                | Launch time and memory of a built Devot.app (macOS, needs Accessibility)                                     |
| `pnpm tokens` / `tokens:check`  | Compile design tokens into CSS and TS / fail if the output is stale                                          |
| `pnpm app-icon`                 | Make the app icon images in `src-tauri/icons/` from `design/app-icon/` (macOS)                               |
| `pnpm smoke:quit`               | Real-app check that quitting right after typing saves (macOS, needs Accessibility)                           |
| `pnpm rust:check`               | cargo fmt, clippy, tests and cargo-deny; the sync client's tests start the Node relay (after `pnpm install`) |
| `pnpm deps:audit`               | `pnpm audit` for known vulnerabilities in the npm dependencies (high and above)                              |
| `pnpm lint`                     | oxlint, including the architecture boundary rules                                                            |
| `pnpm format`                   | oxfmt                                                                                                        |
| `pnpm typecheck`                | TypeScript for tooling, tests, the core, the UI and the sync relay                                           |

### Targeted UI CI

Pull requests select browser tests separately from the Web and Rust build jobs. `scripts/ci/ui-plan.ts` reads the changed paths from the PR's merge with its base and writes the project, exact spec files and shard count to the UI job matrix. The changes job's summary lists the selected specs.

- A changed UI spec runs that file. A removed spec runs the remaining specs in its project; renames include both old and new paths.
- Exact source allowlists cover Find, update checking, tooltip placement and Mermaid rendering. Their selections include cross-feature consumers and the production CSP suite. For example, tooltip placement also runs note-link hover coverage, Find also runs IME and read-only coverage, and Mermaid also runs export and scroll restoration coverage. Update these mappings when a feature gains another consumer.
- Other sources go by the UI's module graph (`scripts/ci/ui-graph.ts`, read from the import statements): a file a page loads runs the full suite; a file loaded only behind the phone layout's lazy import runs the phone specs; a file no page loads runs no browser. Specs that import a file themselves also run. `tests/scripts/ui-graph.test.ts` fails when a source is unreachable, so a missed import form cannot skip specs.
- UI fixtures, test support, dependency files, build configuration and unknown paths run the full UI suite. A missing mapped spec also falls back to full coverage.
- Documentation-only changes skip the heavy build and test jobs; the always-on `web`, `rust` and `policy` gates still report success. Unit tests, Rust-only, relay and licence-service changes need no browser run, and their existing build, type and Vitest checks still apply.
- Manual workflow runs select the full suite. Empty change lists and missing selection outputs also retain full coverage.

Development and production CSP run in separate jobs, each starting only its own server. Measured development selections target about 400 seconds of recorded work per shard and cap at fourteen; a set without measured durations uses one shard per six spec files, capped at eight. Production CSP currently has one spec and uses one job. The planner assigns each spec to exactly one shard, balancing the recorded durations in `scripts/ci/ui-durations.json`, and each job runs only its own files. Each CI job runs two Playwright workers: four workers on a four-core runner starved WebKit's rendering processes and produced motion and rendering failures. Local runs use the same two unless `DEVOT_UI_WORKERS` raises them. More shards reduce work per runner but still depend on GitHub runner availability and account concurrency limits. Traces from failures and retries retain project and shard names, and each job uploads its JSON report.

The UI shards test the bundle, not Vite's dev server: a page of the bundle loads a few dozen files where the dev server sends each module on its own, and every test opens a fresh page. The `ui-build` job runs `pnpm test:ui:build` once per run and hands `dist-test/` to every shard as an artifact; with `DEVOT_UI_PREBUILT=1` Playwright only serves it (`vite preview` for `webkit`, `scripts/serve-csp.ts` for the production CSP). The UI tests' build keeps its test hooks: in-memory storage, the motion speed factor, and the app functions a few specs call from the page (`window.devotTestModules`, main.tsx).

Pull requests merge through GitHub's merge queue: once a pull request's own CI is green, add it to the queue (Merge when ready). The queue merges it onto the newest `main` together with the pull requests ahead of it, runs the full CI on that commit (`merge_group`), and moves `main` to it only when that run passes, so a pull request no longer has to be brought up to date by hand and several merges share one full run. A newer push to a pull request or to `main` cancels the older run. The queue itself is a repository setting (Settings, Rules, a ruleset on `main` with Require merge queue, merge method Squash, and the required checks `web`, `rust`, `policy` and `title`).

The `changes` job is the path filter. It writes `docs_only=true` when every changed path is documentation, and the expensive jobs then skip; `policy-check` still runs the format check and `pnpm test:policy`, whose tests read the docs. The `web`, `rust` and `policy` jobs always run as small gates, so the required checks are still reported instead of staying pending.

Refresh the recorded durations after a large change, and when `tests/policy/ci-config.test.ts` finds more than five specs the file does not know or one it names that is gone. The reports of a full CI run on `main` measure the runners the shards run on:

```sh
gh run download <run ID> -p 'playwright-results-*' -D /tmp/ui-reports
node scripts/ci/ui-timings.ts scripts/ci/ui-durations.json /tmp/ui-reports/*/report.json
```

A complete local run works too: `PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/ui-report.json pnpm test:ui --reporter=json`, then the same script with `/tmp/ui-report.json`.

Specs the file does not know cost as much as the median known spec. Pricing them at the slowest spec instead left a few new files each holding a shard's worth of planned work, so the measured shards ran far longer than those shards.

`pnpm test:ui` still runs both complete projects locally, building `dist-test/` first (about 20 seconds). `DEVOT_UI_SERVER=dev pnpm test:ui` serves the `webkit` project from Vite's dev server instead, which picks up edits without a build; `DEVOT_UI_PREBUILT=1` reuses the last build. To run an exact selection with only its server:

```sh
DEVOT_UI_PROJECT=webkit DEVOT_UI_TEST_FILES='["tests/ui/tooltips.spec.ts"]' pnpm test:ui
DEVOT_UI_PROJECT=webkit-prod-csp pnpm test:ui
git diff --no-renames --name-only main...HEAD | node scripts/ci/ui-plan.ts
```

An empty file array runs the complete selected project. Invalid project names, malformed selections and missing or cross-project spec paths fail before tests start.

### smoke:quit

`pnpm smoke:quit` runs the debug bundle (`pnpm build:debug --bundles app`) on the debug builds' data folder, never on an installed Devot's: it starts the app with HOME in a temporary folder in which only that folder is real, so a bundle built before debug builds had a folder of their own opens a new database there, and the script stops. Each check starts from an empty database: a dev database that is there first is copied aside with SQLite's online backup (into `smoke-backups/` in that folder) and put back at the end, and the script refuses to start while another process has it open.

### bench

`pnpm bench` and `pnpm bench:app` measure speed and memory; method, machine and numbers are in `docs/benchmarks/README.md`. They are run locally before a release and are not CI jobs (the budgets CI enforces stay in the UI tests).

## iOS

The iPhone app is at an early stage: it builds and starts with the desktop interface; the phone layout comes later. The Xcode project is `src-tauri/gen/apple` (regenerate with `pnpm tauri ios init`), and `src-tauri/tauri.ios.conf.json` holds what differs from the Mac app.

```sh
brew install xcodegen cocoapods
(cd src-tauri && rustup target add aarch64-apple-ios)  # the simulator target comes with rust-toolchain.toml
xcodebuild -downloadPlatform iOS                 # the simulator, once
pnpm tauri ios build --debug --target aarch64-sim  # src-tauri/gen/apple/build/arm64-sim/Devot.app
pnpm tauri ios dev                               # run on a simulator or a connected iPhone
```

Menus, updates, the Settings window, folder pickers and the single-instance socket are desktop only (`cfg(desktop)`); their commands are not registered on a phone, and the UI does not call them for menus or updates (`hasDesktopShell`, `src/renderer/src/platform.ts`). The licence's daily checks run on a phone too (`licence/schedule.rs`). Running on your own iPhone needs a signing team: add your Apple ID in Xcode > Settings > Accounts, then set `bundle.iOS.developmentTeam` or `APPLE_DEVELOPMENT_TEAM`. A build carries no entitlements unless `DEVOT_ICLOUD=YES` is set, so a free personal team works for your own device (its profile lasts seven days). A personal team cannot use the App ID `io.github.jma49.devot`, which belongs to the owner's team: give your build a bundle identifier of your own and keep that change local. Such a build has no iCloud container and offers only the relay for sync. `DEVOT_ICLOUD=YES` adds iCloud, push and the keychain group `WMG3HG38DV.io.github.jma49.devot`, which only the owner's team can sign (docs/releasing.md, iCloud entitlements).

SF Symbols are drawn through UIKit on a phone (`src-tauri/src/native/ios.rs`), so both icon styles work there. Its tests run inside a booted simulator, from `src-tauri`: `CARGO_TARGET_AARCH64_APPLE_IOS_SIM_RUNNER="xcrun simctl spawn booted" cargo test --target aarch64-apple-ios-sim --lib native::` (the filter leaves out desktop-only tests that start processes or open sockets, which fail in the simulator). CI compiles for iOS (`ios-check`, which also runs clippy for the macOS host) and builds the simulator app (`ios-app`), but runs none of these tests, so run them by hand after changing `ios.rs`. The notebook icon catalog is checked against macOS 26 only: on iOS before 26 (the app runs from 15) a newer symbol name can be missing, and the notebook shows the default icon.

StoreKit 2 is Swift-only, so the App Store purchase goes through a Swift package, `src-tauri/apple/DevotStore` (ADR 0014, The native bridge). `src-tauri/gen/apple/project.yml` links it into the iPhone app only, and `native/ios.rs` calls its C functions; Rust sees it through the `AppStore` trait (`src-tauri/src/app_store`), with `FakeAppStore` off iOS and in tests. Its tests need StoreKit Test, which runs only inside an app, so `scripts/ci/devot-store-tests.sh` generates a test project with an empty host app (`TestHost/project.yml`) and runs them on an iPhone simulator: `sh scripts/ci/devot-store-tests.sh` (set `DEVOT_STORE_SIMULATOR` to a simulator's UDID to pick one). CI runs it in `ios-app`. A purchase from the App Store's sandbox, Ask to Buy from a real family and a refund through Apple are checked only on a device.

`DevotStore.storekit` beside the package holds both products (Devot Pro at US$29.99 and the free 30-day Trial) for local runs too. The purchase sheet is only in an App Store build, so build the app as one: Release configuration with `DEVOT_RELEASE_BUILD=1` and `DEVOT_DISTRIBUTION=app-store` in the environment of the build's Rust step, which means starting Xcode from that shell rather than from the Dock. Then in Product > Scheme > Edit Scheme > Run, choose that file under Options > StoreKit Configuration: purchases, refunds and Ask to Buy then come from the file (Debug > StoreKit > Manage Transactions) instead of Apple's sandbox. Keep the scheme change local; `project.yml` regenerates the scheme.

`libc` is held at 0.2.189 in `Cargo.lock`: 0.2.190 limits the `_dyld_*` functions to macOS, and `backtrace` 0.3.76 (through Sentry) still calls them on iOS. Lift the hold once `backtrace` has a release that builds for iOS with the newer `libc`.

## Stacked pull requests

Stack only changes that depend on each other: the same tokens, the same stylesheet, the same module. Independent work still branches from `main` and runs in parallel.

- **Start a layer**: branch from the layer below and open the PR with `gh pr create --base <lower-branch>`. CI runs on every pull request whatever its base.
- **Merge bottom-up**: squash-merge each layer after its CI is green. Then run `scripts/stack/restack.sh <merged-branch> <next-branch> [<further-branch> ...]`: it rebases the next layer onto `main` without the commits the squash replaced, then each further layer onto its rebased parent, points the next PR at `main` and pushes with `--force-with-lease`. Wait for CI on the rebased layer before merging it. `--dry-run` prints the commands only. If the merged branch was deleted, the script reads its last commit from the PR; `--old-tip <sha>` gives it explicitly.
- **Conflicts**: the script stops with exit 1, leaves the rebase in progress and prints the resume command. Resolve the conflict, run `git rebase --continue`, then run `scripts/stack/restack.sh --onto <rebased-branch> <remaining layers...>`: it rebases the remaining layers onto the resolved branch and pushes them, then pushes the resolved branch. With no layers left, push the resolved branch yourself with `--force-with-lease`.
- **Release**: before a beta, line the release's PRs up as one stack. Build the QA debug app from the top layer and device-check once, merge bottom-up, then tag from `main` (`docs/releasing.md`).

## Layout

| Path                     | Contents                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/renderer`           | React UI (runs in the webview)                                                                            |
| `src/core`               | Core library: plain TypeScript, no Tauri, no Node built-ins                                               |
| `src-tauri`              | Rust app: commands, storage, native macOS code (`src/native`), the MCP bridge (`src/mcp_bridge`)          |
| `relay`                  | Sync relay, deployed on its own (`docs/sync-relay.md`)                                                    |
| `src-tauri/capabilities` | Which window may call which command                                                                       |
| `tests`                  | Vitest tests (core, policy, security, relay, licence, UI code, scripts, tokens) and UI tests (Playwright) |
| `design`                 | Design tokens, the icon map and the app icon source                                                       |
| `docs`                   | Architecture, decisions and the release process                                                           |

## README clips

The animated WebP files in `docs/images/` are the website's recordings of the real app. The website repo's media pipeline ([jma49/devot-site](https://github.com/jma49/devot-site)) records them and keeps the original 2x frames (`<slot>/<light|dark>/00000.png`, 30 fps). `scripts/readme-clips.sh` converts those frames to looping, lossy WebP at 15 frames per second (needs `img2webp`, `ffprobe` and an `ffmpeg` that reads animated WebP):

```sh
scripts/readme-clips.sh /path/to/devot-site/.cache/media/frames
```

It writes light and dark files to `docs/images/`: the hero at 1280 px wide, Write, Organise and Find at 800 px, and three `cards-N` rows that each pair two clips at the same height, the largest at which both and a 24 px gap fit in 1600 px, on a transparent canvas. Wide cards show the top 1312 by 820 px of their frames, the part the website shows. The shorter clip of a pair holds its last frame until the longer one ends. Clips are only ever scaled uniformly: after writing each file the script measures every clip in it and stops with `E_CLIP_RATIO` if one's aspect ratio is more than 0.5% off its source's. Every clip has rounded corners and a hairline edge (black at 12% on light, white at 10% on dark) so it stands out on GitHub's page. Each file stays under 2.5 MB; `tests/policy/readme-images.test.ts` checks that every image the README references exists and fits.

## Crash reporting in local builds

Builds report crashes to Sentry only when they are made with a DSN. Copy `.env.example` to `.env.local` (git-ignored) and set:

- `DEVOT_SENTRY_DSN`: turns on reports of Rust panics, UI errors and native crashes (a native crash is sent on the next launch).
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` (all three or none): `pnpm build` then uploads the UI's source maps and the app's debug symbols to Sentry. They never ship in the app.

Environment variables win over `.env.local`. Details: `docs/architecture.md`, Crash reporting and logs.

To measure what crash reporting costs at launch and when idle, build the app with and without a DSN and run `bash scripts/perf/launch-cost.sh <Devot.app>` on each (steps in the same section). It runs the app on a temporary data folder, never an installed Devot's.
