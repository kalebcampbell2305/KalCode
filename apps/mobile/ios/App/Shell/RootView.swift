import SwiftUI
import RemoteKit

private struct PairingRequest: Identifiable {
    let id: UUID
    let payload: PairingPayload
}

private struct SplitPaneKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    /// True inside the iPad split panes: navigation selects panes instead of pushing.
    var isSplitPane: Bool {
        get { self[SplitPaneKey.self] }
        set { self[SplitPaneKey.self] = newValue }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let pairing = Binding<PairingRequest?>(
            get: { model.pairingPayload.map { PairingRequest(id: model.pairingNonce, payload: $0) } },
            set: { if $0 == nil { model.pairingPayload = nil } }
        )
        ZStack {
            Palette.bg.ignoresSafeArea()
            content
                .transition(.opacity)
        }
        .animation(Motion.standard(reduceMotion), value: phaseKey)
        .overlay(alignment: .top) {
            if let toast = model.toast {
                ToastView(toast: toast)
                    .padding(.top, 6)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                    .onTapGesture { withAnimation(Motion.quick) { model.toast = nil } }
                    .zIndex(10)
            }
        }
        .fullScreenCover(item: pairing) { request in
            PairConfirmView(payload: request.payload)
                .environment(model)
                .environment(\.liveness, .live)
        }
        .environment(\.liveness, model.liveness)
    }

    private var phaseKey: Int {
        switch model.client.status {
        case .unpaired: return 0
        case .removed: return 1
        default: return 2
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.client.status {
        case .unpaired:
            WelcomeView()
        case .removed:
            RemovedView()
        default:
            // Stacked (not a safe-area inset) so the shell's own bars lay out below the badge.
            VStack(spacing: 0) {
                if model.isDemo {
                    DemoBadge()
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                if sizeClass == .regular {
                    PadShell()
                } else {
                    PhoneShell()
                }
            }
        }
    }
}

/// The persistent marker for the in-app demo; its menu leaves the demo.
struct DemoBadge: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            Section("Simulated on this \(DeviceInfo.idiomNoun). Nothing connects to your network.") {
                Button {
                    model.exitDemo()
                } label: {
                    Label("Exit demo", systemImage: "arrow.uturn.backward")
                }
                .accessibilityIdentifier("demo.exit")
            }
        } label: {
            HStack(spacing: 7) {
                Circle()
                    .fill(Palette.amber)
                    .frame(width: 6, height: 6)
                    .shadow(color: Palette.amber.opacity(0.8), radius: 3)
                Text("DEMO")
                    .font(.kcLabel)
                    .tracking(1.2)
                    .foregroundStyle(Palette.amberText)
                Text("Simulated workstation")
                    .font(.kcCaption)
                    .foregroundStyle(Palette.text2)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(Palette.amber.opacity(0.10)))
            .overlay(Capsule().strokeBorder(Palette.amber.opacity(0.32), lineWidth: 0.75))
            .contentShape(Capsule())
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .padding(.bottom, 4)
        .accessibilityLabel("Demo: simulated workstation")
        .accessibilityHint("Opens a menu to exit the demo")
        .accessibilityIdentifier("demo.badge")
    }
}

// MARK: - Shared route destinations

struct RouteDestinations: ViewModifier {
    func body(content: Content) -> some View {
        content.navigationDestination(for: Route.self) { route in
            switch route {
            case .agent(let id): AgentDetailView(agentId: id)
            case .diff(let id): DiffView(agentId: id)
            case .log(let id): AgentLogView(agentId: id)
            case .run(let id): RunDetailView(runId: id)
            case .settings: SettingsView()
            }
        }
    }
}

extension View {
    func routeDestinations() -> some View { modifier(RouteDestinations()) }
}
