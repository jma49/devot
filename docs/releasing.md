# Releasing Devot

Until 1.0 every build ships as a GitHub prerelease on the beta channel. A release is made by pushing a tag: the release workflow (`.github/workflows/release.yml`) builds, signs and publishes it, and points the update feed at it. There is no manual confirm step.

## Versions and tags

- Tags look like `vMAJOR.MINOR.PATCH-betaN`, for example `v0.9.1-beta1`. Stable tags (from 1.0) are `vMAJOR.MINOR.PATCH`.
- The tag decides the version. The workflow writes it (without the leading `v`) into `package.json` and `src-tauri/Cargo.toml` before building (`scripts/release/release.ts set-version`); `tauri.conf.json` takes its version from Cargo. The committed versions stay `0.0.0`.
- Each release gets a new tag and a new prerelease. Never replace an existing release or move an existing tag.
- Every release raises PATCH and starts at `beta1` (`v0.9.1-beta1`, then `v0.9.2-beta1`, ...).
- N goes up only for a rebuild of the same version (`v0.9.1-beta2`). It stays a single digit, 1 to 9: as a semver prerelease identifier `beta10` would sort before `beta2`, so `set-version` refuses it.
- Releases before `v0.9.1-beta1` used `vMAJOR.MINOR.PATCH-beta.N` (the last was `v0.9.0-beta.1`). The feed comparison still reads that form, so a feed that offers one is replaced by a newer release.
- Stable releases start at 1.0. Until then the update feed has no `stable.json` (the first stable release writes it) and only `beta.json` is published. A stable release goes in both feeds (see Update feed).
- Apple Silicon only.

## When to release

Release only when both are true:

1. CI is green on the head commit of the pull request that was merged. CI runs on pull requests only, not on `main`.
2. The tree of `main` equals the tree of that head commit (`git diff --quiet <head commit> origin/main`), so the build is of exactly what CI checked.

## Release

Write the notes in English, one line per issue the release closes (`- #148 Drag notes and notebooks out of the app as links`), then tag the merge commit with them and push the tag:

```sh
git fetch origin
git tag -a <tag> <merge commit> -F notes.md
git push origin <tag>
```

The tag's message becomes the release notes and the update's notes in the app. A tag without a message gets GitHub's generated notes.

The workflow refuses a tag whose commit is not on `main`. Then it runs four jobs:

1. **build** (macOS 26, Apple Silicon): sets the version from the tag (a tag of any other form fails the run) and builds `app` and `dmg` bundles, ad-hoc signed (`signingIdentity: "-"`; without it the bundle has no seal and downloaded copies are reported as damaged), with the updater's public key built in and `requireSignedVersion` on, so an install takes an update only when its signature records the version the feed announces. It verifies them (`codesign --verify --deep --strict`, `hdiutil verify`). This job runs the dependencies' code, so it gets a read-only token and no updater key: Tauri signs the updater bundle (`Devot.app.tar.gz`) with a throwaway key, which is discarded.
2. **sign**: signs the updater bundle with the updater key, recording the version (`scripts/release/release.ts sign`), and checks the signature against `TAURI_UPDATER_PUBKEY`: a private key that does not match the public key fails the run instead of shipping updates no install would accept. It runs only Node and `release.ts`, never `pnpm install`.
3. **publish**: creates the release for the tag (a prerelease for a beta) with the dmg, the updater bundle and its signature.
4. **feed**: writes the feeds the release goes in and uploads them to the fixed `updater` release, which it creates on first use: `beta.json` for a beta; `stable.json` and `beta.json` for a stable release (`scripts/release/release.ts feeds`). Each feed is replaced only by a release newer than the one it offers, and a stable release never takes `beta.json` back from a newer beta. A feed that cannot be read (other than one not there yet) fails the run rather than being replaced, and each feed is read back after uploading. Feed jobs run one at a time across runs (a concurrency group), so tags pushed close together leave the newest release in each feed. GitHub keeps only one job waiting in the group: when a third run arrives, the waiting feed job is cancelled; re-run it.

Only the publish and feed jobs can write to the repository. Every action is pinned to a commit (`tests/policy/release-workflow.test.ts`). A failed run can be run again: a release already made gets its files uploaded again instead.

Watch the run in the Actions tab; when it fails, fix the cause and release under a new tag.

## After a release

Once the new beta's release is published and `beta.json` offers it, delete the previous beta releases together with their tags:

```sh
gh release delete <tag> --yes --cleanup-tag
```

Only the newest beta release is kept. Never delete the `updater` release (see Update feed).

## Update feed

The app reads `https://github.com/jma49/devot/releases/download/updater/beta.json` (a prerelease build) or `.../stable.json` (a stable build): a release named `updater` that holds one file per channel. It is a prerelease so that it never shows as the latest release. Do not delete it: installed copies would stop finding updates.

A beta install reads `beta.json`, so a stable release also goes there when it is newer than the beta it offers: the beta channel always offers the newest build of either kind (`1.0.0-beta5` is offered `1.0.0`, but `1.0.2-beta1` stays when `1.0.1` ships). A stable install reads only `stable.json` and never gets a beta.

Release builds check 30 seconds after launch and then daily, and on Devot > Check for Updates…. With Settings > General > Automatically Download Updates on (the default), an update downloads in the background; then Devot offers Restart to Update, which installs it and restarts once the notes are saved. A plain quit installs nothing; the next launch finds the update again.

## Signing key

The updater accepts only bundles signed by the updater key. Its private key and password are the secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` of the `release` environment, whose deployments are limited to `v*` tags; only the sign job uses that environment; the public key is the repository variable `TAURI_UPDATER_PUBKEY`, passed to the build with `--config`. No key is committed, so local builds have no updater (a manual check says updates are unavailable).

The key pair is made once with `pnpm tauri signer generate -w <path>/devot-updater.key`, which asks for the password and writes the private key there and the public key to `devot-updater.key.pub`. Keep an offline backup of the private key and its password: losing either means installed copies can never update again, and a new key only reaches users who install a new copy by hand.

Optional secrets turn on crash reporting in release builds, as `.env.local` does locally: `DEVOT_SENTRY_DSN` and `SENTRY_AUTH_TOKEN`, with the variables `SENTRY_ORG` and `SENTRY_PROJECT`.

## Building locally

A local build makes the same bundles without the updater:

```sh
PATH="$(brew --prefix rustup)/bin:$PATH" CI=true pnpm tauri build --bundles app,dmg \
  --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
```

`CI=true` makes the dmg step skip arranging the disk image window through Finder, which otherwise needs Automation access and can hang. Set a version with `node scripts/release/release.ts set-version <tag>` first if the build should carry one (a local change; do not commit it).
