---
id: bench-renderer-baseline
category: benchmarks
date: 2026-11-19
topics: [performance, preview, launch]
verified: true
source: docs/benchmarks/README.md
---

# Renderer and launch baseline

The source file does not call these numbers a marketing claim.
It says the run was taken with other work on the machine, load average 8.4 at the start, so absolute values are on the high side.
Compare runs only on a quiet machine.

## Machine

MacBook Pro (MacBookPro18,3), Apple M1 Pro, 8 cores, 16 GB, macOS 27.2, WebKit 27.2, Node 26.

## Renderer medians from that run

- Window ready, 1,000 notes: 160 ms. With 10,000 notes: 325 ms.
- Open a 20 KB note until the preview is complete: 124 ms.
- Keystroke to editor paint, 20 KB note: 10 ms. Until the preview updates: 46 ms.

## App launch

Release build 0.9.3-beta1, five warm launches, a new data folder.
Cold launches were not taken.
Warm launch to first frame: median 579 ms.
Warm launch until the open note is on screen: median 710 ms.
Footprint 3 seconds after the note shows, the app and its WebKit processes: median 165 MB.

## Reusable snippet

On the loaded M1 Pro baseline in `docs/benchmarks/README.md` (load average 8.4, so the figures are high), the window was ready in a median of 325 ms with 10,000 notes, and a warm launch of 0.9.3-beta1 reached the open note in a median of 710 ms.
Do not quote the medians without that load note.
