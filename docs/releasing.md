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

1. CI checked exactly the tagged commit's tree: either the merge queue's run on that merge commit passed (the usual way, since pull requests merge through the queue), or CI is green on the head commit of the pull request that was merged and the tree of `main` equals that head's tree (`git diff --quiet <head commit> origin/main`).
2. The tag is a merged pull request's merge commit on `main`.

The release workflow checks this before it builds. It fails with `E_RELEASE_NO_MERGED_PR`, `E_RELEASE_TREE_MISMATCH` or `E_RELEASE_CI_NOT_GREEN` otherwise, so a release cannot be made from a commit CI never checked.

A pull request merged outside the queue whose branch was behind `main` fails the tree check: its merge commit also holds what `main` gained meanwhile. Merge through the queue, or bring the branch up to date with `main` before merging a pull request you mean to release.

## Release

Write the notes in English, one line per issue the release closes (`- #148 Drag notes and notebooks out of the app as links`), then tag the merge commit with them and push the tag:

```sh
git fetch origin
git tag -a <tag> <merge commit> -F notes.md
git push origin <tag>
```

The tag's message becomes the release notes and the update's notes in the app. A tag without a message gets GitHub's generated notes. The notes of the first release signed with the Developer ID also carry the line in Signing the app, Keychain items after the switch.

The workflow refuses a tag whose commit is not on `main`. Then it runs five jobs, and a sixth, **sentry**, once crash reporting is set up:

1. **build** (macOS 26, Apple Silicon): sets the version from the tag (a tag of any other form fails the run) and builds the `app` bundle, ad-hoc signed (`signingIdentity: "-"`), with the updater's public key built in and `requireSignedVersion` on, so an install takes an update only when its signature records the version the feed announces. It verifies it (`codesign --verify --deep --strict`, and that the app has its layered icon: `Assets.car` and `CFBundleIconName`, see `docs/specs/design-system.md`) and hands it on as a `ditto` archive, which keeps the bundle's symlinks and extended attributes. This job runs the dependencies' code, so it gets a read-only token and no Apple credential, updater key or Sentry token. With `SENTRY_PROJECT` set it leaves the UI's source maps (with their debug IDs written into the shipped scripts) and the app's `devot.dSYM` in a `sentry` artifact of their own (`DEVOT_SENTRY_STAGE`), and the app it hands on still holds no map nor a comment pointing to one.
2. **notarize** (macOS 26): signs the app with the Developer ID, has it notarized and staples it, makes the dmg and the updater bundle (`Devot.app.tar.gz`) from the stapled app, and signs, notarizes and staples the dmg (`scripts/release/macos-sign.sh`, see Signing the app). It holds the Apple credentials and runs only Apple's tools and the committed scripts, never `pnpm install`.
3. **sign**: signs the notarize job's updater bundle with the updater key, recording the version (`scripts/release/release.ts sign`), and checks the signature against `TAURI_UPDATER_PUBKEY`: a private key that does not match the public key fails the run instead of shipping updates no install would accept. It runs only Node and `release.ts`, never `pnpm install`.
4. **publish**: creates the release for the tag (a prerelease for a beta) with the dmg, the updater bundle and its signature.
5. **feed**: writes the feeds the release goes in and uploads them to the fixed `updater` release, which it creates on first use: `beta.json` for a beta; `stable.json` and `beta.json` for a stable release (`scripts/release/release.ts feeds`). Each feed is replaced only by a release newer than the one it offers, and a stable release never takes `beta.json` back from a newer beta. A feed that cannot be read (other than one not there yet) fails the run rather than being replaced, and each feed is read back after uploading. Feed jobs run one at a time across runs (a concurrency group), so tags pushed close together leave the newest release in each feed. GitHub keeps only one job waiting in the group: when a third run arrives, the waiting feed job is cancelled; re-run it.
6. **sentry**, only with `SENTRY_PROJECT` set: uploads the build's `sentry` artifact to Sentry (`scripts/sentry/staged.ts`: the maps under the release `devot@<version>`, then the dSYM). It holds `SENTRY_AUTH_TOKEN`, a secret of the `release` environment, and runs only `staged.ts` (Node modules alone) and `sentry-cli`, which it installs alone at the version `package.json` names and without install scripts, never `pnpm install`.

Only the publish and feed jobs can write to the repository. Every action is pinned to a commit (`tests/policy/release-workflow.test.ts`). A failed run can be run again: a release already made gets its files uploaded again instead.

Watch the run in the Actions tab; when it fails, fix the cause and release under a new tag.

## After a release

The MCP bridge ships inside the app's binary, so it adds nothing to sign, notarize or bundle. No automated test runs it against a signed build, so check it on the first release that carries it, and after any change to how Devot starts or signs:

1. With Devot quit, run `/Applications/Devot.app/Contents/MacOS/devot --cli mcp`, send a `tools/call` for `list_notebooks` on its stdin, and check that no window, Dock icon or keychain prompt appears, that a menu bar icon does, and that the answer comes.
2. Open Devot from Finder: its window shows, and the menu bar icon goes.
3. Quit from the menu bar icon and from Settings > Integrations with a note just edited: the edit is there on the next launch.
4. Leave one started that way alone for 10 minutes: it quits by itself.
5. Connect Claude Code and Claude Desktop from Settings, make a write, and check it shows as theirs in the note's authorship.

Once the new release is published and its feeds offer it, delete the releases it replaces together with their tags: the previous stable release, and every beta that is not newer than the newest stable release.

```sh
gh release delete <tag> --yes --cleanup-tag
```

Only the newest stable release is kept, plus a beta newer than it if one is out. Never delete the `updater` release (see Update feed).

## The iPhone app

Until the App Store build (below) is in TestFlight, a release reaches the owner's iPhone as a development build signed by the owner's team, built on a Mac from the tagged commit and installed on a registered device. It is never attached to the GitHub release: its provisioning profile lists the registered devices.

```sh
git switch --detach <tag>
node scripts/release/release.ts set-version <tag>   # also the iPhone app's version; a local change, do not commit it
node scripts/release/app-store.ts icloud-settings src-tauri/gen/apple/devot.xcodeproj/project.pbxproj   # a local change too
pnpm tauri ios build                                # src-tauri/gen/apple/build/arm64/Devot.ipa
xcrun devicectl list devices
unzip -q src-tauri/gen/apple/build/arm64/Devot.ipa -d <scratch folder>
xcrun devicectl device install app --device <device ID> <scratch folder>/Payload/Devot.app
git restore package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/gen/apple
```

A development build needs a signing team (docs/development.md, iOS). `icloud-settings` writes `DEVOT_ICLOUD = YES` into the iPhone app's build settings, which gives it the iCloud entitlements and container (see Signing the app, iCloud entitlements), so it also needs a development profile of the owner's team that grants the app's iCloud container, push and keychain group. With automatic signing, Xcode makes that profile from the App ID. The export uses CloudKit's Production environment, as the Mac app does (`ExportOptions.plist`). Remove the `build` folder the build leaves in `src-tauri/gen/apple` afterwards.

## The App Store build

`.github/workflows/app-store.yml` makes the iPhone app for the App Store (ADR 0014). It runs for every release tag, on demand (Actions > App Store > Run workflow), and for a pull request that changes the workflow, its scripts or `src-tauri/gen/apple`. It has two jobs:

1. **build** runs the dependencies' code with a read-only token and no Apple secret. It sets the version (a tag's, as the release workflow does) and the build number, then archives the app unsigned (`pnpm tauri ios build --archive-only --no-sign`) with `DEVOT_RELEASE_BUILD=1`, `DEVOT_DISTRIBUTION=app-store` (an App Store build, docs/licensing.md) and `DEVOT_ICLOUD=YES` (Signing the app, iCloud entitlements). The Tauri CLI starts `xcodebuild` with only its own variables (`TAURI_*`, `CARGO_*`, `RUST_*`), so these three and `DEVOT_SENTRY_DSN` cannot come from the job's environment: `app-store.ts project-settings` writes them into the checkout's Xcode project as build settings of the iPhone app, and Xcode hands them to the Rust build through its Run Script phase. `marker-check` then reads rustc's dep-info to confirm the Rust build saw both markers. `scripts/release/app-store.ts check-bundle` checks the archived app's bundle ID, that it is for the iPhone only, the iCloud container in its `Info.plist`, `ITSAppUsesNonExemptEncryption`, the version and the build number. `privacy-check` checks that `PrivacyInfo.xcprivacy` gives a reason for every required-reason API the binary calls, found with `nm -u` and the binary's Objective-C class and selector names. A failure is an `E_APP_STORE_…` annotation.
2. **export** runs only for a tag, after the same release gate as the release workflow, in the `release` environment, and runs no dependency code. `scripts/release/ios-export.sh` imports the Apple Distribution certificate into a keychain made for the run and checks the App Store profile with `scripts/release/ios-profile.sh`. The profile must be for iOS, an App Store profile (no device list, no `get-task-allow`), for the team, App ID and certificate, grant every signing entitlement, and be valid for 30 more days (`E_SIGN_PROFILE_…`). The script signs the app with `devot_iOS.entitlements` plus the App ID, the team, `aps-environment` `production` and CloudKit's Production environment, exports the `.ipa` with `ExportOptions-AppStore.plist`, and checks its signature, embedded profile, privacy manifest and entitlements (`E_EXPORT_…`). The `.ipa` stays on the run as the `ipa` artifact for 7 days. When the repository variable `APP_STORE_UPLOAD` is `true`, the script then uploads it to App Store Connect with the API key; otherwise the run says it did not upload. The API key reaches the job only when it uploads.

A pull request and a run on demand stop after `build`, because the `release` environment takes only `v*` tags. So signing, export and upload first run on a tag; a beta tag is the way to try them.

**Version and build number.** `CFBundleShortVersionString` is the release version without its beta suffix (`1.2.0-beta3` ships as `1.2.0`), because App Store Connect takes only numbers there. `CFBundleVersion` is `<run number>.<run attempt>` of the App Store workflow (`app-store.ts version`), which grows with every run and every re-run, so each upload has a new build number. App Store Connect refuses a build number lower than one it has, and GitHub counts runs per workflow file, so never rename `app-store.yml`: a renamed workflow starts again at 1. The betas and the stable release of one version share its version string. The development build (The iPhone app above) is unchanged and keeps `ExportOptions.plist`.

**Export compliance.** Devot uses encryption of its own beside Apple's: sync seals notes with AES-256-GCM under keys derived with HKDF-SHA256 (ADR 0015), licences are verified with Ed25519, and the relay and the licence Worker are reached over HTTPS. These are standard, published algorithms, not proprietary ones. So `ITSAppUsesNonExemptEncryption` is `true` in `project.yml` and `Info.plist`, and App Store Connect asks about the build's encryption. The owner answers there: the app uses encryption; it uses standard encryption algorithms instead of, or in addition to, Apple's operating system; and whether the app is offered in France, which needs a declaration to France's ANSSI. If App Store Connect issues an export compliance code, add it as `ITSEncryptionExportComplianceCode` to both files, so later builds skip the questions. With these answers two filings fall to the owner as the developer, not to Apple: the yearly self-classification report to the US Bureau of Industry and Security (due by 1 February for the year before), and, while the app is offered in France, the declaration to ANSSI.

**Privacy.** `src-tauri/gen/apple/devot_iOS/PrivacyInfo.xcprivacy` declares no tracking and what leaves the device: the purchase the licence Worker checks (Purchase History), the random device ID of a licence seat (Device ID) and, once the user turns them on, crash reports to Sentry (Crash Data). Each is used only for the app's function. The device ID is linked to the user: the Worker keeps it, with the seat's label, under the licence, whose licensee is the buyer's email. The label is the build's fixed name (`Devot for iPhone`), not the device's name, so it is no data type of its own. The purchase and crash reports are not linked. It gives reason `C617.1` for file timestamps, which the app reads only for files in its own container, and `E174.1` for disk space: `statfs`, `fstatfs` and `statvfs` read a volume's flags and file system type before the app writes to it (SQLite picks its locking style that way, and `atomic_file` checks for a read-only volume), never its free space, and Apple's list has no closer reason. App Store Connect's privacy label must match: Identifiers (Device ID) linked to the user, Purchases and Diagnostics (Crash Data) not linked, each for App Functionality and none used for tracking. When a dependency starts calling another required-reason API, `privacy-check` fails and names it: add the category with its reason.

### Owner steps for the App Store

1. **App Store Connect > Business:** sign the Paid Apps agreement and complete tax and banking.
2. **Apps > New App:** iOS, name Devot, bundle ID `io.github.jma49.devot` (the App ID with iCloud, push and In-App Purchase; Signing the app, Owner steps before the first release with iCloud). Under **Pricing and Availability**, untick the Mac (iPhone and iPad apps on Apple silicon Macs) and Apple Vision Pro availability, which are on by default: the Mac app is sold with a licence key, and the iPhone app is built for the iPhone only.
3. **In-App Purchases**, both non-consumable and with Family Sharing off: `io.github.jma49.devot.pro` (Devot Pro, US$29.99) and `io.github.jma49.devot.trial` (30-day Trial, free).
4. **Certificates > Apple Distribution:** make the certificate, export it with its private key from Keychain Access as a `.p12`, then:
   ```sh
   base64 -i Distribution.p12 | gh secret set --env release APPLE_DISTRIBUTION_CERTIFICATE
   gh secret set --env release APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD   # asks for the .p12's password
   ```
5. **Profiles > App Store Connect:** an App Store profile for `io.github.jma49.devot` with that certificate. It grants the iCloud container, push and the keychain group through the App ID. Make it again after renewing the certificate.
   ```sh
   base64 -i Devot_App_Store.mobileprovision | gh secret set --env release APPLE_PROVISIONING_PROFILE_IOS
   ```
6. **The upload key:** the team API key the release workflow already uses (`APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`; Credentials below) uploads builds with its Developer role. A key without that right needs the App Manager role, or a new key in the same secret and variables.
7. **Turn the upload on** once the app record exists: `gh variable set APP_STORE_UPLOAD --body true`. Until then a tag's run signs and exports the `.ipa` but does not upload it.
8. **Before submitting:** answer export compliance (above), fill the privacy label (above), the age rating, screenshots and description, deploy the CloudKit schema to Production (Owner steps before the first release with iCloud), add sandbox testers, and write review notes that explain Guideline 3.1.3(b) for Enter License Key, with a complimentary production licence key for App Review (docs/licensing.md). Then submit the build for review.

### Before the first submission

Push a beta tag and check that the export job signs, exports and (with `APP_STORE_UPLOAD` on) uploads, and that App Store Connect accepts the build and its privacy manifest. Then, from TestFlight on an iPhone: buy Devot Pro and the Trial in the sandbox, restore them, enter a licence key, and sync through iCloud against CloudKit's Production environment.

## Update feed

The app reads `https://github.com/jma49/devot/releases/download/updater/beta.json` (a prerelease build) or `.../stable.json` (a stable build): a release named `updater` that holds one file per channel. It is a prerelease so that it never shows as the latest release. Do not delete it: installed copies would stop finding updates.

A beta install reads `beta.json`, so a stable release also goes there when it is newer than the beta it offers: the beta channel always offers the newest build of either kind (`1.0.0-beta5` is offered `1.0.0`, but `1.0.2-beta1` stays when `1.0.1` ships). A stable install reads only `stable.json` and never gets a beta.

Release builds check 30 seconds after launch and then daily (hourly on a beta build), and on Devot > Check for Updates…. With Settings > General > Automatically Download Updates on (the default), an update downloads in the background; then Devot offers Restart to Update, which installs it and restarts once the notes are saved. A plain quit installs nothing; the next launch finds the update again.

The same daily schedule fetches the license Worker's revocation list, also in a build without the updater key (docs/specs/updates.md).

## Signing the app

Releases are signed with the owner's Developer ID Application certificate, with the hardened runtime and a secure timestamp, and notarized by Apple, so Gatekeeper opens them without a warning and the hardened runtime keeps injected libraries out of the signed app. `scripts/release/macos-sign.sh` does it all in the notarize job:

1. It imports the certificate into a keychain made for the run (a random password, under `RUNNER_TEMP`) and deletes that keychain when it ends, whatever happens. The keychain goes on the runner's search list for the run (`--search-list`), so codesign also finds an intermediate certificate the `.p12` carries.
2. It checks the Developer ID provisioning profile against the imported certificate (`scripts/release/macos-profile.sh`, see iCloud entitlements below) and embeds it as `Contents/embedded.provisionprofile`. The profile ships in the dmg and the updater bundle: Apple signs it, and it holds only the App ID, the team, the entitlements and the public certificate, no private key. Do not remove it from the bundle.
3. It signs every piece of code in the bundle inside out (nested Mach-O files and bundles first, then the app) with `--options runtime --timestamp`. Only the app's own signature, which is its main executable's, carries entitlements: exactly the set in `src-tauri/macos/Devot.entitlements` (`--entitlements`). Every other Mach-O gets none. The bundled `devot` command is a shell script among the resources, sealed with them.
4. It checks the app: `codesign --verify --deep --strict`, the hardened runtime and the timestamp on every Mach-O, that the signature's authority is `APPLE_SIGNING_IDENTITY` and its Team ID the one the identity names, and that the profile is embedded. `scripts/release/macos-entitlements.sh` checks that the main executable carries exactly the set in the file and that no other Mach-O carries any entitlement; otherwise it fails with `E_SIGN_ENTITLEMENTS`.
5. It has a `ditto` zip of the app notarized (`scripts/release/macos-notarize.sh`, with the API key written to a file under `RUNNER_TEMP` and removed; see Waiting for Apple below) and staples the ticket to the app, then checks it again with `xcrun stapler validate` and `spctl -a -t exec -vv`, which must answer `source=Notarized Developer ID`.
6. It makes the dmg from the stapled app (`scripts/release/macos-dmg.sh`: the app and a link to `/Applications`, the app's icon as the volume icon, HFS+, compressed; as before, no Finder window layout), signs it, has it notarized and staples it, and checks it with `xcrun stapler validate`, `spctl -a -t open --context context:primary-signature -vv` and `hdiutil verify`.
7. It packs the updater bundle from the stapled app, without AppleDouble (`._`) entries, which the updater would unpack into the bundle and so break its seal, and checks that the unpacked copy still verifies and carries its ticket. The sign job signs that bundle with the updater key.

A missing secret or variable, an identity of another form, a profile that fails its checks, a signature by another identity or team, or a notarization that does not end `Accepted` fails the run with an annotation that says which (`E_SIGN_…`). On a refused notarization it prints the submission ID and the notary log. No secret is ever printed.

### iCloud entitlements

iCloud sync (ADR 0015) needs CloudKit, push and a keychain group that the iPhone app shares. A Developer ID app gets these only through entitlements, and macOS accepts them only when an embedded provisioning profile from the same team grants them. So the main executable carries:

- `com.apple.application-identifier` (`WMG3HG38DV.io.github.jma49.devot`) and `com.apple.developer.team-identifier`;
- `com.apple.developer.icloud-services` (`CloudKit`), `com.apple.developer.icloud-container-identifiers` (`iCloud.io.github.jma49.devot`) and `com.apple.developer.icloud-container-environment` (`Production`; a Developer ID build always uses Production);
- `com.apple.developer.aps-environment` (`production`), so CloudKit can push changes;
- `keychain-access-groups` (`WMG3HG38DV.io.github.jma49.devot`), the data-protection keychain group shared with the iPhone app.

Only the main executable needs them, because it is the only process that calls CloudKit and the keychain. Before iCloud sync the app needed no entitlements for its other work, and it still needs none for it: WebKit runs JavaScript, and its JIT, in its own processes; the app loads no library of another team (only Apple's frameworks); it sends Apple events only through `/usr/bin/osascript` (installing the command line tool), and the updater's privileged install runs its script inside the app; the crash reporter, a second copy of the app, reads only the memory the crashed app hands it over Mach IPC. Restricted entitlements on any other Mach-O would also need the profile to cover that code, so the check refuses them.

`scripts/release/macos-profile.sh` checks the profile after the certificate is imported and before anything is signed. It must be for macOS and for the team the identity names. It must be a Developer ID profile, which provisions all devices (`ProvisionsAllDevices`); a Mac App Store or development profile does not. It must hold the signing certificate among its `DeveloperCertificates`, compared by SHA-1 with the identity in the run's keychain: a profile made before the certificate was renewed does not. It must be for the App ID `<team ID>.<bundle ID>`, which the entitlements file must name too. It must grant every entitlement in the file, either as the same value, as `*`, or by a `<team ID>.*` wildcard. It must also be valid for at least 30 more days. Otherwise the run fails with `E_SIGN_PROFILE_TEAM`, `E_SIGN_PROFILE_PLATFORM`, `E_SIGN_PROFILE_NOT_DEVELOPER_ID`, `E_SIGN_PROFILE_CERTIFICATE`, `E_SIGN_PROFILE_APP_ID`, `E_SIGN_PROFILE_ENTITLEMENTS` (naming the entitlements it lacks) or `E_SIGN_PROFILE_EXPIRING`. macOS kills an app at launch whose profile does not hold its signing certificate or grant its entitlements. When one of these fails, make a new profile in the portal and replace the secret. A Developer ID profile lasts as long as its certificate.

The script reads the profile with `security cms -D`, which does not check that Apple signed it. So the check catches a wrong or stale profile, not a forged one. The secret is in the same release environment as the certificate, and macOS checks Apple's signature when the app starts.

Builds without the profile, which are local `pnpm tauri build`, the CI checks, `build:debug` and forks, are still made and carry no entitlements. Without `--entitlements`, `macos-sign.sh` signs that way as well. Such a build has no CloudKit container. Once iCloud sync is built, it reports `E_SYNC_CLOUDKIT_UNAVAILABLE` there and offers only the relay (ADR 0015). Never add the entitlements to `tauri.conf.json`: macOS kills an ad-hoc signed app that claims restricted entitlements at launch.

The iPhone app carries the same container, keychain group and push in `src-tauri/gen/apple/devot_iOS/devot_iOS.entitlements`, but only in a build whose Xcode build settings have `DEVOT_ICLOUD = YES`. The Tauri CLI starts `xcodebuild` without the shell's other variables, so setting it in the environment of `pnpm tauri ios build` or `dev` does nothing: `node scripts/release/app-store.ts icloud-settings <project.pbxproj>` writes it into the checkout's project (undo with `git restore src-tauri/gen/apple`), and a direct `xcodebuild` run takes it as an argument (`DEVOT_ICLOUD=YES`). Only the builds that ship set it: the owner's iPhone build and the App Store build (The iPhone app and The App Store build above). Such a build signs with the entitlements file (`CODE_SIGN_ENTITLEMENTS`) and writes the container ID into its `Info.plist` (`DevotCloudKitContainer`, from the `DEVOT_CLOUDKIT_CONTAINER` build setting). Every other build, which is local `pnpm tauri ios dev` and `build`, the CI checks and forks, has neither, so it signs with any team and reports `E_SYNC_CLOUDKIT_UNAVAILABLE` (ADR 0015). That is how the app tells on iOS whether it may touch CloudKit. Xcode takes the App ID and team from the profile, and it changes `aps-environment` to `production` when it exports for the App Store. The file names no container environment: a development-signed build that runs from Xcode or `pnpm tauri ios dev` uses Development, and `ExportOptions.plist` asks for Production when a build is exported.

#### Owner steps before the first release with iCloud

In the Apple Developer portal (Certificates, Identifiers & Profiles):

1. **Identifiers > App IDs:** `io.github.jma49.devot` is an explicit App ID with **iCloud** (CloudKit support), **Push Notifications** and **In-App Purchase**.
2. **Identifiers > iCloud Containers:** `iCloud.io.github.jma49.devot`, assigned to that App ID. A container can never be deleted.
3. **Keychain sharing:** the group `WMG3HG38DV.io.github.jma49.devot` needs no portal step. The profiles grant it through `WMG3HG38DV.*`.
4. **Profiles:** a **Developer ID** profile for the Mac app, and an **App Store** profile for the iPhone app, both for that App ID. A development profile for a `.dev` App ID with its own container is optional, for testing against CloudKit's Development environment.
5. **GitHub, the `release` environment:** `APPLE_PROVISIONING_PROFILE_MACOS` and `APPLE_PROVISIONING_PROFILE_IOS`, each the profile in base64 (`base64 -i Devot.provisionprofile | pbcopy`), next to the credentials below.

In the CloudKit Console, for the container:

1. In the **Development** environment, let a development-signed build create the record types `DevotVault`, `DevotMeta`, `DevotDevice`, `DevotClock`, `DevotRecord` and `DevotPairing` and their fields: on a registered iPhone, signed by the owner's team, turn on Sync Through iCloud, write a note and let it sync. Use a build that carries its web assets, since `pnpm tauri ios dev` loads every module through the dev server and a module the proxy fails leaves a blank window. After `icloud-settings` (iCloud entitlements above), set `iCloudContainerEnvironment` to `Development` in `ExportOptions.plist`, run `pnpm tauri ios build --debug --export-method debugging`, install it with `xcrun devicectl device install app` as in The iPhone app, then `git restore src-tauri/gen/apple`.
2. **Deploy Schema Changes to Production** before the first release that uses them. A Developer ID or App Store build uses Production, where record types are never created on first save: an undeployed type fails the save with code 12 (`Cannot create new type`).
3. Indexes: the transport looks records up only by record name and fetches zone changes, so it needs no index beyond those CloudKit keeps. When the transport (#603) starts querying a field, that field needs a queryable index, deployed the same way.

Deploy every later schema change to Production before the release that needs it. Production can only add record types and fields; it never removes them.

### Waiting for Apple

Notarization is submitted without `--wait`, so the log shows the submission ID at once, and the script then waits for Apple's answer in chunks of at most 30 minutes. `NOTARY_WAIT_MINUTES` (default 300) is the budget for the app and the dmg together: the dmg gets what the app left, but at least 20 minutes. The notarize job's `timeout-minutes` is 360, the hosted-runner maximum, which two full 300-minute waits could not fit.

- `E_SIGN_NOTARIZATION_TIMEOUT`: Apple had not answered within the budget. Look the submission up by its ID with `xcrun notarytool info <id>` (add `--key`, `--key-id` and `--issuer` for the API key). A re-run of the failed jobs submits again; it does not resume the old submission, so a new team's first notarization can take as long again.
- `E_SIGN_NOTARIZATION_REFUSED`: Apple answered with something other than `Accepted`. The log shows the notary log; fetch it again with `xcrun notarytool log <id>`.
- A failed submission (a network error) is retried up to 3 times.

### Credentials

In the `release` environment, as secrets:

- `APPLE_CERTIFICATE`: the Developer ID Application certificate with its private key, exported from Keychain Access as a `.p12`, in base64 (`base64 -i DeveloperID.p12 | pbcopy`).
- `APPLE_CERTIFICATE_PASSWORD`: the password the `.p12` was exported with.
- `APPLE_API_KEY_P8`: the whole text of the App Store Connect team API key (`AuthKey_<key ID>.p8`, Users and Access > Integrations, role Developer).
- `APPLE_PROVISIONING_PROFILE_MACOS`: the Developer ID provisioning profile in base64. The notarize job passes it to `macos-sign.sh` as `APPLE_PROVISIONING_PROFILE`, and the script decodes it into its own folder under `RUNNER_TEMP`, never into the checkout. The script never prints the profile.
- `APPLE_PROVISIONING_PROFILE_IOS`, `APPLE_DISTRIBUTION_CERTIFICATE` and `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD`: the App Store profile and the Apple Distribution certificate for the iPhone app, read only by the App Store workflow's export job (The App Store build above).

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

`tests/scripts/macos-sign.bench.test.ts` also signs with `--entitlements tests/fixtures/signing/test.entitlements` and a test profile made from `tests/fixtures/signing/profile.plist`. That profile is signed with a throwaway key, never with a real profile or secret. `tests/scripts/macos-profile.test.ts` and `tests/scripts/macos-entitlements.test.ts` cover the two checks on a Mac.

`pnpm tauri build` stays ad-hoc signed (see Building locally): only the release workflow signs with the Developer ID.

### Keychain items after the switch

macOS ties a keychain item to the signature of the app that made it. An ad-hoc signature names one exact build, so each ad-hoc update was a different app to the keychain; a Developer ID signature names the team and the app's identifier, so every later signed update is the same app and reads its items without asking. The first Developer ID build that opens an install's items (the license, the trial, sync's vault and device token, the AI keys, the HTTP API token) may make macOS ask once, per item, whether Devot may use it. Choosing Always Allow ends the prompts for good.

A denied or failed read loses nothing, since Devot never writes over or removes on its own an item it could not read:

- the license shows its keychain error (`E_LICENCE_KEYCHAIN`) and is asked for again at the next tick (a minute), not at every save; with the trial over, notes stay readable but read-only until the license is read or added again;
- the trial counts as ended and is read again at the next tick; a trial it could not read is never begun again, so a denial never resets it;
- sync, AI and the HTTP API report their keychain errors and never make a new vault key, AI key or token in place of one they could not read.

The notes of the first signed release carry this line:

```md
- Devot is now signed with its Developer ID and notarized by Apple. On the first launch macOS may ask whether Devot may use its items in your keychain; choose Always Allow. Nothing is lost if you deny: Devot asks again later.
```

### The first signed release

Once the credentials are in place, release a beta first (the very first notarization of a new team can take hours, so the notarize job may run for most of its 360 minutes; see Waiting for Apple) and, before the stable release, check on a Mac that has an ad-hoc build installed: the downloaded dmg opens without Gatekeeper's warning (`spctl -a -vv /Applications/Devot.app` says `Notarized Developer ID`); the update from the ad-hoc build installs; the keychain prompts appear once and Always Allow keeps the license, the trial and sync working; a native crash is still reported (`devot --crash-reporter`). Then check the install steps in `README.md` and the Release signing section of `SECURITY.md` against the build users download.

## Updater key

The updater accepts only bundles signed by the updater key. Its private key and password are the secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` of the `release` environment, whose deployments are limited to `v*` tags; only the sign job reads them; the public key is the repository variable `TAURI_UPDATER_PUBKEY`, passed to the build with `--config`. No key is committed, so local builds have no updater (a manual check says updates are unavailable).

The key pair is made once with `pnpm tauri signer generate -w <path>/devot-updater.key`, which asks for the password and writes the private key there and the public key to `devot-updater.key.pub`. Keep an offline backup of the private key and its password: losing either means installed copies can never update again, and a new key only reaches users who install a new copy by hand.

Optional settings turn on crash reporting in release builds, as `.env.local` does locally: the repository secret `DEVOT_SENTRY_DSN` (built into the app), the variables `SENTRY_ORG` and `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` as a secret of the `release` environment, where only the sentry job reads it (a repository secret of that name is no longer read; delete it).

## Building locally

A local build keeps its notes and keychain items in `io.github.jma49.devot.local`, apart from an installed Devot's: only the release workflow compiles with `DEVOT_RELEASE_BUILD=1`, and `build.rs` stops a tag's release build on GitHub Actions without it (`E_RELEASE_BUILD_MARKER`). So never hand a local build to anyone as Devot: it would show none of their notes.

With Xcode 26 or later, a local build makes the same bundles without the updater, ad-hoc signed and not notarized (with the command line tools alone it leaves out the layered app icon); the last three lines are the release workflow's check that the icon is in:

```sh
PATH="$(brew --prefix rustup)/bin:$PATH" CI=true pnpm tauri build --bundles app,dmg \
  --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
app=src-tauri/target/release/bundle/macos/Devot.app
test -s "$app/Contents/Resources/Assets.car"
plutil -extract CFBundleIconName raw "$app/Contents/Info.plist"
```

`CI=true` makes the dmg step skip arranging the disk image window through Finder, which otherwise needs Automation access and can hang. Set a version with `node scripts/release/release.ts set-version <tag>` first if the build should carry one (a local change; do not commit it).
