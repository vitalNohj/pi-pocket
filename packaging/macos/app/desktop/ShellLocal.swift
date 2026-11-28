import Cocoa
import Foundation

struct LocalLaunchSettings {
    let data: String
    let folder: String
    let port: Int
    let access: String
    var dataRoot: URL { URL(fileURLWithPath: data, isDirectory: true) }
    var snapshot: [String: Any] { ["data": data, "cwd": folder, "port": port, "access": access] }

    init(_ fields: [String: Any]) throws {
        guard let data = fields["data"] as? String, data.hasPrefix("/"),
            let folder = fields["cwd"] as? String, folder.hasPrefix("/"),
            let port = fields["port"] as? Int, (1...65535).contains(port),
            let access = fields["access"] as? String, ["local", "lan", "tailscale", "cloudflare"].contains(access) else {
            throw shellError("The local server settings are invalid.")
        }
        self.data = data
        self.folder = folder
        self.port = port
        self.access = access
    }
}

struct LocalServer {
    let data: URL
    let address: URL
    let pid: pid_t
    let verified: Bool
}

private struct LocalProcess {
    let parent: pid_t
    let user: uid_t
    let start: Date
    let name: String

    init?(_ pid: pid_t) {
        guard let line = commandOutput("/bin/ps", ["-p", String(pid), "-o", "ppid=,uid=,lstart=,comm="]) else { return nil }
        let parts = line.split(whereSeparator: \.isWhitespace)
        let date = DateFormatter()

        date.locale = Locale(identifier: "en_US_POSIX")
        date.dateFormat = "EEE MMM d HH:mm:ss yyyy"
        guard parts.count >= 8, let parent = pid_t(parts[0]), let user = uid_t(parts[1]),
            let start = date.date(from: parts[2...6].joined(separator: " ")) else { return nil }
        self.parent = parent
        self.user = user
        self.start = start
        name = (parts[7...].joined(separator: " ") as NSString).lastPathComponent
    }
}

private func commandOutput(_ executable: String, _ arguments: [String]) -> String? {
    let process = Process()
    let output = Pipe()
    var environment = ProcessInfo.processInfo.environment

    environment["LC_ALL"] = "C"
    process.environment = environment
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let data = output.fileHandleForReading.readDataToEndOfFile()

    process.waitUntilExit()
    return process.terminationStatus == 0 ? String(data: data, encoding: .utf8) : nil
}

// Use a literal local interface, never a name that DNS could move to another computer.
private func localInterface(_ host: String) -> Bool {
    var head: UnsafeMutablePointer<ifaddrs>?

    guard getifaddrs(&head) == 0, let first = head else { return false }
    defer { freeifaddrs(first) }
    var item: UnsafeMutablePointer<ifaddrs>? = first
    while let found = item {
        item = found.pointee.ifa_next
        guard let address = found.pointee.ifa_addr,
            address.pointee.sa_family == UInt8(AF_INET) || address.pointee.sa_family == UInt8(AF_INET6) else { continue }
        var label = [CChar](repeating: 0, count: Int(NI_MAXHOST))

        if getnameinfo(address, socklen_t(address.pointee.sa_len), &label, socklen_t(label.count), nil, 0, NI_NUMERICHOST) == 0,
            String(cString: label) == host { return true }
    }
    return false
}

func runningServer(data: URL, pid: pid_t? = nil) -> LocalServer? {
    let record = data.appendingPathComponent("launcher-running.json")
    guard let metadata = try? record.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]),
        metadata.isRegularFile == true, let size = metadata.fileSize, size <= 4096, let changed = metadata.contentModificationDate,
        let data = try? Data(contentsOf: record), data.count <= 4096,
        let running = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], running["version"] as? Int == 1,
        let found = running["pid"] as? Int, found > 0, found <= Int(Int32.max), pid == nil || pid == pid_t(found),
        let address = running["url"] as? String, let url = URL(string: address), let rawHost = url.host,
        let port = url.port, (1...65535).contains(port), ["http", "https"].contains(url.scheme ?? ""),
        url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
        localInterface(rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))),
        let parent = LocalProcess(pid_t(found)), parent.name == "node", parent.user == getuid(), parent.start <= changed.addingTimeInterval(1),
        let info = try? request("GET", url.appendingPathComponent("api/pocket/info"), token: nil),
        let identity = (try? JSONSerialization.jsonObject(with: info)) as? [String: Any], identity["name"] as? String == "pi-pocket"
    else { return nil }

    let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    let endpoint = host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
    let listeners = commandOutput("/usr/sbin/lsof", ["-nP", "-a", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpn"]) ?? ""
    var listener: pid_t = 0
    var exact: Set<pid_t> = []
    var wildcard: Set<pid_t> = []
    for line in listeners.split(separator: "\n") {
        if line.hasPrefix("p") { listener = pid_t(line.dropFirst()) ?? 0 }
        if listener <= 0 { continue }
        if line == "n\(endpoint)" { exact.insert(listener) }
        if line == "n*:\(port)" { wildcard.insert(listener) }
    }
    let candidates = exact.isEmpty ? wildcard : exact
    let owner = candidates.count == 1 ? candidates.first : nil
    let verified = owner.map { listener in
        if listener == pid_t(found) { return true }
        guard let child = LocalProcess(listener), child.parent == pid_t(found), child.user == getuid(), child.start >= parent.start else { return false }
        return child.name == "node"
    } ?? false
    return LocalServer(data: data, address: url, pid: pid_t(found), verified: verified)
}

func verifiedOwnerRequest(_ local: LocalServer, _ route: String) throws -> Data {
    guard local.verified, let server = runningServer(data: local.data, pid: local.pid), server.address == local.address, server.verified else {
        throw shellError("The local listener is not verified.")
    }
    return try request("POST", server.address.appendingPathComponent(route), token: try ownerToken(local.data))
}

extension AppDelegate {
    func localSnapshot(_ status: String, server: LocalServer? = nil, message: String? = nil) -> [String: Any] {
        let owned = launcher?.isRunning == true && (server == nil || launcher?.processIdentifier == server?.pid)
        var result: [String: Any] = ["status": status, "owned": owned, "verified": server?.verified ?? false]

        if let server = server {
            result["address"] = server.address.absoluteString
            if owned { result["settings"] = launcherSettings?.snapshot }
        }
        if let message = message { result["message"] = message }
        else if server?.verified == false { result["message"] = "The app could not verify the listener. Sign in inside the app." }
        return result
    }

    private func reuseLocal(data: URL) -> LocalServer? {
        if let process = launcher, process.isRunning, let settings = launcherSettings {
            return runningServer(data: settings.dataRoot, pid: process.processIdentifier)
        }
        return runningServer(data: data)
    }

    func inspectLocal(data: URL) -> [String: Any] {
        local = reuseLocal(data: data)
        return localSnapshot(local == nil ? "stopped" : "running", server: local)
    }

    func openLocal(_ wanted: LocalLaunchSettings, replace: Bool) throws -> [String: Any] {
        if quitting { return localSnapshot("stopped") }
        if replace {
            guard let owned = launcher, owned.isRunning else {
                throw shellError("Only a server started by this app can apply these settings.")
            }
            if let server = runningServer(data: wanted.dataRoot), server.pid != owned.processIdentifier {
                throw shellError("Another launcher is using that data folder. Choose a different folder or stop the other launcher yourself.")
            }
        } else if let server = reuseLocal(data: wanted.dataRoot) {
            local = server
            return localSnapshot("running", server: server)
        }
        if let problem = packageProblem() {
            return localProblem("\(problem.title) \(problem.advice)")
        }
        if replace { try stopLocal() }
        do {
            if launcher?.isRunning != true { try startLauncher(wanted) }
        } catch {
            return localProblem("Pi Pocket could not start. Check the server log or install again.")
        }

        let settings = launcherSettings ?? wanted
        let start = Date()
        while !quitting && Date().timeIntervalSince(start) < 6 * 60 {
            guard let process = launcher, process.isRunning else { break }
            if let server = runningServer(data: settings.dataRoot, pid: process.processIdentifier) {
                local = server
                return localSnapshot("running", server: server)
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return localProblem(launcherStartProblem(settings))
    }

    private func launcherStartProblem(_ settings: LocalLaunchSettings) -> String {
        // Recognize only fixed launcher diagnostics. Do not send log output or paths to Settings.
        if let file = try? FileHandle(forReadingFrom: logFile) {
            defer { try? file.close() }
            if let size = try? file.seekToEnd(), (try? file.seek(toOffset: size > 8192 ? size - 8192 : 0)) != nil,
                let data = try? file.read(upToCount: 8192) {
                let tail = String(decoding: data, as: UTF8.self)
                if tail.contains("Tailscale is not connected on this machine.") {
                    return "Tailscale is not connected. Connect Tailscale, then start Pi Pocket again."
                }
                if tail.contains("cloudflared is not installed.") {
                    return "Cloudflare Tunnel needs cloudflared. Install it, then start Pi Pocket again."
                }
                if tail.contains("Port \(settings.port) is already in use") {
                    return "The port is in use. Choose a different port or connect to a known server from Another server."
                }
            }
        }
        return "Pi Pocket did not get ready with these settings. Check the server log."
    }

    func pickLocalFolder(_ data: [String: Any], reply: @escaping ShellController.Reply) {
        guard let window = settings?.window, window.isVisible else {
            reply(.failure(shellError("Open Desktop Settings to choose a folder.")))
            return
        }
        let forData = data["kind"] as? String == "data"
        let picker = NSOpenPanel()
        picker.title = forData ? "Choose the Pi Pocket data folder" : "Choose the default folder for new sessions"
        picker.prompt = "Choose"
        picker.canChooseFiles = false
        picker.canChooseDirectories = true
        picker.canCreateDirectories = forData
        picker.allowsMultipleSelection = false
        if let folder = data["folder"] as? String {
            picker.directoryURL = URL(fileURLWithPath: folder, isDirectory: true)
        }
        picker.beginSheetModal(for: window) { result in
            reply(.success((result == .OK ? picker.url?.path : nil) as Any? ?? NSNull()))
        }
    }

    func localProblem(_ message: String) -> [String: Any] {
        log("Error: \(message)")
        return localSnapshot("error", message: message)
    }

    func stopLocal() throws {
        guard let process = launcher else { return }
        if process.isRunning {
            try? lifeline?.fileHandleForWriting.close()
            let started = Date()
            while process.isRunning && Date().timeIntervalSince(started) < 20 { Thread.sleep(forTimeInterval: 0.1) }
            if process.isRunning { throw shellError("The local launcher is still stopping.") }
        }
        launcher = nil
        launcherSettings = nil
        lifeline = nil
        local = nil
    }
}
