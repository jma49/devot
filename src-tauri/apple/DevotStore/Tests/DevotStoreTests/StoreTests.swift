import Foundation
import StoreKit
import StoreKitTest
import XCTest

@testable import DevotStore

/// StoreKit Test against DevotStore.storekit, in the host app on a simulator. Every test starts
/// with no transactions; the session's dialogs are off, so purchases complete on their own.
final class StoreTests: XCTestCase {
    private var session: SKTestSession!

    override func setUp() async throws {
        let url = try XCTUnwrap(
            Bundle(for: StoreTests.self).url(forResource: "DevotStore", withExtension: "storekit"))
        session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.askToBuyEnabled = false
        session.clearTransactions()
    }

    override func tearDown() async throws {
        try await session.setSimulatedError(nil, forAPI: .purchase)
        session.clearTransactions()
    }

    private func purchased(_ productID: String) async throws -> TransactionReply {
        let reply = await Store.purchase(productID)
        XCTAssertEqual(reply.status, "purchased", reply.code ?? "")
        return try XCTUnwrap(reply.transaction)
    }

    private func storeTransaction(_ productID: String) throws -> SKTestTransaction {
        try XCTUnwrap(session.allTransactions().last { $0.productIdentifier == productID })
    }

    func testProductsComeWithTheirDisplayPrice() async throws {
        let reply = await Store.products()
        XCTAssertEqual(reply.status, "products")
        let products = try XCTUnwrap(reply.products)
        XCTAssertEqual(Set(products.map(\.id)), Set(Store.productIDs))
        let pro = try XCTUnwrap(products.first { $0.id == Store.pro })
        XCTAssertEqual(pro.displayName, "Devot Pro")
        XCTAssertTrue(pro.displayPrice.contains("29.99"), pro.displayPrice)
    }

    func testAPurchaseReportsTheVerifiedTransaction() async throws {
        let transaction = try await purchased(Store.pro)
        XCTAssertEqual(transaction.productId, Store.pro)
        XCTAssertEqual(transaction.bundleId, Bundle.main.bundleIdentifier)
        XCTAssertEqual(transaction.originalTransactionId, transaction.transactionId)
        XCTAssertEqual(transaction.ownershipType, "PURCHASED")
        XCTAssertEqual(transaction.environment, "Xcode")
        XCTAssertNil(transaction.revocationDate)
        XCTAssertNil(transaction.revocationReason)
        XCTAssertEqual(transaction.jwsRepresentation.split(separator: ".").count, 3)
    }

    func testTheReplyUsesTheFieldNamesRustReads() async throws {
        let transaction = try await purchased(Store.pro)
        let json = Reply(status: "purchased", transaction: transaction).json()
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: json) as? [String: Any])
        XCTAssertEqual(object["status"] as? String, "purchased")
        let fields = try XCTUnwrap(object["transaction"] as? [String: Any])
        XCTAssertEqual(
            Set(fields.keys),
            [
                "productId", "transactionId", "originalTransactionId", "bundleId", "purchaseDate",
                "originalPurchaseDate", "ownershipType", "environment", "jwsRepresentation",
            ])
        XCTAssertEqual((fields["transactionId"] as? NSNumber)?.uint64Value, transaction.transactionId)
    }

    func testTheTrialStartsAtItsPurchaseDate() async throws {
        let before = milliseconds(Date()) - 60_000
        let trial = try await purchased(Store.trial)
        let after = milliseconds(Date()) + 60_000
        XCTAssertEqual(trial.productId, Store.trial)
        XCTAssertTrue((before...after).contains(trial.originalPurchaseDate), "\(trial.originalPurchaseDate)")
        XCTAssertEqual(trial.purchaseDate, trial.originalPurchaseDate)

        session.clearTransactions()
        let tenDaysAgo = Date().addingTimeInterval(-10 * 24 * 3600)
        try await session.buyProduct(identifier: Store.trial, options: [.purchaseDate(tenDaysAgo)])
        let restored = try await entitlement(Store.trial)
        XCTAssertLessThan(abs(restored.originalPurchaseDate - milliseconds(tenDaysAgo)), 60_000)
    }

    func testAPurchaseIsACurrentEntitlementUntilItIsRefunded() async throws {
        let (updates, continuation) = AsyncStream<Reply>.makeStream()
        let listening = Store.listen { continuation.yield($0) }
        defer { listening.cancel() }
        let bought = try await purchased(Store.pro)
        let held = await Store.entitlements()
        XCTAssertEqual(held.transactions?.map(\.transactionId), [bought.transactionId])
        XCTAssertEqual(held.unverified, [])

        try session.refundTransaction(identifier: storeTransaction(Store.pro).identifier)
        let refunded = try await next(updates, continuation) { $0.transaction?.revocationDate != nil }
        XCTAssertEqual(refunded.status, "transaction")
        XCTAssertEqual(refunded.transaction?.transactionId, bought.transactionId)
        XCTAssertNotNil(refunded.transaction?.revocationReason)
        let after = await Store.entitlements()
        XCTAssertEqual(after.transactions?.map(\.productId), [])
    }

    func testAskToBuyIsPendingUntilApprovedThenArrivesAsAnUpdate() async throws {
        session.askToBuyEnabled = true
        let (updates, continuation) = AsyncStream<Reply>.makeStream()
        let listening = Store.listen { continuation.yield($0) }
        defer { listening.cancel() }
        let reply = await Store.purchase(Store.pro)
        XCTAssertEqual(reply.status, "pending")
        XCTAssertNil(reply.transaction)

        try session.approveAskToBuyTransaction(identifier: storeTransaction(Store.pro).identifier)
        let approved = try await next(updates, continuation) { $0.transaction?.productId == Store.pro }
        XCTAssertEqual(approved.status, "transaction")
        XCTAssertNil(approved.transaction?.revocationDate)
    }

    func testACancelledPurchaseIsCancelledNotAnError() async throws {
        try await session.setSimulatedError(.generic(.userCancelled), forAPI: .purchase)
        let reply = await Store.purchase(Store.pro)
        XCTAssertEqual(reply.status, "cancelled")
        XCTAssertNil(reply.code)
        let held = await Store.entitlements()
        XCTAssertEqual(held.transactions, [])
    }

    func testAFailedPurchaseIsOnlyItsCode() async throws {
        try await session.setSimulatedError(.generic(.networkError(URLError(.notConnectedToInternet))), forAPI: .purchase)
        let reply = await Store.purchase(Store.pro)
        XCTAssertEqual(reply, .error("E_APP_STORE_NETWORK"))
    }

    func testRestoreSyncsAndKeepsThePurchase() async throws {
        let bought = try await purchased(Store.pro)
        let reply = await Store.restore()
        XCTAssertEqual(reply.status, "synced", reply.code ?? "")
        let held = await Store.entitlements()
        XCTAssertEqual(held.transactions?.map(\.transactionId), [bought.transactionId])
    }

    func testFinishFindsTheUnfinishedTransactionOnce() async throws {
        let bought = try await purchased(Store.pro)
        let first = await Store.finish(bought.transactionId)
        XCTAssertEqual(first.status, "finished")
        let again = await Store.finish(bought.transactionId)
        XCTAssertEqual(again.status, "notFound")
    }

    // A purchase the bridge never handed to Rust, as after a relaunch between recording it and
    // finishing it: finish finds it among the unfinished transactions instead. The search runs on
    // its own, so a listener started by another test cannot hand the purchase over first.
    func testFinishFindsATransactionFromBeforeARelaunch() async throws {
        let id = try await session.buyProduct(identifier: Store.pro).id
        var answer = ""
        for _ in 0..<300 where answer != "finished" {
            answer = await Store.finishUnfinished(id).status
            if answer != "finished" { try await Task.sleep(nanoseconds: 100_000_000) }
        }
        XCTAssertEqual(answer, "finished")
        let again = await Store.finishUnfinished(id)
        XCTAssertEqual(again.status, "notFound")
    }

    func testOnlyTheTwoProductsCanBeBought() async {
        let reply = await Store.purchase("io.github.jma49.devot.other")
        XCTAssertEqual(reply, .error("E_APP_STORE_UNKNOWN_PRODUCT"))
    }

    func testTheCFunctionsReplyOnceWithTheirRequestNumber() async throws {
        devotStoreProducts(41, recordReply)
        let products = try await recorded(41)
        XCTAssertEqual(products["status"] as? String, "products")

        devotStorePurchase(42, nil, 0, recordReply)
        let refused = try await recorded(42)
        XCTAssertEqual(refused["code"] as? String, "E_APP_STORE_UNKNOWN_PRODUCT")

        let id = Array(Store.pro.utf8)
        id.withUnsafeBufferPointer { devotStorePurchase(43, $0.baseAddress, UInt($0.count), recordReply) }
        let bought = try await recorded(43)
        XCTAssertEqual(bought["status"] as? String, "purchased")
        XCTAssertEqual(replies.count(43), 1)
    }

    // The process's one listener: no other test starts it through the C function.
    func testTheCListenerStartsOnceAndTheOtherCFunctionsReply() async throws {
        XCTAssertTrue(devotStoreListen(recordUpdate))
        XCTAssertFalse(devotStoreListen(recordUpdate))
        session.askToBuyEnabled = true
        let pending = await Store.purchase(Store.pro)
        XCTAssertEqual(pending.status, "pending")
        try session.approveAskToBuyTransaction(identifier: storeTransaction(Store.pro).identifier)
        let update = try await recordedUpdate { ($0["transaction"] as? [String: Any])?["productId"] as? String == Store.pro }
        XCTAssertEqual(update["status"] as? String, "transaction")
        let fields = try XCTUnwrap(update["transaction"] as? [String: Any])
        let id = try XCTUnwrap((fields["transactionId"] as? NSNumber)?.uint64Value)

        devotStoreEntitlements(51, recordReply)
        let held = try await recorded(51)
        XCTAssertEqual(held["status"] as? String, "entitlements")
        let transactions = try XCTUnwrap(held["transactions"] as? [[String: Any]])
        XCTAssertEqual(transactions.compactMap { ($0["transactionId"] as? NSNumber)?.uint64Value }, [id])

        devotStoreRestore(52, recordReply)
        let restored = try await recorded(52)
        XCTAssertEqual(restored["status"] as? String, "synced")

        devotStoreFinish(53, id, recordReply)
        let finished = try await recorded(53)
        XCTAssertEqual(finished["status"] as? String, "finished")
        devotStoreFinish(54, id, recordReply)
        let again = try await recorded(54)
        XCTAssertEqual(again["status"] as? String, "notFound")
        for request: UInt64 in 51...54 { XCTAssertEqual(replies.count(request), 1) }
    }

    private func recordedUpdate(where match: ([String: Any]) -> Bool) async throws -> [String: Any] {
        for _ in 0..<300 {
            for json in listened.all() {
                if let object = try JSONSerialization.jsonObject(with: json) as? [String: Any], match(object) {
                    return object
                }
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("no matching update within 30 s")
        throw CancellationError()
    }

    private func next(
        _ updates: AsyncStream<Reply>, _ continuation: AsyncStream<Reply>.Continuation,
        where match: @escaping (Reply) -> Bool
    ) async throws -> Reply {
        let timeout = Task {
            try await Task.sleep(nanoseconds: 30_000_000_000)
            continuation.finish()
        }
        defer { timeout.cancel() }
        for await update in updates where match(update) {
            return update
        }
        XCTFail("no matching transaction update within 30 s")
        throw CancellationError()
    }

    // A purchase made with session.buyProduct reaches the entitlements after the call returns,
    // and never as an update.
    private func entitlement(_ productID: String) async throws -> TransactionReply {
        for _ in 0..<300 {
            if let held = await Store.entitlements().transactions?.first(where: { $0.productId == productID }) {
                return held
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("no entitlement to \(productID) within 30 s")
        throw CancellationError()
    }

    private func recorded(_ request: UInt64) async throws -> [String: Any] {
        for _ in 0..<300 {
            if let json = replies.first(request) {
                return try XCTUnwrap(try JSONSerialization.jsonObject(with: json) as? [String: Any])
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("no reply to request \(request) within 30 s")
        throw CancellationError()
    }
}

final class Replies: @unchecked Sendable {
    private let lock = NSLock()
    private var received: [(UInt64, Data)] = []

    func add(_ request: UInt64, _ json: Data) {
        lock.lock()
        defer { lock.unlock() }
        received.append((request, json))
    }

    func first(_ request: UInt64) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return received.first { $0.0 == request }?.1
    }

    func all() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return received.map(\.1)
    }

    func count(_ request: UInt64) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return received.filter { $0.0 == request }.count
    }
}

let replies = Replies()

let listened = Replies()

let recordUpdate: DevotStoreUpdate = { json, length in
    listened.add(0, json.map { Data(bytes: $0, count: Int(length)) } ?? Data())
}

let recordReply: DevotStoreReply = { request, json, length in
    let data = json.map { Data(bytes: $0, count: Int(length)) } ?? Data()
    replies.add(request, data)
}
