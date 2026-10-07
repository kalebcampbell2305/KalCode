import SwiftUI
import RemoteKit

/// "Pair with <workstation>?" → Connecting securely… → success → Continue.
struct PairConfirmView: View {
    let payload: PairingPayload
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    enum Phase: Equatable {
        case confirm
        case connecting
        case success
        case failed(ErrorCopy.PairFailure)
    }

    @State private var phase: Phase = .confirm
    @State private var showPaste = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    hero
                    switch phase {
                    case .confirm, .connecting: confirmBody
                    case .success: successBody
                    case .failed(let failure): failureBody(failure)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 20)
                .padding(.bottom, 32)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
                .animation(Motion.standard(reduceMotion), value: phase)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background(Atmosphere(level: .cinematic, nebulaHeight: 420))
            .toolbar {
                if phase != .success && phase != .connecting {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { model.pairingPayload = nil }
                            .accessibilityIdentifier("pair.cancel")
                    }
                }
            }
        }
        .interactiveDismissDisabled(phase == .connecting)
        .sheet(isPresented: $showPaste) {
            PasteLinkSheet { link in
                showPaste = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    if model.beginPairing(link) == nil { phase = .confirm }
                }
            }
        }
    }

    // MARK: Pieces

    private var hero: some View {
        ZStack {
            Circle()
                .fill(RadialGradient(colors: [tint.opacity(0.32), .clear], center: .center, startRadius: 2, endRadius: 90))
                .frame(width: 180, height: 180)
            Circle()
                .strokeBorder(tint.opacity(0.45), lineWidth: 1)
                .frame(width: 96, height: 96)
            Circle()
                .fill(Palette.surface2)
                .frame(width: 88, height: 88)
            Group {
                switch phase {
                case .confirm:
                    Image(systemName: PlatformGlyph.symbol(nil)).foregroundStyle(Palette.icy)
                case .connecting:
                    ProgressView().controlSize(.large).tint(Palette.accentText)
                case .success:
                    Image(systemName: "checkmark").foregroundStyle(Palette.green)
                        .transition(.scale.combined(with: .opacity))
                case .failed:
                    Image(systemName: "exclamationmark").foregroundStyle(Palette.amber)
                }
            }
            .font(.system(size: 34, weight: .semibold))
        }
        .frame(height: 180)
        .accessibilityHidden(true)
    }

    private var tint: Color {
        switch phase {
        case .success: return Palette.green
        case .failed: return Palette.amber
        default: return Palette.accent
        }
    }

    private var confirmBody: some View {
        VStack(spacing: 20) {
            VStack(spacing: 8) {
                Text(phase == .connecting ? "Connecting securely…" : "Pair with \(payload.name)?")
                    .font(.kcTitle)
                    .foregroundStyle(Palette.text)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("pair.title")
                Text("Check this name matches your workstation.")
                    .font(.kcSub)
                    .foregroundStyle(Palette.text2)
                    .multilineTextAlignment(.center)
            }

            VStack(alignment: .leading, spacing: 12) {
                detailRow("Workstation", value: payload.name)
                Hairline()
                VStack(alignment: .leading, spacing: 6) {
                    Text("ADDRESSES").font(.kcLabel).tracking(1).foregroundStyle(Palette.faint)
                    ForEach(payload.addrs, id: \.self) { addr in
                        Text(addr).font(.kcMono).foregroundStyle(Palette.icy).textSelection(.enabled)
                    }
                }
                Hairline()
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let remaining = payload.expiresAt.timeIntervalSince(ctx.date)
                    HStack {
                        Text("Code expires").font(.kcSub).foregroundStyle(Palette.muted)
                        Spacer()
                        Text(remaining > 0 ? countdown(remaining) : "Expired")
                            .font(.kcMono)
                            .foregroundStyle(remaining > 60 ? Palette.text2 : remaining > 0 ? Palette.amberText : Palette.redText)
                            .monospacedDigit()
                            .accessibilityIdentifier("pair.expiry")
                    }
                }
                if model.client.workstation != nil {
                    Hairline()
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(Palette.amber)
                        Text("This replaces your pairing with \(model.client.workstation?.name ?? "your current workstation").")
                            .font(.kcFootnote).foregroundStyle(Palette.text2)
                    }
                }
            }
            .card(padding: 16)

            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let expired = payload.isExpired(now: ctx.date)
                VStack(spacing: 10) {
                    Button(action: pair) {
                        HStack(spacing: 8) {
                            if phase == .connecting { ProgressView().tint(.white).controlSize(.small) }
                            Text(phase == .connecting ? "Connecting securely…" : "Pair")
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(expired || phase == .connecting)
                    .accessibilityIdentifier("pair.confirm")
                    if expired {
                        Text("This code expired. Show a new code on your workstation.")
                            .font(.kcFootnote)
                            .foregroundStyle(Palette.redText)
                            .multilineTextAlignment(.center)
                    }
                }
            }
        }
    }

    private var successBody: some View {
        VStack(spacing: 20) {
            VStack(spacing: 8) {
                Text("Paired with \(model.client.workstation?.name ?? payload.name)")
                    .font(.kcTitle)
                    .foregroundStyle(Palette.text)
                    .multilineTextAlignment(.center)
                Text("Your agents are a tap away. KalCode will notify you when one needs you, fails or finishes.")
                    .font(.kcSub)
                    .foregroundStyle(Palette.text2)
                    .multilineTextAlignment(.center)
            }
            Button("Continue") {
                Haptics.tap()
                model.finishPairing()
            }
            .buttonStyle(PrimaryButtonStyle())
            .accessibilityIdentifier("pair.done")
        }
    }

    private func failureBody(_ f: ErrorCopy.PairFailure) -> some View {
        VStack(spacing: 20) {
            VStack(spacing: 8) {
                Text(f.title)
                    .font(.kcTitle)
                    .foregroundStyle(Palette.text)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("pair.errorTitle")
                Text(f.message)
                    .font(.kcSub)
                    .foregroundStyle(Palette.text2)
                    .multilineTextAlignment(.center)
            }
            if f.showAddresses {
                VStack(alignment: .leading, spacing: 6) {
                    Text("TRIED").font(.kcLabel).tracking(1).foregroundStyle(Palette.faint)
                    ForEach(payload.addrs, id: \.self) { Text($0).font(.kcMono).foregroundStyle(Palette.icy) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .card(padding: 14)
            }
            VStack(spacing: 10) {
                if f.canRetry && !payload.isExpired() {
                    Button("Try again", action: pair)
                        .buttonStyle(PrimaryButtonStyle())
                        .accessibilityIdentifier("pair.retry")
                }
                if f.needsNewCode || !f.canRetry {
                    Button {
                        showPaste = true
                    } label: {
                        Label("Paste a new link", systemImage: "link")
                    }
                    .buttonStyle(f.canRetry ? AnyButtonStyle(SecondaryButtonStyle()) : AnyButtonStyle(PrimaryButtonStyle()))
                }
                Button("Cancel") { model.pairingPayload = nil }
                    .buttonStyle(SecondaryButtonStyle())
            }
        }
    }

    private func detailRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label).font(.kcSub).foregroundStyle(Palette.muted)
            Spacer()
            Text(value).font(.kcSubMedium).foregroundStyle(Palette.text).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    private func countdown(_ s: TimeInterval) -> String {
        let total = Int(s)
        if total >= 86_400 { return "in \(total / 86_400) days" }
        if total >= 3600 { return "\(total / 3600)h \((total % 3600) / 60)m" }
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    private func pair() {
        Haptics.tap()
        phase = .connecting
        Task {
            do {
                try await model.client.pair(with: payload)
                Haptics.success()
                phase = .success
                await Notifier.shared.requestAuthorization()
            } catch {
                Haptics.error()
                phase = .failed(ErrorCopy.pairing(error, name: payload.name))
            }
        }
    }
}

/// Type-erased button style so one button can switch between primary and secondary.
struct AnyButtonStyle: ButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: ButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}
