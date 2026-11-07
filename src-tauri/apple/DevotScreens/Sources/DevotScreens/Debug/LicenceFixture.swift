#if DEBUG
    import Foundation

    /// A locked licence the iPhone UI tests launch with (`-DevotLicenceFixture K1`), named as in
    /// tests/fixtures/licence-gate.json. Only the snapshot changes, so the gate shows its surface;
    /// Rust, which a debug build does not gate, still takes every write.
    enum LicenceFixture {
        static let argument = "DevotLicenceFixture"

        static var launched: Licence? {
            UserDefaults.standard.string(forKey: argument).flatMap(named)
        }

        static func named(_ name: String) -> Licence? {
            let ended = Licence.Trial(state: "ended", endsAt: 1000, code: nil)
            let store = Licence.AppStore(pro: false, code: nil, takesKeys: true)
            switch name {
            case "A1":
                return Licence(
                    gated: true, state: "none", trial: Licence.Trial(state: "available", endsAt: nil, code: nil),
                    appStore: store)
            case "A2": return Licence(gated: true, state: "none", trial: ended, appStore: store)
            case "A3":
                return Licence(
                    gated: true, state: "none", trial: ended,
                    appStore: Licence.AppStore(pro: false, code: Licence.unread, takesKeys: true))
            case "K1": return Licence(gated: true, state: "none", trial: ended)
            case "K2": return Licence(gated: true, state: "revoked", id: "lic_1", trial: ended)
            case "X1": return Licence(gated: true, state: "none", code: ProGate.unreadable, trial: ended)
            default: return nil
            }
        }
    }
#endif
