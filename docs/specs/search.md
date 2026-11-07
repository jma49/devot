# Search

Part of the [architecture overview](../architecture.md).

Search covers live notes (never the Trash) through the FTS5 trigram index (`src/core/search.ts`, `notes_search`).
A search first re-indexes the notes saved since they were indexed, so it finds what they hold now (see [Data model](data-model.md), FTS5).

- **Syntax:** words and `"quoted phrases"` must all appear in the title or body (case-insensitive substrings).
  Qualifiers narrow the search: `title:` and `body:` (text in that part only), `book:` or `in:` (the notebook and its sub-notebooks, like selecting it in the sidebar), `tag:`, `#name` (the tag when one has that name, found when the query is resolved, otherwise the text `#name`, so `#include` still finds code; `#"two words"` for a name with spaces, and a quoted `"#name"` is always text), `status:` or `is:` (an ID such as `on_hold` or a name such as `"On Hold"`, in any case, with spaces, hyphens or underscores), `bookId:` and `tagId:` (the same by ID, a UUID; `bookId:` also includes sub-notebooks) and `pinned:` (`true`, `yes` or `1`; `false`, `no` or `0`; any case).
  A leading `-` excludes what any clause matches (`-draft`, `-tag:done`, `-pinned:true`, which is `pinned:false`).
  Phrases take `"…"` or `'…'`; a single quote opens a phrase only at the start of a clause or right after a qualifier, and only when a closing one follows (before a space or the end), so `don't` and `'tis` stay words.
  Clauses combine with AND, so repeating a qualifier narrows further.
  Names match in any case (accents count); a name with spaces is quoted (`book:"Weekly notes"`).
  A query keeps at most 10 clauses; a text value keeps at most 100 characters, and a `book:` or `tag:` name as many as a notebook or tag name can have (200 and 100).
- **Malformed input** never fails: an unknown qualifier, an empty value, an unknown status, an ID that is no UUID or a `pinned:` value that is no boolean is searched as the plain text typed; an unclosed double quote runs to the end, an unclosed single quote is literal.
  A `book:`, `bookId:`, `tag:` or `tagId:` naming nothing matches no note; excluding one excludes nothing.
  Two `pinned:` clauses that disagree, or one that disagrees with the view's Pinned filter, match nothing.
  The search field's "?" button lists the syntax.
- **Where it runs:** the core parses the query and turns notebook and tag names into IDs (`resolveSearch`; `NoteQuery.pinned` is true, false or null for either, in the core, the Rust store and the SQLite adapter); storage runs every condition in SQL before the result limit (200), so a qualifier never loses matches to the limit.
  Indexed text is matched in the FTS table first and ranked by bm25 (an excluded word uses the index too); text under three characters is scanned (it reads the bodies, of the ranked matches only when there are some), folding case with the SQL function `devot_fold` that both SQLite stores (Rust and `tests/support/sqlite-adapter.ts`) register, the same character-for-character fold as the trigram index and the core, so "ém" finds "Émile" (shared cases in `tests/support/folds.json`).
  Live notes come from the note list's index (schema v14 `notes_list`, which covers what a search filters on and returns), never from their rows: a note's small columns come after its Markdown and its Yjs state in the row, so reading them there walks every overflow page of both, and a search would cost more the longer the notes are.
  A ranked search walks the whole list index even when one note matches (O(notes), about 2.5 ms for 50,000 notes): a deliberate trade-off, since letting the matches drive the join reads each match's row through its blobs and costs twice as much once a word is in many notes.
  Ties go to the newer note, then by ID, as in the note list.
  The note list reads the same index and stops at a page in SQL (`listNotes` with a limit and a notebook to leave out, Templates; command `notes_list`), so the list's first notes cost the same in any library.
  List rows by ID (`getSummaries`, command `notes_summaries`, at most 500 IDs like `notes_bodies`, which also takes them in one statement) are found through the primary key and read from their rows: for a page of IDs that costs far less than the index of every note; the preview's and the hover card's link targets read them.
  The Rust store, the better-sqlite3 adapter and the UI tests' memory adapter implement the same rules, and a property test checks SQLite against a plain model of them; tests check the query plans and that the results (rows and order) are those of the statements schema v14 replaced.
  A benchmark keeps 10,000 notes of a few KB each (with Yjs states larger than their text) under 50 ms for the lists and searches, excerpts included, and under 100 ms for a scan of every body (a missing two-character word).
  A word found in nearly every note together with a two-character word misses 50 ms at these sizes (about 65 ms: every body is read); the benchmark marks it as a known failure until #48 is fixed.
- **Saved searches** (`src/core/savedSearches.ts`, schema v25 `saved_searches`): a name (at most 100 characters) and a query in this syntax (at most 1,000 characters, one line), kept as typed and resolved each time it runs, so one that names a notebook or tag since deleted matches nothing and stays; a sort key orders the rows by hand (`order.ts`), like notebooks.
  Rust validates a record as it does a tag's (`E_SAVED_SEARCH_*`).
  Each is a sync record of its own kind (`search`), merged per field by HLC; a Devot from before them skips the record on pull and counts it as skipped until a newer build pulls everything again (the engine's `skippedBy`).
  A query is counted from the listed notes' fields alone (`countMatches`), and by running the search when it has text.
  Renaming a tag (`tag_rename`) rewrites in the same transaction every saved search whose query names it (`tag:Old`, `-tag:Old` or `#Old`, quoted or not, matched like a search matches names) to `tag:New`, or `tagId:` when no quoting holds the new name or the query would pass its limit (a rename that would still leave one too long is refused with `E_TAG_RENAME_SEARCH_TOO_LONG`, nothing changed; renames run one at a time); the rest of the query stays as written, and a query is left alone while another live tag still has the old name (two tags of one name that sync brought: the clause goes on naming the other), and each rewrite is an ordinary query edit for sync.
  A rename pulled through sync rewrites the saved searches on the device that pulls it the same way (a query too long to rewrite is left as it is and logged by code), so one saved or edited there by the old name before the rename came, which wins the merge, follows it too and goes out as an edit.
- **Two scopes:** Shift+Cmd+F (or `/` in the note list) searches the current view: the selected notebook and filter stay, and the field reads "Search in <view>".
  Shift+Opt+Cmd+F searches every note; while it does, nothing in the sidebar shows as selected (the notebook, All Notes or filter shows again once the search is cleared, and a row pressed meanwhile shows its own view: a notebook comes without the hidden filter, a filter covers every note rather than the hidden notebook).
  Escape or the clear button empties the field and returns to searching every note.
  Typing a search in the Trash shows All Notes.
- **Results:** in relevance order (see Note list order).
  Each row marks the words found in its title and in an excerpt of the body around the first word found there (about 160 characters), built from text nodes and `<mark>`, never from HTML.
  Storage cuts excerpts in code for the returned notes only, folding case one character for one like the trigram index.
  An excerpt is cut from the body's readable text (`src/core/readable.ts`, mirrored step for step in Rust with shared test cases): a leading front matter block is skipped and Markdown markers come out (heading, list, quote, task and alert markers, emphasis paired as in CommonMark, code fences and backticks, link and image syntax keeping the link text and alt text, defined link references, HTML tags and comments, table pipes; `[[target]]` and `[[target|label]]` from other tools show the label, else the target), while text that only looks like syntax stays as the preview shows it (an unpaired `*` or `_`, brackets that make no link, a `<` that opens no tag), so the marks land on the words as shown; a word found only in front matter or syntax shows no excerpt; an excerpt that would open inside a word starts at the next word instead (a cut with no space before the word found, as in Chinese text, stays where it falls).
  A body of more than 600 characters is not read whole, so a page of results costs the same however long the notes are (`EXCERPT_STRETCH`): a word is looked for as written (in any case), at most 8 places, after the front matter, and each place is read with 300 characters on each side as a body of its own (growing 300 at a time while the word shows too near an end of it for a whole excerpt).
  So in a long body a word that only markers cut apart (`te**rm**`) shows no excerpt, and a code fence or comment opened, or a link reference defined, outside that stretch is not known in it (`tests/support/excerpts.json` holds the cases both stores agree on).
- The MCP tool `search_notes` uses the same syntax; `book:` and `bookId:` name only notebooks AI may see.

## Find in a note

- **Bar:** Cmd+F opens a find bar above the open note; Option+Cmd+F opens it with a replace row.
  Cmd+G and Shift+Cmd+G (or Return and Shift+Return in the field) go to the next and previous match, wrapping around; the bar shows "3 of 12".
  Option+Cmd+R toggles regular expressions and Option+Cmd+C case sensitivity (only while the bar is open).
  Escape in the bar or the searched pane closes it and returns the focus there (in the editor, its popups and the selection toolbar take Escape first).
  The shortcuts are the registry's `find.*` commands, in the `window` scope: they work window-wide while a note is open (`src/renderer/src/find/`), ahead of the editor's own Cmd+F and Cmd+G, and a held Cmd+G keeps stepping; the registry's clash test keeps them apart from every other key.
  F3 and Shift+F3 step through matches in the editor while the bar is open (editor-scope commands).
  The command palette lists Find in Note, Find and Replace and the match steps while a note is open, and the two toggles while the bar is open.
  A selection made by the user becomes the query when the bar opens; a selection the query already matches (the match left selected when the bar closed) does not.
  With the bar closed, Cmd+G and Shift+Cmd+G reopen it with the last query and go on to the next or previous match from the cursor.
  The bar's buttons use `aria-disabled` rather than `disabled`, so a button that runs out of matches (Replace All from the keyboard) keeps the focus and Escape still closes the bar.
- **Matching** (`src/core/find.ts`, shared by both panes): plain text by default, case-insensitive unless Match Case is on; a regular expression runs in Unicode mode with `^` and `$` per line (a pattern only the older syntax accepts, such as `\#` or `\-`, runs without Unicode mode), and an invalid one shows "Invalid regular expression" instead of failing.
  Empty matches (`^`) count and can be replaced, so replacing `^` with `> ` quotes every line.
  At most 10,000 matches are counted and marked ("More than 10,000 matches"); Replace All has no limit.
  Regular expression replacements expand `$&`, `$1`, `$<name>` and the rest as `String.prototype.replace` does (a property test checks this); plain replacements are inserted as typed.
  While the bar is open, a change to the note finds plain text again only around the change (`updateMatches`): the matches before it are kept, a window as wide as the change plus the longest possible match is searched, and the matches after it are moved once the scan is back in step with the old one, so a keystroke in a big note never searches the whole note.
  A regular expression, and a result already over the 10,000 cap, are searched again in full, since a match can depend on text far from the change.
  Property tests check that the matches, the count and the current match equal a full search after random edits, in the editor and in the preview.
- **Editor:** matches are CodeMirror decorations and the current match is the selection (it does not pop up the selection toolbar).
  On a change, the marks are mapped through it and only those in the searched window are replaced.
  F3 and Shift+F3 in the editor also step through matches; CodeMirror's own search panel and Go to Line dialog never open (`editor/settings.ts` keeps only its two searches that open nothing, Select Next Occurrence and Select All Matches, and a test checks that no built-in key opens a panel, also with Find Next moved to another key).
  Replace and Replace All are ordinary editor transactions, so they reach the Yjs document like typing; each is one undo step.
  `@codemirror/search` is not used: its marks only show with its own panel, and the preview needs the same rules outside the editor.
- **Preview:** Cmd+F in preview mode searches the rendered text (a line break between blocks and at every line break, so a match never runs across two paragraphs, but it does across bold or links) and paints matches with the CSS Custom Highlight API, so the preview's DOM is never changed and its patcher keeps owning every node; the marks follow re-renders.
  Rendered text cannot be edited, so the preview has no replace row; diagrams (islands) are not searched.
  Each piece keeps the text it read, so after a re-render only the pieces a mutation touched are read again (`previewTextReader`), and the matches are updated from the span where the text changed.
- **Split mode:** Cmd+F searches the pane that has the keyboard focus: the preview after a click in it, otherwise the editor.
  The bar stays on that pane until find opens again from the other one.

## Write mode

- **What:** the fourth view mode beside Edit, Split and Preview (`src/renderer/src/editor/write/`), one choice with them: its own round toolbar button stands before their group (`ModeControl.tsx`), and while it is chosen no segment is pressed.
  The note stays Markdown; the editor hides the marks of every element the selection is not on and styles the text instead: emphasis, strikethrough, inline code, `==` and `<mark>` lose their marks, a link shows its text (a note link as a chip; one with no text shows the note's title, loaded as the hover card loads it; `[[text]]`, no link in Devot's Markdown, stays plain text with its brackets, as the preview shows it), a footnote reference and the start of its definition show the footnote's number raised at caption size in the link colour, numbered as the preview numbers them (`footnotes.ts`: a label with a definition, in the order of its first reference outside code), a heading loses its `#`s and keeps the heading line's size, a quote loses its `>` and keeps its bar, an alert shows its kind as a label, a bullet is drawn over its list mark, a task's box is a checkbox that ticks the task (`taskToggle`, one undo step), a horizontal rule is a line, an emoji shortcode and a `<kbd>`, `<sup>` or `<sub>` element are drawn as the preview draws them (their Markdown goes through the preview's renderers as a rendered block's does, `inline.ts`, and is drawn from memory after the first time; an element holding other HTML or an image stays source, so nothing drawn is taller than its line), and front matter folds to one row naming its keys, which opens on click.
  Inline math is drawn as the preview draws it, through the same renderers and memory as an emoji; a formula the preview shows as text or one over lines stays source, and one taller than its line (a fraction) makes the line taller while it is drawn.
  Code blocks keep their box; their fences turn transparent while the selection is outside the block, so the fence lines keep their height (a long info string wraps as it does as source), the opening one naming the language (as the preview's code header names it) at the box's inner right edge in caption size and `color.text.tertiary`; an alert's text is upright in `color.text.editor` and its title semibold in its alert colour, as the preview draws them; a table is a grid (see below); HTML blocks other than a frame stay source for now.
- **Which elements show their source:** each element by itself, while a selection meets it, or a caret is in it or at its edge while the editor has the keyboard (a note just opened reads as a document): a span its marks, a link its whole `[text](url)`, a footnote its `[^label]`, a footnote's definition its `[^label]:` while the caret is on its lines, a heading its `#`s while the caret is on its line, a code block its fences while the selection is on one of its lines, an alert its `[!KIND]`, a horizontal rule its `---`, an emoji its shortcode, a formula its dollars and TeX, a `<kbd>`, `<sup>` or `<sub>` element its tags and everything in them, a rendered block its source.
  The other elements of the same line stay styled.
  List bullets and numbers, task checkboxes and quote marks are never source: the caret passes a list mark and its space as one unit.
  Front matter goes by lines: it opens while the selection is on one of its lines.
  A double click on an element the first click opened takes the word the first click was on, since showing the marks moved the text under the pointer.
- **Rendered blocks** (`blockRanges.ts`, `rendered.ts`): a line of images alone (attachments and https images), `$$` math (over lines or on one line) and a `math` fence, a closed `mermaid` fence, a video link alone on its line and an `<iframe>` block show as the preview shows them, at the top level of the note (not in lists or quotes).
  The block's Markdown goes through the preview's own renderers in the core (`renderPreviewPieces`, so plugin renderers too), and the sanitised tree is built with `preview/dom.ts`; diagrams are the preview's islands, whose stylesheets go in the editor's shadow root, which also adopts `preview/content.css`.
  No HTML from the note reaches the editor another way.
- **A block and the caret:** a block shows only its rendering until a caret is in its source, its first and last character included, or a selection meets it; then its source shows with the rendering under it, drawn again as the source changes.
  A caret off its lines closes it.
  Down from the line over a closed block puts the caret at the start of its source, Up from the line under it at the end, and Left and Right come into it as into any line; leaving its source by the arrows closes it.
  A click on an image puts the caret at the end of that image's alt text and a double click opens the viewer (as under an Edit mode image line and in the preview), also when showing the source moved the image down between the clicks; a click elsewhere on a block puts the caret in its source; its menu is the image menu; a frame's Load button loads it.
  Backspace at the start of the text line under a closed block selects it, and Backspace again deletes it with one line break; Delete does the same from the end of the line over it, and Return with it selected makes a line under it.
  A selection over all of it rings it; copying copies its Markdown; with an image selected whole, the size bar shows for it.
  Edit mode's previews under image lines are off in Write mode.
- **A table:** a GFM table always shows as a grid, as the preview draws it, and the caret edits its cells in place; its pipes, padding and delimiter row never show (`tableGrid.ts`, `tables.ts`).
  The source stays in the editor: each row is its own line laid out as a CSS grid, every character of a row is inside one cell's box (an outer mark from its pipe to the next), and the hidden characters are replaced inside it, so typing, input methods, undo, Find and the formatting toolbar are the editor's own.
  Column widths come from the widest shown text of each column, in a constructed stylesheet with one rule per set of widths (the content security policy refuses style attributes).
  The caret steps over everything between one cell's text and the next as one unit, so the arrows go from cell to cell, Up and Down keep the column, and a click past a cell's text or Home and End land at the text's edge.
  A user's edit (typing, pasting, dropping, deleting) keeps the table's pipes and line breaks (`EditorState.changeFilter`), a typed or pasted pipe is written `\|` and a line break a space, and the table is printed again as Tab prints it in the same transaction, so undo takes the edit and the printing back as one step; spaces typed at the end of a cell's text stay until the next character.
  Nothing is printed inside a composition: the first edit after it prints the table.
  Tab, Shift+Tab and Return, and the table bar's alignment, row and column commands, are the table commands (`tableCommands.ts`); Return in the first cell goes to the next row too, and the hand-typed row rule (`tableTyping.ts`) is off, since a pipe typed in a cell is its text.
  A selection over the whole table deletes it.
  Several cursors in a table show its source until one is left.
  A table in a list or a quote is a grid too, its row prefixes hidden and kept.
  A cell with nothing between its pipes is an empty cell; a short row draws the cells it leaves out, and a click on one writes the row out to the table's columns; cells past the delimiter row's are hidden, as GFM leaves them out, and a table with them is not printed again.
  A pipe an input method composed is escaped by the first edit after the composition, which reads the cells from where they were when it began (`composedTables`).
- **Sizes before rendering:** a box keeps the height its block had last (kept per source, in memory) or, for an image, the height its known size gives at its size preset (an image's size is loaded as soon as its block is found, before the box is drawn), until what it shows is in place; while a changed source draws again it keeps its height.
  Synced scrolling shares a block's height out over its lines, so a line inside a closed block still maps (`editor/scrollPane.ts`).
- **How:** the rules are a pure function of the syntax tree and the selection (`rules.ts`), drawn by a view plugin over the visible ranges only; hidden marks, widgets and list marks are atomic, so the caret steps over them.
  Inline marks skip a rendered block's source, so an open formula shows `\{`, `_` and `*` as written.
  Whole-line decorations come from a state field fed by the `writeBlockRule` facet (`blocks.ts`): front matter, the rendered blocks and tables.
  A rule gives a list of decorations, which the caret steps over, or layers: decorations, outer marks and the ranges the caret steps over.
  The rendered blocks are found by reading the text line by line and asking the syntax tree only where a line may start one, once per change.
  Inside an input method's composition nothing is built again: the decorations are mapped through the change and built on the first update after it, and Write mode never dispatches a transaction of its own, which would drop the text being composed.
  Write mode is a compartment of the same editor, so switching to and from Edit keeps the text, caret, history and focus, and the line at the top stays there (`scrollSnapshot`).
- **Default:** a new install opens in Write mode; an install that kept a window's state before Write mode existed keeps Edit (`defaultMode` in `lastState.ts`, decided once and stored as `devot.defaultMode`, so every window agrees).
  A window's stored mode always wins; a Write switch kept beside Edit by a test build reads as Write.
  Toggle Editor and Preview (Cmd+E) and leaving Preview or Split go back to whichever of Write and Edit was used last.
  UI tests run as an install from before Write mode unless they ask for a new one (`install` in `tests/ui/fixtures.ts`).

## Split mode

- **Synced scrolling:** in split mode, scrolling either pane brings the other to the same source line (`src/renderer/src/preview/scrollSync.ts`).
  The core marks every block of the preview with the line it starts on (`data-source-line`: paragraphs, headings, list items, table rows, code blocks, alerts, diagrams, math and embeds), in a last step after the renderers, which keep a replaced block's source position, and after sanitizing, so a note cannot set the attribute (the sanitizer drops the note's own `data-*` attributes).
  Both panes speak in fractional source lines: the editor reads CodeMirror's height map, the preview interpolates between its blocks, whose offsets it measures once per rendering, resize or loaded image, never on a scroll.
  The pane being scrolled leads, once per animation frame; the scroll it causes in the other pane is recognised by its offset and never sent back, and for half a second after a wheel or touch gesture in one pane, scrolling still running in the other does not pull it.
  A pane that cannot scroll (a short note in the editor) leads nothing.
  The tops line up with each other; over the leader's last screen the follower blends from the matching line to its own end, so both reach the bottom together without a jump.
  When a pane is laid out anew (the preview after each rendering, a loaded image or a diagram drawn later, a resize), it lines up with the other pane unless the user was last scrolling, clicking or typing in it, so typing in the editor keeps the preview with it while a place read in the preview stays put.
  Synced scrolling starts with the editor leading, or with the preview when the window comes from Preview mode, so the place being read is kept.
  It is on by default, an editor setting (`syncScroll`), turned off and on from View > Synced Scrolling (a check item: Rust stores the change itself and keeps the check mark in line with the setting however it changes), from the command palette (Turn Off/On Synced Scrolling) and from Settings > Preview.
- **Copy buttons:** each fenced code block in the preview (not front matter, inline code or diagrams) has a copy button in its top right corner, shown on hover and on keyboard focus (Option+Tab, as for every button in WebKit, or Tab with Full Keyboard Access).
  It copies the block's text as written in the note, without its final line break, through `clipboard_write_text` like every other copy (the command takes as much text as a note may hold, so any block fits), then reads Copied (or Could Not Copy) for a moment.
  The button is the page's own control, never part of the note's HTML: the core renders none, the preview adds it as a React portal marked `data-devot-ui`, which the patcher never reuses, replaces or removes, it has no text of its own (so find and selections do not see it), and printing hides it, so exports and printed or copied HTML never contain it.
