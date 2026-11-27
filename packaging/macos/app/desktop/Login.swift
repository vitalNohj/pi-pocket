import Foundation

// Reads the OS registration. The same script is used by the per-user installer and uninstaller.
struct WindowLogin {
    static var agent: URL {
        home.appendingPathComponent("Library/LaunchAgents/io.github.tannermidd.pi-pocket.plist")
    }

    static var enabled: Bool { FileManager.default.fileExists(atPath: agent.path) }

    static var legacyHidden: Bool {
        guard let data = try? Data(contentsOf: agent),
            let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
            let args = plist["ProgramArguments"] as? [String]
        else { return false }
        return args.last == "--hidden"
    }

    static func set(_ on: Bool, completion: @escaping (Bool) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            let task = Process()
            task.executableURL = appFolder.appendingPathComponent("login-item.sh")
            task.arguments = [on ? "on" : "off"]
            let ok: Bool
            do {
                try task.run()
                task.waitUntilExit()
                ok = task.terminationStatus == 0
            } catch {
                ok = false
            }
            DispatchQueue.main.async { completion(ok) }
        }
    }
}
