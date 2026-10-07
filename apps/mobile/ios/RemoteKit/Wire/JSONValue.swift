import Foundation

/// A loosely typed JSON value for request args and the few result fields whose shape the
/// protocol leaves open (log entries, run logs, worktree info).
public enum JSONValue: Codable, Equatable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n):
            if n.rounded() == n, abs(n) < 9.0e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? {
        switch self {
        case .string(let s): return s
        case .number(let n): return n.rounded() == n ? String(Int64(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }

    public var numberValue: Double? {
        if case .number(let n) = self { return n }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    public var isNull: Bool { self == .null }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(nilLiteral: ()) { self = .null }
}

/// RFC 3339 timestamps as the desktop writes them (any fractional precision, `Z` or offset).
public enum RFC3339 {
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public static func parse(_ string: String) -> Date? {
        // Strip any fractional seconds, parse the rest, then add the fraction back. This accepts
        // nanosecond precision (chrono) which ISO8601DateFormatter rejects.
        guard let tIndex = string.firstIndex(where: { $0 == "T" || $0 == "t" || $0 == " " }) else { return nil }
        var fraction = 0.0
        var cleaned = string
        if let dot = string[tIndex...].firstIndex(of: ".") {
            var end = string.index(after: dot)
            while end < string.endIndex, string[end].isNumber { end = string.index(after: end) }
            let digits = string[string.index(after: dot)..<end]
            if !digits.isEmpty { fraction = Double("0." + digits) ?? 0 }
            cleaned = String(string[..<dot]) + String(string[end...])
        }
        cleaned = cleaned.replacingOccurrences(of: " ", with: "T")
        if cleaned.hasSuffix("z") { cleaned = String(cleaned.dropLast()) + "Z" }
        guard let date = plain.date(from: cleaned) else { return nil }
        return date.addingTimeInterval(fraction)
    }

    public static func format(_ date: Date) -> String { plain.string(from: date) }
}

public extension JSONDecoder {
    /// The decoder every protocol message goes through.
    static var remote: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self), let date = RFC3339.parse(s) { return date }
            if let n = try? c.decode(Double.self) { return Date(timeIntervalSince1970: n > 1e11 ? n / 1000 : n) }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not an RFC 3339 timestamp")
        }
        return d
    }
}

/// Decodes an array element by element, dropping items that don't decode instead of failing the
/// whole message. One malformed agent must never blank the fleet.
public struct LossyArray<Element: Decodable>: Decodable {
    public var elements: [Element]

    public init(_ elements: [Element] = []) { self.elements = elements }

    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !c.isAtEnd {
            if let item = try? c.decode(Element.self) {
                out.append(item)
            } else {
                _ = try? c.decode(JSONValue.self)
            }
        }
        elements = out
    }
}
