import XCTest

@testable import DevotScreens

/// The shared fixtures (tests/fixtures/screens), which Vitest and `cargo test` read too.
struct Fixture {
    let name: String
    let from: String
    let code: String?
    let envelope: Bool
    let message: Data

    static func all(_ kind: String) throws -> [Fixture] {
        let folder = try XCTUnwrap(
            Bundle(for: MessageTests.self).url(forResource: "screens", withExtension: nil)
        ).appendingPathComponent(kind)
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted()
        return try names.filter { $0.hasSuffix(".json") }.map { name in
            let data = try Data(contentsOf: folder.appendingPathComponent(name))
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let message = try XCTUnwrap(object["message"])
            return Fixture(
                name: name,
                from: try XCTUnwrap(object["from"] as? String),
                code: object["code"] as? String,
                envelope: object["envelope"] as? Bool ?? false,
                message: try JSONSerialization.data(withJSONObject: message, options: .fragmentsAllowed)
            )
        }
    }
}

func sameJSON(_ a: Data, _ b: Data) throws -> Bool {
    let left = try JSONSerialization.jsonObject(with: a, options: .fragmentsAllowed) as AnyObject
    let right = try JSONSerialization.jsonObject(with: b, options: .fragmentsAllowed) as AnyObject
    return left.isEqual(right)
}

final class MessageTests: XCTestCase {
    func testEveryValidFixtureSurvivesARoundTrip() throws {
        let fixtures = try Fixture.all("valid")
        XCTAssertFalse(fixtures.isEmpty)
        for fixture in fixtures {
            let message = try Message(json: fixture.message)
            XCTAssertTrue(try sameJSON(message.json(), fixture.message), fixture.name)
        }
    }

    func testEveryInvalidEnvelopeIsRefusedWithItsCode() throws {
        let fixtures = try Fixture.all("invalid").filter(\.envelope)
        XCTAssertFalse(fixtures.isEmpty)
        for fixture in fixtures {
            XCTAssertThrowsError(try Message(json: fixture.message), fixture.name) { error in
                XCTAssertEqual((error as? MessageError)?.code, fixture.code, fixture.name)
            }
        }
    }

    func testEveryOperationAndNoticeHasAValidFixture() throws {
        let messages = try Fixture.all("valid").map { try Message(json: $0.message) }
        let ops = Set(messages.compactMap { if case .request(_, let op, _) = $0 { op } else { nil } })
        let notices = Set(messages.compactMap { if case .notice(let kind, _) = $0 { kind } else { nil } })
        XCTAssertEqual(ops, Set(Op.allCases))
        XCTAssertEqual(notices, Set(NoticeKind.allCases))
    }

    func testRefusesAMessageOverFourMebibytes() {
        let json = Data(#"{"v":1,"notice":"notes.changed","pad":""#.utf8)
            + Data(repeating: 0x61, count: 4 << 20) + Data(#""}"#.utf8)
        XCTAssertThrowsError(try Message(json: json)) { error in
            XCTAssertEqual((error as? MessageError)?.code, "E_SCREENS_MESSAGE_TOO_LARGE")
        }
    }

    func testRefusesAFractionalID() {
        let json = Data(#"{"v":1,"id":1.5,"op":"ping","args":{}}"#.utf8)
        XCTAssertThrowsError(try Message(json: json)) { error in
            XCTAssertEqual(error as? MessageError, .invalid)
        }
    }
}
