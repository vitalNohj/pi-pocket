import Darwin
import Foundation

// One invocation owns one CLI process group. EOF on our private pipe means the controller is gone or wants to stop it.
private let unavailable: Int32 = 125

private func run(_ node: String, _ arguments: [String]) -> Int32 {
    var attributes: posix_spawnattr_t?
    var actions: posix_spawn_file_actions_t?
    guard posix_spawnattr_init(&attributes) == 0 else { return unavailable }
    defer { posix_spawnattr_destroy(&attributes) }
    guard posix_spawn_file_actions_init(&actions) == 0 else { return unavailable }
    defer { posix_spawn_file_actions_destroy(&actions) }

    guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP)) == 0,
        posix_spawnattr_setpgroup(&attributes, 0) == 0,
        posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0
    else { return unavailable }

    var words = ([node] + arguments).map { strdup($0) } + [nil]
    var environment = ProcessInfo.processInfo.environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer {
        words.forEach { free($0) }
        environment.forEach { free($0) }
    }

    var child: pid_t = 0
    guard posix_spawn(&child, node, &actions, &attributes, &words, &environment) == 0 else { return unavailable }
    return OwnedRunner(child).wait()
}

private final class OwnedRunner: @unchecked Sendable {
    private let child: pid_t
    private let lock = NSLock()
    private var finished = false

    init(_ child: pid_t) { self.child = child }

    func wait() -> Int32 {
        DispatchQueue.global().async { [self] in
            var buffer = [UInt8](repeating: 0, count: 256)
            while true {
                let size = read(STDIN_FILENO, &buffer, buffer.count)
                if size == 0 || (size < 0 && errno != EINTR) { break }
            }

            signal(child, SIGTERM)
            Thread.sleep(forTimeInterval: 5)
            signal(-child, SIGKILL)
        }

        // Keep the leader unreaped until after group cleanup. The PID cannot be reused by an unrelated process.
        var reason = siginfo_t()
        var waited: Int32
        repeat { waited = waitid(P_PID, id_t(child), &reason, WEXITED | WNOWAIT) } while waited < 0 && errno == EINTR
        lock.lock()
        defer { lock.unlock() }
        finished = true
        guard waited == 0 else { return unavailable }
        kill(-child, SIGKILL)
        var status: Int32 = 0
        repeat { waited = waitpid(child, &status, 0) } while waited < 0 && errno == EINTR
        guard waited == child else { return unavailable }
        return status & 0x7f == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
    }

    private func signal(_ target: pid_t, _ value: Int32) {
        lock.lock()
        defer { lock.unlock() }
        if !finished { kill(target, value) }
    }
}

private func config(_ path: String) throws -> String {
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
    var info = stat()
    guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), chmod(path, 0o700) == 0 else {
        throw CocoaError(.fileWriteNoPermission)
    }
    let file = (path as NSString).appendingPathComponent("link.json")
    if lstat(file, &info) == 0 && (info.st_mode & S_IFMT != S_IFREG || info.st_uid != getuid()) {
        throw CocoaError(.fileReadNoPermission)
    }
    return file
}

@main
private enum ProcessesRunner {
    static func main() {
        do {
            exit(try start(CommandLine.arguments))
        } catch {
            // Do not print paths or arguments, even when the OS puts them in an error.
            FileHandle.standardError.write(Data("Could not start the owned runner process.\n".utf8))
            exit(unavailable)
        }
    }

    static func start(_ args: [String]) throws -> Int32 {
        guard args.count >= 3, args[1].hasPrefix("/"), let executable = Bundle.main.executableURL else { return unavailable }
        let root = executable.deletingLastPathComponent().path
        let node = root + "/node/bin/node"
        let runner = root + "/app/lib/node_modules/pi-pocket-runner/bin/pi-pocket-runner.js"
        guard access(node, X_OK) == 0, access(runner, R_OK) == 0 else { return unavailable }
        let file = try config(args[1])
        let options = ["--config", file]
        switch args[2] {
            case "status", "unlink":
                guard args.count == 3 else { return unavailable }
                return run(node, [runner, args[2]] + options)
            case "start" where args.count == 3:
                return run(node, [runner, "start", "--confirm-via", "stdio"] + options)
            case "link" where args.count == 5 && !args[3].hasPrefix("-") && ["tls", "allow-http"].contains(args[4]):
                guard let code = readLine(), code.range(of: "^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){2}$", options: .regularExpression) != nil else {
                    return unavailable
                }
                let http = args[4] == "allow-http" ? ["--allow-http"] : []
                return run(node, [runner, "link", args[3], code] + http + options)
            default:
                return unavailable
        }
    }
}
