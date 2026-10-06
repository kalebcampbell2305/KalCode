import SwiftUI
import RemoteKit

/// Shown above every live surface while not Online. The last state stays visible but dimmed
/// beneath it; nothing stale is ever presented as live.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let status = model.client.status
        let name = model.workstationName
        switch status {
        case .reconnecting:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small).tint(Palette.amber)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Reconnecting to \(name)…")
                        .font(.kcSubMedium)
                        .foregroundStyle(Palette.amberText)
                        .lineLimit(2)
                    updatedLine
                }
                Spacer(minLength: 0)
            }
            .card(padding: 12, radius: 12, edge: Palette.amber.opacity(0.32), fill: Palette.surface2)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("banner.reconnecting")
        case .offline(let reason):
            let copy = ErrorCopy.offline(reason, name: name)
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: reason == .versionMismatch ? "arrow.down.app" : "wifi.slash")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.muted)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(copy.title).font(.kcSubMedium).foregroundStyle(Palette.text)
                    Text(copy.detail).font(.kcFootnote).foregroundStyle(Palette.text2)
                    updatedLine
                }
                Spacer(minLength: 0)
                if reason != .versionMismatch {
                    Button("Try again") {
                        Haptics.tap()
                        model.client.reconnectNow()
                    }
                    .buttonStyle(SecondaryButtonStyle(compact: true, fullWidth: false))
                    .accessibilityIdentifier("banner.retry")
                }
            }
            .card(padding: 12, radius: 12, edge: Palette.borderStrong, fill: Palette.surface2)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("banner.offline")
        case .connecting:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small).tint(Palette.accentText)
                Text("Connecting securely to \(name)…")
                    .font(.kcSubMedium)
                    .foregroundStyle(Palette.accentText)
                Spacer(minLength: 0)
            }
            .card(padding: 12, radius: 12, edge: Palette.litSoft, fill: Palette.surface2)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("banner.connecting")
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var updatedLine: some View {
        if let last = model.client.lastUpdate {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Text("Updated \(Elapsed.seconds(ctx.date.timeIntervalSince(last)))")
                    .font(.kcCaption)
                    .foregroundStyle(Palette.faint)
                    .monospacedDigit()
            }
        }
    }
}
