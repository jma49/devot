// Feasibility probe: account status, then write / read / conflict / delta-fetch of one record in a private
// database zone. Needs a signed build with iCloud entitlements and a container the owner made (README.md).
// Never run unsigned: CKContainer raises an Objective-C exception without the entitlement.
import CloudKit
import Foundation

guard let containerId = ProcessInfo.processInfo.environment["DEVOT_PROBE_CONTAINER"] else {
    print("E_PROBE_NO_CONTAINER: set DEVOT_PROBE_CONTAINER=iCloud.<id>"); exit(2)
}
let container = CKContainer(identifier: containerId)
let db = container.privateCloudDatabase
let zone = CKRecordZone(zoneID: CKRecordZone.ID(zoneName: "probe", ownerName: CKCurrentUserDefaultName))

func retryAfter(_ error: Error) -> Double? { (error as? CKError)?.retryAfterSeconds }

func run() async throws {
    let status = try await container.accountStatus()
    print("account status:", status.rawValue, "(1 = available)")
    guard status == .available else { print("E_PROBE_ACCOUNT"); return }

    _ = try await db.modifyRecordZones(saving: [zone], deleting: [])
    print("zone ready")

    // A stand-in for one sealed chunk: random bytes, as AES-GCM output looks to the server.
    let id = CKRecord.ID(recordName: UUID().uuidString, zoneID: zone.zoneID)
    let first = CKRecord(recordType: "Chunk", recordID: id)
    first["version"] = 1 as NSNumber
    first["blob"] = Data((0..<4096).map { _ in UInt8.random(in: 0...255) }) as NSData
    let saved = try await db.save(first)
    print("saved, change tag:", saved.recordChangeTag ?? "nil")

    // Compare-and-set: two copies with the same tag; the second save must lose.
    let a = try await db.record(for: id), b = try await db.record(for: id)
    a["version"] = 2 as NSNumber
    _ = try await db.modifyRecords(saving: [a], deleting: [], savePolicy: .ifServerRecordUnchanged)
    b["version"] = 2 as NSNumber
    let result = try await db.modifyRecords(saving: [b], deleting: [], savePolicy: .ifServerRecordUnchanged)
    for (_, r) in result.saveResults {
        if case .failure(let e) = r, (e as? CKError)?.code == .serverRecordChanged {
            print("stale save rejected with serverRecordChanged (compare-and-set holds)")
        } else { print("E_PROBE_CAS_NOT_ENFORCED") }
    }

    // Delta fetch with a server change token, the analogue of pull(since_seq).
    var token: CKServerChangeToken?
    var more = true, count = 0
    while more {
        let page = try await db.recordZoneChanges(inZoneWith: zone.zoneID, since: token)
        count += page.modificationResultsByID.count
        token = page.changeToken; more = page.moreComing
    }
    print("zone changes seen:", count, "token present:", token != nil)

    // Clean up the probe zone (and with it every record).
    _ = try await db.modifyRecordZones(saving: [], deleting: [zone.zoneID])
}

do { try await run() } catch {
    let e = error as NSError
    print("E_PROBE_FAILED domain=\(e.domain) code=\(e.code) retryAfter=\(retryAfter(error).map { "\($0)" } ?? "-")")
    print("detail:", e.localizedDescription)
    if let server = e.userInfo["ServerErrorDescription"] { print("server:", server) }
    if let parts = e.userInfo[CKPartialErrorsByItemIDKey] as? [AnyHashable: Error] {
        for (_, part) in parts { print("part:", (part as NSError).code, (part as NSError).localizedDescription) }
    }
    exit(1)
}
