import Foundation
import Observation

/// The licence as Rust last reported it (`direct.licence.get`), shared by Settings and the gate.
/// It is read each time the app becomes active (its launch included), when Rust says the licence
/// changed and when Settings shows. It is only the UI's guess: Rust is the lock on every write.
@Observable
@MainActor
final class LicenceSnapshotStore {
    @ObservationIgnored weak var bridge: (any SettingsBridge)?
    private(set) var licence: Licence?

    init() {
        #if DEBUG
            licence = LicenceFixture.launched
        #endif
    }

    func adopt(_ value: JSONValue) {
        #if DEBUG
            if let fixed = LicenceFixture.launched {
                licence = fixed
                return
            }
        #endif
        if let next = Licence(value) { licence = next }
    }

    func read(done: @escaping () -> Void = {}) {
        guard let bridge else { return done() }
        bridge.direct(.licenceGet, [:]) { [weak self] outcome in
            switch outcome {
            case .ok(let value): self?.adopt(value)
            case .failed(let code): self?.bridge?.log(.warn, "W_LICENCE_READ_FAILED code=\(code)")
            }
            done()
        }
    }
}
