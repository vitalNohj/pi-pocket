import Cocoa
import Foundation

struct LocalServer {
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

func runningServer(pid: pid_t? = nil) -> LocalServer? {
    let record = dataFolder.appendingPathComponent("launcher-running.json")
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
    return LocalServer(address: url, pid: pid_t(found), verified: verified)
}

func verifiedOwnerRequest(_ local: LocalServer, _ route: String) throws -> Data {
    guard local.verified, let server = runningServer(pid: local.pid), server.address == local.address, server.verified else {
        throw shellError("The local listener is not verified.")
    }
    return try request("POST", server.address.appendingPathComponent(route), token: try ownerToken())
}

extension AppDelegate {
    func localSnapshot(_ status: String, server: LocalServer? = nil, message: String? = nil) -> [String: Any] {
        var result: [String: Any] = ["status": status, "owned": server != nil && launcher?.processIdentifier == server?.pid,
            "verified": server?.verified ?? false]

        if let server = server { result["address"] = server.address.absoluteString }
        if let message = message { result["message"] = message }
        else if server?.verified == false { result["message"] = "The app could not verify the listener. Sign in inside the app." }
        return result
    }

    func inspectLocal() -> [String: Any] {
        local = runningServer()
        return localSnapshot(local == nil ? "stopped" : "running", server: local)
    }

    func openLocal() -> [String: Any] {
        if let server = runningServer() {
            local = server
            return localSnapshot("running", server: server)
        }
        if let problem = packageProblem() {
            return localProblem("\(problem.title) \(problem.advice)")
        }
        do {
            if launcher?.isRunning != true { try startLauncher() }
        } catch {
            return localProblem("Pi Pocket could not start. Check the server log or install again.")
        }

        let start = Date()
        while !quitting && Date().timeIntervalSince(start) < 6 * 60 {
            guard let process = launcher, process.isRunning else { break }
            if let server = runningServer(pid: process.processIdentifier) {
                local = server
                return localSnapshot("running", server: server)
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return localProblem("Pi Pocket did not get ready. Check the server log. If the port is in use, choose Another server instead.")
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
        lifeline = nil
        local = nil
    }
}
