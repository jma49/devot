# Performance

Part of the [architecture overview](../architecture.md).

- Budgets (the cost of native crash reports against the first two is still unmeasured on the app; see [Crash reporting and logs](quality.md#crash-reporting-and-logs)): launch to first editor paint < 700 ms; idle memory footprint < 200 MB; keystroke to paint < 8 ms on a 120 Hz display (one frame); full-text search over 10k notes < 50 ms; switching notes < 16 ms.
- In WebKit, `tests/ui/long-note-typing.spec.ts` keeps typing in a 200 KB note (prose, lists, tables, code blocks) within a looser budget for that engine on Linux: the median keystroke's editor work (CodeMirror's update and measure) under 25 ms and its key to the end of its frame under 80 ms; it stood at about 13 ms and 30 ms when added, of which the Markdown parser's incremental pass to the note's end is about 5 ms.
- The phase 2 harness measures them on macOS, in-app for typing latency, plus idle GPU power (`powermetrics`) with the transparent window against an opaque one.
- Core budgets, held by the benchmarks in `tests/core/*.bench.test.ts` (`pnpm test` and CI run them; `pnpm test:fast` leaves them out) against the test store on better-sqlite3, which runs the Rust store's SQL.
  Each holds on a developer machine and is stretched 5 times on a hosted CI runner (`tests/support/budget.ts`).
  Where the product has no number, the budget is a measured baseline with room.
  A growth check asks that four times the input take under 7 times as long (`tests/support/growth.ts`), so linear work passes and quadratic work fails on any machine.
  - Search over 10k notes (median, excerpts included): every query < 50 ms, whether words, a word start, a phrase, Chinese terms, tags, notebooks, statuses, exclusions or all of them combined, and each query typed on the way to two words; a scan of every body for text under three characters < 100 ms; a note's backlinks, a page of them or none, < 10 ms (the link index; the phrase search before it took 84 ms when every note holds a note link); saving an edit into the trigram and link indexes < 10 ms; counting 20 saved searches over the listed notes < 16 ms (one frame, on the UI thread).
  - Yjs on a 250 KB note: a remote keystroke or paste < 2 ms; a state vector and diff for sync < 2 ms; loading and encoding the whole state < 25 ms; merging two copies with 200 edits each < 60 ms; a body write of 20 changed lines, saved, < 100 ms; the line diff of a rewrite of every line of a 1 MB note < 50 ms.
    Linear: merging diverged copies, the line diff of a few changed lines, and the state's size against the edits typed.
  - Import: a Markdown folder with links, tags and images < 30 ms a note, linear in the notes, linear when every folder repeats the same names, and linear in thousands of folders (1,640 against 6,560 notebooks); a 600 KB file prepared < 3 s, linear in its length; HTML pages and bare links linear (`html-import`, `import` benches).
  - Link index: a note of 10,000 links saved < 150 ms; reading a body's links linear in its length.
