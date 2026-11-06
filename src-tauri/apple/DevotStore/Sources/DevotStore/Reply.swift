import Foundation
import StoreKit

// The JSON each call replies with; src-tauri/src/app_store/payload.rs reads it. `status` names the
// outcome. Dates are milliseconds since the Unix epoch. Only codes describe a failure: no error
// description, which could carry account details, ever leaves Swift.

struct ProductReply: Encodable, Equatable {
    let id: String
    let displayName: String
    let displayPrice: String
}

struct TransactionReply: Encodable, Equatable {
    let productId: String
    let transactionId: UInt64
    let originalTransactionId: UInt64
    let bundleId: String
    let purchaseDate: Int64
    let originalPurchaseDate: Int64
    let revocationDate: Int64?
    let revocationReason: String?
    let ownershipType: String
    let environment: String
    let jwsRepresentation: String
}

struct Reply: Encodable, Equatable {
    var status: String
    var code: String?
    var products: [ProductReply]?
    var transaction: TransactionReply?
    var transactions: [TransactionReply]?
    var unverified: [String]?

    static func error(_ code: String) -> Reply { Reply(status: "error", code: code) }

    func json() -> Data {
        // Every field is a string, a number or an array of them, so encoding cannot fail; the
        // fallback is still a reply Rust reads as a code.
        (try? JSONEncoder().encode(self)) ?? Data(#"{"status":"error","code":"E_APP_STORE_UNKNOWN"}"#.utf8)
    }
}

func milliseconds(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1000).rounded())
}

extension TransactionReply {
    init(_ transaction: Transaction, jws: String) {
        let reason: String?
        switch transaction.revocationReason {
        case nil: reason = nil
        case .developerIssue?: reason = "developerIssue"
        case .other?: reason = "other"
        default: reason = "unknown"
        }
        self.init(
            productId: transaction.productID,
            transactionId: transaction.id,
            originalTransactionId: transaction.originalID,
            bundleId: transaction.appBundleID,
            purchaseDate: milliseconds(transaction.purchaseDate),
            originalPurchaseDate: milliseconds(transaction.originalPurchaseDate),
            revocationDate: transaction.revocationDate.map(milliseconds),
            revocationReason: reason,
            ownershipType: transaction.ownershipType.rawValue,
            environment: environmentName(transaction),
            jwsRepresentation: jws
        )
    }
}

private func environmentName(_ transaction: Transaction) -> String {
    if #available(iOS 16.0, macOS 13.0, *) {
        return transaction.environment.rawValue
    }
    return transaction.environmentStringRepresentation
}

/// A verified transaction's reply fields, or the code of why StoreKit could not verify it.
enum Checked {
    case verified(Transaction, TransactionReply)
    case unverified(String)

    init(_ result: VerificationResult<Transaction>) {
        switch result {
        case .verified(let transaction):
            self = .verified(transaction, TransactionReply(transaction, jws: result.jwsRepresentation))
        case .unverified(_, let error):
            self = .unverified(unverifiedCode(error))
        }
    }
}

func unverifiedCode(_ error: VerificationResult<Transaction>.VerificationError) -> String {
    switch error {
    case .revokedCertificate: return "E_APP_STORE_UNVERIFIED_REVOKED_CERTIFICATE"
    case .invalidCertificateChain: return "E_APP_STORE_UNVERIFIED_CERTIFICATE_CHAIN"
    case .invalidDeviceVerification: return "E_APP_STORE_UNVERIFIED_DEVICE"
    case .invalidEncoding: return "E_APP_STORE_UNVERIFIED_ENCODING"
    case .invalidSignature: return "E_APP_STORE_UNVERIFIED_SIGNATURE"
    case .missingRequiredProperties: return "E_APP_STORE_UNVERIFIED_MISSING_PROPERTIES"
    @unknown default: return "E_APP_STORE_UNVERIFIED"
    }
}

/// The code of a StoreKit failure; a user cancel is not a failure and is handled before this.
func errorCode(_ error: Error) -> String {
    if let error = error as? StoreKitError {
        switch error {
        case .networkError: return "E_APP_STORE_NETWORK"
        case .systemError: return "E_APP_STORE_SYSTEM"
        case .notAvailableInStorefront: return "E_APP_STORE_NOT_AVAILABLE"
        case .notEntitled: return "E_APP_STORE_NOT_ENTITLED"
        default: return "E_APP_STORE_UNKNOWN"
        }
    }
    if let error = error as? Product.PurchaseError {
        switch error {
        case .productUnavailable: return "E_APP_STORE_PRODUCT_UNAVAILABLE"
        case .purchaseNotAllowed: return "E_APP_STORE_PURCHASE_NOT_ALLOWED"
        default: return "E_APP_STORE_PURCHASE_FAILED"
        }
    }
    return "E_APP_STORE_UNKNOWN"
}

func refundReply(_ status: Transaction.RefundRequestStatus) -> Reply {
    switch status {
    case .success: return Reply(status: "refundRequested")
    case .userCancelled: return Reply(status: "cancelled")
    @unknown default: return .error("E_APP_STORE_UNKNOWN")
    }
}

func refundCode(_ error: Error) -> String {
    if let error = error as? Transaction.RefundRequestError {
        switch error {
        case .duplicateRequest: return "E_APP_STORE_REFUND_DUPLICATE"
        default: return "E_APP_STORE_REFUND_FAILED"
        }
    }
    return errorCode(error)
}

func isUserCancel(_ error: Error) -> Bool {
    if case .userCancelled? = error as? StoreKitError { return true }
    return false
}
