import XCTest

@testable import DevotScreens

/// Excerpts for the rows on screen, from the core through the page (docs/specs/iphone-screens.md,
/// Excerpt cache).
@MainActor
final class ExcerptCacheTests: XCTestCase {
    private var bridge: FakeBridge!
    private var arrived: [[String]] = []

    override func setUp() async throws {
        bridge = FakeBridge()
        arrived = []
    }

    private func cache() -> ExcerptCache {
        let cache = ExcerptCache(bridge: bridge)
        cache.onExcerpts = { [unowned self] in arrived.append($0) }
        return cache
    }

    private func excerpts(_ ids: [String], _ text: (String) -> String) -> Outcome {
        .ok(.object(["excerpts": .object(Dictionary(uniqueKeysWithValues: ids.map { ($0, .string(text($0))) }))]))
    }

    private func asked(_ index: Int) -> [String] {
        bridge.sent[index].args["ids"]?.array?.compactMap(\.string) ?? []
    }

    func testAsksForAtMostSixtyIdsACallAndOnlyForThoseItLacks() {
        let cache = cache()
        let rows = (1...130).map { noteRow($0, updated: Double($0)) }
        cache.want(rows)
        XCTAssertEqual(bridge.ops, Array(repeating: Op.excerpts.rawValue, count: 3))
        XCTAssertEqual((0..<3).map { asked($0).count }, [60, 60, 10])
        XCTAssertEqual(Set((0..<3).flatMap(asked)), Set(rows.map(\.id)))
        cache.want(rows)
        XCTAssertEqual(bridge.sent.count, 3)
    }

    func testKeepsAnExcerptForTheBodyVersionItWasAskedAt() {
        let cache = cache()
        let row = noteRow(1, updated: 1, version: 3)
        cache.want([row])
        bridge.answer(Op.excerpts.rawValue, excerpts([row.id]) { _ in "First line" })
        XCTAssertEqual(arrived, [[row.id]])
        XCTAssertEqual(cache.excerpt(row), "First line")
        cache.want([row])
        XCTAssertEqual(bridge.sent.count, 0)
        let edited = noteRow(1, updated: 2, version: 4)
        XCTAssertNil(cache.excerpt(edited))
        cache.want([edited])
        XCTAssertEqual(asked(0), [row.id])
    }

    func testANoteWithoutAnExcerptIsNotAskedForAgain() {
        let cache = cache()
        let row = noteRow(1, updated: 1)
        cache.want([row])
        bridge.answer(Op.excerpts.rawValue, .ok(.object(["excerpts": .object([:])])))
        XCTAssertEqual(cache.excerpt(row), "")
        cache.want([row])
        XCTAssertEqual(bridge.sent.count, 0)
    }

    func testAFailedCallIsLoggedByCodeAndAskedForAgainLater() {
        let cache = cache()
        let row = noteRow(1, updated: 1)
        cache.want([row])
        bridge.answer(Op.excerpts.rawValue, .failed("E_SCREENS_UNAVAILABLE"))
        XCTAssertEqual(bridge.lines, ["W_PHONE_EXCERPTS_FAILED code=E_SCREENS_UNAVAILABLE"])
        XCTAssertNil(cache.excerpt(row))
        cache.want([row])
        XCTAssertEqual(bridge.ops, [Op.excerpts.rawValue])
    }
}
