# Open questions

Only the owner can close these.
Nothing below was guessed into the public copy.

- TODO: confirm the website licence is still US$29.90 and App Store Devot Pro is still US$29.99. ADR 0014 records both. Stripe holds the live Mac price, and this repository does not.
- TODO: choose a role contact address for directories. None is named in the source. Do not use a personal inbox.
- TODO: add the public App Store URL once the listing has one. The source has the bundle id `io.github.jma49.devot` and no `apps.apple.com` link.
- TODO: confirm the GitHub Social preview image. The settings API used on 2026-11-21 did not show one.
- TODO: export a 512px square logo, a 1200 by 640 or 1200 by 630 social image, and three 1280 by 800 screenshots before a directory submission. `src-tauri/icons/` has 32, 64, 128 and 256 pixel icons. `docs/images/` has the README screenshots.
- TODO: decide whether to publish `docs/mcp-plugin/`. Its README says it is not published, and the privacy-policy URL and contact address are still open.
- TODO: Simplified Chinese App Store text. It has to be entered in App Store Connect. CJK characters in this repository stay in the translation catalogs.
- TODO: confirm https://devot.online/support, https://devot.online/privacy and https://devot.online/terms stay canonical. They answered on 2026-11-21 and are not named in the app source.
- TODO: if a directory form requires rival products, the owner fills them. `competitors_replaced` is empty on purpose.
- TODO: keep `https://devot.online/llms.txt` (site repository) from drifting away from `llms.txt` here when a price or a platform changes.
