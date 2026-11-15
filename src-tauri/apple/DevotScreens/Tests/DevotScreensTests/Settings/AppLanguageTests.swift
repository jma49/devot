import XCTest

@testable import DevotScreens

@MainActor
final class AppLanguageTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!

    override func setUp() {
        suite = "AppLanguageTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testFollowsTheSystemUntilALanguageIsChosen() {
        XCTAssertEqual(AppLanguage(defaults: defaults, domain: suite).chosen, "system")
    }

    func testEachChoiceIsReadBackAtTheNextLaunch() {
        for choice in AppLanguage.choices + ["system"] {
            AppLanguage(defaults: defaults, domain: suite).choose(choice)
            XCTAssertEqual(AppLanguage(defaults: defaults, domain: suite).chosen, choice)
        }
        XCTAssertNil(defaults.persistentDomain(forName: suite)?["AppleLanguages"])
    }

    func testAnUnknownChoiceChangesNothing() {
        let language = AppLanguage(defaults: defaults, domain: suite)
        language.choose("fr")
        XCTAssertEqual(language.chosen, "system")
        XCTAssertNil(defaults.persistentDomain(forName: suite)?["AppleLanguages"])
    }

    func testALanguageSetInIOSSettingsReadsByItsFirstTag() {
        XCTAssertEqual(AppLanguage.choice(for: "zh-Hans-CN"), "zh-Hans")
        XCTAssertEqual(AppLanguage.choice(for: "zh_CN"), "zh-Hans")
        XCTAssertEqual(AppLanguage.choice(for: "en-GB"), "en")
        XCTAssertEqual(AppLanguage.choice(for: "zh-Hant"), "system")
        XCTAssertEqual(AppLanguage.choice(for: "zh-TW"), "system")
        XCTAssertEqual(AppLanguage.choice(for: "fr"), "system")
    }

    func testEachLanguageIsNamedInItself() {
        XCTAssertEqual(AppLanguage.title("en"), "English")
        XCTAssertEqual(AppLanguage.title("system"), L10n.generalSettingsLanguageSystem())
        XCTAssertFalse(AppLanguage.title("zh-Hans").unicodeScalars.allSatisfy(\.isASCII))
    }
}
