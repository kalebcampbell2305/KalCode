import Foundation
import UserNotifications
import RemoteKit

/// Local notifications for `notify` (protocol §6): banners in the foreground, taps routed as deep links.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    /// Set by AppModel; a tap that arrives before it exists (cold launch) is held until then.
    var onOpen: ((DeepLink) -> Void)? {
        didSet {
            if let link = pending, let onOpen { pending = nil; onOpen(link) }
        }
    }
    private var pending: DeepLink?

    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    @discardableResult
    func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func post(_ note: NotifyMessage, wid: String?, workstationName: String?) {
        let content = UNMutableNotificationContent()
        let kind = NotifyKind(note.kind)
        content.title = note.title?.nonEmpty ?? kind.fallbackTitle
        if let body = note.body?.nonEmpty { content.body = body }
        if let subtitle = workstationName?.nonEmpty { content.subtitle = subtitle }
        content.sound = kind.isUrgent ? .default : nil
        content.interruptionLevel = (kind == .deployment || kind == .other) ? .passive : .active
        content.relevanceScore = kind.isUrgent ? 1 : 0.4
        content.threadIdentifier = kind.rawValue
        var kc: [String: String] = [:]
        if let link = note.link { kc["link"] = link }
        if let wid { kc["wid"] = wid }
        content.userInfo = ["kc": kc]
        let request = UNNotificationRequest(identifier: note.id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let link = DeepLink(userInfo: response.notification.request.content.userInfo)
        DispatchQueue.main.async {
            if let link {
                if let open = self.onOpen { open(link) } else { self.pending = link }
            }
            completionHandler()
        }
    }
}

/// `notify.kind` (protocol §8).
enum NotifyKind: String {
    case needsYou = "needs_you"
    case agentFailed = "agent_failed"
    case agentDone = "agent_done"
    case runFailed = "run_failed"
    case deployment
    case other

    init(_ raw: String?) { self = NotifyKind(rawValue: raw ?? "") ?? .other }

    var fallbackTitle: String {
        switch self {
        case .needsYou: return "An agent needs you"
        case .agentFailed: return "An agent failed"
        case .agentDone: return "An agent finished"
        case .runFailed: return "A run failed"
        case .deployment: return "Deployment update"
        case .other: return "KalCode"
        }
    }

    /// Decisions and failures interrupt; outcomes arrive quietly.
    var isUrgent: Bool { self == .needsYou || self == .agentFailed || self == .runFailed }
}
