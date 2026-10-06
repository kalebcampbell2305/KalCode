import CryptoKit
import Foundation
import Security

/// Secret storage. Production uses the Keychain with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (never synced, never in backups).
public protocol SecretStore: AnyObject {
    func read(_ key: String) -> Data?
    func write(_ key: String, _ value: Data) throws
    func delete(_ key: String)
}

public struct KeychainError: Error, Equatable { public let status: OSStatus }

public final class KeychainStore: SecretStore {
    private let service: String

    public init(service: String = "com.kalcode.remote") { self.service = service }

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    public func read(_ key: String) -> Data? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    public func write(_ key: String, _ value: Data) throws {
        delete(key)
        var q = query(key)
        q[kSecValueData as String] = value
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func delete(_ key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }
}

public final class MemorySecretStore: SecretStore {
    private var values: [String: Data] = [:]
    public init() {}
    public func read(_ key: String) -> Data? { values[key] }
    public func write(_ key: String, _ value: Data) throws { values[key] = value }
    public func delete(_ key: String) { values[key] = nil }
}

/// The pinned workstation (stored in the Keychain as JSON).
public struct PairedWorkstation: Codable, Equatable, Sendable {
    public var wid: String
    public var name: String
    public var publicKey: Data
    public var addrs: [String]
    public var deviceId: String?
    public var pairedAt: Date
    public var host: HostInfo?

    public init(wid: String, name: String, publicKey: Data, addrs: [String], deviceId: String?, pairedAt: Date, host: HostInfo?) {
        self.wid = wid; self.name = name; self.publicKey = publicKey; self.addrs = addrs
        self.deviceId = deviceId; self.pairedAt = pairedAt; self.host = host
    }

    public var endpoints: [HostPort] { addrs.compactMap(HostPort.init) }
}

/// Device identity + pinned workstation persistence.
public final class PairingStore {
    private let store: SecretStore
    private static let deviceKeyKey = "remote.device-key"
    private static let workstationKey = "remote.workstation"

    public init(store: SecretStore) { self.store = store }

    /// The device's X25519 static key; created on first use. The private half never leaves the Keychain.
    public func deviceKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        if let raw = store.read(Self.deviceKeyKey), let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw) {
            return key
        }
        let key = Curve25519.KeyAgreement.PrivateKey()
        try store.write(Self.deviceKeyKey, key.rawRepresentation)
        return key
    }

    public func workstation() -> PairedWorkstation? {
        guard let data = store.read(Self.workstationKey) else { return nil }
        return try? JSONDecoder().decode(PairedWorkstation.self, from: data)
    }

    public func save(_ workstation: PairedWorkstation) throws {
        try store.write(Self.workstationKey, JSONEncoder().encode(workstation))
    }

    /// Forgets the workstation and the device identity. A new pairing gets a fresh key, so a
    /// revoked key is never reused.
    public func clear() {
        store.delete(Self.workstationKey)
        store.delete(Self.deviceKeyKey)
    }
}
