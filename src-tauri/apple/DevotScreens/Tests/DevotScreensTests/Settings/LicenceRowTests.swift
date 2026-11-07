import XCTest

@testable import DevotScreens

/// The License row's value and mark, as `settingsRows.test.ts` checks the page's.
@MainActor
final class LicenceRowTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func read(_ fields: [String: JSONValue]) throws -> Licence {
        try XCTUnwrap(Licence(.object(fields)))
    }

    func testAValidLicenceOrDevotProShowsProWithoutAMark() throws {
        let valid = try read(["gated": .bool(true), "state": .string("valid")])
        XCTAssertEqual(valid.row(now).label, L10n.phoneSettingsLicencePro())
        XCTAssertFalse(valid.row(now).attention)
        let pro = try read(["gated": .bool(true), "state": .string("none"), "appStore": .object(["pro": .bool(true)])])
        XCTAssertEqual(pro.row(now).label, L10n.phoneSettingsLicencePro())
        XCTAssertTrue(pro.allows(now))
    }

    func testARunningTrialCountsItsDaysAndMarksTheLastThree() throws {
        let ends = { (days: Double) in
            try self.read([
                "gated": .bool(true), "state": .string("none"),
                "trial": .object([
                    "state": .string("running"), "endsAt": .number(self.now.milliseconds + days * Licence.dayMs),
                ]),
            ])
        }
        XCTAssertEqual(try ends(10).row(now).label, L10n.phoneSettingsLicenceTrialDays(days: "10"))
        XCTAssertFalse(try ends(10).row(now).attention)
        XCTAssertTrue(try ends(2.5).row(now).attention)
        XCTAssertTrue(try ends(2.5).trialRunning(now))
        XCTAssertFalse(try ends(-1).trialRunning(now))
    }

    func testAnEndedTrialLocksEditingAndMarksTheRow() throws {
        let ended = try read(["gated": .bool(true), "state": .string("none")])
        XCTAssertEqual(ended.trial?.state, "ended")
        XCTAssertFalse(ended.allows(now))
        XCTAssertTrue(ended.trialOver(now))
        XCTAssertEqual(ended.row(now).label, L10n.phoneSettingsLicenceAttention())
        XCTAssertTrue(ended.row(now).attention)
    }

    func testAnUngatedBuildIsFreeAndAnUnreadEntitlementIsBeingChecked() throws {
        XCTAssertEqual(try read(["gated": .bool(false), "state": .string("none")]).row(now).label, L10n.phoneSettingsLicenceFree())
        let unread = try read([
            "gated": .bool(true), "state": .string("none"), "appStore": .object(["code": .string(Licence.unread)]),
        ])
        XCTAssertEqual(unread.row(now).label, L10n.phoneSettingsLicenceChecking())
    }

    func testRefusesASnapshotItCannotRead() {
        XCTAssertNil(Licence(.object(["gated": .bool(true), "state": .string("odd")])))
        XCTAssertNil(Licence(.object(["state": .string("none")])))
    }

    func testRefundAndRestoreValuesNameTheProblemNotItsCode() {
        XCTAssertEqual(Refunding.failed("E_APP_STORE_REFUND_DUPLICATE").text, L10n.phoneSettingsRefundDuplicate())
        XCTAssertEqual(Refunding.failed("E_APP_STORE_NETWORK").text, L10n.phoneSettingsRefundOffline())
        XCTAssertEqual(Refunding.failed("E_OTHER").text, L10n.phoneSettingsRefundFailed())
        XCTAssertFalse(Restoring.failed("E_APP_STORE_NO_REPLY").text.contains("E_"))
    }
}
