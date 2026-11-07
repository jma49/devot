import Foundation

// The C functions src-tauri/src/native/ios/screens.rs declares, and the Rust functions it hands
// over at install, so Rust exports no symbol. A buffer passed either way is valid only until the
// call that received it returns: each side copies it first.

public typealias DevotScreensReply = @convention(c) (UInt64, UnsafePointer<UInt8>?, UInt) -> Void
public typealias DevotScreensCall = @convention(c) (
    UInt64, UnsafePointer<UInt8>?, UInt, DevotScreensReply
) -> Void
public typealias DevotScreensLog = @convention(c) (UInt8, UnsafePointer<UInt8>?, UInt) -> Void

private func copied(_ bytes: UnsafePointer<UInt8>?, _ length: UInt) -> Data? {
    guard let bytes, length > 0, length <= UInt(Message.maxBytes) else { return nil }
    return Data(bytes: bytes, count: Int(length))
}

/// Rust answers from any thread, sometimes before `call` has returned.
private func replied(_ request: UInt64, _ json: UnsafePointer<UInt8>?, _ length: UInt) {
    let data = copied(json, length)
    DispatchQueue.main.async {
        MainActor.assumeIsolated { Screens.shared?.replied(request, data) }
    }
}

struct Rust: RustSide {
    let callFunction: DevotScreensCall
    let logFunction: DevotScreensLog

    func call(_ request: UInt64, _ json: Data) {
        json.withUnsafeBytes { bytes in
            callFunction(
                request, bytes.bindMemory(to: UInt8.self).baseAddress, UInt(bytes.count), replied)
        }
    }

    func log(_ level: LogLevel, _ line: String) {
        var line = line
        line.withUTF8 { bytes in logFunction(level.rawValue, bytes.baseAddress, UInt(bytes.count)) }
    }
}

/// Rust calls this once, on the main thread, with the window's WKWebView and tao's root view
/// controller; `false` keeps the web shell.
@_cdecl("devot_screens_install")
public func devotScreensInstall(
    _ webView: UnsafeMutableRawPointer?, _ root: UnsafeMutableRawPointer?,
    _ call: DevotScreensCall, _ log: DevotScreensLog
) -> Bool {
    let rust = Rust(callFunction: call, logFunction: log)
    guard Thread.isMainThread else {
        rust.log(.error, "E_SCREENS_INSTALL_OFF_MAIN")
        return false
    }
    guard let webView, let root else {
        rust.log(.warn, "W_SCREENS_INSTALL_REFUSED reason=null")
        return false
    }
    // Both are UIKit objects that only the main thread touches, which this is.
    nonisolated(unsafe) let view = Unmanaged<AnyObject>.fromOpaque(webView).takeUnretainedValue()
    nonisolated(unsafe) let controller = Unmanaged<AnyObject>.fromOpaque(root).takeUnretainedValue()
    return MainActor.assumeIsolated {
        guard Screens.shared == nil else {
            rust.log(.warn, "W_SCREENS_INSTALL_REFUSED reason=twice")
            return false
        }
        Screens.shared = Screens.attach(webView: view, root: controller, rust: rust)
        return Screens.shared != nil
    }
}

/// A notice from the page, which Rust has checked.
@_cdecl("devot_screens_deliver")
public func devotScreensDeliver(_ json: UnsafePointer<UInt8>?, _ length: UInt) {
    let data = copied(json, length)
    DispatchQueue.main.async {
        MainActor.assumeIsolated { Screens.shared?.delivered(data) }
    }
}
