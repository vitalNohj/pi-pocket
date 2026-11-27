import AVFoundation
import Cocoa
import WebKit

final class DictationHost {
    private unowned let owner: AppDelegate
    private var targets: [ObjectIdentifier: Target] = [:]
    private var session: Session?
    private var key: DictationKey?
    private var resign: NSObjectProtocol?
    private var consent: Set<String> = []
    private weak var lastView: WKWebView?
    private var indicator: NSTextField?

    private final class Target {
        weak var view: WKWebView?
        let scope: String
        let generation: Int

        var data: [String: Any] { ["scope": scope, "generation": generation] }

        init(_ view: WKWebView, _ scope: String, _ generation: Int) {
            self.view = view
            self.scope = scope
            self.generation = generation
        }
    }

    private final class Session {
        let target: Target
        let id: String
        var capture: DictationCapture?
        var stopping = false
        var asking = false
        var data: [String: Any] { target.data.merging(["id": id]) { _, new in new } }

        init(_ target: Target, _ id: String) {
            self.target = target
            self.id = id
        }
    }

    init(_ owner: AppDelegate) { self.owner = owner }

    func installKeys() {
        key = DictationKey(
            target: { [weak self] in self?.foreground()?.view },
            prefs: { [weak self] in self?.owner.prefs["dictation"] as? [String: Any] ?? [:] },
            send: { [weak self] view, op in
                guard let self = self, let target = self.targets[ObjectIdentifier(view)] else { return }
                if op == "fixture-menu", self.fixture(view) != nil {
                    // Open the installed π menu without relying on the runner’s menu-bar item positions.
                    DispatchQueue.main.async { self.owner.statusItem?.button?.performClick(nil) }
                } else if op == "cancel" { self.cancel() }
                else { self.lastView = view; self.send(target, op) }
            }
        )
        resign = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: nil, queue: .main) { [weak self] note in
            if let self = self, let current = self.session, !current.asking, note.object as? NSWindow === current.target.view?.window {
                self.cancel()
            }
        }
    }

    func close() {
        key = nil
        if let resign = resign { NotificationCenter.default.removeObserver(resign) }
        resign = nil
        cancel()
        targets.removeAll()
        lastView = nil
        consent.removeAll()
    }

    func script(for address: URL) -> String {
        guard speechOrigin(address),
            let source = try? String(contentsOf: owner.assets.appendingPathComponent("protocol/page-dictation.js"), encoding: .utf8) else { return "null" }
        return String(source.trimmingCharacters(in: .whitespacesAndNewlines).dropLast())
    }

    private func speechOrigin(_ url: URL?) -> Bool {
        guard let url = url, let host = url.host?.lowercased(), owner.sameOrigin(url) else { return false }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        return url.scheme == "https" || (url.scheme == "http" && loopback)
    }

    private func eligible(_ view: WKWebView) -> Bool {
        owner.page?.bridge == true && speechOrigin(view.url) &&
            (view === owner.webView ? owner.pageCommitted : view.window.map { owner.popups[$0] != nil } == true)
    }

    private func focused(_ view: WKWebView?) -> Bool {
        guard let view = view, let window = view.window else { return false }
        return NSApp.isActive && window.isKeyWindow && window.isVisible && !window.isMiniaturized && eligible(view)
    }

    private func foreground() -> Target? { targets.values.first { focused($0.view) } }

    private func opaque(_ value: String) -> Bool {
        value.utf8.count == 32 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    func receive(_ view: WKWebView, _ body: [String: Any]) {
        guard let op = body["op"] as? String, eligible(view), let generation = owner.page?.generation else { return }
        if op == "settings", focused(view) { owner.openSettings("dictation"); return }
        guard let scope = body["scope"] as? String, opaque(scope) else { return }
        let identity = ObjectIdentifier(view)

        if op == "attach" {
            if targets[identity]?.scope == scope { return }
            detach(view)
            let target = Target(view, scope, generation)
            targets[identity] = target
            if focused(view) { lastView = view }
            owner.report("dictation.attach", target.data)
            return
        }
        guard let target = targets[identity], target.scope == scope, target.generation == generation else { return }
        if op == "detach" { detach(view); return }
        guard let id = body["id"] as? String, opaque(id) else { return }
        if op == "start" {
            if session != nil { send(target, "error", id: id, fields: ["message": "Finish the current recording first."]); return }
            if !focused(view) { send(target, "error", id: id, fields: ["message": "Focus an editable Pi Pocket composer first."]); return }
            start(Session(target, id), view)
        } else if let current = session, current.target === target, current.id == id {
            if op == "cancel" { cancel(notify: false) }
            if op == "stop" { stop(current) }
        }
    }

    func detach(_ view: WKWebView?) {
        guard let view = view, let target = targets.removeValue(forKey: ObjectIdentifier(view)) else { return }
        if session?.target === target { cancel() }
        owner.report("dictation.detach", target.data)
        if lastView === view { lastView = nil }
    }

    func operation(_ action: String, _ data: [String: Any]) throws {
        if action == "toggle" {
            guard let target = foreground() ?? lastView.flatMap({ targets[ObjectIdentifier($0)] }),
                let view = target.view, let window = view.window, window.isVisible, !window.isMiniaturized, eligible(view) else {
                throw shellError("Focus an editable Pi Pocket composer first.")
            }
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            send(target, "toggle")
        } else if action == "copy" {
            guard targets.values.contains(where: { $0.scope == data["scope"] as? String && $0.generation == data["generation"] as? Int && $0.view.map(eligible) == true }),
                let text = data["text"] as? String, !text.isEmpty, text.utf16.count <= 6000 else {
                throw shellError("There is no dictation to copy for this server.")
            }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        } else if let current = session, current.id == data["id"] as? String,
            current.target.scope == data["scope"] as? String, current.target.generation == data["generation"] as? Int,
            let op = data["type"] as? String {
            if op == "stop" { stop(current); return }
            guard focused(current.target.view) else { cancel(); return }
            send(current.target, op, id: current.id, fields: data.filter { ["parts", "message"].contains($0.key) })
            if ["end", "empty", "error"].contains(op) { cancel(notify: false) }
        }
    }

    private func fixture(_ view: WKWebView) -> URL? {
        let env = ProcessInfo.processInfo.environment
        guard let settings = env["PI_POCKET_DESKTOP_STATE"], settings.hasPrefix("/"),
            let path = env["PI_POCKET_DICTATION_SMOKE_PCM"], path.hasPrefix("/"),
            let host = view.url?.host, ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) else { return nil }
        return URL(fileURLWithPath: path)
    }

    private func start(_ current: Session, _ view: WKWebView) {
        guard let origin = pageOrigin(view.url) else { return }
        lastView = view
        session = current
        current.asking = true
        let input = fixture(view)
        func allowed(_ yes: Bool) {
            guard session === current else { return }
            current.asking = false
            guard yes else { fail(current, "Allow Pi Pocket to use the microphone in System Settings → Privacy & Security → Microphone."); return }
            guard focused(view) else { cancel(); return }
            warm(current, input)
        }
        func authorize() {
            guard session === current else { return }
            if input != nil { allowed(true); return }
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: allowed(true)
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .audio) { yes in DispatchQueue.main.async { allowed(yes) } }
            default: allowed(false)
            }
        }
        if input != nil || consent.contains(origin) { authorize(); return }
        let alert = NSAlert()
        alert.messageText = "Allow the microphone for offline dictation on this server?"
        alert.informativeText = "\(origin)\n\nPi Pocket recognizes speech on this device. It does not send audio to the server."
        alert.addButton(withTitle: "Allow")
        alert.addButton(withTitle: "Cancel")
        if let window = view.window {
            alert.beginSheetModal(for: window) { answer in
                if answer == .alertFirstButtonReturn { self.consent.insert(origin); DispatchQueue.main.async { authorize() } }
                else { self.fail(current, "Microphone access was not allowed for this server.") }
            }
        } else { cancel() }
    }

    private func warm(_ current: Session, _ input: URL?) {
        report("start", current.data) { [weak self, weak current] answer in
            guard let self = self, let current = current, self.session === current else { return }
            if case .failure(let error) = answer { self.fail(current, error.localizedDescription); return }
            guard self.focused(current.target.view) else { self.cancel(); return }
            if current.stopping { self.stop(current, warmed: true); return }
            let capture = DictationCapture(write: { [weak self, weak current] frame in
                guard let self = self, let current = current, self.session === current else { return }
                var data = current.data
                data["pcm"] = frame.base64EncodedString()
                self.report("frame", data) { answer in
                    if case .failure = answer { self.fail(current, "The offline speech engine could not accept audio.") }
                }
            }, failure: { [weak self, weak current] in
                if let current = current { self?.fail(current, "The microphone stopped. Check the selected input device.") }
            })
            current.capture = capture
            do {
                try capture.start(fixture: input) { [weak self, weak current] in
                    if let current = current { self?.stop(current) }
                }
                if let view = current.target.view { self.showIndicator(view) }
            } catch { self.fail(current, "Could not use the microphone. Check the selected input device.") }
        }
    }

    private func report(_ op: String, _ data: [String: Any], _ reply: @escaping ShellController.Reply) {
        guard let controller = owner.controller else { reply(.failure(shellError("The offline speech engine is not available."))); return }
        controller.call("host.report", ["event": "dictation.\(op)", "data": data], reply: reply)
    }

    private func stop(_ current: Session, warmed: Bool = false) {
        if current.stopping && !warmed { return }
        current.stopping = true
        if current.capture == nil && !warmed { return }
        current.capture?.stop(flush: true)
        indicator?.removeFromSuperview()
        indicator = nil
        DispatchQueue.main.async { [weak self, weak current] in
            guard let self = self, let current = current, self.session === current else { return }
            self.report("stop", current.data) { answer in
                if case .failure(let error) = answer { self.fail(current, error.localizedDescription) }
            }
        }
    }

    private func fail(_ current: Session, _ message: String) {
        guard session === current else { return }
        send(current.target, "error", id: current.id, fields: ["message": message])
        cancel(notify: false)
    }

    func cancel(notify: Bool = true) {
        guard let current = session else { return }
        session = nil
        current.capture?.stop(flush: false)
        indicator?.removeFromSuperview()
        indicator = nil
        owner.report("dictation.cancel", current.data)
        if notify { send(current.target, "cancel", id: current.id) }
    }

    private func send(_ target: Target, _ op: String, id: String? = nil, fields: [String: Any] = [:]) {
        guard let view = target.view, eligible(view), target.generation == owner.page?.generation else { return }
        var event = fields
        event["scope"] = target.scope
        event["op"] = op
        event["id"] = id
        owner.sessionBridge.sendDictation(view, event)
    }

    private func showIndicator(_ view: WKWebView) {
        guard let parent = view.window?.contentView else { return }
        let label = NSTextField(labelWithString: "  ●  Microphone on — offline dictation  ")
        label.textColor = .white
        label.backgroundColor = .systemRed
        label.drawsBackground = true
        label.translatesAutoresizingMaskIntoConstraints = false
        parent.addSubview(label, positioned: .above, relativeTo: nil)
        NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: parent.centerXAnchor),
            label.topAnchor.constraint(equalTo: parent.topAnchor, constant: 6)])
        indicator = label
    }
}
