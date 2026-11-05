# Prints what a provisioning profile grants, without its certificates or the blob itself.
#   python3 -I inspect-profile.py <label> <profile.plist>
import plistlib
import sys

label, path = sys.argv[1], sys.argv[2]
with open(path, "rb") as f:
    p = plistlib.load(f)
e = p.get("Entitlements", {})
print(f"[{label}] Name: {p.get('Name')}")
print(f"[{label}] AppIDName: {p.get('AppIDName')}")
print(f"[{label}] TeamIdentifier: {p.get('TeamIdentifier')}")
print(f"[{label}] Platform: {p.get('Platform')}")
print(f"[{label}] ExpirationDate: {p.get('ExpirationDate')}")
print(f"[{label}] ProvisionsAllDevices: {p.get('ProvisionsAllDevices')} devices: {len(p.get('ProvisionedDevices', []))}")
print(f"[{label}] DeveloperCertificates: {len(p.get('DeveloperCertificates', []))}")
print(f"[{label}] Entitlement keys: {sorted(e)}")
shown = [
    "application-identifier",
    "com.apple.application-identifier",
    "com.apple.developer.team-identifier",
    "keychain-access-groups",
    "com.apple.developer.icloud-services",
    "com.apple.developer.icloud-container-identifiers",
    "com.apple.developer.icloud-container-environment",
    "com.apple.developer.icloud-container-development-container-identifiers",
    "com.apple.developer.ubiquity-container-identifiers",
    "com.apple.developer.ubiquity-kvstore-identifier",
    "aps-environment",
    "com.apple.developer.aps-environment",
    "get-task-allow",
    "beta-reports-active",
]
for key in shown:
    if key in e:
        print(f"[{label}]   {key} = {e[key]}")
