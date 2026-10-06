import SwiftUI
import RemoteKit

/// Same buckets as the desktop deck (deckModel.shortElapsed): <1m "now", "4m", "2h", "3d".
enum Elapsed {
    static func short(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "now" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return "\(h)h" }
        return "\(h / 24)d"
    }

    static func ago(_ seconds: TimeInterval) -> String {
        let s = short(seconds)
        return s == "now" ? "just now" : "\(s) ago"
    }

    static func spoken(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "less than a minute" }
        let m = s / 60
        if m < 60 { return m == 1 ? "1 minute" : "\(m) minutes" }
        let h = m / 60
        if h < 24 { return h == 1 ? "1 hour" : "\(h) hours" }
        let d = h / 24
        return d == 1 ? "1 day" : "\(d) days"
    }

    /// "12s" granularity for the "Updated … ago" banner.
    static func seconds(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s)s ago" }
        return ago(seconds)
    }
}

/// Live-ness of the mirrored state. When not live, every timer freezes at `frozenAt`.
struct Liveness: Equatable {
    var live: Bool
    var frozenAt: Date

    static let live = Liveness(live: true, frozenAt: .distantPast)
}

private struct LivenessKey: EnvironmentKey {
    static let defaultValue = Liveness.live
}

extension EnvironmentValues {
    var liveness: Liveness {
        get { self[LivenessKey.self] }
        set { self[LivenessKey.self] = newValue }
    }
}

/// Elapsed time for an agent: working/active counts up since createdAt; anything else reads
/// "… ago" since lastActivityAt. Ticks only while live (TimelineView); frozen otherwise.
struct AgentElapsed: View {
    var agent: Agent
    var font: Font = .kcMonoSmall
    @Environment(\.liveness) private var liveness

    private var anchor: (date: Date, counting: Bool)? {
        if agent.state.isActive, let c = agent.createdAt { return (c, true) }
        if let a = agent.lastActivityAt ?? agent.createdAt { return (a, false) }
        return nil
    }

    var body: some View {
        if let anchor {
            if liveness.live {
                TimelineView(.periodic(from: .now, by: 5)) { ctx in
                    label(anchor, now: ctx.date)
                }
            } else {
                label(anchor, now: liveness.frozenAt)
            }
        }
    }

    private func label(_ anchor: (date: Date, counting: Bool), now: Date) -> some View {
        let seconds = now.timeIntervalSince(anchor.date)
        return Text(anchor.counting ? Elapsed.short(seconds) : Elapsed.ago(seconds))
            .font(font)
            .foregroundStyle(anchor.counting && liveness.live ? agent.state.tone.text : Palette.faint)
            .monospacedDigit()
            .lineLimit(1)
            .accessibilityLabel(anchor.counting ? "running for \(Elapsed.spoken(seconds))" : "last active \(Elapsed.spoken(seconds)) ago")
    }
}

/// Relative date label (updatedAt etc.), frozen while not live.
struct RelativeLabel: View {
    var date: Date?
    var font: Font = .kcFootnote
    var color: Color = Palette.faint
    @Environment(\.liveness) private var liveness

    var body: some View {
        if let date {
            if liveness.live {
                TimelineView(.periodic(from: .now, by: 15)) { ctx in
                    text(ctx.date.timeIntervalSince(date))
                }
            } else {
                text(liveness.frozenAt.timeIntervalSince(date))
            }
        }
    }

    private func text(_ s: TimeInterval) -> some View {
        Text(Elapsed.ago(s)).font(font).foregroundStyle(color).lineLimit(1)
            .accessibilityLabel("\(Elapsed.spoken(s)) ago")
    }
}

enum PlatformGlyph {
    static func symbol(_ platform: String?) -> String {
        switch platform?.lowercased() {
        case "windows": return "pc"
        case "macos", "darwin", "mac": return "desktopcomputer"
        case "linux": return "terminal"
        default: return "desktopcomputer"
        }
    }

    static func name(_ platform: String?) -> String {
        switch platform?.lowercased() {
        case "windows": return "Windows"
        case "macos", "darwin", "mac": return "macOS"
        case "linux": return "Linux"
        case let p?: return p.capitalized
        default: return "Workstation"
        }
    }
}

enum Plural {
    static func s(_ n: Int, _ word: String, _ plural: String? = nil) -> String {
        "\(n) \(n == 1 ? word : (plural ?? word + "s"))"
    }
}
