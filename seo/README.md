# Discoverability files

These files describe Devot for GitHub, directories and answer engines.
They do not change the app.
Facts come from the README, the architecture overview and the ADRs.
Anything not settled there is a TODO in [`kb/open-questions.md`](kb/open-questions.md).

- [`../llms.txt`](../llms.txt): the repository summary for agents. The public summary stays at [https://devot.online/llms.txt](https://devot.online/llms.txt), in the site repository.
- [`kb/brand-ssot.md`](kb/brand-ssot.md): one place for product facts and boundaries.
- [`kb/pages-index.md`](kb/pages-index.md): which page may quote which fact.
- [`kb/open-questions.md`](kb/open-questions.md): questions only the owner can close.
- [`kb/proof/benchmarks/renderer-baseline.md`](kb/proof/benchmarks/renderer-baseline.md): the published baseline, including the load caveat.
- [`kb/proof/workflows/mirror-outside-edits.md`](kb/proof/workflows/mirror-outside-edits.md): what the Markdown mirror does with an outside edit.
- [`submission-manifest.json`](submission-manifest.json): directory fields. Nothing has been submitted.
- [`store/app-store.en.json`](store/app-store.en.json): English copy to paste into App Store Connect. The release scripts do not read it.
- [`roast-roadmap.md`](roast-roadmap.md): what this pass fixed, and what is left.

## GitHub settings recorded on 2026-11-21

The repository settings already match the product line.
No change is required for these three:

- Description: `Local-first Markdown notes for Mac and iPhone: live preview, end-to-end encrypted sync, plugins, themes and MCP for AI tools.`
- Website: `https://devot.online`
- Topics (19): `codemirror`, `crdt`, `end-to-end-encryption`, `ios`, `iphone`, `knowledge-base`, `local-first`, `macos`, `markdown`, `markdown-editor`, `mcp`, `mcp-server`, `note-taking`, `notes`, `notes-app`, `pkm`, `rust`, `tauri`, `yjs`.

Optional, if the owner wants the twentieth topic: `sqlite`.
Notes are stored in SQLite.
TODO: confirm the Social preview image in the repository settings.
A 1280 by 640 crop of `docs/images/hero.webp` is the in-repo image to start from.
