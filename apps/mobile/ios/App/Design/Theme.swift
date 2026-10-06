import SwiftUI
import UIKit

// KalCode design tokens for iOS, mirrored from packages/ui/src/styles/tokens.css.
// Every colour, font and duration in the app comes from here; views never invent one-off values.

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: opacity)
    }
}

enum Palette {
    // Graphite foundation
    static let bg = Color(hex: 0x08090C)
    static let sunken = Color(hex: 0x050608)
    static let hull = Color(hex: 0x0F1115)
    static let surface1 = Color(hex: 0x0C0E12)
    static let surface2 = Color(hex: 0x111318)
    static let surface3 = Color(hex: 0x16191F)
    static let codeBg = Color(hex: 0x0A0B0E)

    // Borders
    static let border = Color(red: 180 / 255, green: 195 / 255, blue: 225 / 255, opacity: 0.11)
    static let borderStrong = Color(red: 180 / 255, green: 195 / 255, blue: 225 / 255, opacity: 0.20)
    static let borderSubtle = Color(red: 180 / 255, green: 195 / 255, blue: 225 / 255, opacity: 0.07)
    static let lit = Color(red: 92 / 255, green: 150 / 255, blue: 1, opacity: 0.55)
    static let litSoft = Color(red: 92 / 255, green: 150 / 255, blue: 1, opacity: 0.26)

    // Text
    static let text = Color(hex: 0xEEF1F6)          // Starlight
    static let text2 = Color(hex: 0xB4BCCB)
    static let muted = Color(hex: 0x959EAE)         // Nebula
    static let faint = Color(hex: 0x8A93A3)

    // Constellation blue
    static let accent = Color(hex: 0x4C8DFF)
    static let accentText = Color(hex: 0x8DB6FF)
    static let icy = Color(hex: 0xA9C8FF)
    static let primaryTop = Color(hex: 0x2F6BEC)
    static let primaryBottom = Color(hex: 0x2257D6)

    // Status
    static let green = Color(hex: 0x3CCF8E)
    static let greenText = Color(hex: 0x62DCA4)
    static let amber = Color(hex: 0xF2B544)
    static let amberText = Color(hex: 0xF6C566)
    static let red = Color(hex: 0xEF5F6B)
    static let redText = Color(hex: 0xFF8A93)
    static let done = Color(hex: 0xEEF3FB)
    static let blue = Color(hex: 0x5F9BFF)
    static let onAmber = Color(hex: 0x1C1404)

    // Diff
    static let diffAdd = Color(red: 60 / 255, green: 207 / 255, blue: 142 / 255, opacity: 0.10)
    static let diffAddGutter = Color(red: 60 / 255, green: 207 / 255, blue: 142 / 255, opacity: 0.16)
    static let diffDel = Color(red: 239 / 255, green: 95 / 255, blue: 107 / 255, opacity: 0.11)
    static let diffDelGutter = Color(red: 239 / 255, green: 95 / 255, blue: 107 / 255, opacity: 0.18)
}

/// Status tones: BLUE active, GREEN healthy/working, AMBER waiting/Needs You, RED failure.
enum Tone: Equatable {
    case green, amber, red, blue, muted, bright, accent

    var fill: Color {
        switch self {
        case .green: return Palette.green
        case .amber: return Palette.amber
        case .red: return Palette.red
        case .blue: return Palette.blue
        case .muted: return Palette.faint
        case .bright: return Palette.done
        case .accent: return Palette.accent
        }
    }

    var text: Color {
        switch self {
        case .green: return Palette.greenText
        case .amber: return Palette.amberText
        case .red: return Palette.redText
        case .blue: return Palette.accentText
        case .muted: return Palette.muted
        case .bright: return Palette.done
        case .accent: return Palette.accentText
        }
    }

    var wash: Color { fill.opacity(self == .muted ? 0.12 : 0.13) }
    var edge: Color { fill.opacity(0.32) }
}

// MARK: - Typography (Dynamic Type via relativeTo:)

enum LexendWeight: String {
    case light = "LexendDeca-Light"
    case regular = "LexendDeca-Regular"
    case medium = "LexendDeca-Medium"
    case semibold = "LexendDeca-SemiBold"
    case bold = "LexendDeca-Bold"
}

extension Font {
    static func lexend(_ weight: LexendWeight, _ size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
        .custom(weight.rawValue, size: size, relativeTo: style)
    }

    static func mono(_ size: CGFloat, weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .footnote) -> Font {
        let name: String
        switch weight {
        case .bold, .semibold, .heavy, .black: name = "JetBrainsMono-Bold"
        case .medium: name = "JetBrainsMono-Medium"
        default: name = "JetBrainsMono-Regular"
        }
        return .custom(name, size: size, relativeTo: style)
    }

    static let kcHero = lexend(.semibold, 34, relativeTo: .largeTitle)
    static let kcTitle = lexend(.semibold, 26, relativeTo: .title)
    static let kcTitle2 = lexend(.semibold, 20, relativeTo: .title2)
    static let kcTitle3 = lexend(.medium, 18, relativeTo: .title3)
    static let kcHeadline = lexend(.medium, 16, relativeTo: .headline)
    static let kcBody = lexend(.regular, 16, relativeTo: .body)
    static let kcBodyLight = lexend(.light, 16, relativeTo: .body)
    static let kcCallout = lexend(.regular, 15, relativeTo: .callout)
    static let kcSub = lexend(.regular, 14, relativeTo: .subheadline)
    static let kcSubMedium = lexend(.medium, 14, relativeTo: .subheadline)
    static let kcFootnote = lexend(.regular, 13, relativeTo: .footnote)
    static let kcCaption = lexend(.medium, 12, relativeTo: .caption)
    static let kcLabel = lexend(.semibold, 11, relativeTo: .caption2)
    static let kcStat = lexend(.semibold, 26, relativeTo: .title)
    static let kcButton = lexend(.medium, 16, relativeTo: .body)
    static let kcButtonSmall = lexend(.medium, 14, relativeTo: .subheadline)

    static let kcMono = mono(13, relativeTo: .footnote)
    static let kcMonoSmall = mono(12, relativeTo: .caption)
    static let kcMonoMedium = mono(12, weight: .medium, relativeTo: .caption)
    static let kcCode = mono(12.5, relativeTo: .footnote)
}

enum UIFonts {
    static func lexend(_ weight: LexendWeight, _ size: CGFloat) -> UIFont {
        UIFont(name: weight.rawValue, size: size) ?? .systemFont(ofSize: size)
    }
}

// MARK: - Motion (160–260 ms; Reduce Motion swaps springs for opacity)

enum Motion {
    static let quick = Animation.easeOut(duration: 0.16)
    static let standard = Animation.spring(response: 0.26, dampingFraction: 0.9)
    static let gentle = Animation.easeInOut(duration: 0.22)

    static func standard(_ reduce: Bool) -> Animation { reduce ? .easeInOut(duration: 0.16) : standard }
}

enum Metrics {
    static let radius: CGFloat = 14
    static let radiusSmall: CGFloat = 10
    static let gutter: CGFloat = 16
    static let readable: CGFloat = 760
}

// MARK: - Global UIKit chrome (navigation bar in Lexend, transparent over graphite)

enum Chrome {
    static func install() {
        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: UIFonts.lexend(.semibold, 17),
            .foregroundColor: UIColor(Palette.text),
        ]
        let largeAttrs: [NSAttributedString.Key: Any] = [
            .font: UIFonts.lexend(.semibold, 32),
            .foregroundColor: UIColor(Palette.text),
            .kern: -0.4,
        ]
        let transparent = UINavigationBarAppearance()
        transparent.configureWithTransparentBackground()
        transparent.titleTextAttributes = titleAttrs
        transparent.largeTitleTextAttributes = largeAttrs

        let scrolled = UINavigationBarAppearance()
        scrolled.configureWithDefaultBackground()
        scrolled.backgroundEffect = UIBlurEffect(style: .systemUltraThinMaterialDark)
        scrolled.backgroundColor = UIColor(Palette.bg).withAlphaComponent(0.55)
        scrolled.shadowColor = UIColor(Palette.border)
        scrolled.titleTextAttributes = titleAttrs
        scrolled.largeTitleTextAttributes = largeAttrs

        let bar = UINavigationBar.appearance()
        bar.standardAppearance = scrolled
        bar.compactAppearance = scrolled
        bar.scrollEdgeAppearance = transparent
        bar.tintColor = UIColor(Palette.accentText)

        let barButton = UIBarButtonItem.appearance()
        barButton.setTitleTextAttributes([.font: UIFonts.lexend(.medium, 16)], for: .normal)

        let tabItem = UITabBarItem.appearance()
        tabItem.setTitleTextAttributes([.font: UIFonts.lexend(.medium, 10)], for: .normal)

        UISegmentedControl.appearance().setTitleTextAttributes([.font: UIFonts.lexend(.medium, 13)], for: .normal)
    }
}

// MARK: - Haptics

enum Haptics {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func select() { UISelectionFeedbackGenerator().selectionChanged() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}
