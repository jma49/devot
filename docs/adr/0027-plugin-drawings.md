# Plugins draw preview blocks as SVG

Status: accepted (2026-11-16). The third step of the plugin ecosystem's order, after easy install (ADR 0025) and themes (ADR 0026).

A preview renderer whose `output` is `svg` (API version 2) answers an SVG drawing instead of Markdown, drawn for the theme on screen, so diagram languages Devot does not build in (Graphviz, D2 and the like) can come as plugins.

## Why

- Markdown cannot hold a diagram, so a renderer could only describe one.
- A layout engine for a diagram language is large, and most users never need a given one; a plugin carries it only for those who install it.

## Rules

- `contributes.previewRenderers[].output` is `markdown` (the default) or `svg`; `svg` needs API version 2 (`E_PLUGIN_CONTRIBUTION_INVALID`).
- The worker leaves a block of an SVG renderer to the page as an island (`plugin`), whose source is the renderer's key and the block (`src/core/preview/plugins.ts`).
- The main window asks the plugin through `preview.render` with the block and the theme on screen: its appearance and the diagram colours by stable name (`ground`, `text`, `series1` and the rest) as hex, so a plugin never depends on Devot's token names.
- The page rebuilds the answer from a fixed list of SVG elements (shapes, text, gradients, masks, markers, filters, `style`) without scripts, handlers, `foreignObject`, links, `use`, images, animation or anything that names a URL other than a `#` fragment (`src/renderer/src/preview/pluginDrawing.ts`).
- The drawing goes into a shadow root of its own, so its stylesheet styles only the drawing; rules naming `:host` are dropped, and the host is laid out with `contain: paint`, so nothing in it draws outside its box.
- A block the plugin declines (null) shows as code, as in a window without plugins; a drawing that cannot be read shows a short notice, and a failed call is asked for again at the next mount.
- Drawings are kept by renderer list, block and theme, so switching notes or scrolling does not ask again, and an update of the plugin does.
- The plugin's page allows `'wasm-unsafe-eval'`, so a plugin can bring its layout engine as WebAssembly inside its own script; `eval` and `new Function` stay refused, and the page still reaches no network.

## Consequences

- Exported and printed pages show such a block as code, as they do every plugin block.
- Drawings follow a theme change by being asked for again, and may use the page's `--color-*` properties in their stylesheet, which reach into the shadow root.
- A plugin must answer within the 5 s drawing limit, its first drawing included.
