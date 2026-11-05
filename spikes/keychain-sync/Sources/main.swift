// Probe for #612: can a Developer ID signed Mac app keep a synchronizable item in the data-protection
// keychain, in the team's access group? Prints OSStatus codes only, never item bytes.
//
//   probe [cycle|write|read|delete|groups]
//
// cycle   adds, reads, updates, reads and deletes a synchronizable item (and a local control item first)
// write   leaves a synchronizable item behind for another device to read; its data is the write time
// read    reads that item and prints the write time it holds
// delete  deletes that item
import Foundation
import Security

let team = "WMG3HG38DV"
let group = "\(team).io.github.jma49.devot"
let service = "io.github.jma49.devot.probe612"
let handoverAccount = "probe612-handover"

func code(_ status: OSStatus) -> String {
    let text = (SecCopyErrorMessageString(status, nil) as String?) ?? "?"
    return "\(status) (\(text))"
}

func base(_ account: String, synchronizable: CFTypeRef) -> [CFString: Any] {
    [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service,
        kSecAttrAccount: account,
        kSecAttrAccessGroup: group,
        kSecUseDataProtectionKeychain: true,
        kSecAttrSynchronizable: synchronizable,
    ]
}

func add(_ account: String, _ data: Data, synchronizable: Bool) -> OSStatus {
    var query = base(account, synchronizable: synchronizable as CFBoolean)
    query[kSecValueData] = data
    query[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
    return SecItemAdd(query as CFDictionary, nil)
}

func read(_ account: String) -> (OSStatus, Data?, [String: Any]?) {
    var query = base(account, synchronizable: kSecAttrSynchronizableAny)
    query[kSecReturnData] = true
    query[kSecReturnAttributes] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    let attributes = result as? [String: Any]
    return (status, attributes?[kSecValueData as String] as? Data, attributes)
}

func update(_ account: String, _ data: Data) -> OSStatus {
    SecItemUpdate(
        base(account, synchronizable: kSecAttrSynchronizableAny) as CFDictionary,
        [kSecValueData: data] as CFDictionary)
}

func delete(_ account: String) -> OSStatus {
    SecItemDelete(base(account, synchronizable: kSecAttrSynchronizableAny) as CFDictionary)
}

func describe(_ attributes: [String: Any]?) -> String {
    guard let attributes else { return "" }
    let sync = attributes[kSecAttrSynchronizable as String].map { "\($0)" } ?? "absent"
    let accessible = attributes[kSecAttrAccessible as String].map { "\($0)" } ?? "absent"
    let agrp = attributes[kSecAttrAccessGroup as String].map { "\($0)" } ?? "absent"
    return " sync=\(sync) accessible=\(accessible) group=\(agrp)"
}

func printEntitlements() {
    guard let task = SecTaskCreateFromSelf(nil) else { print("entitlements: no task"); return }
    for name in ["keychain-access-groups", "com.apple.application-identifier", "com.apple.developer.team-identifier"] {
        let value = SecTaskCopyValueForEntitlement(task, name as CFString, nil)
        print("entitlement \(name): \(value.map { "\($0)" } ?? "absent")")
    }
}

func randomBytes() -> Data { Data((0..<32).map { _ in UInt8.random(in: 0...255) }) }

let mode = CommandLine.arguments.dropFirst().first ?? "cycle"
printEntitlements()
switch mode {
case "groups":
    break
case "cycle":
    let account = "probe612-\(UUID().uuidString)"
    _ = delete(account + "-local")
    print("local add (control):", code(add(account + "-local", randomBytes(), synchronizable: false)))
    print("local delete (control):", code(delete(account + "-local")))

    let first = randomBytes()
    let started = Date()
    print("sync add:", code(add(account, first, synchronizable: true)))
    var (status, data, attributes) = read(account)
    print("sync read:", code(status), "matches=\(data == first)" + describe(attributes))
    let second = randomBytes()
    print("sync update:", code(update(account, second)))
    (status, data, attributes) = read(account)
    print("sync read after update:", code(status), "matches=\(data == second)" + describe(attributes))
    print("sync delete:", code(delete(account)))
    (status, _, _) = read(account)
    print("sync read after delete:", code(status))
    print(String(format: "cycle took %.3f s", Date().timeIntervalSince(started)))
case "write":
    _ = delete(handoverAccount)
    let stamp = ISO8601DateFormatter().string(from: Date())
    print("handover add:", code(add(handoverAccount, Data(stamp.utf8), synchronizable: true)), "written at \(stamp)")
case "read":
    let (status, data, attributes) = read(handoverAccount)
    let stamp = data.flatMap { String(data: $0, encoding: .utf8) } ?? "none"
    print("handover read:", code(status), "written at \(stamp), read at \(ISO8601DateFormatter().string(from: Date()))" + describe(attributes))
case "delete":
    print("handover delete:", code(delete(handoverAccount)))
default:
    print("E_PROBE_USAGE: probe [cycle|write|read|delete|groups]")
    exit(2)
}
