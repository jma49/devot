# Command line

Part of the [architecture overview](../architecture.md).
Part of the [Markdown dialect](markdown-dialect.md).

Settings > General > Command Line Tool installs the `devot` command: a symbolic link, `/usr/local/bin/devot`, to a shell script in the bundle (`src-tauri/cli/devot`, in the resources as `bin/devot`), which runs the app's binary with `--cli` and its arguments; `main` hands them to `src-tauri/src/cli.rs` before anything of the app starts.
The row says whether the link is there (`cli_tool_status`, `cli_tool_install`, `cli_tool_uninstall`, granted to the Settings window alone and taking no arguments).
The link is made beside its place and renamed over it; where `/usr/local/bin` cannot be written (or is not there), the system's authorization prompt does it (`osascript … with administrator privileges`, the paths passed as arguments, never in the script's text).
Install refuses (`E_CLI_APP_NOT_IN_APPLICATIONS`, and the row asks to move Devot to Applications) while the app runs from a read-only volume, as a disk image is (`statvfs` reports it so), or a translocated copy (`…/AppTranslocation/…`), where the link would break once the image is ejected or the app moved; an app on a second disk, writable, installs the link.
Install replaces only a missing file or a link, never a file; Uninstall removes only a link to this app's script; a cancelled prompt changes nothing (`src-tauri/src/cli_tool.rs`).

- **`devot`** brings Devot forward, or launches it.
- **`devot a.md b.md [--notebook NAME]`** checks that each file is a Markdown file there (paths taken from the folder the command ran in) and hands them over by absolute path: to a running Devot through the single-instance socket, in the format a second launch writes (only when the socket may be trusted, see One Devot), else by launching Devot (`open -a`, with no arguments) and sending them through the socket once it listens there, asking every 50 ms for up to 30 s (`E_CLI_LAUNCH_UNANSWERED` after that); then it returns.
  Devot ignores `open -a`'s arguments while it runs, even while another `devot` call is still launching it, so files never ride on a launch.
  A Devot started with them in its own arguments (the binary run by hand) still takes them, and Restart to Update restarts with none (`restart_env` in `src-tauri/src/exit.rs`), or every update would import them again.
  A running Devot that cannot be reached there (it holds the data folder, but nothing answers at the socket) fails the command instead: it prints `E_CLI_HANDOFF_UNREACHABLE` and exits with status 1.
  So does a hand-off the running Devot does not take within 5 s (`E_CLI_HANDOFF_UNANSWERED`) or closes unanswered, as it does while it quits (`E_CLI_HANDOFF_REFUSED`).
  It checks the data folder with a shared `flock` for an instant; a launch that meets it there tries once more 50 ms later.
  Devot scans them as Markdown Files… picks them and the main window gets a link of its own (`{kind: 'import', scan, notebook, first}`, which no URL makes; it waits like any link), imports them without a sheet into the notebook of that name (exactly, else in any case; made when there is none) or the default notebook, and opens the note the first file became (`src/renderer/src/cliOpen.ts`).
  A failure shows a notice.
- **`devot append <note-id>|--title TITLE|--today [--heading H] [--prepend] [--stdin | TEXT]`** adds text to a note in the running Devot, at the end (or with `--prepend` the start) of the section under heading `H`, or of the whole note (issue #477; `src-tauri/src/cli_append.rs`).
  The note is named by ID or by title (an exact title first, else one differing only in case; several alike fail with `E_NOTE_TITLE_AMBIGUOUS`; templates never count), or with `--today` as today's note, made first when missing (see Note templates).
  The text is one argument or standard input, at most 512 KB, UTF-8 and without NUL.
  The command hands it over the single-instance socket as `devot a.md` does, launching Devot first when none runs; unlike files, the hand-off is answered after it ran: the listener runs it on a thread of its own (`Accept::Answered`), sends the request to the frontmost main window that takes requests as an event (`devot://cli-append`, `{ id, target, heading, position, text }`; a window takes them once it has asked, `cli_append_take`, and again after a reload, so a request sent while Devot is still starting waits for it, as a link does) and waits up to 30 s for `cli_append_done` (main windows only; the answer is a code or nothing, else `E_CLI_APPEND_FAILED`), then answers the command with the outcome: the taken byte when done, else a refusal byte and the code.
  The window answers only once the note is saved (`flush`), so the command's success means the text is on disk; `E_NOTE_SAVE_FAILED` otherwise.
  The window's core puts the text in as one Yjs transaction (`NoteService.appendToNote`, `src/core/append.ts`: the section ends before the next heading of the same or a higher level, a heading inside a fenced code block is none, the heading matches by its text in any case, with or without its marks, the first found), keeps the text before as a version as a plugin edit does, and the open editor takes the update as one undo step.
  Devot is not brought forward.
  A missing heading fails the command with `E_HEADING_NOT_FOUND` and changes nothing; so do `E_NOTE_NOT_FOUND` and `E_LICENCE_REQUIRED` (read-only after the trial).
  The window runs requests one at a time; the window claims each request (`cli_append_claim`) before its core writes anything, so one Rust gave up on before the claim never runs (`E_CLI_APPEND_TIMEOUT`, safe to run again), while one claimed and not answered within the 30 s may still land (`E_CLI_APPEND_LATE`): read the note before running the command again.
  An empty, oversized (512 KB) or non-UTF-8 text fails before anything is sent (`E_APPEND_TEXT_EMPTY`, `E_APPEND_TEXT_TOO_LARGE`, `E_APPEND_TEXT_INVALID`).
  Logs carry the request's ID and codes, never the text.
  The same operation is `POST /v1/notes/<id>/append` in the local HTTP API and the `append_to_note` MCP tool (see AI), each with `separator: none` to join the text to the line it lands on, and each through the AI service, so they write only where AI access is on; the command writes anywhere, as the owner's own tool.
- **`devot mcp`** serves AI tools over stdio (see AI).
  Clients run the binary directly, with `--cli mcp`.
- **`devot export <file.md|-> -o out.pdf|out.html [--simple]`** runs in its own process with nothing of the app's: no data folder, database, socket or Dock icon, so it runs beside an open Devot (`src-tauri/src/cli_export.rs`).
  The page is made by the exporter's own code, which needs a web view, so the process has one window that is never shown (`export.html`, private web data, its own capability granting `cli_export_source`, `cli_export_finish` and `cli_export_fail` and nothing else); Rust writes the HTML, or prints the PDF as Export as PDF… does (in a private folder in the app's caches, then copied into place).
  `-` reads standard input; at most 10 MB of UTF-8.
  `--simple` gives the bare markup (HTML only).
  Attachment images are not resolved (nothing reads the database), and an image given by a relative path stays a link beside the page, which the page's own CSP would not let load.
  It gives up after two minutes, and stops on SIGINT or SIGTERM; either way it removes its private PDF folder and the temporary file it was writing beside the output first.
  The output goes into place under the same lock such an exit takes, so it is either whole and the export exits 0 (a signal that comes after it is ignored), or never put there.
  Each PDF job, and every launch of the app, removes such folders more than ten minutes old left in `pdf/` (in the app's data and caches) by a job that never finished.
- Errors go to standard error as `devot: <message>`, with the code where there is one; the exit status is 0 when done, 1 when it failed and 2 when the command was not understood (`devot --help`).
