# Quality

Part of the [architecture overview](../architecture.md).

## Priorities

When trade-offs collide: **data integrity > security > performance > functional correctness > visual polish.**
Losing or corrupting a note is the one failure that cannot be undone.

## Test layers

1. **Unit (Vitest):** most TypeScript tests.
   The core library is plain TypeScript and its unit tests run in milliseconds.
2. **Integration (Vitest + real SQLite):** the core with its better-sqlite3 adapter on temporary database files; the database is never mocked.
   Covers the data layer, import and export, the link index and MCP.
3. **Property-based (Vitest + fast-check):** random operation sequences checked against invariants, for example: Yjs edits converge in any order; the link index always matches note bodies; a purge deletes only the attachments no note left shows.
   Markdown export then import is checked by example round trips (`tests/core/export.test.ts`), not yet by a property test (phase 2).
4. **Rust (cargo test):** command validation, storage on temporary SQLite files, and native code.
   Tests that touch WebKit run on the main thread in harness-free test binaries (`harness = false`), because libtest's worker threads crash WebKit.
5. **UI integration (Playwright, WebKit engine, phase 1):** the real UI in the UI tests' build (`vite.ui-test.config.ts`: notes in an in-memory storage), bundled and served by `vite preview` (`DEVOT_UI_SERVER=dev` serves it from Vite's dev server; `tests/support/ui-servers.ts`), with Tauri's IPC mocked and `Object.prototype` frozen in the main frame, as the app does.
   Real keyboard input works here.
   Runs on Linux CI.
   A second project (`tests/ui-csp`) runs the built UI under the production CSP (`scripts/serve-csp.ts`), because `pnpm dev` relaxes the policy.
   Each checkout serves on ports derived from its folder (`tests/support/ports.ts`; `DEVOT_UI_PORT` and `DEVOT_CSP_PORT` move them), and a server already answering on one fails the run unless `DEVOT_REUSE_SERVERS=1`.
   In dev mode Vite pre-bundles the core worker's dependencies up front (`optimizeDeps.entries`), and a test fails if Vite re-bundles under an open page.
   The window sets `data-ready` on `.window` once its lists have loaded and its last state is restored; tests open and reload the app with `openApp` and `reloadApp` (`tests/ui/fixtures.ts`), which wait for it, and check for a positive sign (a write, a notice) before they check that something did not happen.
   Timing tests poll or compare growth between sizes; none relies on a wall-clock limit that load can break.
6. **Full-app end-to-end (WebdriverIO + `@wdio/tauri-service`, phase 2):** a few critical flows in the built app on macOS, through the embedded WebDriver (debug builds only).
   Its `browser.keys` does not type into CodeMirror; text goes in with `addValue`.
   Real keyboard and IME input stay manual checks.

## Data integrity

- **Crash safety:** a test kills the app at random points during writes, reopens the database, and checks that every committed change is intact and the WAL recovers.
- **Schema migrations:** a fixture database is kept for every released schema version; each must upgrade to the current one.
- **Merge convergence:** property tests over Yjs edits (see above).
- **Automatic local backups (phase 1):** a daily snapshot through SQLite's online backup API into `<app data>/backups/devot-<UTC time>-<number>.sqlite`.
  A background thread checks 20 s after launch and then hourly; a backup is due when the last one taken (safety copies aside) is a day old.
  Each check, and every backup or restore, first removes what a quit during a snapshot left (its private folder), so a nearly full disk gets that room back even when the next snapshot fails.
  It copies from its own read-only connection in one step (a consistent read; WAL keeps writers going), checks the copy with `quick_check`, and renames it into place, never over another file (SQLite writes it in a new private folder in `backups/`, see Security).
  Devot > Backups… lists them, the last taken first; restoring asks first, copies the current data aside as a safety copy (`devot-<UTC time>-<number>-before-restore.sqlite`, listed with the backups; when the live database itself fails that copy's `quick_check`, the very case a restore is for, it keeps the database's bytes with its `-wal` and `-shm` instead, `…-before-restore-raw.sqlite`, logs `W_BACKUP_SAFETY_RAW`, and the sheet marks that copy Unverified; any other failure to take the copy still calls the restore off), checks the snapshot with `quick_check` (a damaged one is refused, `E_BACKUP_DAMAGED`), copies it into the open database (waiting at most 10 s for another process's lock, then `E_STORAGE_BUSY`), migrates it, and reloads the window.
  The raw copy reads the three files through `/bin/cat` in a process of its own, on the database's thread, and keeps a file only when `cat` exits cleanly, since closing any descriptor of a file in the app's process would drop every POSIX lock it holds on it, the app's own SQLite locks included (#761).
  Every other window with a core of its own (each main window, `main` hidden too, and each note window) is asked first (`devot://restore-prepare`): it saves, holds compaction, stops its core and answers (`backup_restore_ready`); a window that has not answered in 5 seconds calls the restore off (`E_BACKUP_RESTORE_WINDOWS`).
  Once the restore is over, ran or not, each of them reloads (`devot://restore-done`).
  From its start until those are sent, every restore, one with no other window to ask too, refuses another (`E_BACKUP_RESTORE_BUSY`, `RestorePhase` in `src-tauri/src/backups.rs`).
  So no window writes the notes it held from before the restore back over it, and the compaction in `main` is held wherever the restore starts.
  Failures are logged by code and shown as a notice.
  While sync is on, a restore is refused (`E_BACKUP_SYNC_ON`, said in the sheet): the relay's newer clocks would win the next sync's merges and its purges are final, so the restore would be undone within a cycle.
  A restore made with sync off sets `restoredAt` in `sync_state`.
  When sync is next turned on, the engine connects to nothing while that marker is there (`E_SYNC_RESTORE_CHOICE`, in Settings as advice) and the main window asks (`RestoreSyncChoice.tsx`, ADR 0013): **Merge**, the default (Return and Escape), syncs as usual, so the other devices' later changes come back; **Keep This Mac's Copy** gives every field of every live note, note tag, notebook, tag and saved search here a fresh HLC (`keepRestored` in `src/core/sync/engine.ts`) and, during the next full pull, edits a body another device changed before the choice back to this device's text on top of the merged state (`keptBody`), so every device ends with the restored notes.
  Either way the marker is cleared, and the dialog says that a note purged on another device cannot come back (a purge is final).
  Merge also clears a Keep's mark (`keepRestoredBefore`) the restored library may hold, so it merges as usual.
  Keep is recorded first (`keepingRestored`, holding the marker's value) and the marker is cleared only once every record is stamped: a Keep cut off part-way (a storage failure) is reported like any sync failure, and the next connect carries it on from the start instead of asking again; a note a window saved while Keep ran is read again and stamped.
  A restored library that never synced (no `hasSynced` in `sync_state`) is not asked about.
  Notes made elsewhere after the backup are not in it and stay.
  Restore has its own test.
  - **Order and retention** (`src-tauri/src/backups.rs`): backups go in the order they were taken, which the number keeps (one more than the highest in the folder), never by the time in the name, so a clock set back or ahead can neither make a new backup the first to go nor keep a future one the newest.
    Taking a backup (daily or Back Up Now) keeps the last 7 backups and, apart from them, the last 7 safety copies, raw ones among them, whose side files go with them (enough to restore each backup in turn and still go back), and never removes the one just taken.
    It also keeps the first safety copy taken after each of the 7 backups it keeps, since that copy holds the notes from before a run of restores, which no backup has; it goes with the backup before it.
    A restore removes nothing.
    Names from before backups were numbered still list and restore, before every numbered one.
  - **Clock changes:** the thread takes a backup only when it has not taken one itself in the last 24 hours by a clock that setting the time does not move and that keeps counting while the Mac sleeps (`CLOCK_MONOTONIC`, through `native::macos::time_since_boot`; Rust's `Instant` stops during sleep), as well as when the newest backup is a day old by the wall clock.
    When the newest backup is from the future (the clock was set back), its age is unknown, and only the first rule applies.
    So a clock set back, or a slow clock set right, costs a backup a day, never one an hour, and a Mac that sleeps still backs up daily.
  - **Partial snapshots:** a quit or crash during a snapshot leaves its private folder behind.
    Every check and every backup removes such folders (with older builds' `.partial` files and the side files of backups that are gone) while this process takes no snapshot; a snapshot also locks its folder (`flock`) while SQLite writes in it, and a locked folder is never removed, whoever tidies.
    Links and anything outside `backups/` are never touched.

## Security tests

From phase 1:

- A known XSS payload corpus run through the HTML sanitizer; every payload must come out inert.
- Every Tauri command is declared in `build.rs` (from its area's list in `build_commands.rs`) and granted only by capability files; `tests/security/capabilities.test.ts` checks that each declared command is granted explicitly and that no other app permission is granted.
- Command argument validation is unit-tested in Rust.
- The CSP blocks external resource loads (`tests/security/csp.test.ts`).
- Files are never written through a folder swapped for a link: Rust tests swap a folder on the way for a link between a writer's checks and its step (`atomic_file::race`, for the Markdown mirror's writes, moves, removals and kept files, notebook exports and their attachments) or after the folder was chosen (an export session's, a PDF's, the mirror's own), and check that nothing lands, moves or goes outside; `tests/policy/one-writer.test.ts` keeps folder changes by path out of the writers of folders the user chose.
- MCP cannot read notebooks without AI access: `tests/core/ai.test.ts`, `tests/core/http-api.test.ts` and the bridge's tests in `src-tauri/src/mcp_bridge/` (over a real socket) check on real SQLite that notes in other notebooks, in sub-notebooks, in no notebook, in deleted notebooks, in the Trash or purged are invisible to every tool; `tests/core/http-api.test.ts` checks the same for the local HTTP API, and `tests/core/ai-storage.test.ts` that the AI queries made of plain storage calls (the app's) answer as the tests' SQLite adapter's.
- The local HTTP API's guards: `src-tauri/src/http_api/tests.rs` (see Local HTTP API).

## Static checks

- TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; oxlint and oxfmt.
- Architecture boundaries enforced by lint rules: the core library imports neither `@tauri-apps/*`, `better-sqlite3` nor `node:*`; the UI imports no Node modules.
- Rust: `cargo fmt`, `cargo clippy -D warnings`, `unsafe_code = "deny"` outside `native::macos` and `native::ios`, and `cargo deny` (licences, advisories, sources) for the targets Devot ships.
- Dependencies: every new dependency needs a stated reason in its PR; `pnpm audit` and `cargo deny` must pass.

## Coverage

Coverage is reported, not gated: a percentage is easy to game.
Every PR must test the logic it changes, which review checks.

## CI

- GitHub Actions on hosted Linux and macOS runners of the standard size, free for a public repository: quick static checks (`web-checks`: `pnpm deps:audit`, tokens, format, lint, type check), unit and integration tests in their own job, UI tests (`ui`: Playwright WebKit in up to fourteen measured development shards, balanced by recorded durations, plus a separate production CSP job, two workers per runner), and Rust checks split between a compile/test job (`rust-check`: fmt, clippy, tests), the iPhone jobs below, a macOS job that runs clippy on the macOS host and for the iOS simulator (`ios-check`), a `macos-26` job for the signing scripts' tests and the StoreKit tests (`mac-tests`, in both the `web` and the `rust` gate), and a parallel manifest-only `deny` job, all started together.
  The required `web`, `rust` and `policy` gates sum up their actual jobs and write the results to the run summary.
  `pnpm check` runs the same steps in one go (`pnpm deps:audit` and `cargo deny check` are the dependency checks: `pnpm audit` for npm, advisories, licences and sources for Rust), and a policy test (`tests/policy/ci-config.test.ts`) fails when the two drift apart. macOS-only code is behind `cfg(target_os = "macos")`: `ios-check` compiles and lints it on every pull request that needs the Rust jobs, and the `pre-push` hook compiles and tests it locally when a push changes Rust or Cargo files.
- A pull request's run is meant to end within ten minutes.
  The account runs at most five macOS jobs at once, and a job waiting for one of them, or waiting behind another job's steps, was the slowest part of a run.
  So a pull request runs at most five macOS jobs at a time, each under ten minutes: `iphone-build`, one `iphone-ui` shard, `mac-tests` and, only when their own inputs change, the two `ios-app` jobs start together, and `ios-check` takes `iphone-build`'s runner once that has ended.
  A full run (the merge queue, main, a manual run) tests everything and has more jobs than runners, so it takes about twice as long.
  A push to main is compared with main's last run that passed, not with its parent, since a newer push cancels main's run and the parent may never have been tested (`scripts/ci/last-green.ts`, `scripts/ci/main-plan.sh`).
  When nothing but documentation changed since then, it runs only the always-on gates; otherwise it runs in full, less the tests of a Swift package nothing touched.
  The five macOS runners are shared by every run of the account, so a documentation commit on main that ran in full held up the pull requests behind it for half an hour.
- The iPhone jobs (`ios-check`, `ios-app`, `iphone-build`, `iphone-ui`) and the App Store build run on the `xcode-27` runner image with Xcode 27.2, and the simulator jobs test on an iPhone 17 with iOS 27.2, the toolchain of local development.
  The StoreKit tests are the exception: they run in `mac-tests` on `macos-26`, on iOS 26.2, because StoreKit Test hangs under xcodebuild on the iOS 27 simulators (iOS 27.2 never returns from a purchase given a simulated error and sends no transaction update for a refund) and is broken on iOS 26.4 and 26.5 (`scripts/ci/iphone-simulator.ts --storekit` lists the broken versions).
  A StoreKit test that hangs fails after two minutes.
  The pins are `DEVOT_XCODE` and `DEVOT_IOS` in `ci.yml` (`app-store.yml` pins the same Xcode); `scripts/ci/xcode.sh` selects the Xcode by path and `scripts/ci/iphone-simulator.ts` picks the phone, and each fails the job at once when the image lacks its pin, so no job falls back to the image's default Xcode.
  The Mac release and `mac-tests` stay on `macos-26`.
  The app still deploys to iOS 26.0, which CI checks at compile time only (`ios-check` typechecks the generated Swift for `arm64-apple-ios26.0-simulator`, and `#available` guards newer APIs); no job runs an iOS 26 simulator.
  A simulator job boots its phone in the background right after setup, and each test script waits for the boot through `scripts/ci/iphone-simulator-ready.sh`, which runs `simctl bootstatus -b` a second time when the first races the background boot and fails with "current state: Booted".
- `ios-app`, a macOS job in the `rust` gate, runs the screens package's XCTests in an empty host app on an iPhone simulator (`scripts/ci/devot-screens-tests.sh`), since UIKit needs an app; `mac-tests` runs the StoreKit package's the same way (`scripts/ci/devot-store-tests.sh`).
  It installs no npm packages and builds no Rust.
  Neither package's tests link Rust or load the page, so a pull request runs the screens tests only when it changes their package, the fixtures they read (`tests/fixtures/`), a CI script or a workflow, and the StoreKit tests only for their package, a CI script or a workflow (`screens` and `storekit` of `scripts/ci/changed-code.sh`); every other run tests both.
  A screens job spends about six minutes booting its simulator and building the package before its first test, so two jobs share the test classes (`scripts/ci/screens-shards.ts`: the last part runs every class the first does not name).
  Both test scripts wait for the boot before they build: the boot takes every core of the runner for five to six minutes, and tests built beside it took 13 to 14 minutes where waiting first takes 9 to 11.
  The simulator's data folder is not cached: on an idle runner a cold boot took 158 s, a boot from the restored folder 91 s after 23 s to restore its 700 MB, and a second boot on the same machine 76 to 100 s, so the cache saved about 45 s of a job, and none of a pull request's smoke shard, whose simulator is up before the app build it waits for.
  The check that the spike harness is absent from the Release build (`scripts/ci/devot-screens-release-check.sh`) builds the package twice more, so it runs in the merge queue, on main and in manual runs, not on pull requests.
- `iphone-build`, a macOS job in the `rust` gate, builds the iPhone app for the simulator with the release UI (`pnpm tauri ios build`, whose `beforeBuildCommand` is `pnpm ui:release`), the only build that links the packages, once per run.
  When the UI test runs, it also builds the XCUITest runner (`scripts/ci/iphone-ui-tests.sh build`, `xcodebuild build-for-testing`) and uploads the runner, its `.xctestrun` and the app as one zstd-compressed tar, the `iphone-ui-build` artifact (about 32 MB, kept 1 day), for the `iphone-ui` shards.
  It boots no simulator and runs no test: a simulator booting beside the build kept the 3-core runner's load in the hundreds and made the app build and clippy two to eight times slower.
  `tauri ios build` archives the app after building it, which builds all of it again, and for a simulator only takes the app out of the archive; it also compiles the Swift packages for the Intel simulator, which no job runs.
  For this job alone, `scripts/shims/xcodebuild` makes that archive of the app the build just left and builds without the Intel slice.
  The job turns the shim on with a file beside it (`ci-simulator-build`, ignored by git), since Tauri starts xcodebuild with an environment of its own and a variable would not arrive.
- `ios-check`, a macOS job in the `rust` gate, runs the Mac's and the phone's compile checks: clippy for the macOS host and for `aarch64-apple-ios-sim`, the input bar's tests, and the generated Swift's typecheck.
  It starts once `iphone-build` has ended, failed or not: as a sixth macOS job from the start it kept another waiting for a runner, once the smoke shard for four minutes.
- `iphone-build`'s Rust cache (`shared-key: iphone-sim`, keyed by the Xcode build that `scripts/ci/xcode.sh` reports) is saved from main only, so a pull request never writes a cache a later run builds on; the release and App Store builds use caches of their own and save none.
  pnpm checks the lockfile against its supply-chain policies with registry metadata, which the `xcode-27` image fetched in 4 to 5 minutes; the job caches pnpm's metadata folder (`pnpm cache path`), keyed by the lockfile, so an unchanged lockfile's verdict is reused.
  XcodeGen makes each test project from the package's `TestHost/project.yml`; nothing generated is committed.
  The screens package's tests read the same message fixtures as Vitest and `cargo test` (`tests/fixtures/screens/`).
- `iphone-ui`, macOS jobs in the `rust` gate, install `iphone-build`'s app on a simulator and run the XCUITest in `src-tauri/apple/DevotUITests` from its runner (`scripts/ci/iphone-ui-tests.sh test`, `xcodebuild test-without-building`); they install no packages and build nothing.
  The tests are split into shards, `fail-fast` off: `scripts/ci/iphone-ui-shards.ts` lists each shard's classes and methods, and its last shard, `rest`, runs every test not listed, so a new class or method is never left out (`tests/policy/iphone-ui-shards.test.ts` checks that each test runs in exactly one shard and that the matrix is the list the script prints).
  A pull request runs only the `smoke` shard (the tab bar with its audit, and a note opened by its link: about a minute of tests); a full run runs `smoke`, `settings`, `editor` and `rest`.
  A shard does not wait for `iphone-build` to end, since a job that `needs` another starts only once all of it has ended: it starts beside it, boots its simulator, which takes five to six minutes, while the app builds, and waits for the artifact (`scripts/ci/wait-for-artifact.ts`, which stops at once when the build ended without one).
  A test that fails is run once more (`-retry-tests-on-failure -test-iterations 2`), so a one-off simulator stall does not fail the job; a test that fails twice does.
  The DevotScreens XCTests run the same way (`scripts/ci/devot-screens-tests.sh`).
  Once it has the app, a shard starts it once and waits until its web view has made its WebKit folders, for at most 2 minutes (`scripts/ci/iphone-ui-tests.sh settle`): tests started during WebKit's first start found an empty web view and missed their waits.
  It used to wait for the one-minute load to drop under the core count, but on the 3-core `xcode-27` runner the load stays in the hundreds, so that was a fixed 4 minute wait.
  A shard runs under 8 minutes of tests and the smoke shard about one; a test that makes one longer moves to a lighter shard, or a new shard is added to the list.
  The test launches the app by its bundle ID, switches all four tabs of the native tab bar and runs `performAccessibilityAudit()` on the bar; the page inside the web view is not audited there.
  The Settings test audits the root at the top of its list and at its foot, scrolled until the list stops; an element whose contrast is measured against a system bar's glass or a bar's scroll edge effect must also show clear of them in one of the two places, where it is audited for real, and every other issue fails wherever it shows.
  The tab bar's edge effect is `size.phone-tab-edge` (44) above the bar, and the Settings list ends that far above it, so its build footer is audited clear at the foot.
  Under the navigation bar, once the list has scrolled beneath it, the edge effect and the shadow of Pair a Device's glass reach 33 pt below the bar's frame (measured on the iOS 26.5 screenshot: the page differs from `color.phone.background` down to y = 148 under a bar ending at 116).
  They are the only jobs that run the shipping app, so it is what catches a web view that fails to move between the tabs or a tab item without a name.
  A failed shard, the smoke shard included, uploads its result bundle as the `iphone-ui-xcresult-<shard>` artifact, with each audit issue's element and the screenshots.
  A pull request runs it only when it changes `src-tauri/apple/`, `src-tauri/gen/apple/`, `src-tauri/src/native/ios/`, a `screens/` folder, `src/renderer/src/phone/` or the scripts that run it (`scripts/ci/changed-code.sh`); every other run includes it.
- CI runs on every pull request, every push to main, or when started by hand.
  A pull request runs only the jobs its changed files need: `scripts/ci/changed-code.sh` says which paths need the web and the Rust jobs, and `scripts/ci/ui-plan.ts` picks the UI specs (docs/development.md, Targeted UI CI).
  Documentation-only changes run only the format check and the policy and token tests (`pnpm test:policy`), which read the docs; a pull request without web changes runs `policy-check` instead of the web jobs: the format check, lint, the type check and all of Vitest, whose tests also read the Rust sources, migrations and capabilities.
  Every job runs unless the change detection said it is not needed, so missing outputs run everything, and the three required gates always report.
  Pull-request runs cancel an older run for the same PR; main runs never cancel each other.
  Each UI shard uploads its Playwright results (traces of failed attempts, including a test that failed once and passed on retry, and the JSON report the shard durations are refreshed from) as `playwright-results-<project>-<shard>` unless the run was cancelled.
- The `PR title` workflow (`pr-title.yml`) checks that a pull request's title, which becomes the squash commit's message, is a Conventional Commit; it runs again when the title is edited.
- The dependency checks run on every pull request that changes code, on a run started by hand and in `pnpm check`.
  There is no scheduled run yet, so a new advisory on an unchanged dependency shows up with the next such run.
- The other macOS jobs (full-app end-to-end, performance, GPU power) come in phase 2.

## Flaky tests

A one-off flake on a shared runner must not fail a merge or a release, and a flaky test must not be forgotten.

- On CI, Vitest (`retry` in `vitest.config.ts`), Playwright (`retries`) and the XCUITests (`-retry-tests-on-failure -test-iterations 2` in the iPhone, screens and StoreKit test scripts) run a failed test once more; a test that fails twice fails the job.
  Locally a failure fails at once.
  A failed iPhone UI test ends the test process, and xcodebuild then goes on with the tests that are left without running the failed one again: on main, 10 of the 11 shards with a failed test lost their retry that way.
  A test made to fail on its first run showed it on CI: after the failure xcodebuild logged `Restarting after unexpected exit, crash, or test timeout` and went on to the next test.
  So `scripts/ci/iphone-ui-tests.sh` runs the tests that failed once and were not run again in a second xcodebuild run (`scripts/ci/xctest-retry.ts` reads them from the log), and the job passes when they pass there.
- A test that passed only on its retry is listed as a "Flaky" warning annotation and in the job summary (`tests/support/flaky-report.ts`, `scripts/ci/playwright-flaky.ts`, the test scripts).
- After each CI run on main and in the merge queue, `.github/workflows/flaky-tracker.yml` opens an issue labelled `flaky` for each such test, or comments on the one it has (`scripts/ci/flaky-tracker.ts`); the number of comments ranks which to fix first.
  Pull request runs are left out, since a flake there may be the pull request's own change.
- A run on main that failed has its failed jobs run again, once, by the same workflow: what a test's retry cannot cover (a download, a runner, a simulator that did not start) must not leave main red.
  A job that passed only then gets a `Flaky job: …` issue the same way.
  A run that is still red is a real failure: the workflow says so in a comment on the `CI health` issue, with the failed jobs.
- The `CI health` issue is rewritten after each run on main: how many of main's last 30 finished runs passed, how many of those on the first attempt, the red runs, and the open flaky issues with the most seen first.
  The first-attempt rate falling, or an issue's count rising, is the signal to fix a flake before it costs a release.
- A flaky test is fixed at its cause, and the pull request that fixes it closes its issue; no test is skipped, disabled or quarantined to make a run green.
- The causes found so far, and the rule each left:
  - A check made before the page settled: a test waits for the state it asserts (`expect.poll`, `toHave…`), never reads it once right after an action.
  - A spec that changes `localStorage` on the live page races the app's own writes; what a spec needs on every load goes in an init script (`tests/ui/fixtures.ts`).
  - A screens test that read the page's requests once after a fixed run-loop turn missed them on a loaded runner; it waits for them (`settle(until:)`).
  - The iPhone UI tests' waits were sized on an idle simulator, and the `xcode-27` runner's load stays in the hundreds; every wait goes through `waitLimit` (`src-tauri/apple/DevotUITests/Tests/Waits.swift`), which CI multiplies by `DEVOT_UI_WAIT_SCALE` (3), and a policy test refuses a bare number.
  - A product time limit (a parse budget) that a slow machine reaches is measured with `expectWithinBudget`, which allows for the hosted runner, instead of being asserted as if it never ran out.
  - A time check's budget is written for a developer's Mac; a machine that is slower without being overloaded (a cloud container, where the load stays under the core count) sets `DEVOT_BUDGET_SCALE`, which stretches every budget by up to the hosted runner's factor (`tests/support/budget.ts`).
  - A test that runs out of time is not stopped: it keeps writing to what it shares with the next test, and with its own retry, which then fails on state the first attempt is still changing (a rate limit's count); a test with many signed requests gets a time limit a loaded runner stays under.
  - StoreKit Test's local server answers some purchases with a server error (AMSErrorDomain 305) on a loaded runner; the retry covers it.
  - xcodebuild reruns no test that ran out of its time allowance, so a test that is slow under load, not stuck, gets the whole limit: every StoreKit test may take two minutes (a purchase took 82 s).

## Workflow

- All changes reach `main` through pull requests, and CI must pass before merging.
  A ruleset on `main` enforces it: a pull request is required, the `web`, `rust` and `policy` checks must pass, and pull requests are squash-merged.
  The local `pre-push` hook that blocks pushes to `main` stays as a convenience.
- Issues marked `ready-for-agent` state acceptance criteria that translate directly into tests.
  Agents work test-first, PRs include tests, a code review runs before merging.
- Local hooks (lefthook): `pre-commit` runs oxfmt, oxlint and rustfmt on staged files; `pre-push` blocks `main`, runs the format check, and lints when the push changes code or config (TypeScript, JavaScript, JSON, YAML), then only what the pushed files need: the type check when it changes code or config, Vitest without its benchmarks and builds (`pnpm test:fast`, about half the time; CI runs all of it) when it changes those, CSS, HTML or the Rust sources, migrations and fixtures its tests read, and `cargo fmt --check`, clippy and cargo test when it changes Rust, Cargo, JSON or migration files under `src-tauri/`.
  A push of docs or images runs neither; CI still runs what the change needs.
  The rustfmt hook covers every Rust file under `src-tauri`, including `build.rs` and `build_env.rs`.

## Crash reporting and logs

- **Sentry:** the Rust SDK (`src-tauri/src/crash.rs`, ureq transport over the system TLS) for panics, the browser SDK (`src/renderer/src/crash.ts`, loaded only when a DSN is set) for uncaught UI errors, and a crash reporter process for native crashes (below).
  One Sentry project for all three.
  All are off until the user turns on Send Crash Reports in Settings > General, kept as the file `crash-reports-on` in the data folder: without it no event is sent, no crash reporter starts and any saved report is deleted.
  A panic before the data folder is known is dropped.
- **Native crashes** (`src-tauri/src/crash_reporter.rs`; signals, aborts, crashes inside WebKit or AppKit): in a DSN build, a background thread at launch starts a second copy of the app binary as the crash reporter (`devot --crash-reporter <Mach service> <app data>/crash-reports`; the service name carries the app's process ID and a random token).
  Once the reporter says on its standard output that it holds the service (a name has one holder at a time, so no other process can stand in for it; a reporter that has not said so within 5 s is stopped), the app attaches a crash handler (Mach exception ports plus a `SIGABRT` hook; `native::macos::attach_crash_handler`, the only `unsafe` it needs).
  On a crash the handler hands the crashed task to the reporter over Mach IPC and waits up to 10 s for its answer.
  Then the app ends as it would have without the handler: the handler puts back the `SIGABRT` action and exception ports from before it was attached, a Mach exception goes on to those (by default the system's crash reporting, then the signal), and a `SIGABRT` (an abort, or one sent by another process) is raised again under the old action, which by default ends the app with that signal.
  The handler's own thread blocks `SIGABRT`, so a signal sent to the app never lands on the thread that must answer it.
  When the reporter ends (its output closes: it saved a crash, or something stopped it), the app detaches the handler, which could no longer report, and does not start another reporter: the reporter ends on its own only after a crash, and one stopped from outside could be stopped again; the app then crashes as it would in a build without a DSN.
  The reporter accepts a crash only from the app that started it (by process ID).
  It writes a minidump of the app **into memory**, walks each thread's frame-pointer chain through the dumped stack memory (on arm64 a leaf function's caller comes from the link register when that points into another binary; an abort's trace starts where the signal was raised, below the handler's own frames), and keeps only code addresses, the binaries they fall in (file names, never folders; debug IDs; frames in the app's own executable are in-app, so Sentry groups by them: that binary is found by the crashed process's executable path, since the minidump lists any plug-in bundle AppKit or WebKit loaded before it), the exception and signal numbers, and the OS version and CPU.
  A frame-pointer chain or a register can hold data instead of a code address (note text, when data is used as a pointer), so an address outside every binary is never a frame, and a bad access's fault address (the Mach subcode) is kept only near null (below 4 KiB) or inside a binary; otherwise the Mach exception's numbers are left out and its names stay in the error type.
  It builds a native Sentry event from those alone (the crashed thread and up to 63 others, 128 frames each), runs it through the same scrubbing as every other event, and saves it as `<event id>.json`.
  A minidump that fails to write (it happened in about 1 of 150 crashes while the machine was overloaded) is tried twice more, 100 ms apart; if no minidump can be written or read, the report still carries the exception, named as it would be with one, without stacks.
  The minidump itself holds stack memory, which may contain note text, so it never reaches the disk or the network, and registers are not kept.
  The next launch (DSN builds only) sends up to five saved reports, newest first, on its own thread and one request each (ureq over the system TLS, as Sentry's transport, but reading Sentry's answer, which the SDK's background transport drops), and deletes the rest.
  A report is deleted once Sentry has accepted it or refused it for good (another 4xx); without a connection, on a 429 or a 5xx it waits for a later launch, for up to 30 days, and nothing more is sent that launch.
  The choice is read again before each request, so turning reports off while they are being sent stops those already read from disk too.
  The reporter sleeps in the kernel until a crash arrives (no polling) and exits when the app's end of a pipe closes, which happens on any quit or kill.
  Builds without a DSN start no reporter, attach no handler and create no folder; a build without a DSN also refuses `--crash-reporter`.
  Release builds keep line tables in a separate `devot.dSYM` next to the stripped binary, so Sentry can name functions once it is uploaded (below).
  Crashes in WebKit's own processes (the page's content process) do not stop the app and are not reported.
  Tests: `tests/native_crash.rs` crashes a process for real (an abort, a `SIGABRT` sent from another process, a bad memory access and a call through a pointer made of note text, with note-like text and attachment bytes on its heap and stack and a plug-in bundle loaded) and checks that it ends with the signal and that the reporter saved one report and exited: no minidump, no home path, user name, note text, address made of text or attachment bytes, frames in named binaries, only the app's own frames in-app, the trace starting at the crash; it also checks that nothing starts without a DSN, that the reporter exits with the app, and that once the reporter has been killed the handler is detached and an abort ends the app without a report.
- **What native crash reports cost, measured on the reporter alone** (2026-10-11, M1 Pro, macOS 27.2, release builds, while the machine was heavily loaded; `cargo test --test native_crash -- measure <devot built with a DSN>`, which starts the reporter from a test binary, not from the app): builds without a DSN do no work at all (the binary grows by 16 KiB, 8.28 to 8.30 MiB, as the code is compiled out).
  In a DSN build, starting the reporter returns in under 0.2 ms (two threads); the reporter is ready 13 to 31 ms later on its own thread (about 300 ms on a cold disk cache), with a footprint of about 2.4 MB (7 to 9 MB resident, mostly shared system libraries), 0 % CPU and no wakeups while it waits.
  Not counted there: what the second copy of the 12 MB binary (it links AppKit and WebKit) takes from the app's own launch while both load, the `devot-crash-reports` thread that reads saved reports and sends them over TLS at launch, and the two threads the app gains, both blocked in the kernel: the exception handler's and one that waits for the reporter's output to close.
  The binary grows by 1.2 MB (10.8 to 12.1 MB) for the minidump writer and parser; that adds 28 crates (`crash-handler`, `crash-context`, `minidump-writer`, `minidump` and what they use), all MIT or Apache-2.0, which `cargo deny` checks.
- **Native crash reports against the budgets: pending a check on the real app.**
  Launch to first editor paint (< 700 ms) and the idle footprint (< 200 MB) have not been measured on the app with and without a DSN yet, so whether they stay within budget is open.
  Steps (macOS, Accessibility permission for the terminal, Devot quit, an idle machine; `sudo purge` asks for the password):
  1. `DEVOT_SENTRY_DSN= pnpm tauri build --bundles app` (the empty variable wins over `.env.local`), then `cp -R src-tauri/target/release/bundle/macos/Devot.app /tmp/devot-no-dsn.app`.
  2. `DEVOT_SENTRY_DSN=<the DSN> pnpm tauri build --bundles app`, then `cp -R src-tauri/target/release/bundle/macos/Devot.app /tmp/devot-dsn.app`.
     With no saved crash reports, launching it sends nothing.
  3. `bash scripts/perf/launch-cost.sh /tmp/devot-no-dsn.app`, then `bash scripts/perf/launch-cost.sh /tmp/devot-dsn.app`.
     Each prints 5 cold and 5 warm launches (milliseconds from starting the binary until the open note's editor is in the accessibility tree, with the empty shell's time beside it; `scripts/perf/first-paint.swift`), then, after 60 s idle, `footprint` and `top -stats pid,cpu,idlew,power` (5 s) for the app and, in the DSN build, the reporter (WebKit's own processes are not included; a DSN does not change them).
     The script runs the app with HOME in a temporary folder, so each build starts on a new data folder of its own (made by a first launch that is not timed and opens a first note, which the timed launches restore; the budget is judged on that library of one empty note) and never opens an installed Devot's notes or sends its saved crash reports.
  4. Record the ranges here: cold and warm launch with and without a DSN, the app's idle footprint and wakeups with and without, the reporter's footprint and wakeups.
     Within budget: the DSN build's launches under 700 ms and its app footprint plus the reporter's under 200 MB.
- **Source maps and debug symbols:** release builds upload the UI's source maps and the app's `devot.dSYM` to Sentry; neither ships.
  Tauri runs `pnpm ui:release` (`scripts/sentry/ui.ts`) before compiling the app, which embeds `dist/`: with the upload settings it builds hidden source maps (no `sourceMappingURL` comments), gives every script a Sentry debug ID (`sentry-cli sourcemaps inject`; the SDK moves it into the event's `debug_meta`, which scrubbing keeps, so Sentry matches each frame to its map), uploads the maps for release `devot@<version>`, and deletes them; without the settings it builds none.
  Either way the build fails if `dist/` still holds a `.map` file or a comment pointing to one, or the UI tests' in-memory storage (checked before uploading anything; see App data folder), and a failed upload fails the build (after deleting the maps).
  Tauri then runs `pnpm sentry:debug-files` (`scripts/sentry/debug-files.ts`) before bundling, which uploads the dSYM of that build.
  With `DEVOT_SENTRY_STAGE` in place of the upload settings, both scripts do the same but copy the maps (with `release`, the release name) and the dSYM into that folder instead of uploading them, and `scripts/sentry/staged.ts` uploads the folder later.
  The release workflow builds that way, so the job that runs the dependencies' code never holds the Sentry token; a job of its own uploads the folder (`docs/releasing.md`).
  Rust panics list the binaries loaded at launch by debug ID (the SDK's `debug-images`; scrubbing keeps the ones a frame is in), so Sentry names the functions of a stripped release build's frames from that dSYM; a unit test prepares a panic with the app's client settings and a stand-in transport and checks that the binary its frames are in is listed.
  `pnpm ui:build` (development, tests, CI) never makes source maps.
  Tests: `tests/policy/source-maps.build.test.ts` runs the three scripts against a stand-in sentry-cli.
- **One release and one environment per build:** the version is `src-tauri/Cargo.toml`'s alone.
  Rust reports `devot@<version>`; `tauri.conf.json` names no version, so Tauri gives the UI (`getVersion`) and the app bundle the same one; the source maps upload under that name.
  Rust reports `development` for a build with debug assertions and `production` otherwise; the UI reads Tauri's `TAURI_ENV_DEBUG` (`true` for `tauri dev` and `tauri build --debug`, `false` for `tauri build`) and reports the same, and a UI built outside Tauri's CLI reports `development`.
  `tests/policy/release.test.ts` checks that every side agrees.
- **Turning uploads on:** set `SENTRY_AUTH_TOKEN` (an organisation auth token, made in Sentry under Settings > Developer Settings > Organization Tokens; it can upload release files and nothing more), `SENTRY_ORG` (the organisation slug) and `SENTRY_PROJECT` (the project slug) in the environment or in `.env.local` (an environment variable wins), then run `pnpm build`.
  All three or none: some but not all stops the build.
  `tauri build --debug` never uploads.
  The token reaches `sentry-cli` (a pinned dev dependency, license FSL-1.1-MIT; it runs only on the developer's machine and is never shipped) through its environment, never as an argument, and Vite never exposes `SENTRY_` variables to the UI.
- **Scrubbing:** all PII collection off (`dataCollection` in browser SDK 11, `send_default_pii` in Rust), no session replay, tracing or breadcrumbs.
  Scrubbing is an allowlist on both sides (`src-tauri/src/crash_scrub.rs`, `src/renderer/src/crash.ts`): an event is rebuilt from a fixed list of fields, and each value is kept only in the shape its field must have.
  What is kept: codes (a message or exception value becomes the code it starts with, or `<redacted>`; a rejection that is not an Error, which the SDK wraps in text of its own, keeps its code too), error types (names only, without the numbers a crash reason can go on with), code locations (function names; source files and scripts, without a query and with the user name in a home folder path replaced; lines; addresses only inside a binary the event lists, at a page boundary, and those binaries by file name and debug ID), the UI scripts' source map debug IDs (`debug_meta`), the release and environment, and system details (OS name, version and build; CPU, model and family; never the device's or host's name).
  Everything else is left out: tags, fingerprints, extra data, breadcrumbs, user and request data, other contexts, registers, context lines, variables and mechanism data.
  `before_send` and `beforeSend` run it (breadcrumbs are dropped as they come); native crash reports run it when saved and again when sent.
  Devot's own errors carry codes and IDs, never content.
  Unit tests on both sides fill every field of an event with note text, titles, paths that name the user, attachment bytes and addresses made of text, and assert that none of it survives.
- **Consent:** on in the user's own builds; off in any build without a DSN.
  The DSN is injected at build time from `DEVOT_SENTRY_DSN`, set in the environment or in a git-ignored `.env.local` at the repository root (see `.env.example`; Rust reads it in `build.rs`, Vite through `envDir` and `envPrefix`; an environment variable, even an empty one, wins. `build.rs` watches `.env.local` only while it exists, because Cargo treats a missing path, or the repository folder with `target` inside it, as changed on every run and would rebuild the app each time; so a `.env.local` created for the first time takes effect after `touch src-tauri/build.rs`, or when the variable is set instead) and never committed; tests run without it.
  The CSP allows `https://*.ingest.us.sentry.io` in `connect-src`, nothing else.
- **Plan:** Sentry's free Developer plan.
  Over-quota events are rejected rather than billed.
- **Local logs:** structured, size-rotated logs in the app data folder (`logs/devot.log`, JSON lines, 1 MiB per file, four older files kept).
  User names in paths are replaced before writing.
  The UI logs through `log_write`, which accepts only a code and IDs.
  Help > Export Diagnostics… writes a text bundle (versions plus logs) to Downloads as a new file (numbered when its name is taken: it never replaces a file or writes through a link there) and reveals it in Finder (`open -R`, reaped like a link's `open`).
  The core worker has a console of its own: its coded warnings and errors (a failed revision write, a swallowed notebook-order failure) and its uncaught errors and rejections (`E_WORKER_UNCAUGHT`, `E_WORKER_UNHANDLED_REJECTION`, by kind and code only) are posted to the page (`src/renderer/src/workerLog.ts`), which writes them through `log_write` like its own; the uncaught ones also go to Sentry by code (`reportCode` in `crash.ts`).
- **Error codes on the way to the log and Sentry:** a failed storage call is logged as `W_STORAGE_FAILED` with its code (the change watch, which reads every second, logs a run of failures once, as `W_WATCH_READ_FAILED` with its code), and a SQLite failure's code says its kind (`E_STORAGE_BUSY`, `E_STORAGE_FULL`, `E_STORAGE_READONLY`, `E_STORAGE_CORRUPT`, `E_STORAGE_IO`, `E_STORAGE_CANTOPEN` for a file that cannot be made or opened, else `E_STORAGE_SQLITE`), never SQLite's message.
  Commands reject with their code as a string; every command the UI runs goes through `src/renderer/src/ipc.ts` (a policy test keeps it so), which turns a rejection into an Error whose message is the code alone (`E_COMMAND_FAILED` for Tauri's own failures, which can quote what was sent).
  The core's `errorCode()` reads the code an Error or a string starts with wherever a failure is reported (notices, batches, revision writes, the UI log).
- **Error codes never reach what a person reads:** a message says what failed and, for a code `failureReason` (`src/renderer/src/failure.ts`) can put in plain words, why: no connection, a time limit, an address Devot does not connect to, a request the server refused, a server or service not available.
  An area that knows its codes better (sync, the licence, AI, imports, images) says its own reason first.
  The code goes to the log where the failure is caught (`logFailure`, a warning under the area's code with the failure's code as its argument), or is logged by Rust or the worker that holds it (sync, mirror, backups and licence states).
  `tests/policy/no-error-codes-in-ui.test.ts` refuses a catalog message with a `{code}` slot or a written code, and the launch alert (`startup.rs`) leaves the code out too.
  The command line's standard error and the HTTP API's and MCP's answers are read by programs and keep their codes.
- **Poisoned locks in Rust:** a lock whose value a panic cannot leave half-changed is taken through `locks::lock` (`src-tauri/src/locks.rs`), which logs `W_LOCK_POISONED` with the site once and clears the poison; a lock whose value could be torn maps the poison to its command's error code instead.
  No lock is skipped silently, so a waiting reply is never dropped because another holder panicked.
- Data region: US (the existing Sentry account).
