# Brand facts: Devot

Last verified against the source: 2026-11-21.

## Product

- Devot is a local-first Markdown notes app for Mac and iPhone.
- The iOS build also runs on iPad, with the same screens, in columns when the window is wide (`docs/specs/iphone-screens.md`).
- Notes stay in a SQLite database on the device (`README.md`, `docs/architecture.md`).
- Writing, organising and searching work offline, with no Devot account.
- Mac: macOS 15 or later, Apple Silicon and Intel, one universal app (`src-tauri/tauri.conf.json`).
- iPhone and iPad: iOS 26 or later (`docs/architecture.md`).
- The app's languages are English and Simplified Chinese (`README.md`).
- The product site is https://devot.online.
- The source repository is https://github.com/jma49/devot.

## Writing and organising

- The editor has editor-only, split and preview modes, and a live preview (`README.md`).
- The preview covers GitHub-flavoured Markdown, code, math, Mermaid and PlantUML diagrams, and tables edited from the keyboard.
- Notebooks nest. Tags have colours. A note has a status, and it can be pinned or in the Trash.
- Templates, today's note and a menu-bar Quick Note are in the README.
- Full-text search has a query syntax. Related by Meaning uses the system's on-device sentence model.
- Image text search runs on the device, on Mac and iPhone, and does not sync the extracted text.
- Notes link with `[[`, and backlinks are listed.

## Sync, share and AI

- Sync is end-to-end encrypted, through the owner's iCloud or a relay the owner runs.
- Each note is sealed on the device before it leaves (`README.md`).
- Sync needs no Devot account.
- Share on Web publishes an encrypted, read-only page with an expiry. The key travels only in the link (`docs/adr/0019-share-on-web-as-an-encrypted-page-without-accounts.md`).
- Plugins run on Mac, in a sandbox, after the owner approves what they can access.
- The iPhone does not run plugins. It can display plugin drawings synced from a Mac.
- MCP runs inside the Mac app's binary and talks only to the app on that Mac (`README.md`, `docs/adr/0012-mcp-through-a-bridge-in-the-app.md`).
- An MCP client sees only notebooks with Allow AI Access on.

## Licence and price

- A 30-day trial unlocks every feature (`docs/adr/0006-source-available-and-sold-once.md`).
- After the trial, notes can still be read, searched by keyword, copied and exported.
- Editing, sync, semantic search and AI then need a licence (`README.md`).
- A licence bought once unlocks those on up to three devices at a time, in every version (`docs/adr/0009-licences-activated-on-three-devices.md`).
- The Mac licence is sold through the licence Worker. The repository does not store the Stripe Price id (`docs/adr/0006-source-available-and-sold-once.md`).
- ADR 0014 records two prices: the Mac licence on the website at US$29.90, and the App Store product Devot Pro at US$29.99 (`io.github.jma49.devot.pro`).
- The 30-day Trial on the App Store is a free non-consumable, `io.github.jma49.devot.trial`.
- A build from source checks no licence (`README.md`).
- The source licence is FSL-1.1-MIT. Each release becomes MIT two years after it is published. Versions up to v1.0.4 stay MIT.

## Distribution

- Mac builds are signed with Devot's Developer ID and notarised, from release 1.0.5-beta2 on (`SECURITY.md`).
- They are downloaded from GitHub Releases.
- The iOS app is created in App Store Connect with Mac (Apple silicon) and visionOS availability left unticked (`docs/releasing.md`).
- No App Store URL is stored in this repository.

## Boundaries

- There is no Devot account for notes or sync.
- MCP has no hosted endpoint.
- A hosted relay for people who do not want to run one is not built (`docs/adr/0011-optional-hosted-sync-is-a-service-not-a-license-feature.md`).
- This repository does not name other note apps as a model for Devot.
- Customer counts, testimonials and a live user total are not in the source.
