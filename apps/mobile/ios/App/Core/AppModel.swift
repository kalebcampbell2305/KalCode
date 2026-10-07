import SwiftUI
import UIKit
import RemoteKit

enum DeviceInfo {
    static let deviceNameKey = "deviceName"

    @MainActor static var name: String {
        UserDefaults.standard.string(forKey: deviceNameKey)?.nonEmpty ?? UIDevice.current.name
    }

    static var model: String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim }
        var info = utsname()
        uname(&info)
        let mirror = Mirror(reflecting: info.machine)
        return mirror.children.reduce(into: "") { out, child in
            if let v = child.value as? Int8, v != 0 { out.append(Character(UnicodeScalar(UInt8(v)))) }
        }
    }

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }

    @MainActor static var idiomNoun: String {
        UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    }
}

/// App-wide state: the one RemoteClient, the router, toasts, pairing and deep links.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    let client: RemoteClient
    let router = Router()
    var toast: Toast?
    /// A validated pairing payload awaiting confirmation (presents the confirm screen).
    var pairingPayload: PairingPayload?
    var pairingNonce = UUID()
    /// Name to show on the Removed screen when the client has none (fixtures only).
    var removedNameOverride: String?
    private(set) var fixtureMode = false

    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var linkTask: Task<Void, Never>?

    private init() {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-kc-reset") {
            PairingStore(store: KeychainStore()).clear()
            if let id = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: id) }
        }
        client = RemoteClient(
            store: KeychainStore(),
            environment: ClientEnvironment(
                deviceName: { MainActor.assumeIsolated { DeviceInfo.name } },
                deviceModel: DeviceInfo.model,
                appVersion: DeviceInfo.appVersion
            )
        )
        #if DEBUG
        if let i = args.firstIndex(of: "-kc-fixture"), i + 1 < args.count {
            fixtureMode = true
            Fixtures.load(args[i + 1], into: self)
        }
        // Design review: `-kc-tab <section>` and `-kc-open <link>` jump straight to a screen.
        if let i = args.firstIndex(of: "-kc-tab"), i + 1 < args.count, let section = AppSection(rawValue: args[i + 1]) {
            router.section = section
        }
        if args.contains("-kc-launch") { router.showLaunch = true }
        if let i = args.firstIndex(of: "-kc-open"), i + 1 < args.count, let url = URL(string: args[i + 1]) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.open(url) }
        }
        #endif
        client.onNotify = { [weak self] note in self?.post(note) }
        Notifier.shared.onOpen = { [weak self] link in self?.open(link) }
        if !fixtureMode { client.start() }
    }

    // MARK: Names

    var workstationName: String {
        client.fleet.workstation?.name?.nonEmpty ?? client.workstation?.name ?? "your workstation"
    }

    var removedName: String {
        client.removedWorkstationName ?? removedNameOverride ?? "Your workstation"
    }

    var liveness: Liveness {
        client.status.isOnline ? .live : Liveness(live: false, frozenAt: client.lastUpdate ?? Date())
    }

    // MARK: Requests

    /// Every operation goes through here (fixture mode answers locally in DEBUG builds only).
    func call<T: Decodable>(_ op: String, _ args: [String: JSONValue] = [:], as type: T.Type = T.self) async throws -> T {
        #if DEBUG
        if fixtureMode, client.status.isOnline {
            return try await FixtureResponder.respond(op, args, model: self, as: T.self)
        }
        #endif
        return try await client.request(op, args, as: T.self)
    }

    func errorText(_ error: Error, target: ErrorCopy.Target = .generic) -> String {
        ErrorCopy.request(error, workstation: workstationName, target: target)
    }

    /// Approve once / Deny for a Needs You item. Returns true when the decision landed.
    @discardableResult
    func decide(_ item: NeedsYouItem, approve: Bool) async -> Bool {
        guard let approvalId = item.approvalId else { return false }
        Haptics.tap()
        do {
            let result: SummaryResult = try await call("needs.decide", ["approvalId": .string(approvalId), "decision": .string(approve ? "approve_once" : "deny")])
            switch result.status {
            case "already_answered":
                // Someone (the desktop, another device) decided first; the snapshot patch removes it.
                Haptics.warning()
                show("Already answered", style: .info)
                if !client.status.isOnline { client.reconnectNow() }
                return false
            case "denied":
                Haptics.success()
                show("Denied", style: .info)
            default:
                Haptics.success()
                show(approve ? "Approved once" : "Denied", style: approve ? .success : .info)
            }
            return true
        } catch {
            Haptics.warning()
            show(errorText(error, target: .needs), style: ErrorCopy.toastStyle(error))
            return false
        }
    }

    // MARK: Toasts

    func show(_ message: String, style: Toast.Style = .info) {
        toastTask?.cancel()
        let t = Toast(message: message, style: style)
        withAnimation(Motion.standard) { toast = t }
        UIAccessibility.post(notification: .announcement, argument: message)
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_200_000_000)
            guard !Task.isCancelled, let self, self.toast?.id == t.id else { return }
            withAnimation(Motion.gentle) { self.toast = nil }
        }
    }

    // MARK: Pairing

    /// Validates a scanned/pasted/opened link. Returns an error message, or nil when the confirm screen opens.
    @discardableResult
    func beginPairing(_ text: String) -> String? {
        do {
            let payload = try PairingLink.parse(text)
            pairingNonce = UUID()
            pairingPayload = payload
            return nil
        } catch let e as PairingLinkError {
            return ErrorCopy.link(e)
        } catch {
            return ErrorCopy.link(.malformed)
        }
    }

    func finishPairing() {
        pairingPayload = nil
        router.reset()
    }

    func unpair() {
        client.unpair()
        router.reset()
    }

    // MARK: Notifications

    private func post(_ note: NotifyMessage) {
        Notifier.shared.post(note, wid: client.workstation?.wid, workstationName: client.workstation?.name)
    }

    // MARK: Deep links

    func open(_ url: URL) {
        guard let link = DeepLink(url: url) else {
            show("That link isn't one KalCode Remote understands.", style: .warning)
            return
        }
        open(link)
    }

    func open(_ link: DeepLink) {
        if case .pair(let text) = link {
            if let message = beginPairing(text) { show(message, style: .error) }
            return
        }
        guard client.workstation != nil || fixtureMode else {
            show("Pair with your workstation first.", style: .info)
            return
        }
        if link == .fleet { router.showFleet(); return }
        linkTask?.cancel()
        linkTask = Task { [weak self] in await self?.resolve(link) }
    }

    /// Waits up to ~5 s for the first snapshot, then opens the exact target or explains why not.
    private func resolve(_ link: DeepLink) async {
        let deadline = Date().addingTimeInterval(5)
        while !client.fleet.hasSnapshot && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if Task.isCancelled { return }
        }
        let fleet = client.fleet
        guard fleet.hasSnapshot else {
            router.showFleet()
            show("Can't open that until \(workstationName) is reachable.", style: .warning)
            return
        }
        switch link {
        case .agent(let id), .diff(let id):
            if fleet.agent(id) != nil {
                if case .diff = link { router.showAgent(id, diff: true) } else { router.showAgent(id) }
            } else {
                router.showFleet()
                show("This agent has finished", style: .info)
            }
        case .needs(let id):
            if let item = fleet.needsYouItem(id) {
                router.showNeeds(item)
            } else {
                router.showFleet()
                show("Already answered", style: .info)
            }
        case .run(let id):
            if fleet.run(id) != nil {
                router.showRun(id)
            } else {
                router.showFleet()
                show("This run has ended", style: .info)
            }
        case .fleet, .pair:
            router.showFleet()
        }
    }
}
