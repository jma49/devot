@testable import DevotScreens

/// Stands in for `Screens`: holds every request until the test answers it.
@MainActor
final class FakeBridge: SettingsBridge {
    struct Sent {
        let op: String
        let args: [String: JSONValue]
        let done: (Outcome) -> Void
    }

    var sent: [Sent] = []
    var lines: [String] = []

    func direct(_ op: DirectOp, _ args: [String: JSONValue], done: @escaping (Outcome) -> Void) {
        sent.append(Sent(op: op.rawValue, args: args, done: done))
    }

    func request(_ op: Op, _ args: [String: JSONValue], done: @escaping (Outcome) -> Void) {
        sent.append(Sent(op: op.rawValue, args: args, done: done))
    }

    func log(_ level: LogLevel, _ line: String) {
        lines.append(line)
    }

    var ops: [String] { sent.map(\.op) }

    /// Answers the oldest request for `op`.
    func answer(_ op: String, _ outcome: Outcome) {
        guard let index = sent.firstIndex(where: { $0.op == op }) else { return }
        sent.remove(at: index).done(outcome)
    }
}
