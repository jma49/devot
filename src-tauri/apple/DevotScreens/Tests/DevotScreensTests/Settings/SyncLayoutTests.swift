import XCTest

@testable import DevotScreens

/// The page's phone layout of Sync: tests/fixtures/sync-pane.json holds what each group shows.
@MainActor
final class SyncLayoutTests: XCTestCase {
    private struct Shared: Decodable {
        struct Case: Decodable {
            struct Group: Decodable {
                let labels: [String]
                let notes: [String]
                let footer: String?
            }

            let name: String
            let snapshot: JSONValue
            let icloud: JSONValue
            let usage: JSONValue?
            let devices: JSONValue
            let sections: [Group]
        }

        let cases: [Case]
    }

    private func upToPlaceholder(_ key: String) -> String {
        String(catalog(key).prefix { $0 != "{" })
    }

    func testEachGroupShowsWhatThePagesPhoneLayoutShows() throws {
        let url = try XCTUnwrap(Bundle(for: SyncLayoutTests.self).url(forResource: "sync-pane", withExtension: "json"))
        let shared = try JSONDecoder().decode(Shared.self, from: Data(contentsOf: url))
        XCTAssertFalse(shared.cases.isEmpty)
        for c in shared.cases {
            let snapshot = try XCTUnwrap(SyncSnapshot(c.snapshot), c.name)
            var input = SyncLayout.Input(snapshot: snapshot, icloud: ICloudStatus(c.icloud))
            input.usage = c.usage.flatMap(StorageView.init).map(SyncLayout.Usage.ready) ?? .failed(code: "E_SYNC_OFFLINE")
            input.stored = .ready(2_500_000)
            input.devices = SyncDevice.list(c.devices)
            let sections = SyncLayout.sections(input)
            XCTAssertEqual(
                sections.map { $0.rows.filter { !$0.note }.map(\.key) }, c.sections.map(\.labels), c.name)
            for (section, want) in zip(sections, c.sections) {
                let notes = section.rows.filter(\.note)
                XCTAssertEqual(notes.count, want.notes.count, c.name)
                for (note, key) in zip(notes, want.notes) {
                    XCTAssertTrue(note.text.hasPrefix(upToPlaceholder(key)), "\(c.name): \(note.text)")
                }
                if let footer = want.footer {
                    XCTAssertTrue(section.footer?.hasPrefix(upToPlaceholder(footer)) == true, "\(c.name): \(section.footer ?? "")")
                } else {
                    XCTAssertNil(section.footer, c.name)
                }
            }
        }
    }

    private func relayVault() -> SyncSnapshot {
        var snapshot = SyncSnapshot()
        snapshot.relayUrl = "https://relay.example.test"
        snapshot.enabled = true
        snapshot.vault = true
        snapshot.enrolled = true
        snapshot.status.state = "idle"
        return snapshot
    }

    func testALockedLicenceLeadsWithItsSentenceAndBuy() {
        let sections = SyncLayout.sections(SyncLayout.Input(snapshot: relayVault(), locked: "Sync needs a license"))
        XCTAssertEqual(sections.first?.rows.first, SyncLayout.Row(key: "licenceSettings.title", text: "Sync needs a license", control: .buy))
    }

    func testPairADeviceLandsOnTheSetupRowsOutsideAVaultAndOnPairingInIt() {
        XCTAssertEqual(SyncLayout.sections(SyncLayout.Input(snapshot: .off)).filter(\.pairing).map(\.id), ["setup"])
        XCTAssertEqual(SyncLayout.sections(SyncLayout.Input(snapshot: relayVault())).filter(\.pairing).map(\.id), ["pairing"])
    }

    func testTheSetupPathsAskForWhatEachNeeds() {
        var snapshot = SyncSnapshot.off
        snapshot.relayUrl = "https://relay.example.test"
        let rows = { (path: SyncLayout.Path?) in
            var input = SyncLayout.Input(snapshot: snapshot)
            input.path = path
            return SyncLayout.sections(input).first { $0.id == "setup" }?.rows.map(\.key)
        }
        XCTAssertEqual(rows(nil), ["syncSettings.setup"])
        XCTAssertEqual(rows(.first), ["syncSettings.setup", "syncSettings.relay", "syncSettings.secret"])
        XCTAssertEqual(rows(.another), ["syncSettings.setup", "syncSettings.joinCode", "syncSettings.joinRecovery", "syncSettings.relay"])
    }

    func testAPausedRelayWordsTheWaitAndAStoppedOneItsAdvice() {
        var snapshot = relayVault()
        snapshot.status.state = "stopped"
        snapshot.status.code = "E_SYNC_CIRCUIT_OPEN"
        let status = { SyncLayout.sections(SyncLayout.Input(snapshot: snapshot))[0].rows.first { $0.key == "syncSettings.status" }?.text }
        XCTAssertEqual(
            status(), "\(catalog("syncSettings.state.stopped")) \(catalog("sync.advice.circuit")) \(catalog("syncSettings.neverSynced"))")
        snapshot.status.state = "offline"
        snapshot.status.code = "E_SYNC_OFFLINE"
        XCTAssertEqual(status(), "\(catalog("syncSettings.state.offline")) \(catalog("syncSettings.neverSynced"))")
    }

    func testSizesReadAsThePageWritesThem() {
        XCTAssertEqual(SyncText.fileSize(0), "0 kB")
        XCTAssertEqual(SyncText.fileSize(1), "1 kB")
        XCTAssertEqual(SyncText.fileSize(999_499), "999 kB")
        XCTAssertEqual(SyncText.fileSize(1_250_000), "1.3 MB")
        XCTAssertEqual(SyncText.fileSize(2_000_000_000), "2 GB")
        XCTAssertEqual(SyncText.countdown(61_001), "1:02")
    }

    func testAFailureSaysWhyInSyncsWordsOrThePlainReason() {
        XCTAssertEqual(
            SyncText.failure("syncSettings.joinFailed", "E_SYNC_PAIRING_EXPIRED"),
            "\(catalog("syncSettings.joinFailed")) \(catalog("syncSettings.why.codeGone"))")
        XCTAssertEqual(SyncText.failure("syncSettings.joinFailed", "E_SOMETHING"), catalog("syncSettings.joinFailed"))
    }

    func testAPairingLinkNamesItsRelayAndOnlyASafeOneIsTaken() {
        XCTAssertEqual(SyncLinks.relay("devot://pair?code=X&relay=https%3A%2F%2Frelay.example.test"), "https://relay.example.test")
        XCTAssertNil(SyncLinks.relay("ABCD-EFGH"))
        XCTAssertTrue(SyncLinks.allowed("https://relay.example.test"))
        XCTAssertTrue(SyncLinks.allowed("http://127.0.0.1:8787"))
        XCTAssertFalse(SyncLinks.allowed("http://relay.example.test"))
        XCTAssertEqual(SyncLinks.host("https://relay.example.test:8443/x"), "relay.example.test:8443")
    }
}
