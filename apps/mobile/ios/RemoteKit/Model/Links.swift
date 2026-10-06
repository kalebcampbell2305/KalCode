import Foundation

/// `kalcode-remote://pair?d=<base64url(JSON)>` (protocol §2).
public struct PairingPayload: Codable, Equatable, Sendable {
    public var v: Int
    public var wid: String
    public var name: String
    public var pk: String
    public var code: String
    public var addrs: [String]
    public var exp: Int

    public var publicKey: Data? { Base64.decode(pk).flatMap { $0.count == 32 ? $0 : nil } }
    public var expiresAt: Date { Date(timeIntervalSince1970: TimeInterval(exp)) }
    public func isExpired(now: Date = Date()) -> Bool { now >= expiresAt }
}

public enum PairingLinkError: Error, Equatable, Sendable {
    case notAPairingLink
    case malformed
    case unsupportedVersion(Int)
    case invalidKey
    case noAddresses
    case expired
}

public enum PairingLink {
    public static let scheme = "kalcode-remote"

    /// Accepts the full link, or the link with whitespace/line breaks pasted around it.
    public static func parse(_ text: String, now: Date = Date()) throws -> PairingPayload {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: "").replacingOccurrences(of: " ", with: "")
        guard let url = URL(string: trimmed), url.scheme?.lowercased() == scheme, url.host?.lowercased() == "pair" else {
            throw PairingLinkError.notAPairingLink
        }
        guard let d = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "d" })?.value,
              let json = Base64.decode(d) else {
            throw PairingLinkError.malformed
        }
        guard let payload = try? JSONDecoder().decode(PairingPayload.self, from: json) else { throw PairingLinkError.malformed }
        guard payload.v == 1 else { throw PairingLinkError.unsupportedVersion(payload.v) }
        guard payload.publicKey != nil, let code = Base64.decode(payload.code), code.count == 32 else {
            throw PairingLinkError.invalidKey
        }
        guard !payload.addrs.compactMap(HostPort.init).isEmpty else { throw PairingLinkError.noAddresses }
        guard !payload.isExpired(now: now) else { throw PairingLinkError.expired }
        return payload
    }
}

/// `"192.168.1.20:47820"` → host + port.
public struct HostPort: Equatable, Hashable, Codable, Sendable, CustomStringConvertible {
    public var host: String
    public var port: UInt16

    public init?(_ text: String) {
        var s = text.trimmingCharacters(in: .whitespaces)
        guard let colon = s.lastIndex(of: ":"), let port = UInt16(s[s.index(after: colon)...]), port > 0 else { return nil }
        s = String(s[..<colon])
        if s.hasPrefix("[") && s.hasSuffix("]") { s = String(s.dropFirst().dropLast()) }
        guard !s.isEmpty else { return nil }
        host = s
        self.port = port
    }

    public var description: String { host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)" }
}

public enum Base64 {
    /// Decodes standard or URL-safe base64, with or without padding.
    public static func decode(_ text: String) -> Data? {
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let rem = s.count % 4
        if rem == 1 { return nil }
        if rem > 0 { s += String(repeating: "=", count: 4 - rem) }
        return Data(base64Encoded: s)
    }

    public static func urlEncode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// Notification and navigation links (protocol §6).
public enum DeepLink: Equatable, Hashable, Sendable {
    case pair(String)   // the full link text; parsed by PairingLink when used
    case agent(String)
    case needs(String)
    case run(String)
    case diff(String)
    case fleet

    public init?(url: URL) {
        guard url.scheme?.lowercased() == PairingLink.scheme, let host = url.host?.lowercased() else { return nil }
        let id = url.pathComponents.filter { $0 != "/" }.first?.removingPercentEncoding
        switch host {
        case "pair": self = .pair(url.absoluteString)
        case "fleet": self = .fleet
        case "agent": guard let id, !id.isEmpty else { return nil }; self = .agent(id)
        case "needs": guard let id, !id.isEmpty else { return nil }; self = .needs(id)
        case "run": guard let id, !id.isEmpty else { return nil }; self = .run(id)
        case "diff": guard let id, !id.isEmpty else { return nil }; self = .diff(id)
        default: return nil
        }
    }

    public init?(string: String) {
        guard let url = URL(string: string) else { return nil }
        self.init(url: url)
    }

    /// Reads the link from a notification's userInfo (`{"kc":{"link":...,"wid":...}}`).
    public init?(userInfo: [AnyHashable: Any]) {
        guard let kc = userInfo["kc"] as? [String: Any], let link = kc["link"] as? String else { return nil }
        self.init(string: link)
    }
}
