import SwiftUI

struct Toast: Identifiable, Equatable {
    enum Style: Equatable { case info, success, warning, error }
    let id = UUID()
    var message: String
    var style: Style = .info

    var symbol: String {
        switch style {
        case .info: return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.circle.fill"
        case .error: return "xmark.octagon.fill"
        }
    }

    var tone: Tone {
        switch style {
        case .info: return .accent
        case .success: return .green
        case .warning: return .amber
        case .error: return .red
        }
    }
}

struct ToastView: View {
    var toast: Toast

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: toast.symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(toast.tone.fill)
            Text(toast.message)
                .font(.kcSubMedium)
                .foregroundStyle(Palette.text)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background {
            Capsule(style: .continuous).fill(.ultraThinMaterial)
            Capsule(style: .continuous).fill(Palette.surface3.opacity(0.82))
        }
        .overlay(Capsule(style: .continuous).strokeBorder(toast.tone.edge, lineWidth: 0.75))
        .shadow(color: .black.opacity(0.5), radius: 18, y: 8)
        .frame(maxWidth: 520)
        .padding(.horizontal, 20)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("toast")
        .accessibilityAddTraits(.isStaticText)
    }
}
