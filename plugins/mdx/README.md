# MDX Plugin for Devot

Adds `.mdx` import and export, MDX syntax highlighting, live JSX component and expression preview, an interactive MDX Studio inspector, slash menu component snippets, and bidirectional MDX to Markdown conversion under Devot Plugin API v2.

## Installation

Open **Settings > Plugins > Install from Folder…** in Devot and choose this folder, or compress it into a `.zip` archive and choose **Install from Archive…**.

## Features

### Import and Export

- **File > Import > MDX Files…**: imports `.mdx` files losslessly while reading note titles from YAML front matter, `export const metadata` / `frontmatter`, the first level-one heading (with inline expressions evaluated), or the file name.
- **File > Import > MDX Files as Markdown…**: imports `.mdx` files and compiles JSX components, expressions, and MDX comments into native Devot Markdown.
- **File > Export > Note as MDX…**: exports the open note as an `.mdx` file, unwrapping any active MDX preview fence and preserving YAML front matter.

### Inline Preview and Syntax Highlighting

- **` ```mdx ` blocks**: renders MDX prose, YAML front matter, `export const` bindings, `{expressions}`, local `export function` JSX components, and built-in documentation components directly in Devot's preview pane.
- **` ```mdx-code ` and ` ```mdx-source ` blocks**: renders syntax-highlighted MDX source code with line numbers.
- **Playground directives**: start an ` ```mdx ` block with `// @highlight` to show highlighted source only, or `// @both` to show highlighted source above the rendered component preview.

### Commands and Shortcuts

- **Preview and Inspect MDX** (`Cmd+Ctrl+Shift+M`, `Plugins` menu, Command Palette): opens the interactive MDX Studio sheet for the open note with four tabs:
  - **Preview**: interactive `<Tabs>`, `<Accordion>`, `<Callout>`, `<Steps>`, `<CardGroup>`, `<FileTree>`, `<Badge>`, `<Kbd>`, `<Stat>`, local JSX components, and fallback cards with prop inspection for project-specific components.
  - **Highlighted MDX**: line-numbered multi-layer MDX syntax highlighting across YAML front matter, ESM `import`/`export`, Markdown, JSX tags and attributes, `{...}` expressions, and `{/* ... */}` comments.
  - **Compiled Markdown**: previews the native Devot Markdown output and applies it to the open note as one undoable step.
  - **Inspector**: lists components, imports, exports, and MDX v3 syntax diagnostics with line and column numbers.
- **Toggle MDX Preview Block** (`Cmd+Ctrl+Shift+P`): wraps or unwraps the open note's body in an ` ```mdx ` preview fence while keeping YAML front matter at the top, enabling live Split View rendering.
- **Compile MDX to Markdown** (`Cmd+Ctrl+Shift+C`): compiles MDX components and expressions in the open note to native Devot Markdown as a single undo step.
- **Convert Markdown to MDX**: converts HTML comments (`<!-- -->` to `{/* */}`), Devot alerts (`> [!NOTE]` to `<Callout>`), unclosed void HTML tags (`<br />`, `<img />`), `class`/`for` attributes, and bare `<` before numbers into valid MDX v3.
- **Insert MDX Callout / Tabs / Steps** (Slash menu `/` and Command Palette): inserts ready-to-edit MDX component blocks at the cursor, or wraps selected text inside a `<Callout>`.

## Built-in MDX Components

- **Admonitions**: `Callout`, `Alert`, `Admonition`, `Note`, `Tip`, `Info`, `Important`, `Warning`, `Caution`, `Danger`, `Error`, `Check`, `Success`
- **Interactive and Disclosure**: `Tabs`, `Tab`, `TabItem`, `Accordion`, `AccordionGroup`, `Details`, `Collapsible`, `Expandable`
- **Layout and Navigation**: `Card`, `LinkCard`, `Cards`, `CardGroup`, `Columns`, `Column`, `Grid`, `Frame`, `Figure`
- **Workflows and Code**: `Steps`, `Step`, `CodeGroup`, `CodeBlock`, `Pre`, `FileTree`, `FileTree.Folder`, `FileTree.File`
- **Inline and Reference**: `Badge`, `Pill`, `Tag`, `Kbd`, `Highlight`, `Mark`, `Tooltip`, `Stat`, `Metric`, `ParamField`, `ResponseField`, `Property`
- **Diagrams and Media**: `Mermaid`, `Math`, `YouTube`, `Vimeo`, `Video`, `Embed`
