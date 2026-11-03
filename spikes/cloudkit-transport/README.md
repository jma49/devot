# CloudKit transport spike (uncommitted)

`Sources/main.swift` is the smallest probe: account status, then one record written, read, made to conflict
with a stale change tag, and fetched back by change token in a private database zone, then removed.
`probe.entitlements` is a template (`TEAMID`, `CONTAINER` are placeholders; no secret is in this folder).

Status on this Mac (2026-11-02): compiles (`swiftc -swift-version 5`), never run.

## Why it was not run

- Signing identities exist: `Developer ID Application` and `Apple Development`, team in `security find-identity`.
- The only provisioning profile is Xcode's iOS wildcard (`XC Wildcard`); its entitlements are
  application-identifier, team-identifier, get-task-allow and keychain-access-groups. No iCloud services,
  no container identifiers, no macOS Developer ID profile. A wildcard App ID cannot carry iCloud.
- No iCloud container exists for any Devot identifier, and `src-tauri/gen/apple/.../devot_iOS.entitlements`
  is an empty dict. Creating either is a portal action reserved for the owner.

## Owner steps (Apple Developer portal), using a spike-only identifier

1. Certificates, Identifiers & Profiles > Identifiers > + > App IDs > App. Explicit bundle ID
   `io.github.jma49.devot.probe` (not Devot's own). Enable iCloud and choose "Include CloudKit support".
2. Identifiers > + > iCloud Containers: `iCloud.io.github.jma49.devot.probe`. Assign it to the App ID
   (App ID > iCloud > Configure). Container names are probably permanent: keep it clearly a spike.
3. Profiles > + > Distribution > Developer ID, for that App ID and the existing Developer ID Application
   certificate. Download the `.provisionprofile` to a folder outside git.
4. Sign in to iCloud on a test Mac with a throwaway Apple ID.
5. In CloudKit Console, the container's Development environment: after the first run of a Development-signed
   build the record type `Chunk` exists; Deploy Schema Changes to Production (a Developer ID build uses
   Production, where types are not auto-created; unconfirmed, see DESIGN.md).

## Build and sign (after 1-3)

```sh
swiftc -swift-version 5 -o probe Sources/main.swift
mkdir -p Probe.app/Contents/MacOS && cp probe Probe.app/Contents/MacOS/probe
# Info.plist: CFBundleIdentifier io.github.jma49.devot.probe, CFBundleExecutable probe
cp <profile>.provisionprofile Probe.app/Contents/embedded.provisionprofile
sed -e 's/TEAMID/<team id>/g' -e 's/CONTAINER/io.github.jma49.devot.probe/' probe.entitlements > /tmp/e.plist
codesign --force --options runtime --timestamp --entitlements /tmp/e.plist -s "Developer ID Application: …" Probe.app
DEVOT_PROBE_CONTAINER=iCloud.io.github.jma49.devot.probe Probe.app/Contents/MacOS/probe
```

Expected output: `account status: 1`, a change tag, `stale save rejected with serverRecordChanged`, a change count.
A launch that dies with an unsatisfied `icloud-container-*` entitlement in `taskgated-helper` means the
profile and entitlements disagree.
