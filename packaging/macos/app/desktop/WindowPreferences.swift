import Cocoa

// A window adapter's state, separate from server config and the WebView profile.
struct WindowPreferences: Codable {
    var titleBar: String? = nil
    var closeToTray: Bool? = nil
    var startHidden: Bool? = nil
    var externalPages: Bool? = nil
    var globalShortcut: Bool? = nil
    var seeThrough: Bool? = nil
    var opacity: Int? = nil
    var material: String? = nil
    var developerTools: Bool? = nil

    static var file: URL {
        if let path = ProcessInfo.processInfo.environment["PI_POCKET_DESKTOP_STATE"], !path.isEmpty {
            return URL(fileURLWithPath: path).appendingPathComponent("window.json")
        }

        return appFolder.appendingPathComponent("desktop/window.json")
    }

    var seamless: Bool { titleBar != "system" }
    var tint: Int { opacity.flatMap { (0...100).contains($0) ? $0 : nil } ?? 82 }

    static func load() -> WindowPreferences {
        if let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 4096,
            let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Self.self, from: data)
        {
            return saved
        }

        var defaults = Self()
        if UserDefaults.standard.string(forKey: "NSWindow Frame Pi Pocket") != nil {
            defaults.titleBar = "system"
        }
        return defaults
    }

    func save() throws {
        let file = Self.file
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(self).write(to: file, options: .atomic)
    }
}
