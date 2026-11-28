import Cocoa
import UniformTypeIdentifiers

extension AppDelegate {
    func handleUpdateOperation(_ action: String, _ data: [String: Any], reply: @escaping ShellController.Reply) {
        if action == "updates.openDownload" {
            // The controller supplies only the pinned GitHub artifact link. The browser handles sign-in.
            let url = (data["url"] as? String).flatMap { URL(string: $0) }
            reply(.success(url.map { NSWorkspace.shared.open($0) } ?? false))
            return
        }
        guard let window = settings?.window else { reply(.success(NSNull())); return }
        let picker = NSOpenPanel()
        picker.title = "Select the downloaded desktop installer"
        picker.canChooseFiles = true
        picker.canChooseDirectories = false
        picker.allowsMultipleSelection = false
        picker.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        if let type = UTType(filenameExtension: "pkg") { picker.allowedContentTypes = [type] }
        picker.beginSheetModal(for: window) { result in
            let path = result == .OK ? picker.url?.path : nil
            reply(.success(path as Any? ?? NSNull()))
        }
    }
}

// Call before launching app-owned processes. The helper waits for this process to exit.
func takeStagedDesktopUpdate(hidden: Bool) -> Bool {
    let cache = appFolder.appendingPathComponent("desktop-update-cache")
    let files = FileManager.default

    guard ["pending.json", "applying.json"].contains(where: {
        files.fileExists(atPath: cache.appendingPathComponent($0).path)
    }), let resources = Bundle.main.resourceURL else {
        return false
    }

    let helper = resources.appendingPathComponent("desktop-assets/controller/updates/desktop-updates.mjs")
    let command = Process()
    let output = Pipe()
    var environment = ProcessInfo.processInfo.environment
    environment.removeValue(forKey: "NODE_OPTIONS")
    command.executableURL = appFolder.appendingPathComponent("node/bin/node")
    command.arguments = [helper.path, "handoff", appVersion, Bundle.main.bundlePath, String(getpid())]
        + (hidden ? ["--hidden"] : [])
    command.environment = environment
    command.standardOutput = output
    command.standardError = FileHandle.nullDevice

    do {
        try command.run()
    } catch {
        // Let the app give its usual repair advice if the install is incomplete.
        return false
    }

    // Handoff does not fetch or hash the installer. It only claims a lock and starts the helper.
    command.waitUntilExit()
    guard command.terminationStatus == 0,
        let state = try? JSONSerialization.jsonObject(with: output.fileHandleForReading.readDataToEndOfFile())
            as? [String: String]
    else {
        return false
    }

    return state["phase"] == "handoff" || state["phase"] == "busy"
}
