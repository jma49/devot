import XCTest

@testable import DevotScreens

/// The gate against the licence states the page's gate is held to too
/// (tests/fixtures/licence-gate.json), and the held intent's one run after an unlock.
@MainActor
final class ProGateTests: XCTestCase {
    private struct State {
        let name: String
        let licence: Licence
        let surface: LockSurface?
    }

    private func states() throws -> [State] {
        let url = try XCTUnwrap(Bundle(for: ProGateTests.self).url(forResource: "licence-gate", withExtension: "json"))
        let root = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        guard case .array(let rows)? = root["states"] else { throw XCTSkip("no states") }
        let headings = ["phone.pro.inactiveTitle": L10n.phoneProInactiveTitle(), "phone.purchase.ended": L10n.phonePurchaseEnded()]
        return try rows.map { row in
            let name = try XCTUnwrap(row["name"]?.string)
            let licence = try XCTUnwrap(row["licence"].flatMap { Licence($0) }, name)
            let surface: LockSurface? =
                switch row["surface"]?.string {
                case "purchase": .purchase(heading: try XCTUnwrap(row["heading"]?.string.flatMap { headings[$0] }, name))
                case "pro": .pro(try XCTUnwrap(row["sheet"]?.string.flatMap(ProSheetKind.init), name))
                default: nil
                }
            return State(name: name, licence: licence, surface: surface)
        }
    }

    private var now = Date(timeIntervalSince1970: 1_800_000_000)
    private var licence: Licence?
    private var shown: [LockSurface] = []
    private var performed: [WriteIntent] = []
    private var refreshes = 0

    private func gate() -> ProGate {
        let gate = ProGate { [unowned self] in licence }
        gate.now = { [unowned self] in now }
        gate.present = { [unowned self] in shown.append($0) }
        gate.refresh = { [unowned self] done in
            refreshes += 1
            done()
        }
        gate.perform = { [unowned self] in performed.append($0) }
        return gate
    }

    private let k1 = Licence(gated: true, state: "none", trial: Licence.Trial(state: "ended", endsAt: 1000, code: nil))
    private let pro = Licence(gated: true, state: "valid", id: "lic_1")
    private let intent = WriteIntent.newNote(bookId: "01970000-0000-7000-8000-0000000000b1")

    func testEveryLicenceStateShowsTheSurfaceThePageShows() throws {
        let states = try states()
        XCTAssertEqual(states.map(\.name), ["A1", "A2", "A3", "K1", "K2", "K2-seat", "X1", "P1", "F1"])
        for state in states {
            XCTAssertEqual(state.licence.allows(now), state.surface == nil, state.name)
            if let surface = state.surface { XCTAssertEqual(LockSurface(state.licence), surface, state.name) }
        }
    }

    func testEveryStateRunsTheWriteOrShowsOneSurfaceAndHoldsIt() throws {
        for state in try states() {
            licence = state.licence
            shown = []
            performed = []
            let gate = gate()
            gate.require(intent)
            XCTAssertEqual(shown, state.surface.map { [$0] } ?? [], state.name)
            XCTAssertEqual(performed, state.surface == nil ? [intent] : [], state.name)
            XCTAssertEqual(gate.holding, state.surface == nil ? nil : intent, state.name)
        }
    }

    func testTheSheetsWordsNameNoCodeAndNoPrice() {
        for kind in ProSheetKind.allCases {
            for text in ProSheetContent(kind).strings {
                XCTAssertFalse(text.isEmpty, kind.rawValue)
                XCTAssertFalse(text.contains("E_"), kind.rawValue)
                XCTAssertFalse(text.contains("$"), kind.rawValue)
            }
        }
        XCTAssertEqual(ProSheetKind.allCases.filter { ProSheetContent($0).restores }, [.checking])
    }

    func testANilSnapshotLetsTheWriteGoToRust() {
        let gate = gate()
        gate.require(intent)
        XCTAssertEqual(performed, [intent])
        XCTAssertEqual(shown, [])
    }

    func testASecondTapWhileTheSheetIsUpShowsNoSecondSheet() {
        licence = k1
        let gate = gate()
        gate.require(intent)
        gate.require(.newNote(bookId: nil))
        XCTAssertEqual(shown, [.pro(.key)])
        XCTAssertEqual(gate.holding, intent)
    }

    func testAnUnlockRunsTheHeldIntentOnceAfterTheSheetHasGoneAndThroughTheGateAgain() {
        licence = k1
        let gate = gate()
        gate.require(intent)
        licence = pro
        gate.unlocked()
        XCTAssertEqual(performed, [], "nothing runs under a sheet that is still up")
        gate.dismissed()
        XCTAssertEqual(performed, [intent])
        XCTAssertEqual(refreshes, 1, "the licence is read again before the intent runs")
        XCTAssertNil(gate.holding)
        gate.dismissed()
        XCTAssertEqual(performed, [intent])
    }

    func testAnUnlockTheFreshReadDoesNotConfirmShowsTheSurfaceAgain() {
        licence = k1
        let gate = gate()
        gate.require(intent)
        gate.unlocked()
        gate.dismissed()
        XCTAssertEqual(performed, [])
        XCTAssertEqual(shown, [.pro(.key), .pro(.key)])
    }

    func testALicenceChangeThatUnlocksClosesTheSurfaceAndTheIntentRunsOnceThroughTheGate() {
        licence = k1
        let gate = gate()
        var closes = 0
        gate.dismiss = { closes += 1 }
        gate.require(intent)
        licence = pro
        gate.licenceChanged()
        XCTAssertEqual(closes, 1)
        XCTAssertEqual(performed, [], "nothing runs under a sheet that is still up")
        gate.dismissed()
        XCTAssertEqual(performed, [intent])
        XCTAssertEqual(refreshes, 1)
        gate.licenceChanged()
        XCTAssertEqual(closes, 1, "no surface is up any more")
    }

    func testALicenceChangeThatStillLocksKeepsTheSurface() {
        licence = k1
        let gate = gate()
        var closes = 0
        gate.dismiss = { closes += 1 }
        gate.require(intent)
        gate.licenceChanged()
        XCTAssertEqual(closes, 0)
        XCTAssertEqual(gate.holding, intent)
        gate.dismissed()
        XCTAssertEqual(performed, [], "Not Now drops it")
    }

    func testAnUnlockAfterTheSurfaceWentLeavesNothingForALaterOne() {
        licence = k1
        let gate = gate()
        gate.require(intent)
        gate.dismissed()
        gate.unlocked()
        gate.require(intent)
        gate.dismissed()
        XCTAssertEqual(refreshes, 0)
        XCTAssertEqual(shown, [.pro(.key), .pro(.key)], "a declined surface does not come back on its own")
        XCTAssertEqual(performed, [])
    }

    func testTheIntentIsDroppedWithoutAnUnlock() {
        licence = k1
        let gate = gate()
        gate.require(intent)
        licence = pro
        gate.dismissed()
        XCTAssertEqual(performed, [])
        XCTAssertNil(gate.holding)
        XCTAssertFalse(gate.showing)
    }

    func testTheIntentIsDroppedWhenTheAppLeavesTheForeground() {
        licence = k1
        let gate = gate()
        gate.require(intent)
        gate.unlocked()
        gate.drop()
        licence = pro
        gate.dismissed()
        XCTAssertEqual(performed, [])
    }

    func testTheIntentIsDroppedAfterTenMinutes() {
        licence = k1
        let gate = gate()
        gate.require(intent)
        licence = pro
        gate.unlocked()
        now += ProGate.intentLifetime
        gate.dismissed()
        XCTAssertEqual(performed, [])
    }

    func testARefusedWriteShowsTheSurfaceFromAFreshReadWithNothingHeld() {
        licence = pro
        let gate = gate()
        licence = k1
        gate.refused(code: ProGate.required)
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(shown, [.pro(.key)])
        XCTAssertNil(gate.holding)
        gate.unlocked()
        licence = pro
        gate.dismissed()
        XCTAssertEqual(performed, [], "a refused write is never run again on its own")
    }

    func testAnUnreadableLicenceRefusalShowsTheUnreadableSheet() {
        licence = pro
        let gate = gate()
        gate.refused(code: ProGate.unreadable)
        XCTAssertEqual(shown, [.pro(.unreadable)])
    }

    func testARefusalWhileASheetIsUpShowsNoSecondSheet() {
        licence = k1
        let gate = gate()
        gate.require(intent)
        gate.refused(code: ProGate.required)
        XCTAssertEqual(shown, [.pro(.key)])
    }
}
