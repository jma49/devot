# Import and export

Part of the [architecture overview](../architecture.md).
Part of the [Markdown dialect](markdown-dialect.md).

## Import

File > Import has three items: Markdown Files… (`.md`, `.markdown`), Markdown Folder… (one or more folders of Markdown files) and HTML Files… (`.html`, `.htm`).
A notebook's context menu has the same three items in its Import submenu: the web view starts them with `import_pick(kind, bookId)` (Rust checks both), and the session's READY payload carries that notebook as `destination`, so the sheet skips choosing one (a folder's tree offers Import into it; picked files import at once).
If the notebook is gone by then, the sheet asks as usual.
A cancelled panel sends nothing.

- **Reading:** Rust shows the panel, scans what was picked and keeps it as an import session (`src-tauri/src/import.rs`); the web view never names a path outside it.
  A folder scan runs on its own thread and reports how many Markdown files and images it has found (`devot://import-scanning`, `devot://import-progress`, then `devot://import-ready` or `devot://import-failed`); closing the session (`import_finish`) cancels a scan still running.
  The UI reads files by session ID and relative path (`import_read`, `import_attach`, `import_finish`): relative to the folder for one folder, starting with each folder's name (made unique) for several, and for picked files their names (starting with their folder's name when they come from several folders).
  Hidden files and folders are skipped.
  Symbolic links are not walked (a target inside the folder is imported under its own path; a link to a folder or Markdown file that is hidden, outside it or missing is reported); an image link may go through a link, but never to a hidden file or out of the folder (for picked files, only an image file in the file's own folder or one folder below it, links followed, such as `img/shot.png` or a saved page's `Page_files/`: picking one file never opens the rest of a large folder to the import).
  Markdown files and images over 10 MB are left out and listed as skipped.
- **The sheet** (`src/renderer/src/ImportDialog.tsx`): a folder import is a wizard in one sheet: the scan with its progress; a tree of the folders found, each with its Markdown files, images and size and whether it becomes a notebook (`importTree`, `src/core/importTree.ts`), and the files that will be skipped; the destination (a notebook, or No Notebook; the open notebook to begin with); then the import's progress and its result: how many notes were imported, skipped and failed, and every file or image that was not imported, with the reason and its code (never note content).
  Picked files go straight to the destination.
  Cancel (or Escape) ends the session at any step before Import, and nothing is written to the database before Import is pressed.
  Imports picked while a sheet is up wait until it is closed; their scans go on meanwhile.
- **Notebooks:** notes go into the destination.
  One picked folder is not a notebook itself: its files go into the destination, and every folder inside it that holds an imported note (at any depth) becomes a notebook nested as on disk.
  When several folders are picked, each becomes a notebook too.
  Picked files all go into the destination.
  Folders with no imported notes under them, such as image folders, do not become notebooks.
  An empty folder imports nothing.
  The destination is shown afterwards (or the one top-level notebook made, with No Notebook).
  The notebooks are made before the first note, in one write (`BookService.createMany`, storage's `putBooks`, the Tauri command `books_put`, one transaction of up to 5,000), in the order the files (in path order) first need them, with the names, sort keys, parents and clocks that making them one by one would give; the notebooks of folders whose files all failed, or that a stopped import never reached, are deleted again at the end, in one write too (`removeMany`).
  Making each alone listed every notebook before it, and a note made in a notebook listed them all to check it was there (now `isLiveBook`, `book_is_live`), so an import took time quadratic in its folders.
- **Title:** Devot's own front matter `title` (see below), else the first level-one heading, else the file name without its extension (for HTML, the page's `<title>` comes before the heading).
  The body keeps its heading.
  File and folder names are composed (NFC) first, as macOS may give them decomposed and typed text, which searches compare by code point, is composed; CJK compatibility ideographs stay as they are.
  A note whose title is not composed so gets its title in the front matter on export.
- **Front matter:** only front matter that Markdown export added (its first line is the comment `# Devot metadata`) is read, as YAML with the `yaml` library (comments, quote escapes, block and multi-line scalars, lists over several lines; a key whose YAML is not valid is read from its line as far as that goes): its `title` (exactly, only cut to the limit), `tags` (a leading `#` kept; the escapes of double-quoted values read) and `status` become the note's, and it is left out of the note.
  Any other front matter is the note's own text: it stays in the body as written and nothing is read from it (its `title`, `tags` or `status` included).
  A key's line may hold a line or paragraph separator (U+2028, U+2029).
- **HTML:** an HTML file is sanitized (the default GitHub-style schema; scripts, styles, frames, objects and inline SVG or MathML are dropped with their content, event handlers, comments and `javascript:`/`data:` URLs go) and converted to Markdown (`src/core/htmlImport.ts`, with GFM tables, task lists, strikethrough and math; thematic breaks as `***`, so a converted page never starts with a front matter fence).
  From there it imports as a Markdown file does, so its local images become attachments.
  Before the page is sanitized, images embedded as `data:` URIs (PNG, JPEG, GIF, WebP, AVIF or HEIC in base64, as Export as HTML and page savers write them) are taken out and stored as attachments through `putFile` (checked as an upload is, `validate_upload` in Rust), their links pointing at them; a lazy-loaded image's `data-src` wins over its placeholder `src`; and MathML that carries its TeX (an `application/x-tex` annotation, which the preview's MathML keeps, so an exported page has it) becomes `$...$` or a `$$` block again.
  Whatever else the conversion leaves out (inline SVG such as a drawn diagram, MathML without TeX, frames, objects, media, other `data:` or local-file image URLs) is listed in the result as not imported (`E_IMPORT_HTML_CONTENT_DROPPED`, each kind once per file, the first 100 and then `+N` for the rest; an image listed so is left out of the note), and so is an embedded image that could not be stored (its link is left empty).
- **Images:** local images (`![](path)`, reference definitions that images use, and the `src` of an `<img>` in raw HTML, read as HTML reads it) resolve against the note's folder (a leading `/` means the import folder) and become attachments; Rust reads them from disk and checks their format by their bytes.
  Only their destinations change, to `devot://file/<id>` (a size preset stays: `img.png#half` becomes `devot://file/<id>#half`; any other fragment or query is dropped), and an image used twice in a note, at any size, is one attachment.
  Remote images stay as they are.
  A `\` in a destination or a file name is an ordinary name character (only `/` separates folders, in Rust's `resolve` too), so `C\C++ notes.md` imports and `![](shots\one.png)` names a file called `shots\one.png`.
  Missing or refused images and images outside the folder keep their original link and are listed as not imported, and so is an image whose link cannot be found in the text to rewrite.
  A destination is read as CommonMark reads one: it ends only at an ASCII space or control character (a screenshot's name may hold a narrow no-break space), its parentheses balance at any depth, and character references count (`Q&amp;A.png` names `Q&A.png`).
- **Parsing off the core worker:** each file is converted (HTML) and parsed for its title, front matter and image links in a worker of the import's own (`src/renderer/src/import.worker.ts`, started for each import and ended after it), so the saves queued in the core worker go on meanwhile however long a large page takes; the core worker only stores what comes back.
  A worker that cannot start or fails hands the files back to the core worker (logged as `W_IMPORT_WORKER_FAILED`).
  Reading, converting and parsing take time linear in the size of a page: library steps that looked each node up among its siblings, took the whitespace between blocks out one at a time, or read the rest of the page for each line's end, were quadratic in a parent's children or a page's lines; the sibling lookups are fixed upstream (unist-util-visit 5.2, mdast-util-find-and-replace 3.0.4), and the other two are patched (`patches/`).
- **Bodies:** each body reaches its note as Yjs operations (`NoteService.setBody` applies a text diff), never by writing the snapshot.
  A file that fails part-way leaves nothing behind (its note is deleted with its attachments, and so are notebooks made only for it; tags are added last) and is listed as not imported.
- **Line breaks:** `\r\n` and a lone `\r` become `\n`.
  The editor counts a CRLF as one character and the Yjs text as two, so a body that kept `\r` would put every later edit in the wrong place.
- **Lossless:** apart from image destinations and line breaks the snapshot equals the source text byte for byte, so an export that writes the attachments back and restores their paths gives the original files (with `\n` line breaks).
- **Backups and quitting:** an import and the Backups dialog never overlap: Backups… chosen during an import opens once the import's sheet is closed, and a folder picked while Backups is open is imported once it closes, so a restore never mixes with an import.
  Quitting stops an import after the file it is on; only a file still unfinished when the quit allowance (2 s) runs out can be left as a note with an empty body.
- Notes get the import time as their creation and update time.

## Export and print

The note context menu has Export as HTML…, Copy as HTML, Copy as Simple HTML, Export as Markdown…, Export as PDF… and Print… (Shift+Cmd+P, anywhere in the window; Cmd+K is the palette); the palette lists them for the open note.
With several notes selected, the menu keeps only Export Selected Notes as HTML… and as Markdown…, which write the notes side by side in one new folder (`Devot Export`), named after their titles and numbered on a clash; the others act on one note (Shift+Cmd+P does nothing then).
The notebook context menu has an Export submenu (as Markdown…, as HTML…) for the notebook with its sub-notebooks.
File > Export > All Notes as Markdown… and as HTML… (also in the palette) export every note into one new folder (`Devot Notes`): each top-level notebook a folder as in a notebook export, in sidebar order, the notes in no notebook (or in a deleted one) at the top, Templates and the Trash left out.
All three use the notebook's folder panel and session.

- **Panels and files:** Rust shows the native save panel (a note) or folder panel (a notebook) and keeps the choice as an export session (`src-tauri/src/export.rs`): the folder, opened once when it was picked and never looked up by its path again (see Security).
  The web view writes by session ID and a relative path, which Rust checks (plain visible components, the session's extension).
  Every file is written to a new temporary file in its folder and renamed into place, never through a link (see Security), and the folders on its way are made one by one, each opened from the one before as a real folder, and the file is written in the folder so opened (a link in the way fails the file, never followed; one swapped in after the check is never reached).
  A notebook goes into a new folder named after it (`Work`, or `Work 2` when that exists), so nothing on disk is replaced; a note replaces only the file the save panel confirmed.
  Logs carry codes and IDs only.
  A failure is logged by its code and a notice says what did not complete (an export, a print or a copy); notices stack in the window's bottom right corner, so a backup's and an export's never cover each other.
- **Markdown** (`src/core/export.ts`): a note is one `.md` file named after its title; a notebook is a folder, its sub-notebooks folders inside it, its notes files in their notebook's folder.
  Names are made file-safe (no `/`, `:`, control characters or leading dot; at most 200 bytes) and numbered when two would clash as macOS sees names, whatever their case or the form of their accents, or, to be safe, a compatibility form that macOS keeps apart, `x²` and `x2` (`nameKey`: `Plan.md`, `Plan 2.md`; a sub-notebook's folder never takes a note's file name or `attachments`).
  The body is written as it is stored, except: attachments (`devot://file/<id>` image destinations and `<img>` sources in raw HTML, whose ID is a UUIDv7, as Rust accepts; any other such link stays as written) are copied from the database into an `attachments` folder at the top of the export under their own names (a different file of that name already there is kept and the copy is numbered; the same bytes are reused), and their links become relative paths (`../attachments/board.png`, with spaces of any kind, parentheses, `&` (which would start a character reference), `|` (which would end a table cell) and the like percent-encoded, and in an `<img>` quotes too; an image shown at a size preset keeps it as the path's fragment, `../attachments/board.png#half`, which other tools ignore when they load the image and import reads back; each attachment is copied once, whatever sizes it is shown at; an image whose link cannot be found in the text keeps it and is listed as a problem, `E_EXPORT_IMAGE_UNLOCATED`); and the title, tags and status go into front matter where import would not read them back: import reads them only from Devot's own block, opened by the comment `# Devot metadata` (the marker), which it reads exactly and leaves out of the note again.
  So a note whose title is not its first heading or file name, or that has tags or a status, gets that block first; a note's own front matter is never changed (the block goes before it, and import keeps it in the body as it is), and a note whose own front matter would itself read as Devot's block (its first line is `# Devot metadata`) always gets the block.
  Values are single-quoted, or double-quoted with escapes when they hold what cannot be written on one line as it is (control characters, line and paragraph separators, a byte order mark).
  Note links (`devot://note/<id>`) stay as they are.
  So export then import gives the same notes (title, body, tags, status, notebook structure and images), checked on real files in `tests/core/export.test.ts`.
  Notebooks without notes under them do not come back (import makes notebooks for folders with notes), and names come back file-safe.
- **HTML** (`src/core/htmlExport.ts`, `src/renderer/src/exporter.ts`): a note's page is its sanitized preview tree serialized, in a document of its own: no scripts, and a `Content-Security-Policy` meta that allows only its own styles and images (`data:`, `https:`, `http:`; a page to print allows `data:` images only, see Print and PDF).
  Its styles are the design tokens (light, and dark on screens set to dark; print is always light), the preview's note content rules (`preview/content.css`, shared with the app) and the page's own (`preview/page.css`).
  Attachment images (a UUIDv7 ID; any other `devot://file/` image stays as written, so one stray link never fails the page) become `data:` URIs: the UI puts a token with a per-page random nonce in each image's `src` and Rust swaps in the bytes, so text in the note can never be mistaken for one.
  A size preset is the preview's class (`image-size-half`, sized by `content.css`), so exported and printed pages size images as the preview does.
  A table wider than the page scrolls sideways inside its own box on screen, its columns keeping their words whole, as in the preview; on paper it fits the page.
  Mermaid diagrams are drawn by the UI (light) and cleaned again in the core; video embeds and click-to-load embeds become links; swatches get an inline colour; the preview's `data-*` attributes are dropped.
  A notebook gives one page per note, and links between its notes point at their pages.
  Copy as HTML copies the same page as text; Copy as Simple HTML copies the bare markup without any class, style or `data-*` attribute, front matter or drawing (diagrams show their source, alerts become block quotes with a bold title); a sized image gets no width there either (Half has no pixel width to give), so it shows at its own size, as in other Markdown tools.
  Both copy as plain text (the HTML source), with images as `data:` URIs.
- **Print and PDF:** Rust lays the note's page out in an offscreen `WKWebView` (scripts off) and runs an `NSPrintOperation` on it into a PDF on the paper and margins of the page setup (`native/macos/print.rs`), then draws that PDF's pages again with the header and footer (see Page setup): Print… prints that PDF through the system print panel as a sheet on the window (PDFKit, each page scaled down to the paper picked there if it does not fit); Export as PDF… asks where to save in a save panel, prints without a panel into a new private folder in the app's data (`<app data>/pdf`), and copies the PDF from there into place through a temporary file beside it, like any file, in the folder chosen, opened when the save panel closed.
  AppKit creates the PDF by its path, so the folder it prints in must be one nobody else can reach: a private folder in the chosen folder could be swapped for a link while the job runs by anyone who may remove names there (the owner of a folder the user saves into, say), and AppKit would print through it.
  One print job runs at a time.
  The job is named after the note's title (control characters as spaces, at most 1000 characters).
  A load failure (or the page's process ending) ends a job only before printing starts; once the print panel is up, the job ends when the operation reports back.
  AppKit reports back on the thread the operation printed on (a PDF's runs on a thread of its own), so the result is handed to the main thread, where every job ends and frees the print slot for the next.
  A cancelled print panel is no failure; a PDF has no panel to cancel, so one that was not written fails with `E_EXPORT_PDF_FAILED` (AppKit may show its own alert first).
- **Page setup:** Print… and Export as PDF… first show Page Setup (`PageSetupDialog.tsx`): the paper (A4, US Letter, A4 landscape, a 16:9 slide), the margins (narrow, normal, wide: half an inch, three quarters, an inch), a header and a footer with a left, centre and right slot each, whether the first page goes without them, and thin rules under the header and above the footer.
  Until the user picks a paper it starts from the system's: US Letter when macOS's default paper is as wide as Letter, A4 when it is A4, otherwise by the region (Letter in the United States, Canada, Mexico and the other Letter regions).
  It remembers the choices as editor settings (the `page*` keys, checked in TypeScript and Rust like the others: a slot is up to 100 characters, no control characters); Print or Export stores them first, and Rust reads them from the settings for the job (`src-tauri/src/page_setup.rs`).
  A slot's `{title}`, `{page}`, `{total}` and `{date}` (the note's title, the page number, the number of pages and today's date as the locale writes it) are filled in per page.
  WebKit's print path takes the paper and margins from the print info and honours `@page` margins, but ignores `@page` size and draws no margin boxes (`@top-left` and the like), and a fixed element prints on the first page only, so the header and footer cannot come from CSS: Rust draws each page of the laid-out PDF again into a new PDF (Core Graphics, the page as a form, so its text stays text) with the header and footer as text halfway into the top and bottom margins (the rules a quarter of a margin before the note), and keeps the page's links (web links and links to a heading on another page).
  The text and rules take the light theme's tertiary text and hairline colours and the smallest caption size, which the UI hands over from the design tokens (`look`).
- **Images from the web in the preview:** by default images in notes load as written, as in any Markdown tool: the production CSP allows `https:` images (besides `'self' data: blob: devot:`), so the preview renders `https` images (Markdown and allowed raw `<img>`) directly; the sanitizer is unchanged.
  Settings > Preview > Load Images from the Web (`loadRemoteImages`, on by default, stored with the editor settings) turns that off for a reader who does not want a synced, imported or agent-written note to tell a site when it is read: each `http(s)` image then renders as a placeholder ("Image from {site}", a Load button; the `devot.images` renderer with the `remoteImages` preview option, so no `<img>` for it is ever built) in the preview, in Write mode's image blocks and in the editor's image widgets under their lines.
  Load loads that site's images in every preview and editor of the window, and is remembered for the session only (`src/renderer/src/remoteImages.ts`); attachments, `data:` and `blob:` images always show.
  Every app page has `<meta name="referrer" content="no-referrer">`, so an image request carries no `Referer` (embeds keep their own `strict-origin-when-cross-origin`).
  Plain `http` images are not allowed by the policy and do not load.
  HTML export keeps the images and print shows links (see Nothing from the web in print).
  A production-CSP Playwright test checks that an `https` image loads with no violation reported.
- **Nothing from the web in print:** printing never loads an image from the web, so no server learns that a note was printed and no slow host holds a job up.
  Rust puts its print policy (`PRINT_POLICY`: only the page's own styles and `data:` images) in front of every page it prints, before anything of the page's, whatever the page's own policy says; the UI's pages to print carry the same policy (`PRINT_CSP`, kept equal by a policy test) and show each image from the web as a link to it, its alt text (else its URL) as the link's text (only the text inside another link), leaving out a `picture`'s other sources.
  Exported HTML keeps such images, to load where the file is opened.
