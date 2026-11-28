import Foundation

// The per-user LaunchAgent is the source of truth, not desktop.json.
struct WindowLogin {
    private static let label = "io.github.tannermidd.pi-pocket"
    private static let queue = DispatchQueue(label: "Pi Pocket login item", qos: .utility)

    private static var agent: URL {
        home.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    private static var enabled: Bool {
        guard FileManager.default.fileExists(atPath: agent.path) else { return false }
        let task = Process()
        let output = Pipe()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["print-disabled", "gui/\(getuid())"]
        task.standardOutput = output
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { return true }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        return !lines.contains { line in
            let fields = line.components(separatedBy: "=>")
            guard fields.count == 2,
                fields[0].trimmingCharacters(in: .whitespaces) == "\"\(label)\"" else { return false }
            return ["disabled", "true"].contains(fields[1].trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    private static var legacyHidden: Bool {
        guard let data = try? Data(contentsOf: agent),
            let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
            let args = plist["ProgramArguments"] as? [String]
        else { return false }
        return args.last == "--hidden"
    }

    static func status(_ completion: @escaping (Bool) -> Void) {
        queue.async {
            let value = enabled
            DispatchQueue.main.async { completion(value) }
        }
    }

    static func set(_ on: Bool, completion: @escaping ShellController.Reply) {
        change(on, legacyOnly: false, completion: completion)
    }

    static func prepare(completion: @escaping ShellController.Reply) {
        change(true, legacyOnly: true, completion: completion)
    }

    private static func change(_ on: Bool, legacyOnly: Bool, completion: @escaping ShellController.Reply) {
        queue.async {
            if legacyOnly && (!legacyHidden || !enabled) {
                DispatchQueue.main.async { completion(.success(NSNull())) }
                return
            }
            let task = Process()
            task.executableURL = appFolder.appendingPathComponent("login-item.sh")
            task.arguments = [on ? "on" : "off"]
            task.standardOutput = FileHandle.nullDevice
            task.standardError = FileHandle.nullDevice
            let result: Result<Any, Error>
            do {
                try task.run()
                task.waitUntilExit()
                if task.terminationStatus == 0 { result = .success(enabled) }
                else { result = .failure(shellError("Could not change Launch at login in macOS.")) }
            } catch {
                result = .failure(shellError("Could not change Launch at login in macOS."))
            }
            DispatchQueue.main.async { completion(result) }
        }
    }
}
