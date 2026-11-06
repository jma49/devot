# Note templates

Part of the [architecture overview](../architecture.md).
Part of the [Markdown dialect](markdown-dialect.md).

- **What a template is:** an ordinary note (synced, edited, trashed and restored like any other) filed in a reserved notebook, Templates.
  The sidebar lists them under Templates, above the Trash; New Note (or Cmd+N) there makes a new template, and the editor shows a line about front matter and variables in place of the notebook, status and tag pickers (a template's own status and tags are not used, so the status keys and the palette's Add Tag to Note are not offered for one).
- **The reserved notebook:** every device knows it by one fixed ID, `TEMPLATES_BOOK_ID` (`src/core/books.ts`): `00000000-0000-7000-8000-000000000001`, UUIDv7-shaped (version 7, variant 10, a zero timestamp no generated ID has), so Rust's ID checks accept it (a Rust test and a policy test keep the two sides in step) and no schema change was needed.
  Its row (named `Templates`) is written on first use (`TemplateService.create`); the copies two devices write merge field by field into one row, with the earlier creation time (a notebook, tag or saved search merges `createdAt` as the minimum, and storage keeps the minimum too, so a device holding the later one takes the earlier and every copy ends the same).
  The notebook service never lists, renames, moves, deletes or shares it, and `settleOrder` leaves it alone.
  A Devot from before templates shows it as a plain notebook; if it deletes it there, templates keep working (the note service accepts the ID even without a live row).
- **Out of the library:** the note service's `list` and `search` leave templates out (`excludeTemplates` in `src/core/search.ts` adds one condition, or joins a notebook exclusion, so the longest query stays within the 12 conditions Rust accepts), and `book:Templates` names nothing.
  AI tools never count Templates as allowed, even with Allow AI Access set on its row by an older Devot, so AI tools list, find and read no template.
  Backlinks (Note Info's linked-from list) leave templates out the same way (`findBacklinks`), so a template linking to a note never shows there.
  Counts, filters, the palette's notes and the `[[` popup follow from the note list.
  The Trash and the activity heatmap treat templates like any note.
- **A note from a template** (`src/core/templates.ts`): Cmd+T anywhere in the window (the registry's `note.newFromTemplate`, also New Note from Template… in the command palette) opens a picker: a filter, the templates used last on this device first (local storage, at most five, never synced), then the rest by title, and a preview of the note the selected one would make now: its title, notebook, tags and status, and its Markdown as plain text.
  Return, a double click or Create makes the note and opens it with the keyboard in its editor; when the view would not list it, its notebook (or All Notes) shows.
- **Front matter sets the defaults**, read by the import reader (`readFrontMatter`): `title` (else the template's own title), `notebook` (a name in any case, the first in sidebar order, or a path such as `Work/Meetings`; else, or when it names nothing, the notebook the window shows, as with New Note), `tags` (made when missing) and `status`.
  These four keys are then removed from the new note's front matter (all of it when nothing else is left), so the body holds only what is meant for the note; every other key stays.
- **Variables:** `{{date}}` (YYYY-MM-DD), `{{time}}` (HH:mm) and `{{datetime}}` (YYYY-MM-DD HH:mm) take a format after a colon (`{{date:dddd, D MMMM}}`; tokens YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm m ss s A a Z, text in brackets kept as written), `{{title}}` is the new note's title, and `{{uuid}}` is a random UUID v4 (one per note made, the same wherever it appears in that note).
  Names match in any case; anything else between double braces stays as written, and a title that holds a variable is not expanded again.
  Variables are filled in everywhere in the body, code included (a template can put today's date in a code block).
  Line breaks become `\n` first, as import does.
  The time is the page's clock at the moment the note is made, on the wall clock of the system's time zone; unit tests inject the zone (Los Angeles across both 2026 transitions, Shanghai, Kathmandu).
- **Instruction quotes:** a blockquote whose first line is a heading starting with `!` (`> # !Instructions`) is removed, with the blank line after it, from notes made from the template; it stays in the template.
  Quotes in code blocks and ordinary quotes are kept.
- **Starter templates:** Brainstorming, Debugging, Learning, Planning and Daily Report (`src/renderer/src/starterTemplates.ts`, text from the message catalog; core keeps only the `starter:` ID prefix and takes the list through `starters`) are not stored.
  They are read-only, listed under "Built-in" after the user's own templates (the picker and the Templates view), and editing one saves a copy as the user's own template (`TemplateService.save`).
  Applying a template to an existing note (`applyTo`) keeps the note's tags and status.
- **Today's note** (issue #478, `src/core/dailyNotes.ts`): Open Today's Note (the registry's `note.today`, Option-Command-T by default; in the palette, File > Open Today's Note and `devot://today`) saves pending edits, then finds the live note titled for the day (in this device's time zone; `2026-11-02`, `02 Nov 2026` or `Monday 2 November 2026`, English names whatever the locale, so the title stays the same) in the daily notebook, or anywhere when none is set or it is gone.
  When there is none it makes it: from the daily template with its variables filled (as A note from a template, but titled for the day and filed in the daily notebook, whatever the template's front matter names), or empty without one, then saves it, so running it twice in a day opens the same note.
  The note opens as a note link's does, and a workspace the daily notebook is outside is left.
  Read-only after the trial it still finds the day's note, and fails with `E_LICENCE_REQUIRED` when it would make one.
  The settings are editor settings (Settings > General > Daily Notes: `dailyNotebook`, `dailyTemplate`, any of the user's templates, which the main window publishes for Settings by ID and title beside the notebooks, `notebookChoices.ts`, and `dailyTitleFormat`: `iso`, `dayMonthYear` or `weekdayDayMonthYear`), so they are this device's and read leniently, each on its own.
  `devot append --today` appends to the same note, making it first when it is missing.
- **Writing it:** the note is made with `NoteService.create`, then it gets its own copies of the template's images (see Note links), then its body (showing the copies) is applied as Yjs operations (`setBody`), then its status and tags; a failure part-way purges the note.
  The template itself never changes.
