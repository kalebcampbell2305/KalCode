import SwiftUI
import RemoteKit

/// The workstation removed this device (revoked or unpaired it). Explains, then offers Pair again.
struct RemovedView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let name = model.removedName
        let device = DeviceInfo.idiomNoun
        VStack(spacing: 0) {
            Spacer(minLength: 40)
            ZStack {
                Circle()
                    .fill(RadialGradient(colors: [Palette.red.opacity(0.22), .clear], center: .center, startRadius: 2, endRadius: 110))
                    .frame(width: 220, height: 220)
                Circle().strokeBorder(Palette.red.opacity(0.4), lineWidth: 1).frame(width: 104, height: 104)
                Circle().fill(Palette.surface2).frame(width: 96, height: 96)
                Image(systemName: device == "iPad" ? "ipad.slash" : "iphone.slash")
                    .font(.system(size: 36, weight: .medium))
                    .foregroundStyle(Palette.redText)
            }
            .accessibilityHidden(true)

            VStack(spacing: 12) {
                Text("This \(device) was removed")
                    .font(.kcTitle)
                    .foregroundStyle(Palette.text)
                    .multilineTextAlignment(.center)
                Text("\(name) removed this \(device). It no longer has access to your agents, and its key has been erased from this device.")
                    .font(.kcCallout)
                    .foregroundStyle(Palette.text2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
                    .accessibilityIdentifier("removed.message")
                Text("If that wasn't you, check KalCode → Settings → Remote on your workstation.")
                    .font(.kcFootnote)
                    .foregroundStyle(Palette.faint)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
            }
            .padding(.top, 8)

            Spacer(minLength: 40)

            Button {
                Haptics.tap()
                model.router.reset()
                model.client.acknowledgeRemoval()
            } label: {
                Label("Pair again", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(PrimaryButtonStyle())
            .frame(maxWidth: 420)
            .padding(.bottom, 28)
            .accessibilityIdentifier("removed.repair")
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Atmosphere(level: .standard, nebulaHeight: 360))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("removed.view")
    }
}
