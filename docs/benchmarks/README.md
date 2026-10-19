# Performance baseline

How fast Devot is, measured before anything is optimised. Two scripts, both run locally (before a release, or before and after a performance change); neither is a CI job, and CI keeps only the budgets the UI tests already enforce (`tests/ui/render-cost.spec.ts`).

- `pnpm bench` measures the renderer in Playwright's WebKit and writes `results.json`.
- `pnpm bench:app` measures a built Devot.app (launch time and memory) and writes `app-results.json`. It needs a Mac with Accessibility permission for the terminal.

## Method

### `pnpm bench`

It builds the UI the way the UI tests do (a production build with the in-memory note storage and Tauri's IPC mocked, `vite.ui-test.config.ts`), serves it under the production CSP (`scripts/serve-csp.ts`) and drives it in WebKit with the UI tests' mock (`tests/ui/fixtures.ts`). Timings are taken inside the page (`scripts/bench/page.ts`): from the event to the frame after the change is painted.

Fixtures are generated when it runs (`scripts/bench/fixtures.ts`) and never committed:

- Two sample notes, about 20 KB and 100 KB: headings, paragraphs with inline marks, nested, numbered and task lists, quotes, alerts, tables, code in ten languages, inline and block math, images, and 3 (20 KB) or 8 (100 KB) Mermaid diagrams.
- Libraries of 1,000 and 10,000 notes with one line of text each, in 12 or 50 notebooks: half the notes in one big notebook, a tenth unfiled, the rest spread over the others.

| Measurement     | What is timed                                                                                                                                                                                                                                                                                                                           | Runs     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Ready           | page load until the window sets `data-ready` (1,000 and 10,000 notes; HTTP cache warm after the first load)                                                                                                                                                                                                                             | 9        |
| Open a note     | click on a row until the editor shows the note, until the preview shows its last line, and until every Mermaid diagram within a screen of the view is drawn (the others wait until scrolled near, before #224 every diagram); Split view, from a small note. The first open after load is reported apart (`first`), the rest as medians | 15       |
| Typing          | key down until the editor is painted, and until the preview's first heading shows the typed text; 30 keys at the start of the note, Split view                                                                                                                                                                                          | 30 keys  |
| Notebook switch | click on a sidebar item until the list shows its notes (count and first row), into All Notes, into the big notebook and into a small one                                                                                                                                                                                                | 8 cycles |
| List scroll     | frame time while the list scrolls 48 px a frame, 1,200 frames; share of frames over 20 ms                                                                                                                                                                                                                                               | 5 passes |
| Bundle          | the app's production build: files reached from the main page and the core worker without a dynamic `import()` are startup, the rest loads on demand                                                                                                                                                                                     | 1        |

`results.json` holds each series as `n`, `median`, `p90`, `min` and `max` (milliseconds), and the commit, machine and WebKit version. `pnpm bench -- --quick` runs a few of each, to check the harness; do not keep its numbers.

What the web harness cannot say: the real app's startup and memory (see below), the SQLite store (notes are in `localStorage` here, so a save at the end of typing costs more than in the app), and the display's refresh rate. WebKit in Playwright draws at 60 Hz, so frame times cluster at 17 ms.

### `pnpm bench:app`

`scripts/bench/app.sh [Devot.app] [runs] [--cold]` runs the built app on a data folder of its own (HOME in a temporary folder, as `scripts/perf/launch-cost.sh` does, never an installed Devot's notes) and takes, per launch, the time from starting the binary to the first frame and to the open note on screen (read from the accessibility tree by `scripts/perf/first-paint.swift`), and the resident size of the app plus the WebKit processes that started with it 3 s later. One more launch idles for 60 s and is sampled the same way. `--cold` drops the file cache first (`sudo purge`, which asks for the password).

Not measured: resident size after opening the 100 KB note or after minutes of typing. The probe reads the window but cannot type, so these need a person (or a later full-app test).

## Results

Machine: MacBook Pro (MacBookPro18,3), Apple M1 Pro, 8 cores, 16 GB, macOS 27.2, WebKit 27.2, Node 26. The run was taken with other work on the machine (load average 8.4 at the start), so absolute values are on the high side; compare runs only on a quiet machine, with the load average noted in `results.json`.

### Renderer (`results.json`)

| Measurement                                                 |                   Median |                p90 |
| ----------------------------------------------------------- | -----------------------: | -----------------: |
| Window ready, 1,000 notes                                   |                   160 ms |             173 ms |
| Window ready, 10,000 notes                                  |                   325 ms |             398 ms |
| Open 20 KB note: editor shows                               |                    18 ms |              43 ms |
| Open 20 KB note: preview complete                           |                   124 ms |             205 ms |
| Open 20 KB note: diagrams drawn                             |                   240 ms |             318 ms |
| Open 100 KB note: editor shows                              |                    26 ms |              35 ms |
| Open 100 KB note: preview complete                          |                   453 ms |             631 ms |
| Open 100 KB note: diagrams drawn                            |                 1,147 ms |           1,306 ms |
| First open after load, 20 KB (editor / preview / diagrams)  |        88 / 343 / 778 ms |                    |
| First open after load, 100 KB (editor / preview / diagrams) | 1,090 / 1,826 / 2,944 ms |                    |
| Keystroke to editor paint, 20 KB                            |                    10 ms |              13 ms |
| Keystroke to preview updated, 20 KB                         |                    46 ms |              54 ms |
| Keystroke to editor paint, 100 KB                           |                    23 ms |              26 ms |
| Keystroke to preview updated, 100 KB                        |                   203 ms |             211 ms |
| Switch notebook, 1,000 notes: to All Notes / big / small    |            6 / 8 / 44 ms |    15 / 15 / 64 ms |
| Switch notebook, 10,000 notes: to All Notes / big / small   |          9 / 11 / 897 ms | 718 / 420 / 957 ms |
| List scroll, 1,000 notes: frame time (share over 20 ms)     |               17 ms (5%) |              18 ms |
| List scroll, 10,000 notes: frame time (share over 20 ms)    |            17 ms (14.8%) |              22 ms |

### Bundle (production build)

| Part                                        | Files |          Raw |        Gzip |
| ------------------------------------------- | ----: | -----------: | ----------: |
| Startup, main page (2.12 MB JS, 122 KB CSS) |     8 |  2,237,762 B |   700,141 B |
| Startup, core worker                        |     3 |    766,749 B |   246,285 B |
| Loaded on demand                            |   481 |  8,777,404 B | 2,717,583 B |
| Whole build                                 |   492 | 11,781,915 B | 3,664,009 B |

Largest on-demand files: the diagram layout engine (1.46 MB), diagram chunks (629 KB, 435 KB, 419 KB), KaTeX (259 KB) and two Temml builds (about 205 KB each).

### App (`app-results.json`)

Release build 0.9.2-beta1 (the installed app), 5 warm launches, a new data folder (the welcome notes). Cold launches (`--cold`) need a password for `sudo purge` and were not taken.

| Measurement                                                           | Median |    p90 |
| --------------------------------------------------------------------- | -----: | -----: |
| Warm launch to first frame                                            | 666 ms | 766 ms |
| Warm launch to open note on screen                                    | 832 ms | 930 ms |
| Resident size 3 s after the note shows (app and its WebKit processes) | 286 MB | 296 MB |
| Resident size after 60 s idle (one sample)                            | 213 MB |        |

The WebKit processes are those that started with the app; another WebKit app starting during a run would be counted too.

## Reading the numbers

The budgets in `docs/architecture.md` (keystroke to paint under 8 ms on a 120 Hz display, switching notes under 16 ms) are judged on the real app; the web harness gives the shape of the costs, not their final size. The numbers that stand out are listed with the measurement they would be judged by in the issues filed from this baseline.
