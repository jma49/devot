# Synchronizable keychain probe (#612, spike only)

Can a Developer ID signed Mac app keep a synchronizable generic password in the data-protection
keychain, in the access group `WMG3HG38DV.io.github.jma49.devot`, readable after first unlock?

- `Sources/main.swift`: the probe. `probe cycle` adds, reads, updates and deletes one item (after a
  local, non-synchronizable control item); `write`, `read` and `delete` handle one handover item for
  a check from another device. It prints OSStatus codes only.
- `probe.entitlements`: application identifier, team and the access group.
- `build.sh` and `.github/workflows/keychain-probe.yml`: CI builds and signs it with the Developer ID
  profile from the `release` environment (push a `vprobe-keychain-*` tag), notarizes it and uploads it.

Run on a Mac signed in to iCloud:

```sh
gh run download <run id> -n keychain-probe -D <empty folder>
ditto -x -k <folder>/KeychainProbe.app.zip <folder>
<folder>/KeychainProbe.app/Contents/MacOS/probe cycle
```
