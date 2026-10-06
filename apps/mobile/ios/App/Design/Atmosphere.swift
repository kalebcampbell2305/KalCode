import SwiftUI

/// Space intensity, set once per screen: quiet for dense work (agent detail, diff, settings),
/// standard for lists, cinematic for Welcome, the Mission Control header and KalVoice.
enum SpaceLevel {
    case quiet, standard, cinematic

    var starCount: Int {
        switch self {
        case .quiet: return 0
        case .standard: return 70
        case .cinematic: return 150
        }
    }

    var starOpacity: Double {
        switch self {
        case .quiet: return 0
        case .standard: return 0.55
        case .cinematic: return 0.85
        }
    }

    var nebula: Double {
        switch self {
        case .quiet: return 0
        case .standard: return 0.65
        case .cinematic: return 1
        }
    }
}

/// Deterministic generator so the star field is identical on every launch and every redraw.
struct SeededRandom: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

private struct Star {
    var x: CGFloat
    var y: CGFloat
    var r: CGFloat
    var a: Double
    var blue: Bool
}

private enum StarCatalog {
    /// Generated once per process; drawing is a single static Canvas pass (no per-frame work).
    static let stars: [Star] = {
        var rng = SeededRandom(seed: 0x4B414C434F4445)
        return (0..<220).map { _ in
            let bright = Double.random(in: 0...1, using: &rng) > 0.93
            return Star(
                x: CGFloat.random(in: 0...1, using: &rng),
                y: CGFloat.random(in: 0...1, using: &rng),
                r: bright ? CGFloat.random(in: 0.9...1.35, using: &rng) : CGFloat.random(in: 0.35...0.8, using: &rng),
                a: bright ? Double.random(in: 0.45...0.7, using: &rng) : Double.random(in: 0.12...0.38, using: &rng),
                blue: Double.random(in: 0...1, using: &rng) > 0.6
            )
        }
    }()
}

struct StarField: View {
    var count: Int
    var opacity: Double

    var body: some View {
        Canvas(rendersAsynchronously: true) { ctx, size in
            for star in StarCatalog.stars.prefix(count) {
                let rect = CGRect(x: star.x * size.width - star.r, y: star.y * size.height - star.r, width: star.r * 2, height: star.r * 2)
                let color = star.blue ? Palette.icy : Palette.text
                ctx.fill(Path(ellipseIn: rect), with: .color(color.opacity(star.a * opacity)))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Restrained blue nebula: two soft radial washes, only behind headers.
struct Nebula: View {
    var intensity: Double

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            ZStack {
                RadialGradient(colors: [Palette.primaryTop.opacity(0.30 * intensity), .clear],
                               center: UnitPoint(x: 0.88, y: 0.02), startRadius: 0, endRadius: max(w * 0.85, 320))
                RadialGradient(colors: [Color(hex: 0x1B3A8A).opacity(0.26 * intensity), .clear],
                               center: UnitPoint(x: 0.05, y: 0.22), startRadius: 0, endRadius: max(w * 0.7, 260))
                RadialGradient(colors: [Palette.accent.opacity(0.08 * intensity), .clear],
                               center: UnitPoint(x: 0.5, y: 0.0), startRadius: 0, endRadius: max(w * 0.5, 200))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Screen background: graphite + static stars + (optional) nebula header wash.
/// Increase Contrast removes the atmosphere entirely.
struct Atmosphere: View {
    var level: SpaceLevel
    /// Height of the nebula wash from the top; nil = whole screen.
    var nebulaHeight: CGFloat? = 420
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        ZStack(alignment: .top) {
            Palette.bg
            if contrast != .increased && level != .quiet {
                StarField(count: level.starCount, opacity: level.starOpacity)
                    .mask(LinearGradient(colors: [.white, .white.opacity(0.35)], startPoint: .top, endPoint: .bottom))
                Nebula(intensity: level.nebula)
                    .frame(height: nebulaHeight)
                    .frame(maxHeight: nebulaHeight == nil ? .infinity : nil, alignment: .top)
                    .mask(LinearGradient(colors: [.white, .white, .clear], startPoint: .top, endPoint: .bottom))
            }
        }
        .ignoresSafeArea()
    }
}

extension View {
    func spaceBackground(_ level: SpaceLevel, nebulaHeight: CGFloat? = 420) -> some View {
        background { Atmosphere(level: level, nebulaHeight: nebulaHeight) }
    }
}
