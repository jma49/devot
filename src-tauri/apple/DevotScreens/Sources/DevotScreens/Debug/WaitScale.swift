#if DEBUG
    import Foundation

    /// The UI tests' wait scale (`-DevotWaitScale 3`, from `DEVOT_UI_WAIT_SCALE`): a loaded CI
    /// simulator stretches each of XCTest's steps, so a time the app gives the user to act, which a
    /// test acts within, is stretched by the same factor.
    enum WaitScale {
        static var launched: TimeInterval {
            max(1, UserDefaults.standard.double(forKey: LaunchArgument.waitScale))
        }
    }
#endif
