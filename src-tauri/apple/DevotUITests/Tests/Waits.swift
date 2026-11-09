import Foundation

/// The waits are sized on an idle simulator; a CI runner, whose load stays in the hundreds on three
/// cores, stretches every step, and the tests that failed there failed on a wait. CI multiplies them
/// (`DEVOT_UI_WAIT_SCALE`, scripts/ci/iphone-ui-tests.sh); a passing test never waits longer for it.
let waitScale: TimeInterval = {
    let scale = Double(ProcessInfo.processInfo.environment["DEVOT_UI_WAIT_SCALE"] ?? "") ?? 1
    return scale >= 1 ? scale : 1
}()

func waitLimit(_ seconds: TimeInterval) -> TimeInterval { seconds * waitScale }

/// Polls `condition` until it holds or `timeout` seconds (scaled) pass.
@MainActor
func waitUntil(_ condition: () -> Bool, timeout: TimeInterval = 5) -> Bool {
    let deadline = Date().addingTimeInterval(waitLimit(timeout))
    while !condition(), Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return condition()
}
