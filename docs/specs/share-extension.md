# Share Extension

Part of the [architecture overview](../architecture.md).

The iPhone's Share Extension puts text, a link and images from any app (Safari, Photos, Messages) into Devot as a new note.
It is a small app of its own that iOS starts in the sharing app's process space, with its own memory limit, so it does as little as it can: it shows a compose sheet, writes what was shared into an inbox, and goes.
The app makes the notes, the next time it is in front.

## What the extension may touch

- The extension never opens the database, the key store or any key, and links neither Rust nor the page.
  It holds no secret, so a share made while the app is locked, unpaid or not yet set up is safe to keep.
- Its one shared place with the app is the App Group `group.io.github.jma49.devot`, in which it writes only the folder `ShareInbox/`.
- The inbox is not synced and not backed up (`isExcludedFromBackup`), and every file in it has complete protection (`NSFileProtectionComplete`): it is unreadable while the iPhone is locked.

## The sheet

`ShareComposeController` (`src-tauri/apple/DevotShare/Sources/DevotShare/`) is a title field and a text view under a navigation bar with Cancel and Post, in system controls and the system's grouped colours.
The extension's principal class in `src-tauri/gen/apple/devot_Share/` only names it.

- It takes what the sharing app offers: the first web link (http or https), plain text, and up to four images, as `NSExtensionActivationRule` allows (text, one web URL, four images).
  Safari's page title, when it comes beside the link, fills the title; a file link is left out.
- Images are read with ImageIO, scaled so their longer side is at most 2048 pixels and saved as JPEG without their metadata, so a photo's location stays on the phone.
  If the set is over the 2 MiB image budget, each smaller step (1536, then 1024 pixels) is tried, and what still does not fit is left out; the sheet says how many images it holds, and when some were left out.
- Its strings are the `share` area of the English catalog (`src/renderer/src/i18n/en/share.ts`), which `pnpm i18n:apple` writes into the package as `ShareL10n` and its string catalog; the extension carries no other area.
- An error is an alert with the catalog's words, and the extension logs only its code (`W_SHARE_POST_FAILED code=…`, `os.Logger`).

## The inbox file

`DevotShareInbox` (`ShareItem`, `ShareInbox`, `ShareImages`) is the format both sides read.

- One share is one file, `<id>.json`, where `id` is a UUIDv7, so the files sort oldest first.
- The file is JSON: `v` (1), `id`, `title`, `text`, an optional `url` and `images`, each `{ name, data }` with the JPEG's bytes in base64.
  These are the `share.capture` operation's arguments with a version, and the file has the bridge's limits: title 1000 characters, text 100 000, link 2048 and http or https with no space or control character, four images, each a JPEG with a plain name of at most 200 characters, and the whole file at most 3 MiB, so the message that carries it stays under the bridge's 4 MiB.
  An empty share (no title, text, link or image) is refused.
- A file is written whole: to a hidden temporary file created new (`.<id>.tmp`, never over an existing one) with complete protection, then renamed into place, so the app never reads half of one.
  A temporary file older than an hour was left by an extension that stopped mid-write, and the app removes it.
- At most 50 shares wait at once; past that the sheet refuses (`E_SHARE_INBOX_FULL`) until the app has drained them.
- Codes: `E_SHARE_EMPTY`, `E_SHARE_TOO_LARGE`, `E_SHARE_TITLE_TOO_LONG`, `E_SHARE_TEXT_TOO_LONG`, `E_SHARE_URL_INVALID`, `E_SHARE_IMAGES_TOO_MANY`, `E_SHARE_IMAGE_INVALID`, `E_SHARE_ID_INVALID`, `E_SHARE_VERSION`, `E_SHARE_FILE_UNREADABLE`, `E_SHARE_INBOX_FULL`, `E_SHARE_INBOX_UNAVAILABLE`, `E_SHARE_WRITE_FAILED`.

## The drain

`ShareDrain` in the native screens (`src-tauri/apple/DevotScreens/Sources/DevotScreens/Share/`) turns the inbox into notes.

- It runs once the screens have installed, each time the app becomes active, and when the licence changes.
  A drain asked for while one runs runs once more after it.
- It skips the whole inbox while the gate (iPhone screens, The gate) says editing is locked, logging `I_SHARE_DRAIN_LOCKED count=…`, so a share is never lost to an expired trial: it waits for the licence.
- It sends one share at a time as `share.capture` (iPhone screens, Operations); Rust checks the arguments and holds the request until the page listens.
- On success it removes the file. On any failure it keeps the file, logs `W_SHARE_DRAIN_FAILED code=…` and goes on with the next share; on `E_LICENCE_REQUIRED` it stops, keeping the rest. An unreadable file is kept and skipped the same way.
- An image the page could not store comes back in `refused` and is logged as `W_SHARE_IMAGE_REFUSED code=…`; the note is made without it.

## Making the note

The page's `share.capture` handler (`src/renderer/src/phone/screens/share.ts`) makes the note with the core's `captureShare` (`src/core/capture.ts`), the path quick capture takes.

- The note goes in the default notebook (Editor settings), as a new note does.
- The title is the share's title; the body is the text, then the link unless the text holds it, then one Markdown image per stored image.
  Each image is stored as an attachment with the core's checks (`checkUpload`) after the note exists; one refused leaves the note and the others.
- The page refuses `E_LICENCE_REQUIRED` while editing is locked, as Rust's write gate does behind it.
- A reply lost on its way would leave the file, and the next drain would send the share again, so the page remembers the last 100 share IDs with the note each made (`devot.share.made` in the page's storage) and answers a repeat with that note, making none.

## Release

The extension is the target `devot_Share` in `src-tauri/gen/apple/project.yml`, bundle ID `io.github.jma49.devot.share`, embedded in the app.
Its entitlements are the App Group alone (`devot_Share/devot_Share.entitlements`); the app has the App Group in every build (`devot_iOS.entitlements` with iCloud, `devot_iOS-local.entitlements` without).
The App Store workflow signs it with its own App Store profile, gives it the app's version and build number, and checks its entitlements after export (docs/releasing.md, The Share Extension).
