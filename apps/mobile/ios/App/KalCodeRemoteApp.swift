import SwiftUI
import UIKit
import RemoteKit

@main
struct KalCodeRemoteApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Chrome.install()
        // One model per process even if SwiftUI re-creates the App value (launch args such as
        // -kc-reset must run exactly once).
        _model = State(initialValue: AppModel.shared)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(Palette.accent)
                .onOpenURL { model.open($0) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                BackgroundLinger.shared.end()
                if !model.isSimulated { model.client.reconnectNow() }
            case .background:
                // Keep the session briefly so a just-sent prompt lands and notifications still arrive.
                BackgroundLinger.shared.begin()
            default:
                break
            }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Notifier.shared.install()
        return true
    }
}

/// A short `beginBackgroundTask` window after the app leaves the foreground.
@MainActor
final class BackgroundLinger {
    static let shared = BackgroundLinger()
    private var task: UIBackgroundTaskIdentifier = .invalid
    private var timer: Task<Void, Never>?

    func begin() {
        guard task == .invalid else { return }
        task = UIApplication.shared.beginBackgroundTask(withName: "kalcode.remote.linger") { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
        timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 25_000_000_000)
            self?.end()
        }
    }

    func end() {
        timer?.cancel()
        timer = nil
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
    }
}
