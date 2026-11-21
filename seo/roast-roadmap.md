# SEO roast roadmap: the Devot app repository (2026-11-21)

Verdict: the public site already allows crawlers, and GitHub's description and website field already match the product. This repository had no machine-readable summary, and its package description still said macOS only.

Checked, and left as they are, because they are doing the right job:

- `https://devot.online/robots.txt` allows all user agents and names `https://devot.online/sitemap-index.xml`. That site is the other repository.
- Licence pages send `noindex` (`licence/src/pages.ts`). `/buy` redirects to Stripe and does not render a price. ADR 0006 puts prices on the website and in Stripe.
- Share pages send `noindex, nofollow` (`share/src/viewer.ts`, `share/src/app.ts`). A shared note is a private page.

| #   | Tier        | Issue                                                                                                      | What it blocks                                                       | Fix                                    | Owner | Status                 |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- | ----- | ---------------------- |
| 1   | Revenue     | `package.json` described a macOS-only app and pointed home at GitHub                                       | Agents and package metadata quoted a smaller product than the README | One-liner and `https://devot.online`   | agent | shipped                |
| 2   | Revenue     | README lede did not repeat the phrase GitHub already uses, and said iPhone where the app also runs on iPad | The indexed README and the About line could drift                    | Lede, iPad line, site badge            | agent | shipped                |
| 3   | Revenue     | No `llms.txt` in the source                                                                                | An agent reading the repo had to infer the product                   | `llms.txt`, facts only                 | agent | shipped                |
| 4   | Revenue     | No App Store copy in the repo, and no fastlane metadata                                                    | The iOS listing can drift from the README                            | `seo/store/app-store.en.json` to paste | owner | drafted                |
| 5   | Compounding | Directory fields were nowhere                                                                              | Every form asks for a different length of the same facts             | `seo/submission-manifest.json`         | owner | drafted, not submitted |
| 6   | Compounding | README screenshots did not all name Devot                                                                  | Image search cannot tie the picture to the product                   | Alt text                               | agent | shipped                |
| 7   | Compounding | No single fact file                                                                                        | Later edits invent a price or a platform                             | `seo/kb/brand-ssot.md`                 | agent | shipped                |

## Owner, in order

1. Paste `seo/store/app-store.en.json` into App Store Connect, then confirm the two prices in ADR 0014.
2. Add the App Store URL to the README once the listing has one.
3. Confirm the GitHub Social preview, and add the topic `sqlite` only if a twentieth topic is wanted.
4. Submit directories from the manifest after choosing a role email. Skip any form that requires payment.
5. Keep `https://devot.online/llms.txt` in step with `llms.txt` here. That file is the site repository's.

## Not done, and why

- Ahrefs, DataForSEO, Google Search Console and AI SEO Tracker need accounts this pass does not have.
- Awesome Tools, LinkDR and other paid listings were not submitted. No spend was approved.
- Comparison pages belong on the site. This repository does not add them.
- `docs/mcp-plugin/` stays unpublished. Its own README lists the open questions.
- Official MCP registry files were not added. Devot's MCP bridge is local stdio, not a hosted server.
- `src-tauri/Cargo.toml` description was left on the old sentence so this branch does not run the Rust pre-push job. The crate is unpublished. The one-liner to copy is in `package.json`.

## Fluff, left alone

- Heading order in the README.
- Meta description length on the app's own HTML. Those files are the desktop and iPhone shells, not public pages.
