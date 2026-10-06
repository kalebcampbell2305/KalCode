import SwiftUI
import RemoteKit

struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showScanner = false
    @State private var showPaste = false
    @State private var appeared = false

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: geo.size.height * 0.06)

                    ZStack {
                        Circle()
                            .fill(RadialGradient(colors: [Palette.accent.opacity(0.35), Palette.accent.opacity(0.05), .clear],
                                                 center: .center, startRadius: 4, endRadius: 150))
                            .frame(width: 300, height: 300)
                        Image("KalCodeMascot")
                            .resizable()
                            .interpolation(.high)
                            .scaledToFit()
                            .frame(width: 176, height: 176)
                            .offset(y: appeared || reduceMotion ? 0 : 10)
                    }
                    .accessibilityHidden(true)

                    VStack(spacing: 12) {
                        Text("KalCode Remote")
                            .font(.kcHero)
                            .foregroundStyle(Palette.text)
                            .tracking(-0.5)
                        Text("Mission Control for your agents — approve, steer and ship from anywhere on your network.")
                            .font(.kcBodyLight)
                            .foregroundStyle(Palette.text2)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 360)
                    }
                    .padding(.top, 8)

                    Spacer(minLength: 36)

                    VStack(spacing: 12) {
                        Button {
                            Haptics.tap()
                            showScanner = true
                        } label: {
                            Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .accessibilityIdentifier("welcome.scan")

                        Button {
                            Haptics.tap()
                            showPaste = true
                        } label: {
                            Label("Paste pairing link", systemImage: "link")
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        .accessibilityIdentifier("welcome.paste")
                    }
                    .frame(maxWidth: 420)

                    VStack(spacing: 6) {
                        Text("On your workstation")
                            .font(.kcCaption)
                            .foregroundStyle(Palette.faint)
                        Text("KalCode → Settings → Remote → Pair a device")
                            .font(.kcMonoSmall)
                            .foregroundStyle(Palette.icy)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .frame(maxWidth: 420)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.surface1.opacity(0.8)))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 0.75))
                    .padding(.top, 18)
                    .accessibilityElement(children: .combine)

                    HStack(spacing: 6) {
                        Image(systemName: "lock.fill").font(.system(size: 10))
                        Text("End-to-end encrypted. No cloud account.")
                    }
                    .font(.kcCaption)
                    .foregroundStyle(Palette.faint)
                    .padding(.top, 18)
                    .padding(.bottom, 24)
                }
                .padding(.horizontal, 24)
                .frame(minHeight: geo.size.height)
                .frame(maxWidth: .infinity)
                .opacity(appeared || reduceMotion ? 1 : 0)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Atmosphere(level: .cinematic, nebulaHeight: nil))
        .onAppear {
            withAnimation(.easeOut(duration: reduceMotion ? 0.16 : 0.5)) { appeared = true }
        }
        .fullScreenCover(isPresented: $showScanner) {
            ScannerView { link in
                showScanner = false
                // Present confirm after the scanner has gone.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { model.beginPairing(link) }
            } onPaste: {
                showScanner = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { showPaste = true }
            }
        }
        .sheet(isPresented: $showPaste) {
            PasteLinkSheet { link in
                showPaste = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { model.beginPairing(link) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("welcome.view")
    }
}
