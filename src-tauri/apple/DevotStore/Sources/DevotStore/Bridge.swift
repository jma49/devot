import Foundation

// The C functions src-tauri/src/native/ios.rs declares. Each starts a task and returns at once,
// from any thread. The task calls `reply` exactly once, on a thread of its own, with the caller's
// request number and the reply's UTF-8 JSON. That buffer is Swift's: it stays valid until `reply`
// returns, Rust copies it, and Swift frees it afterwards.

public typealias DevotStoreReply = @convention(c) (UInt64, UnsafePointer<UInt8>?, UInt) -> Void
public typealias DevotStoreUpdate = @convention(c) (UnsafePointer<UInt8>?, UInt) -> Void

/// A C function pointer holds no state, so any thread may call it.
struct Callback<Function>: @unchecked Sendable {
    let function: Function
}

func send(_ reply: Reply, as request: UInt64, to callback: DevotStoreReply) {
    reply.json().withUnsafeBytes { bytes in
        callback(request, bytes.bindMemory(to: UInt8.self).baseAddress, UInt(bytes.count))
    }
}

func reply(_ request: UInt64, _ callback: DevotStoreReply, with work: @escaping @Sendable () async -> Reply) {
    let callback = Callback(function: callback)
    Task.detached {
        send(await work(), as: request, to: callback.function)
    }
}

@_cdecl("devot_store_products")
public func devotStoreProducts(_ request: UInt64, _ callback: DevotStoreReply) {
    reply(request, callback) { await Store.products() }
}

/// The product ID is copied before this returns, so the caller's buffer may go right after.
@_cdecl("devot_store_purchase")
public func devotStorePurchase(
    _ request: UInt64, _ productID: UnsafePointer<UInt8>?, _ length: UInt, _ callback: DevotStoreReply
) {
    guard let productID, length > 0, length <= 256 else {
        reply(request, callback) { .error("E_APP_STORE_UNKNOWN_PRODUCT") }
        return
    }
    let id = String(decoding: UnsafeBufferPointer(start: productID, count: Int(length)), as: UTF8.self)
    reply(request, callback) { await Store.purchase(id) }
}

@_cdecl("devot_store_restore")
public func devotStoreRestore(_ request: UInt64, _ callback: DevotStoreReply) {
    reply(request, callback) { await Store.restore() }
}

@_cdecl("devot_store_entitlements")
public func devotStoreEntitlements(_ request: UInt64, _ callback: DevotStoreReply) {
    reply(request, callback) { await Store.entitlements() }
}

@_cdecl("devot_store_finish")
public func devotStoreFinish(_ request: UInt64, _ transactionID: UInt64, _ callback: DevotStoreReply) {
    reply(request, callback) { await Store.finish(transactionID) }
}

final class Listener: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    /// Starts the one listener of the process; `false` when it runs already.
    func start(_ deliver: @escaping @Sendable (Reply) -> Void) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard task == nil else { return false }
        task = Store.listen(deliver)
        return true
    }
}

let listener = Listener()

/// Starts StoreKit's transaction listener for the life of the process; `false` when it runs already.
@_cdecl("devot_store_listen")
public func devotStoreListen(_ callback: DevotStoreUpdate) -> Bool {
    let callback = Callback(function: callback)
    return listener.start { update in
        update.json().withUnsafeBytes { bytes in
            callback.function(bytes.bindMemory(to: UInt8.self).baseAddress, UInt(bytes.count))
        }
    }
}
