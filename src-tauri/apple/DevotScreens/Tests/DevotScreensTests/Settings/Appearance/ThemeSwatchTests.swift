import UIKit
import XCTest

@testable import DevotScreens

@MainActor
final class ThemeSwatchTests: XCTestCase {
    override func tearDown() {
        Tokens.Theme.current = .default
        super.tearDown()
    }

    private func assertColor(
        _ color: UIColor, _ hex: UInt32, _ alpha: CGFloat = 1, file: StaticString = #filePath, line: UInt = #line
    ) {
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        let want = [CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255, CGFloat(hex & 0xff) / 255, alpha]
        for (got, wanted) in zip([r, g, b, a], want) {
            XCTAssertEqual(got, wanted, accuracy: 0.002, file: file, line: line)
        }
    }

    func testASwatchIsDrawnFromItsOwnThemeAndStyleNotTheThemeInEffect() {
        Tokens.Theme.current = .ember
        let light = ThemeSwatch(theme: .dawn, style: .light, strength: 100)
        let dark = ThemeSwatch(theme: .dawn, style: .dark, strength: 100)
        assertColor(light.background, 0xfcedf3)
        assertColor(dark.background, 0x1e1219)
        assertColor(light.accent, 0xb83a68)
        assertColor(dark.accent, 0xee7fa6)
        XCTAssertEqual(light.glow.count, 2)
        assertColor(light.glow[0], 0xf5c4d8, 0.9)
        assertColor(light.glow[1], 0xfdeedc, 0.9)
        assertColor(ThemeSwatch(theme: .default, style: .dark, strength: 100).background, 0x000000)
    }

    func testAGradientThemesGlowFollowsTheStrengthAndIvorysKeepsItsOwn() {
        XCTAssertEqual(ThemeSwatch(theme: .tide, style: .light, strength: 0).glow, [])
        let half = ThemeSwatch(theme: .tide, style: .light, strength: 50).glow
        XCTAssertEqual(half.count, 2)
        assertColor(half[0], 0xc4d8f7, 0.45)
        assertColor(half[1], 0xc6e5f2, 0.45)
        XCTAssertEqual(ThemeSwatch(theme: .ivory, style: .light, strength: 0).glow.count, 2)
        XCTAssertEqual(ThemeSwatch(theme: .default, style: .light, strength: 100).glow, [])
    }

    func testTheThemeInEffectTakesLightFromOneThemeAndDarkFromTheOther() {
        let store = ThemeStore(windows: { [] })
        store.adopt(["lightTheme": .string("dawn"), "darkTheme": .string("ember"), "gradientStrength": .number(30)])
        XCTAssertEqual(Tokens.Theme.current.light, Tokens.Theme.dawn.light)
        XCTAssertEqual(Tokens.Theme.current.dark, Tokens.Theme.ember.dark)
        XCTAssertEqual(store.light, .dawn)
        XCTAssertEqual(store.dark, .ember)
        XCTAssertEqual(store.gradientStrength, 30)
        let background = Tokens.Color.phoneBackground
        assertColor(background.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark)), 0x1d140c)
        assertColor(background.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)), 0xfcedf3)
    }

    func testAnUnknownThemeKeepsTheDefault() {
        let store = ThemeStore(windows: { [] })
        store.adopt(["lightTheme": .string("neon")])
        XCTAssertEqual(store.light, .default)
    }

    func testTheColourSchemeIsEveryWindowsStyle() {
        let windows = [UIWindow(), UIWindow()]
        let store = ThemeStore(windows: { windows })
        store.adopt(["appearance": .string("dark")])
        XCTAssertEqual(windows.map(\.overrideUserInterfaceStyle), [.dark, .dark])
        store.adopt(["appearance": .string("system")])
        XCTAssertEqual(windows.map(\.overrideUserInterfaceStyle), [.unspecified, .unspecified])
        store.adopt(["appearance": .string("light")])
        XCTAssertEqual(windows.map(\.overrideUserInterfaceStyle), [.light, .light])
    }

    func testAGradientThemeInEitherSchemeShowsTheGradientSlider() {
        let store = ThemeStore(windows: { [] })
        store.adopt(["lightTheme": .string("ivory"), "darkTheme": .string("default")])
        XCTAssertFalse(store.gradientShown)
        store.adopt(["lightTheme": .string("ivory"), "darkTheme": .string("sage")])
        XCTAssertTrue(store.gradientShown)
    }
}
