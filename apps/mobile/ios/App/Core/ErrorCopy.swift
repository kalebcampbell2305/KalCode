import Foundation
import RemoteKit

/// Human copy for every error the protocol layer can produce. The desktop's `message` wins
/// when present (it carries the safety rule's reason).
enum ErrorCopy {
    enum Target { case agent, needs, run, generic }

    static func request(_ error: Error, workstation: String, target: Target = .generic) -> String {
        guard let e = error as? RemoteRequestError else {
            if error is CancellationError { return "Cancelled." }
            return "Something went wrong. Try again."
        }
        switch e {
        case let .remote(code, message):
            if code == "not_found" {
                switch target {
                case .agent: return "This agent has finished."
                case .needs: return "Already answered."
                case .run: return "This run has ended."
                case .generic: return message?.nonEmpty ?? "That no longer exists on \(workstation)."
                }
            }
            if e.isRateLimited { return "Slow down — \(workstation) limits how fast actions can be sent. Try again in a minute." }
            if code == "conflict" { return "The state changed — refreshed." }
            if let message = message?.nonEmpty { return message }
            switch code {
            case "conflict": return "The state changed — refreshed."
            case "refused": return "KalCode declined this for safety."
            case "not_entitled": return "KalCode Remote isn't enabled for this account on \(workstation)."
            case "unavailable": return "That isn't available on \(workstation) right now."
            case "invalid": return "KalCode couldn't read that request."
            default: return "Something went wrong on \(workstation)."
            }
        case .notConnected: return "Not connected to \(workstation)."
        case .queueExpired: return "\(workstation) didn't come back within a minute, so this wasn't sent."
        case .connectionLost: return "The connection dropped before KalCode confirmed. Check before trying again."
        case .timeout: return "\(workstation) didn't answer in time."
        case .invalidResponse: return "KalCode sent an answer this app doesn't understand. Update KalCode Remote."
        case .tooLarge: return "That message is too long to send."
        }
    }

    static func isNotFound(_ error: Error) -> Bool { (error as? RemoteRequestError)?.code == "not_found" }
    static func isConflict(_ error: Error) -> Bool { (error as? RemoteRequestError)?.code == "conflict" }

    /// Calm styling for expected outcomes: gone targets are info, rate limits and conflicts amber.
    static func toastStyle(_ error: Error) -> Toast.Style {
        guard let e = error as? RemoteRequestError else { return .error }
        if e.code == "not_found" { return .info }
        if e.isRateLimited || e.code == "conflict" || e == .queueExpired { return .warning }
        return .error
    }

    // MARK: Pairing

    struct PairFailure: Equatable {
        var title: String
        var message: String
        var showAddresses = false
        var canRetry = true
        /// The code itself is dead; the person needs a new one from the workstation.
        var needsNewCode = false
    }

    static func pairing(_ error: Error, name: String) -> PairFailure {
        if let r = error as? HandshakeRejection {
            switch r {
            case .pairingExpired:
                return PairFailure(title: "This code was used or has expired",
                                   message: "Pairing codes work once and only for a few minutes. On \(name), show a new code and scan it again.",
                                   canRetry: false, needsNewCode: true)
            case .notEntitled:
                return PairFailure(title: "Remote isn't enabled on this workstation",
                                   message: "\(name) hasn't enabled KalCode Remote for this account. Turn it on in KalCode on your workstation, then pair again.",
                                   canRetry: false)
            case .version:
                return PairFailure(title: "Update needed",
                                   message: "This app and KalCode on \(name) speak different Remote versions. Update both to the latest release.",
                                   canRetry: false)
            case .busy:
                return PairFailure(title: "\(name) is busy",
                                   message: "Another device is connecting right now. Try again in a moment.")
            case .invalid:
                return PairFailure(title: "\(name) couldn't accept this device",
                                   message: "Its details were refused. Update KalCode Remote and KalCode, then show a new pairing code.",
                                   canRetry: false, needsNewCode: true)
            case .revoked, .unpaired, .unknown:
                return PairFailure(title: "\(name) declined the pairing",
                                   message: "Show a new pairing code on your workstation and try again.",
                                   canRetry: false, needsNewCode: true)
            }
        }
        if let l = error as? PairingLinkError {
            switch l {
            case .expired:
                return PairFailure(title: "This code has expired",
                                   message: "On \(name), show a new pairing code and scan it again.",
                                   canRetry: false, needsNewCode: true)
            default:
                return PairFailure(title: "This pairing code isn't valid", message: link(l), canRetry: false, needsNewCode: true)
            }
        }
        return PairFailure(title: "Can't reach \(name)",
                           message: "Make sure this device is on the same Wi‑Fi or Tailscale network as your workstation and that KalCode is open.",
                           showAddresses: true)
    }

    static func link(_ error: PairingLinkError) -> String {
        switch error {
        case .notAPairingLink: return "That isn't a KalCode pairing link. It starts with kalcode-remote://pair"
        case .malformed: return "This link is incomplete. Copy the whole link from your workstation."
        case .unsupportedVersion: return "This link needs a newer version of KalCode Remote. Update the app and try again."
        case .invalidKey: return "This link's security key isn't valid. Show a new pairing code on your workstation."
        case .noAddresses: return "This link doesn't include an address to reach your workstation."
        case .expired: return "This pairing link has expired. Show a new code on your workstation."
        }
    }

    // MARK: Connection

    static func offline(_ reason: OfflineReason, name: String) -> (title: String, detail: String) {
        switch reason {
        case .unreachable:
            return ("\(name) isn't reachable", "Check that it's awake, KalCode is open, and you're on the same network or Tailscale.")
        case .shutdown:
            return ("KalCode closed on \(name)", "It reconnects automatically when KalCode opens again.")
        case .disabled:
            return ("Remote is turned off on \(name)", "Turn it on in KalCode → Settings → Remote.")
        case .notEntitled:
            return ("Remote isn't enabled on this workstation", "\(name) hasn't enabled KalCode Remote for this account. Turn it on in KalCode on your workstation, then pair again.")
        case .versionMismatch:
            return ("Update needed", "This app and KalCode on \(name) speak different versions. Update both to the latest.")
        case .replaced:
            return ("This device connected from somewhere else", "A newer session from this device took over. Try again to reconnect here.")
        case .invalidHello:
            return ("\(name) didn't accept this device's details", "Try a shorter device name in Settings, then try again.")
        }
    }
}
