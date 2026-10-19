import CryptoKit
import Foundation
import Security

private let fileMagic = Data("DPET1\n".utf8)
private let vaultService = "ai.deskpet.vaultkey"
private let vaultAccount = "data-protection-v1"
private let providerSecretService = "com.deskpet.providerSecrets"

private struct CategorySpec {
    let id: String
    let relativePath: String
    let containsSecrets: Bool
}

private let categorySpecs = [
    CategorySpec(id: "conversations", relativePath: "conversations.json", containsSecrets: false),
    CategorySpec(id: "memory", relativePath: "memories.json", containsSecrets: false),
    CategorySpec(id: "tasks", relativePath: "tasks.json", containsSecrets: false),
    CategorySpec(id: "relationship", relativePath: "relationship.json", containsSecrets: false),
    CategorySpec(id: "schedules", relativePath: "scheduled_tasks.json", containsSecrets: false),
    CategorySpec(id: "providers", relativePath: "providers.json", containsSecrets: true),
    CategorySpec(id: "appearance", relativePath: "preferences.json", containsSecrets: false),
    CategorySpec(id: "live2d-model", relativePath: "Characters/Live2D/characters.json", containsSecrets: false),
]

private enum HelperError: Error, CustomStringConvertible {
    case usage
    case keyUnavailable(OSStatus)
    case invalidVaultKey
    case malformedEnvelope
    case badEnvelope
    case invalidJSON(String)
    case outputFailure

    var description: String {
        switch self {
        case .usage: return "usage: DeskPetMigrationHelper <preview|export> --source <directory> [--include-secrets --secrets-fd <fd>]"
        case .keyUnavailable(let status): return "native-vault-key-unavailable:\(status)"
        case .invalidVaultKey: return "native-vault-key-invalid"
        case .malformedEnvelope: return "native-store-envelope-malformed"
        case .badEnvelope: return "native-store-authentication-failed"
        case .invalidJSON(let file): return "native-store-json-invalid:\(file)"
        case .outputFailure: return "helper-output-failed"
        }
    }
}

private struct Arguments {
    let command: String
    let source: URL
    let includeSecrets: Bool
    let secretsFD: Int32?

    static func parse() throws -> Self {
        let values = Array(CommandLine.arguments.dropFirst())
        guard let command = values.first, command == "preview" || command == "export" else {
            throw HelperError.usage
        }
        var source: String?
        var includeSecrets = false
        var secretsFD: Int32?
        var index = 1
        while index < values.count {
            switch values[index] {
            case "--source":
                index += 1
                guard index < values.count else { throw HelperError.usage }
                source = values[index]
            case "--include-secrets":
                includeSecrets = true
            case "--secrets-fd":
                index += 1
                guard index < values.count, let parsed = Int32(values[index]) else { throw HelperError.usage }
                secretsFD = parsed
            default:
                throw HelperError.usage
            }
            index += 1
        }
        guard let source else { throw HelperError.usage }
        if includeSecrets && secretsFD == nil { throw HelperError.usage }
        return Self(command: command,
                    source: URL(fileURLWithPath: source, isDirectory: true).standardizedFileURL,
                    includeSecrets: includeSecrets,
                    secretsFD: secretsFD)
    }
}

private func keychainData(service: String, account: String, synchronizable: Bool? = nil) throws -> Data? {
    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
    ]
    if let synchronizable { query[kSecAttrSynchronizable as String] = synchronizable }
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw HelperError.keyUnavailable(status) }
    return item as? Data
}

private func open(_ data: Data, vaultKey: inout SymmetricKey?) throws -> Data {
    guard data.starts(with: fileMagic) else { return data }
    if vaultKey == nil {
        guard let keyData = try keychainData(service: vaultService, account: vaultAccount, synchronizable: false) else {
            throw HelperError.keyUnavailable(errSecItemNotFound)
        }
        guard keyData.count == 32 else { throw HelperError.invalidVaultKey }
        vaultKey = SymmetricKey(data: keyData)
    }
    let encoded = data.dropFirst(fileMagic.count)
    guard let combined = Data(base64Encoded: Data(encoded)),
          let box = try? AES.GCM.SealedBox(combined: combined) else {
        throw HelperError.malformedEnvelope
    }
    do {
        return try AES.GCM.open(box, using: vaultKey!)
    } catch {
        throw HelperError.badEnvelope
    }
}

private func stableDigest(root: URL) throws -> String {
    var hasher = SHA256()
    for spec in categorySpecs {
        let url = root.appendingPathComponent(spec.relativePath).standardizedFileURL
        guard FileManager.default.fileExists(atPath: url.path) else { continue }
        hasher.update(data: Data(spec.relativePath.utf8))
        hasher.update(data: try Data(contentsOf: url, options: [.mappedIfSafe, .uncached]))
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

private func countItems(_ value: Any, category: String) -> Int {
    if let items = value as? [Any] { return items.count }
    if category == "providers", let object = value as? [String: Any], let providers = object["providers"] as? [Any] {
        return providers.count
    }
    if category == "live2d-model", let object = value as? [String: Any] {
        return object["character"] is NSNull || object["character"] == nil ? 0 : 1
    }
    return value is NSNull ? 0 : 1
}

private func collectSecretIDs(from value: Any) -> [String] {
    guard let object = value as? [String: Any], let providers = object["providers"] as? [[String: Any]] else { return [] }
    return providers.compactMap { provider in
        guard let id = provider["apiKeySecretID"] as? String, !id.isEmpty else { return nil }
        return id
    }
}

private func jsonData(_ object: Any) throws -> Data {
    guard JSONSerialization.isValidJSONObject(object) else { throw HelperError.outputFailure }
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

private func write(_ object: Any, to handle: FileHandle) throws {
    let data = try jsonData(object)
    do {
        try handle.write(contentsOf: data)
        try handle.write(contentsOf: Data("\n".utf8))
    } catch {
        throw HelperError.outputFailure
    }
}

private func run() throws {
    let arguments = try Arguments.parse()
    var vaultKey: SymmetricKey?
    var values: [String: Any] = [:]
    var categories: [[String: Any]] = []
    var warnings: [String] = []
    var secretIDs: [String] = []

    for spec in categorySpecs {
        let url = arguments.source.appendingPathComponent(spec.relativePath).standardizedFileURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            categories.append(["id": spec.id, "count": 0, "containsSecrets": spec.containsSecrets])
            continue
        }
        do {
            let plaintext = try open(Data(contentsOf: url, options: [.mappedIfSafe, .uncached]), vaultKey: &vaultKey)
            let value = try JSONSerialization.jsonObject(with: plaintext)
            categories.append(["id": spec.id, "count": countItems(value, category: spec.id), "containsSecrets": spec.containsSecrets])
            if arguments.command == "export" { values[spec.id] = value }
            if spec.id == "providers" { secretIDs = collectSecretIDs(from: value) }
        } catch {
            categories.append(["id": spec.id, "count": 0, "containsSecrets": spec.containsSecrets])
            warnings.append("\(spec.id):\(error)")
        }
    }

    let digest = try stableDigest(root: arguments.source)
    let output: [String: Any] = [
        "version": 1,
        "sourcePath": arguments.source.path,
        "sourceDigest": digest,
        "categories": categories,
        "requiresKeychainConfirmation": !secretIDs.isEmpty,
        "warnings": warnings,
        "values": arguments.command == "export" ? values : [:],
    ]
    try write(output, to: .standardOutput)

    if arguments.includeSecrets, let fd = arguments.secretsFD {
        var secrets: [String: String] = [:]
        var secretWarnings: [String] = []
        for secretID in secretIDs {
            do {
                if let data = try keychainData(service: providerSecretService, account: secretID),
                   let value = String(data: data, encoding: .utf8), !value.isEmpty {
                    secrets[secretID] = value
                } else {
                    secretWarnings.append("missing:\(secretID)")
                }
            } catch {
                secretWarnings.append("unavailable:\(secretID)")
            }
        }
        try write(["version": 1, "secrets": secrets, "warnings": secretWarnings],
                  to: FileHandle(fileDescriptor: fd, closeOnDealloc: false))
    }
}

do {
    try run()
} catch {
    let message = error is HelperError ? String(describing: error) : "helper-failed:\(error)"
    try? FileHandle.standardError.write(contentsOf: Data("\(message)\n".utf8))
    exit(1)
}
