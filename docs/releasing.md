# Releasing Devot

Releases are stable from 1.0.0 on; a beta is an optional preview of the next version, shipped as a GitHub prerelease. A release is made by pushing a tag: the release workflow (`.github/workflows/release.yml`) builds it, signs it with the Developer ID and has Apple notarize it, publishes it, and points the update feed at it. There is no manual confirm step.

## Versions and tags

- Stable tags look like `vMAJOR.MINOR.PATCH`, for example `v1.0.1`; beta tags like `vMAJOR.MINOR.PATCH-betaN`, for example `v1.0.2-beta1`.
- The tag decides the version. The workflow writes it (without the leading `v`) into `package.json` and `src-tauri/Cargo.toml` before building (`scripts/release/release.ts set-version`); `tauri.conf.json` takes its version from Cargo. The committed versions stay `0.0.0`.
- Each release gets a new tag and a new release (a prerelease for a beta). Never replace an existing release or move an existing tag.
- Every stable release raises PATCH (`v1.0.1`, then `v1.0.2`, ...); MINOR or MAJOR goes up only when the owner decides. A beta previews the next version and starts at `beta1` (`v1.0.2-beta1` before `v1.0.2`).
- N goes up only for a rebuild of the same beta (`v1.0.2-beta2`). It stays a single digit, 1 to 9: as a semver prerelease identifier `beta10` would sort before `beta2`, so `set-version` refuses it.
- Releases before `v0.9.1-beta1` used `vMAJOR.MINOR.PATCH-beta.N` (the last was `v0.9.0-beta.1`). The feed comparison still reads that form, so a feed that offers one is replaced by a newer release.
- The first stable release, `v1.0.0`, wrote `stable.json`; before it only `beta.json` was published. A stable release goes in both feeds (see Update feed).
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

The tag's message becomes the release notes and the update's notes in the app. A tag without a message gets GitHub's generated notes. The notes of the first release signed with the Developer ID also carry the line in Signing the app, Keychain items after the switch.

The workflow refuses a tag whose commit is not on `main`. Then it runs five jobs:

1. **build** (macOS 26, Apple Silicon): sets the version from the tag (a tag of any other form fails the run) and builds the `app` bundle, ad-hoc signed (`signingIdentity: "-"`), with the updater's public key built in and `requireSignedVersion` on, so an install takes an update only when its signature records the version the feed announces. It verifies it (`codesign --verify --deep --strict`, and that the app has its layered icon: `Assets.car` and `CFBundleIconName`, see `architecture.md`, Design system) and hands it on as a `ditto` archive, which keeps the bundle's symlinks and extended attributes. This job runs the dependencies' code, so it gets a read-only token and no Apple credential or updater key.
2. **notarize** (macOS 26): signs the app with the Developer ID, has it notarized and staples it, makes the dmg and the updater bundle (`Devot.app.tar.gz`) from the stapled app, and signs, notarizes and staples the dmg (`scripts/release/macos-sign.sh`, see Signing the app). It holds the Apple credentials and runs only Apple's tools and the committed scripts, never `pnpm install`.
3. **sign**: signs the notarize job's updater bundle with the updater key, recording the version (`scripts/release/release.ts sign`), and checks the signature against `TAURI_UPDATER_PUBKEY`: a private key that does not match the public key fails the run instead of shipping updates no install would accept. It runs only Node and `release.ts`, never `pnpm install`.
4. **publish**: creates the release for the tag (a prerelease for a beta) with the dmg, the updater bundle and its signature.
5. **feed**: writes the feeds the release goes in and uploads them to the fixed `updater` release, which it creates on first use: `beta.json` for a beta; `stable.json` and `beta.json` for a stable release (`scripts/release/release.ts feeds`). Each feed is replaced only by a release newer than the one it offers, and a stable release never takes `beta.json` back from a newer beta. A feed that cannot be read (other than one not there yet) fails the run rather than being replaced, and each feed is read back after uploading. Feed jobs run one at a time across runs (a concurrency group), so tags pushed close together leave the newest release in each feed. GitHub keeps only one job waiting in the group: when a third run arrives, the waiting feed job is cancelled; re-run it.

Only the publish and feed jobs can write to the repository. Every action is pinned to a commit (`tests/policy/release-workflow.test.ts`). A failed run can be run again: a release already made gets its files uploaded again instead.

Watch the run in the Actions tab; when it fails, fix the cause and release under a new tag.

## After a release

Once the new release is published and its feeds offer it, delete the releases it replaces together with their tags: the previous stable release, and every beta that is not newer than the newest stable release.

```sh
gh release delete <tag> --yes --cleanup-tag
```

Only the newest stable release is kept, plus a beta newer than it if one is out. Never delete the `updater` release (see Update feed).

## Update feed

The app reads `https://github.com/jma49/devot/releases/download/updater/beta.json` (a prerelease build) or `.../stable.json` (a stable build): a release named `updater` that holds one file per channel. It is a prerelease so that it never shows as the latest release. Do not delete it: installed copies would stop finding updates.

A beta install reads `beta.json`, so a stable release also goes there when it is newer than the beta it offers: the beta channel always offers the newest build of either kind (`1.0.0-beta5` is offered `1.0.0`, but `1.0.2-beta1` stays when `1.0.1` ships). A stable install reads only `stable.json` and never gets a beta.

Release builds check 30 seconds after launch and then daily, and on Devot > Check for Updates…. With Settings > General > Automatically Download Updates on (the default), an update downloads in the background; then Devot offers Restart to Update, which installs it and restarts once the notes are saved. A plain quit installs nothing; the next launch finds the update again.

The same daily schedule fetches the licence Worker's revocation list, also in a build without the updater key (docs/architecture.md, Updates).

## Signing the app

Releases are signed with the owner's Developer ID Application certificate, with the hardened runtime and a secure timestamp, and notarized by Apple, so Gatekeeper opens them without a warning and the hardened runtime keeps injected libraries out of the signed app. `scripts/release/macos-sign.sh` does it all in the notarize job:

1. It imports the certificate into a keychain made for the run (a random password, under `RUNNER_TEMP`) and deletes that keychain when it ends, whatever happens. The keychain goes on the runner's search list for the run (`--search-list`), so codesign also finds an intermediate certificate the `.p12` carries.
2. It signs every piece of code in the bundle inside out (nested Mach-O files and bundles first, then the app) with `--options runtime --timestamp`. The app gets no entitlements: WebKit runs JavaScript, and its JIT, in its own processes; the app loads no library of another team (only Apple's frameworks); it sends Apple events only through `/usr/bin/osascript` (installing the command line tool), and the updater's privileged install runs its script inside the app; the crash reporter, a second copy of the app, reads only the memory the crashed app hands it over Mach IPC. The bundled `devot` command is a shell script among the resources, sealed with them. The ad-hoc builds already ran with the hardened runtime and no entitlements.
3. It checks the app: `codesign --verify --deep --strict`, the hardened runtime, the timestamp and no entitlements (`codesign -d --entitlements`) on every Mach-O, and that the signature's authority is `APPLE_SIGNING_IDENTITY` and its Team ID the one the identity names.
4. It has a `ditto` zip of the app notarized (`scripts/release/macos-notarize.sh`, with the API key written to a file under `RUNNER_TEMP` and removed; see Waiting for Apple below) and staples the ticket to the app, then checks it again with `xcrun stapler validate` and `spctl -a -t exec -vv`, which must answer `source=Notarized Developer ID`.
5. It makes the dmg from the stapled app (`scripts/release/macos-dmg.sh`: the app and a link to `/Applications`, the app's icon as the volume icon, HFS+, compressed; as before, no Finder window layout), signs it, has it notarized and staples it, and checks it with `xcrun stapler validate`, `spctl -a -t open --context context:primary-signature -vv` and `hdiutil verify`.
6. It packs the updater bundle from the stapled app, without AppleDouble (`._`) entries, which the updater would unpack into the bundle and so break its seal, and checks that the unpacked copy still verifies and carries its ticket. The sign job signs that bundle with the updater key.

A missing secret or variable, an identity of another form, a signature by another identity or team, or a notarization that does not end `Accepted` fails the run with an annotation that says which (`E_SIGN_…`). On a refused notarization it prints the submission ID and the notary log. No secret is ever printed.

### Credentials

In the `release` environment, as secrets:

- `APPLE_CERTIFICATE`: the Developer ID Application certificate with its private key, exported from Keychain Access as a `.p12`, in base64 (`base64 -i DeveloperID.p12 | pbcopy`).
- `APPLE_CERTIFICATE_PASSWORD`: the password the `.p12` was exported with.
- `APPLE_API_KEY_P8`: the whole text of the App Store Connect team API key (`AuthKey_<key ID>.p8`, Users and Access > Integrations, role Developer).

In the repository settings, as variables:

- `APPLE_SIGNING_IDENTITY`: `Developer ID Application: <name> (<team ID>)`, exactly as `security find-identity -v -p codesigning` shows it.
- `APPLE_API_KEY_ID`: the key's ID.
- `APPLE_API_ISSUER_ID`: the issuer ID shown above the team keys.

The certificate is valid for five years; renew it before it ends (the release workflow fails once it has), then replace the two certificate secrets. Builds signed with it stay valid after it ends, thanks to the timestamp.

### Running it on a Mac

The script runs locally too. A local check signs with a throwaway self-signed identity and leaves notarization out, which needs no Apple account: `tests/scripts/macos-sign.bench.test.ts` makes such an identity, runs the script on a small ad-hoc app and checks the signature, the dmg and the updater bundle, then a refused notarization (with a stand-in `xcrun`). The script never uses the login keychain nor changes the search list without `--search-list`; its keychain and files live in a temp folder it removes.

```sh
APPLE_CERTIFICATE=$(base64 -i test-identity.p12) APPLE_CERTIFICATE_PASSWORD=<password> \
  APPLE_SIGNING_IDENTITY='Developer ID Application: <name> (<team ID>)' \
  scripts/release/macos-sign.sh --skip-notarization path/to/Devot.app out
```

`pnpm tauri build` stays ad-hoc signed (see Building locally): only the release workflow signs with the Developer ID.

### Keychain items after the switch

macOS ties a keychain item to the signature of the app that made it. An ad-hoc signature names one exact build, so each ad-hoc update was a different app to the keychain; a Developer ID signature names the team and the app's identifier, so every later signed update is the same app and reads its items without asking. The first Developer ID build that opens an install's items (the licence, the trial, sync's vault and device token, the AI keys, the HTTP API token) may make macOS ask once, per item, whether Devot may use it. Choosing Always Allow ends the prompts for good.

A denied or failed read loses nothing, since Devot never writes over or removes on its own an item it could not read:

- the licence shows its keychain error (`E_LICENCE_KEYCHAIN`) and is asked for again at the next tick (a minute), not at every save; with the trial over, notes stay readable but read-only until the licence is read or added again;
- the trial counts as ended and is read again at the next tick; a trial it could not read is never begun again, so a denial never resets it;
- sync, AI and the HTTP API report their keychain errors and never make a new vault key, AI key or token in place of one they could not read.

The notes of the first signed release carry this line:

```md
- Devot is now signed with its Developer ID and notarized by Apple. On the first launch macOS may ask whether Devot may use its items in your keychain; choose Always Allow. Nothing is lost if you deny: Devot asks again later.
```

### The first signed release

Once the credentials are in place, release a beta first (the very first notarization of a new team can take hours, so the notarize job may run for most of its 360 minutes; see Waiting for Apple) and, before the stable release, check on a Mac that has an ad-hoc build installed: the downloaded dmg opens without Gatekeeper's warning (`spctl -a -vv /Applications/Devot.app` says `Notarized Developer ID`); the update from the ad-hoc build installs; the keychain prompts appear once and Always Allow keeps the licence, the trial and sync working; a native crash is still reported (`devot --crash-reporter`). Then update the install steps in `README.md` and the Release signing section of `SECURITY.md`, which still describe the ad-hoc build and its first launch.

## Updater key

The updater accepts only bundles signed by the updater key. Its private key and password are the secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` of the `release` environment, whose deployments are limited to `v*` tags; only the sign job reads them; the public key is the repository variable `TAURI_UPDATER_PUBKEY`, passed to the build with `--config`. No key is committed, so local builds have no updater (a manual check says updates are unavailable).

The key pair is made once with `pnpm tauri signer generate -w <path>/devot-updater.key`, which asks for the password and writes the private key there and the public key to `devot-updater.key.pub`. Keep an offline backup of the private key and its password: losing either means installed copies can never update again, and a new key only reaches users who install a new copy by hand.

Optional secrets turn on crash reporting in release builds, as `.env.local` does locally: `DEVOT_SENTRY_DSN` and `SENTRY_AUTH_TOKEN`, with the variables `SENTRY_ORG` and `SENTRY_PROJECT`.

## Building locally

With Xcode 26 or later, a local build makes the same bundles without the updater, ad-hoc signed and not notarized (with the command line tools alone it leaves out the layered app icon); the last three lines are the release workflow's check that the icon is in:

```sh
PATH="$(brew --prefix rustup)/bin:$PATH" CI=true pnpm tauri build --bundles app,dmg \
  --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
app=src-tauri/target/release/bundle/macos/Devot.app
test -s "$app/Contents/Resources/Assets.car"
plutil -extract CFBundleIconName raw "$app/Contents/Info.plist"
```

`CI=true` makes the dmg step skip arranging the disk image window through Finder, which otherwise needs Automation access and can hang. Set a version with `node scripts/release/release.ts set-version <tag>` first if the build should carry one (a local change; do not commit it).
