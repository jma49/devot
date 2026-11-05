import Foundation
import StoreKit

/// StoreKit 2's side of the bridge. Each call gives one reply and never throws: every failure is a
/// code. It decides nothing; Rust reads the replies and applies the entitlement rules.
enum Store {
    static let pro = "io.github.jma49.devot.pro"
    static let trial = "io.github.jma49.devot.trial"
    static let productIDs = [pro, trial]

    // A purchase is missing from Transaction.unfinished for a while after it returns, so finish
    // looks first among the transactions this bridge has handed to Rust.
    private static let handed = Handed()

    static func products() async -> Reply {
        do {
            let products = try await Product.products(for: productIDs)
            return Reply(
                status: "products",
                products: products.map {
                    ProductReply(id: $0.id, displayName: $0.displayName, displayPrice: $0.displayPrice)
                }
            )
        } catch {
            return .error(errorCode(error))
        }
    }

    static func purchase(_ productID: String) async -> Reply {
        guard productIDs.contains(productID) else { return .error("E_APP_STORE_UNKNOWN_PRODUCT") }
        do {
            guard let product = try await Product.products(for: [productID]).first else {
                return .error("E_APP_STORE_PRODUCT_NOT_FOUND")
            }
            switch try await product.purchase() {
            case .success(let result):
                switch Checked(result) {
                case .verified(let transaction, let reply):
                    await handed.keep(transaction)
                    return Reply(status: "purchased", transaction: reply)
                case .unverified(let code): return Reply(status: "unverified", code: code)
                }
            case .pending:
                return Reply(status: "pending")
            case .userCancelled:
                return Reply(status: "cancelled")
            @unknown default:
                return .error("E_APP_STORE_UNKNOWN")
            }
        } catch {
            return isUserCancel(error) ? Reply(status: "cancelled") : .error(errorCode(error))
        }
    }

    static func restore() async -> Reply {
        do {
            try await AppStore.sync()
            return Reply(status: "synced")
        } catch {
            return isUserCancel(error) ? Reply(status: "cancelled") : .error(errorCode(error))
        }
    }

    static func entitlements() async -> Reply {
        var transactions: [TransactionReply] = []
        var unverified: [String] = []
        for await result in Transaction.currentEntitlements {
            switch Checked(result) {
            case .verified(_, let reply): transactions.append(reply)
            case .unverified(let code): unverified.append(code)
            }
        }
        return Reply(status: "entitlements", transactions: transactions, unverified: unverified)
    }

    /// Finishes the unfinished verified transaction with this ID, if there is one.
    static func finish(_ transactionID: UInt64) async -> Reply {
        if let transaction = await handed.take(transactionID) {
            await transaction.finish()
            return Reply(status: "finished")
        }
        return await finishUnfinished(transactionID)
    }

    /// Finish's search of `Transaction.unfinished`, for a transaction this bridge never handed over.
    static func finishUnfinished(_ transactionID: UInt64) async -> Reply {
        for await result in Transaction.unfinished {
            if case .verified(let transaction, _) = Checked(result), transaction.id == transactionID {
                await transaction.finish()
                return Reply(status: "finished")
            }
        }
        return Reply(status: "notFound")
    }

    static func update(_ result: VerificationResult<Transaction>) -> Reply {
        switch Checked(result) {
        case .verified(_, let reply): return Reply(status: "transaction", transaction: reply)
        case .unverified(let code): return Reply(status: "unverified", code: code)
        }
    }

    /// Delivers every transaction update until the task is cancelled.
    static func listen(_ deliver: @escaping @Sendable (Reply) -> Void) -> Task<Void, Never> {
        Task.detached {
            for await result in Transaction.updates {
                if case .verified(let transaction) = result { await handed.keep(transaction) }
                deliver(update(result))
            }
        }
    }
}

private actor Handed {
    private var transactions: [UInt64: Transaction] = [:]

    func keep(_ transaction: Transaction) { transactions[transaction.id] = transaction }

    func take(_ id: UInt64) -> Transaction? { transactions.removeValue(forKey: id) }
}
