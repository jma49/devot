# Devot

Architecture and agreed decisions: `docs/architecture.md`. Design system: `design/README.md`.

Rules here hold for every contributor; add shared rules here. Personal or machine-specific rules (local paths, how you run agents) go in an untracked `CLAUDE.local.md` beside this file, which is read together with it and never committed.

## Rules for every change

- Never push to `main`. Work on a branch and open a pull request; merge only after CI passes.
- Pull request titles follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`); pull requests are squash-merged under that title.
- Work test-first. Every PR includes tests for the logic it changes.
- Never mock the database in tests: use better-sqlite3 (TypeScript) or rusqlite (Rust) on a temporary file.
- Tests make temporary folders only through `tempDir` (`tests/support/temp-dirs.ts`, removed when the test file ends) or Rust's `tempfile` (removed on drop); a policy test refuses `mkdtempSync(join(tmpdir(), …))` and `env::temp_dir()` by hand. Nothing a test makes may outlive the run.
- The core library (`src/core`) must not import `@tauri-apps/*`, `better-sqlite3` or `node:*`; the UI (`src/renderer`) must not import Node modules.
- `unsafe` Rust is allowed only in `src-tauri/src/native/macos.rs` and `src-tauri/src/native/ios.rs`, with a `SAFETY` comment on every block. Guard every private API call with `respondsToSelector:` and fall back instead of crashing.
- Every new Tauri command is declared in `src-tauri/build.rs` and granted in `src-tauri/capabilities/`; it validates its arguments in Rust.
- Tests that touch WebKit must run on the main thread: put them in a `harness = false` test under `src-tauri/tests/`.
- Error messages and logs carry codes and IDs, never note content.
- Components use theme design tokens only, never primitives or colour literals (`design/README.md`); after editing tokens, run `pnpm tokens` (CI fails when its output is stale).
- UI text is English and comes from the i18n message catalog by key; never inline a user-facing string. No CJK characters anywhere in tracked files (a test enforces it); write CJK test data with `\u` escapes.
- Rust tools come from rustup. A non-interactive shell may not read your shell profile: put rustup's `bin` folder on `PATH` before running `cargo` (with Homebrew's rustup, `$(brew --prefix rustup)/bin`). The git hooks add the usual locations themselves.
- A test that checks a time limit uses `expectWithinBudget` (`tests/support/budget.ts`), which skips on an overloaded machine; a policy test refuses `expect(ms).toBeLessThan(…)` by hand. Name a test file that takes seconds (benchmarks, big inputs, real builds) `*.bench.test.ts`: `pnpm test:fast` and the pre-push hook leave it out, CI runs it.
- Local test runs are capped so a local run leaves the machine usable: Vitest 3 workers (`DEVOT_TEST_WORKERS`), Playwright 2 (`DEVOT_UI_WORKERS`), cargo 4 jobs (`CARGO_BUILD_JOBS`). Raise them with those variables if you like; CI sets its own.
- Comment sparingly. Names and structure should explain the code; write a comment only for what the code cannot say: a non-obvious reason, a constraint, a workaround with its cause, or a link to an issue or ADR. Never comment what a line does, restate a name or type, narrate a change, or leave commented-out code. Prefer one short line; a doc comment only on exported APIs whose behaviour is not obvious from the signature. When you touch a file, delete comments that break this rule rather than matching them.
- Repository text (docs, issues, commits, comments, code) describes Devot on its own terms. Never name other note apps as a source or model for Devot.

## Compact instructions

When compacting, keep: the task and its issue numbers, the branch and worktree, files changed and why, failing tests with their error lines, decisions the user made, and open next steps. Drop: full logs and command output, file contents that can be read again, and finished side investigations.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for jma49/devot, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default five triage labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
