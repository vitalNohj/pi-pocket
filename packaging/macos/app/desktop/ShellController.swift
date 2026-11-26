import Foundation

let shellMaxPacket = 65_536

final class ShellController {
    typealias Reply = (Result<Any, Error>) -> Void
    let child = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let writer = DispatchQueue(label: "Pi Pocket controller input")
    private var pending: [Int: Reply] = [:]
    private var next = 0
    private var closed = false

    init(folder: URL, assets: URL, existing: Bool, receive: @escaping ([String: Any]) -> Void, disconnected: @escaping () -> Void) throws {
        child.executableURL = appFolder.appendingPathComponent("node/bin/node")
        child.arguments = [assets.appendingPathComponent("controller/main.mjs").path, folder.path, "macos", appVersion,
            existing ? "existing" : "new"]
        var environment = ProcessInfo.processInfo.environment

        environment.removeValue(forKey: "NODE_OPTIONS")
        environment.removeValue(forKey: "NODE_PATH")
        child.environment = environment
        child.standardInput = input
        child.standardOutput = output
        child.standardError = FileHandle.nullDevice
        try child.run()
        try? input.fileHandleForReading.close()
        try? output.fileHandleForWriting.close()
        DispatchQueue.global(qos: .userInitiated).async { [weak self, output] in
            let stream = output.fileHandleForReading
            var line = Data()
            var overflow = false

            while let data = try? stream.read(upToCount: 8192), !data.isEmpty {
                for byte in data {
                    if byte == 10 {
                        if !overflow, let packet = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], packet["v"] as? Int == 1 {
                            DispatchQueue.main.async { [weak self] in
                                guard let self = self, !self.closed else { return }
                                if packet["type"] as? String == "result", let id = packet["id"] as? Int {
                                    if let reply = self.pending.removeValue(forKey: id) {
                                        if packet["ok"] as? Bool == true { reply(.success(packet["value"] ?? NSNull())) }
                                        else { reply(.failure(shellError((packet["error"] as? [String: Any])?["message"] as? String ?? "The action did not finish."))) }
                                    }
                                } else { receive(packet) }
                            }
                        }
                        line.removeAll(keepingCapacity: true)
                        overflow = false
                    } else if !overflow {
                        if line.count >= shellMaxPacket { overflow = true }
                        else { line.append(byte) }
                    }
                }
            }
            DispatchQueue.main.async { [weak self] in
                guard let self = self, !self.closed else { return }
                self.close()
                disconnected()
            }
        }
    }

    func call(_ command: String, _ value: Any? = nil, reply: @escaping Reply = { _ in }) {
        guard !closed, pending.count < 48 else {
            reply(.failure(shellError("The desktop controller is not available.")))
            return
        }

        next = next == Int(Int32.max) ? 1 : next + 1
        var packet: [String: Any] = ["v": 1, "id": next, "command": command]

        if let value = value { packet["value"] = value }
        guard var data = try? JSONSerialization.data(withJSONObject: packet), data.count <= shellMaxPacket else {
            reply(.failure(shellError("The desktop request is too large.")))
            return
        }
        pending[next] = reply
        data.append(10)
        let line = data
        writer.async { [input] in try? input.fileHandleForWriting.write(contentsOf: line) }
    }

    func close() {
        if closed { return }
        closed = true
        let replies = pending.values

        pending.removeAll()
        writer.async { [input] in try? input.fileHandleForWriting.close() }
        replies.forEach { $0(.failure(shellError("The desktop controller stopped."))) }
    }
}

func shellError(_ message: String) -> Error {
    NSError(domain: "Pi Pocket Desktop", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
