import SwiftUI
import RemoteKit

// MARK: - Card surface

struct CardSurface: ViewModifier {
    var padding: CGFloat = 16
    var radius: CGFloat = Metrics.radius
    var edge: Color? = nil
    var fill: Color = Palette.surface1
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .padding(padding)
            .background {
                shape.fill(fill)
                    .overlay(alignment: .top) {
                        // Faint top sheen (inset highlight from --shadow-panel).
                        shape.fill(LinearGradient(colors: [Color.white.opacity(0.035), .clear], startPoint: .top, endPoint: .center))
                    }
            }
            .overlay {
                shape.strokeBorder(edge ?? (contrast == .increased ? Palette.borderStrong.opacity(1.6) : Palette.border),
                                   lineWidth: contrast == .increased ? 1 : 0.75)
            }
    }
}

extension View {
    func card(padding: CGFloat = 16, radius: CGFloat = Metrics.radius, edge: Color? = nil, fill: Color = Palette.surface1) -> some View {
        modifier(CardSurface(padding: padding, radius: radius, edge: edge, fill: fill))
    }

    /// Hides stale data from being read as live: dims and desaturates while not Online.
    func staleDimmed(_ stale: Bool) -> some View {
        opacity(stale ? 0.55 : 1).saturation(stale ? 0.4 : 1).animation(Motion.gentle, value: stale)
    }
}

// MARK: - Buttons

struct PrimaryButtonStyle: ButtonStyle {
    var compact = false
    var fullWidth = true

    func makeBody(configuration: Configuration) -> some View {
        Styled(configuration: configuration, compact: compact, fullWidth: fullWidth)
    }

    private struct Styled: View {
        let configuration: Configuration
        let compact: Bool
        let fullWidth: Bool
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: compact ? 10 : 13, style: .continuous)
            configuration.label
                .font(compact ? .kcButtonSmall : .kcButton)
                .foregroundStyle(.white)
                .lineLimit(1)
                .frame(maxWidth: fullWidth ? .infinity : nil)
                .padding(.vertical, compact ? 9 : 15)
                .padding(.horizontal, compact ? 14 : 20)
                .background {
                    shape.fill(LinearGradient(colors: [Palette.primaryTop, Palette.primaryBottom], startPoint: .top, endPoint: .bottom))
                        .overlay(shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.22), .white.opacity(0.04)], startPoint: .top, endPoint: .bottom), lineWidth: 0.75))
                        .shadow(color: Palette.accent.opacity(enabled ? 0.28 : 0), radius: compact ? 6 : 14, y: compact ? 2 : 6)
                }
                .opacity(enabled ? (configuration.isPressed ? 0.86 : 1) : 0.4)
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .animation(Motion.quick, value: configuration.isPressed)
                .contentShape(shape)
        }
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    var compact = false
    var fullWidth = true
    var tint: Color = Palette.text

    func makeBody(configuration: Configuration) -> some View {
        Styled(configuration: configuration, compact: compact, fullWidth: fullWidth, tint: tint)
    }

    private struct Styled: View {
        let configuration: Configuration
        let compact: Bool
        let fullWidth: Bool
        let tint: Color
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: compact ? 10 : 13, style: .continuous)
            configuration.label
                .font(compact ? .kcButtonSmall : .kcButton)
                .foregroundStyle(tint)
                .lineLimit(1)
                .frame(maxWidth: fullWidth ? .infinity : nil)
                .padding(.vertical, compact ? 9 : 15)
                .padding(.horizontal, compact ? 14 : 20)
                .background(shape.fill(configuration.isPressed ? Palette.surface3.opacity(1.4) : Palette.surface3))
                .overlay(shape.strokeBorder(Palette.borderStrong, lineWidth: 0.75))
                .opacity(enabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .animation(Motion.quick, value: configuration.isPressed)
                .contentShape(shape)
        }
    }
}

struct DestructiveButtonStyle: ButtonStyle {
    var compact = false
    var fullWidth = true

    func makeBody(configuration: Configuration) -> some View {
        SecondaryButtonStyle(compact: compact, fullWidth: fullWidth, tint: Palette.redText).makeBody(configuration: configuration)
    }
}

/// Circular graphite icon button (toolbar-adjacent actions inside content).
struct IconCircleButtonStyle: ButtonStyle {
    var size: CGFloat = 36
    var tint: Color = Palette.text2

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(Circle().fill(Palette.surface3))
            .overlay(Circle().strokeBorder(Palette.border, lineWidth: 0.75))
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Circle())
    }
}

// MARK: - Status pill (connection)

extension ConnectionStatus {
    var pillLabel: String {
        switch self {
        case .unpaired: return "Not paired"
        case .connecting: return "Connecting"
        case .online: return "Online"
        case .reconnecting: return "Reconnecting"
        case .offline: return "Offline"
        case .removed: return "Removed"
        }
    }

    var tone: Tone {
        switch self {
        case .online: return .green
        case .connecting: return .blue
        case .reconnecting: return .amber
        case .offline, .unpaired: return .muted
        case .removed: return .red
        }
    }

    var isBusy: Bool {
        switch self {
        case .connecting, .reconnecting: return true
        default: return false
        }
    }
}

struct StatusPill: View {
    var status: ConnectionStatus
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            if status.isBusy {
                ProgressView()
                    .progressViewStyle(.circular)
                    .controlSize(.mini)
                    .tint(status.tone.fill)
                    .frame(width: 8, height: 8)
                    .scaleEffect(0.75)
            } else {
                Circle()
                    .fill(status.tone.fill)
                    .frame(width: 7, height: 7)
                    .shadow(color: status == .online ? status.tone.fill.opacity(0.8) : .clear, radius: 4)
            }
            if !compact {
                Text(status.pillLabel)
                    .font(.kcCaption)
                    .foregroundStyle(status.tone.text)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, compact ? 7 : 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(status.tone.wash))
        .overlay(Capsule().strokeBorder(status.tone.edge, lineWidth: 0.75))
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Connection: \(status.pillLabel)")
        .accessibilityIdentifier("status.pill")
    }
}

// MARK: - Agent state presentation

extension AgentState {
    var label: String {
        switch self {
        case .starting: return "Starting"
        case .ready: return "Ready"
        case .working: return "Working"
        case .testing: return "Testing"
        case .waiting: return "Waiting"
        case .needsYou: return "Needs You"
        case .idle: return "Idle"
        case .done: return "Done"
        case .failed: return "Failed"
        case .stopped: return "Stopped"
        case .unknown: return "Unknown"
        }
    }

    var tone: Tone {
        switch self {
        case .working, .testing: return .green
        case .starting: return .blue
        case .waiting, .needsYou: return .amber
        case .done: return .bright
        case .failed: return .red
        case .idle, .ready, .stopped, .unknown: return .muted
        }
    }

    var symbol: String {
        switch self {
        case .working: return "bolt.fill"
        case .testing: return "checklist"
        case .starting: return "sparkle"
        case .waiting: return "hourglass"
        case .needsYou: return "hand.raised.fill"
        case .done: return "checkmark"
        case .failed: return "exclamationmark.triangle.fill"
        case .idle: return "moon.fill"
        case .ready: return "circle.dashed"
        case .stopped: return "stop.fill"
        case .unknown: return "questionmark"
        }
    }
}

struct StateChip: View {
    var state: AgentState

    var body: some View {
        let filled = state == .needsYou
        HStack(spacing: 5) {
            Image(systemName: state.symbol)
                .font(.system(size: 9.5, weight: .bold))
            Text(state.label)
                .font(.kcCaption)
                .lineLimit(1)
        }
        .foregroundStyle(filled ? Palette.onAmber : state.tone.text)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Capsule().fill(filled ? Palette.amber : state.tone.wash))
        .overlay(Capsule().strokeBorder(filled ? .clear : state.tone.edge, lineWidth: 0.75))
        .fixedSize()
        .accessibilityLabel(state.label)
    }
}

/// Small tinted tag (worktree, kind, status words).
struct Tag: View {
    var text: String
    var tone: Tone = .muted
    var mono = false
    var symbol: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).font(.system(size: 9, weight: .semibold)) }
            Text(text).font(mono ? .kcMonoSmall : .kcCaption).lineLimit(1)
        }
        .foregroundStyle(tone.text)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(tone.wash))
        .fixedSize()
    }
}

/// Monospaced capsule for model / effort / ids.
struct MonoChip: View {
    var text: String
    var body: some View {
        Text(text)
            .font(.kcMonoSmall)
            .foregroundStyle(Palette.icy)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Palette.codeBg))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 0.75))
    }
}

// MARK: - Section header

struct SectionHeader: View {
    var title: String
    var count: Int? = nil
    var tone: Tone = .muted
    var trailing: AnyView? = nil

    var body: some View {
        HStack(spacing: 8) {
            Text(title.uppercased())
                .font(.kcLabel)
                .tracking(1.1)
                .foregroundStyle(tone == .muted ? Palette.muted : tone.text)
            if let count {
                Text("\(count)")
                    .font(.kcMonoMedium)
                    .foregroundStyle(tone == .muted ? Palette.faint : tone.text)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(tone.wash))
            }
            Spacer(minLength: 0)
            if let trailing { trailing }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Empty / loading / error states

struct EmptyStateView: View {
    var symbol: String
    var title: String
    var message: String
    var image: String? = nil
    var action: (title: String, run: () -> Void)? = nil

    var body: some View {
        VStack(spacing: 14) {
            if let image {
                Image(image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: 96, height: 96)
                    .opacity(0.9)
            } else {
                ZStack {
                    Circle().fill(Palette.accent.opacity(0.10)).frame(width: 64, height: 64)
                    Circle().strokeBorder(Palette.litSoft, lineWidth: 0.75).frame(width: 64, height: 64)
                    Image(systemName: symbol)
                        .font(.system(size: 24, weight: .medium))
                        .foregroundStyle(Palette.accentText)
                }
            }
            Text(title)
                .font(.kcTitle3)
                .foregroundStyle(Palette.text)
                .multilineTextAlignment(.center)
            Text(message)
                .font(.kcSub)
                .foregroundStyle(Palette.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 340)
            if let action {
                Button(action.title, action: action.run)
                    .buttonStyle(SecondaryButtonStyle(compact: true, fullWidth: false))
                    .padding(.top, 4)
            }
        }
        .padding(.vertical, 36)
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

struct LoadingRow: View {
    var text: String
    var body: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small).tint(Palette.accentText)
            Text(text).font(.kcSub).foregroundStyle(Palette.muted)
            Spacer(minLength: 0)
        }
        .card(padding: 14)
        .accessibilityElement(children: .combine)
    }
}

struct InlineErrorCard: View {
    var title: String
    var message: String?
    var retry: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.red)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.kcSubMedium).foregroundStyle(Palette.text)
                if let message { Text(message).font(.kcFootnote).foregroundStyle(Palette.text2) }
            }
            Spacer(minLength: 0)
            if let retry {
                Button("Retry", action: retry)
                    .buttonStyle(SecondaryButtonStyle(compact: true, fullWidth: false))
            }
        }
        .card(padding: 14, edge: Palette.red.opacity(0.32), fill: Palette.surface1)
        .accessibilityElement(children: .combine)
    }
}

/// Placeholder card while the first snapshot is on its way.
struct SkeletonCard: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            RoundedRectangle(cornerRadius: 6).fill(Palette.surface3).frame(width: 84, height: 18)
            RoundedRectangle(cornerRadius: 6).fill(Palette.surface3).frame(height: 16)
            RoundedRectangle(cornerRadius: 6).fill(Palette.surface2).frame(width: 180, height: 12)
            RoundedRectangle(cornerRadius: 6).fill(Palette.surface2).frame(width: 120, height: 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .opacity(dim ? 0.55 : 1)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Small helpers

struct Hairline: View {
    var vertical = false
    var body: some View {
        Rectangle().fill(Palette.border)
            .frame(width: vertical ? 0.75 : nil, height: vertical ? nil : 0.75)
    }
}

struct MetaItem: View {
    var symbol: String
    var text: String
    var tone: Color = Palette.muted
    var mono = false

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(tone.opacity(0.85))
            Text(text)
                .font(mono ? .kcMonoSmall : .kcFootnote)
                .foregroundStyle(tone)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}

extension String {
    var nonEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}

/// Toolbar title in Lexend with an optional subtitle (inline nav bars).
struct NavTitle: View {
    var title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(spacing: 1) {
            Text(title).font(.lexend(.semibold, 16, relativeTo: .headline)).foregroundStyle(Palette.text).lineLimit(1)
            if let subtitle {
                Text(subtitle).font(.kcCaption).foregroundStyle(Palette.muted).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}
