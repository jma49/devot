# Modularity and code structure

Part of the [architecture overview](../architecture.md).

A codebase worked on by many people and agents in parallel stays fast to change only when every concept has one obvious home, every boundary is enforced by tools, and old paths are deleted when new ones replace them.
Judge structure against the first-day baseline: knowing every real product requirement, platform constraint and data contract Devot has today, ask what the simplest layout would be if it were written fresh, then converge toward that shape through small, verified steps that keep user behaviour, stored data and external contracts intact.

## Single source of truth

Every business rule, data definition, limit, configuration key, state lifecycle and design token has one authoritative owner.
When two runtimes must enforce the same rule or constant, generate one from the other (`pnpm tokens`, `pnpm i18n:apple`) or bind both sides with a contract check (`tests/policy/note-limits.test.ts`, `tests/policy/architecture-gates.test.ts`, `tests/core/hlc-stamps.test.ts`, `tests/core/mcp-tools.test.ts`).
Never copy a constant, regular expression or table across files without a check that fails when they drift.

## One canonical implementation

One semantic responsibility has one standard implementation across a runtime.
Historical helpers, duplicate validators and one-off wrappers are migrated to that implementation and deleted (`tests/policy/canonical-primitives.test.ts`):

- Error and log codes: `src/core/errors.ts` (`isErrorCode`, `errorCode`) in TypeScript and `src-tauri/src/logs.rs` (`is_code`, `is_error_code`, `is_error_or_warn_code`) in Rust.
- UUIDs and `devot://` URIs: `src/core/ids.ts`, `src/core/files.ts` (`fileIdOf`), `src/core/links.ts` (`noteIdOf`) and `src-tauri/src/storage/records.rs` (`valid_note_id`, `valid_uuid`, `valid_hlc`).
- Plain JSON object guards: `src/core/isRecord.ts`.
- Binary base64 encoding and decoding: `src/core/base64.ts` (`toBase64`, `fromBase64`).
- Web Storage access in the UI: `src/renderer/src/localStore.ts` (`localStore`, `sessionStore`).
- Window notice bars: `Notice` and `Notices` in `src/renderer/src/Notices.tsx`.
- Rust state pushed to windows: `followRustState` in `src/renderer/src/rustState.ts` and `createSyncedStore` in `src/renderer/src/syncedStore.ts`.
- Atomic file writes and JSON settings files with damaged-copy recovery: `src-tauri/src/atomic_file.rs` and `src-tauri/src/settings_file.rs` (`SettingsFile`).

Keep a separate implementation only when an explicit runtime or deployment boundary requires it, and enforce that boundary with a test.
For example, `src/core/sync/protocol.ts` and `share/src/envelope.ts` import nothing so Node's native type-stripping and the standalone share viewer page can run them directly (`tests/policy/relay-boundary.test.ts`, `tests/policy/architecture-gates.test.ts`).

## Deep modules and the deletion test

Prefer deep modules that hide intricate mechanics behind a small, stable interface (`createNoteService`, `createSyncEngine`, `atomic_file`, `SettingsFile`, `followRustState`) over shallow pass-through wrappers, barrel re-exports and premature indirection.

Apply the deletion test to every abstraction, helper or forwarding module: if removing the layer makes complexity disappear rather than forcing callers to repeat real invariants, delete the layer.
Do not merge distinct domain concepts merely because two functions look superficially alike today, and do not trade readability for shorter line counts.

## Cohesion, coupling and dependency direction

Each module owns a clear responsibility and depends only inward toward lower-level domain or storage foundations:

- `src/core` is plain TypeScript and imports neither `@tauri-apps/*`, `better-sqlite3` nor `node:*`.
- `src/renderer` imports no Node modules, calls Tauri commands only through `src/renderer/src/ipc.ts`, and imports runtime values from concrete `src/core/<module>` paths rather than the `src/core` barrel so window startup bundles load only what they run (`tests/policy/startup-imports.test.ts`), never re-exporting core values from UI modules.
- In `src-tauri`, `commands/` adapts Tauri IPC to domain and storage modules; non-command modules never depend upward on `crate::commands`, and foundational modules (`locks.rs`, `data_folder.rs`, `crash_scrub.rs`, `keychain.rs`, `logs.rs`, `storage/`) depend on no shell, window or UI modules (`tests/policy/rust-boundaries.test.ts`).
- Standalone deployables (`relay/`, `licence/`, `share/`, `clipper/`) never pull in app UI or Rust shell code, and the app never imports Worker internals (`tests/policy/relay-boundary.test.ts`, `tests/policy/licence-boundary.test.ts`, `tests/policy/architecture-gates.test.ts`).
- Runtime circular dependencies across TypeScript modules are forbidden (`tests/policy/architecture-gates.test.ts`).

## Locality of change

Adding or changing a concept should touch the module that owns it rather than a scatter of unrelated files.
Keep closed sets and feature wiring in typed registries (`src/renderer/src/commands/registry.ts`, `src/renderer/src/settings/panes.ts`, `src-tauri/build_commands.rs`, `design/tokens/`, `src/renderer/src/i18n/`) so exhaustiveness checks point straight to every place a new variant must be handled and parallel branches rarely conflict.

## Closed-loop refactoring (deletion over accumulation)

Never add a new canonical helper, interface or directory while leaving existing callers on the old path.
Every structural cleanup completes the loop in the same change:

1. Map every real caller, boundary and contract of the code being touched.
2. Lock down existing behaviour with tests (and a failing regression test first when fixing a defect).
3. Introduce or choose the canonical implementation with the lowest total system complexity.
4. Migrate all callers within the boundary and delete the superseded implementation, dead exports and pass-through shims.
5. Add or tighten a type, lint or policy check so the retired pattern cannot return.

Avoid directory reshuffles that only rename paths without removing coupling or clarifying ownership.
When a structural change would alter product behaviour, stored formats or public contracts, record the question for a decision rather than guessing.

## Enforceable architecture

Architectural rules that rely on memory erode under parallel development; turn every settled rule into an automated check:

- Type system coverage: every tracked `.ts` and `.tsx` file belongs to a `tsconfig` checked by `pnpm typecheck` (`tests/policy/architecture-gates.test.ts`).
- Static lint and token checks: `.oxlintrc.json`, `scripts/tokens/swift-literals.ts`, `cargo clippy --all-targets -- -D warnings` and `cargo deny check`.
- Structural policy suite (`pnpm test:policy`): fast repository-wide invariants under `tests/policy/` that run on every pull request, including documentation-only changes, using `listFiles` (`tests/support/git-files.ts`) so git hook environments never leak into checks.
