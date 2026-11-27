import Cocoa
import CoreFoundation
import WebKit

struct BridgePin {
    let path: String
    let title: String
    let state: String
    let label: String
}

enum BridgeProtocol {
    static let legacy = ["visibility", "open", "approve"]
    static let events = Set(legacy + ["newSession", "primary"])
    static let pinStates = Set(["waiting", "limited", "working", "failed", "fresh", "seen"])

    static func isNewLink(_ text: String) -> Bool {
        text.utf8.count == 15 && text.lowercased() == "pi-pocket://new"
    }

    static func target(_ path: String) -> Bool {
        if path == "/" || path == "/?pip=1" { return true }
        let digits = path.utf8.dropFirst(3)
        return path.hasPrefix("/s/") && (4...19).contains(path.utf8.count) &&
            (49...57).contains(digits.first ?? 0) && digits.allSatisfy { (48...57).contains($0) } &&
            (Int64(path.dropFirst(3)) ?? .max) <= 9_007_199_254_740_991
    }

    private static func encodedPath(_ url: URL) -> String {
        URLComponents(url: url, resolvingAgainstBaseURL: true)?.percentEncodedPath ?? ""
    }

    static func basePath(_ url: URL) -> String {
        var path = encodedPath(url)
        while path.hasSuffix("/") { path.removeLast() }
        return path
    }

    static func page(_ url: URL, basePath: String) -> Bool {
        let path = encodedPath(url)
        return path == basePath + "/" || (!basePath.isEmpty && path == basePath) ||
            (path.hasPrefix(basePath + "/s/") && target(String(path.dropFirst(basePath.count))))
    }

    static func number(_ value: Any?, max: Int) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
            let count = Int(exactly: number.doubleValue), (0...max).contains(count)
        else { return nil }
        return count
    }

    static func text(_ value: Any?, limit: Int) -> String? {
        guard let value = value as? String, value.utf16.count <= limit else { return nil }
        return value
    }

    static func flag(_ value: Any?) -> Bool {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
        return value.boolValue
    }

    static func recognises(_ get: (String) throws -> Data) -> Bool {
        if let data = try? get("api/pocket/info"),
            let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
            guard info["name"] as? String == "pi-pocket" else { return false }
            if let version = number(info["bridge"], max: Int(Int32.max)), version >= 1 { return true }
        }
        guard let data = try? get("manifest.webmanifest"),
            let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return manifest["name"] as? String == "Pi Pocket"
    }

    static func origin(_ url: URL) -> String? {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: true),
            let host = parts.host, !host.isEmpty, let scheme = parts.scheme?.lowercased(),
            scheme == "http" || scheme == "https", parts.user == nil, parts.password == nil
        else { return nil }
        parts.scheme = scheme
        parts.host = host.lowercased()
        if parts.port == (scheme == "http" ? 80 : 443) { parts.port = nil }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        return parts.string
    }
}

final class BridgeMac: NSObject, WKScriptMessageHandler {
    final class Document {
        weak var view: WKWebView?
        let origin: String
        let basePath: String
        var navigation: WKNavigation?
        var lease: String?
        var events: Set<String>?
        var active = false
        var auth = 0
        var modern: Bool { events?.contains("primary") == true }
        var shown: Bool { view?.window?.isVisible == true && view?.window?.isMiniaturized == false }

        init(_ view: WKWebView, origin: String, basePath: String) {
            self.view = view
            self.origin = origin
            self.basePath = basePath
        }

        func send(_ type: String, _ fields: [String: Any] = [:]) {
            guard let lease = lease, let view = view, let url = view.url, BridgeProtocol.origin(url) == origin else { return }
            var packet = fields
            packet["type"] = type
            packet["key"] = lease
            view.callAsyncJavaScript("window.__pocketNativeReceive?.(packet)", arguments: ["packet": packet], in: nil, in: .page, completionHandler: nil)
        }

        @discardableResult func deliver(_ type: String, _ fields: [String: Any] = [:]) -> Bool {
            guard events?.contains(type) == true, !modern || active,
                type != "approve" || modern, let url = view?.url, BridgeProtocol.origin(url) == origin else { return false }
            var packet = fields
            packet["auth"] = auth
            send(type, packet)
            return true
        }

        func raise() {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            view?.window?.makeKeyAndOrderFront(nil)
        }

        func reset() {
            lease = nil
            events = nil
            active = false
            auth = 0
        }
    }

    let showMain: () -> Void
    let action: (String) -> Void
    let badge: (Int) -> Void
    private let notificationsEnabled: () -> Bool
    private var documents: [Document] = []
    private var primary: Document?
    private weak var newTarget: Document?
    private var newUntil: TimeInterval?
    private var newTimer: Timer?
    private var explained = false
    private(set) var pins: [BridgePin] = []
    lazy var notices = NoticesMac { [weak self] ticket, choice in self?.activate(ticket, choice) }

    init(showMain: @escaping () -> Void, badge: @escaping (Int) -> Void, action: @escaping (String) -> Void,
        notificationsEnabled: @escaping () -> Bool) {
        self.showMain = showMain
        self.badge = badge
        self.action = action
        self.notificationsEnabled = notificationsEnabled
    }

    func install(_ configuration: WKWebViewConfiguration, address: URL) {
        guard let origin = BridgeProtocol.origin(address),
            let file = Bundle.main.url(forResource: "PocketBridge", withExtension: "js"),
            let source = try? String(contentsOf: file, encoding: .utf8),
            let data = try? JSONSerialization.data(withJSONObject: [
                "kind": "pi-pocket-macos", "origin": origin, "basePath": BridgeProtocol.basePath(address), "items": [
                    ["id": "new-session", "label": "New session"], ["id": "new-window", "label": "New window"],
                    ["id": "server-settings", "label": "Desktop Settings…"],
                ],
            ]), let config = String(data: data, encoding: .utf8)
        else { return }
        let arguments = """
            \(config), {
                send: (packet) => window.webkit.messageHandlers.pocket.postMessage(packet),
                listen: (receive) => Object.defineProperty(window, '__pocketNativeReceive', { value: receive }),
            }
            """
        let script = source.replacingOccurrences(of: "/* POCKET_BRIDGE_ARGUMENTS */", with: arguments)
        configuration.userContentController.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController.add(self, name: "pocket")
    }

    private func document(_ view: WKWebView) -> Document? { documents.first(where: { $0.view === view }) }

    func add(_ view: WKWebView, address: URL) {
        if let origin = BridgeProtocol.origin(address) {
            documents.append(Document(view, origin: origin, basePath: BridgeProtocol.basePath(address)))
        }
    }

    func focus(_ view: WKWebView) {
        if let index = documents.firstIndex(where: { $0.view === view }) {
            documents.insert(documents.remove(at: index), at: 0)
            if documents[0].events != nil { notices.seen() }
        }
    }

    func remove(_ view: WKWebView) {
        if let doc = document(view) {
            if doc === newTarget { cancelNew() }
            doc.reset()
            documents.removeAll { $0 === doc }
            reconcile()
        }
    }

    func reset(keepUnboundNewSession: Bool = false) {
        // The first connection may arrive after a cold-launch URL. Do not carry a view-bound intent to another server.
        if !keepUnboundNewSession || newTarget != nil { cancelNew() }
        primary?.send("primary", ["primary": false])
        documents.removeAll()
        primary = nil
        clearFeed(remember: false)
        explained = false
    }

    func started(_ view: WKWebView, _ navigation: WKNavigation?) {
        guard let doc = document(view) else { return }
        if doc.lease != nil && doc === newTarget { cancelNew() }
        doc.reset()
        doc.navigation = navigation
        reconcile()
    }

    func failed(_ view: WKWebView, _ navigation: WKNavigation?) {
        guard let doc = document(view), navigation == nil || navigation === doc.navigation else { return }
        if doc === newTarget { cancelNew() }
        started(view, nil)
    }

    func loaded(_ view: WKWebView, _ navigation: WKNavigation?) {
        guard let doc = document(view), let url = view.url, BridgeProtocol.origin(url) == doc.origin,
            BridgeProtocol.page(url, basePath: doc.basePath), navigation === doc.navigation else { return }
        doc.lease = UUID().uuidString
        doc.send("bind", ["visible": doc.shown])
    }

    func visibility(_ view: WKWebView, shown: Bool? = nil) {
        if let doc = document(view), doc.events?.contains("visibility") == true {
            doc.send("visibility", ["visible": shown ?? doc.shown])
        }
    }

    private func reconcile() {
        if let primary = primary, primary.events != nil { return }
        let next = documents.first { $0.events != nil }
        if primary === next { return }
        primary?.send("primary", ["primary": false])
        clearFeed(remember: true)
        primary = next
        primary?.send("primary", ["primary": true])
    }

    private func clearFeed(remember: Bool) {
        pins = []
        badge(0)
        notices.clear(remember: remember)
    }

    func openAddress(_ path: String, in view: WKWebView) {
        if BridgeProtocol.target(path) { document(view)?.deliver("open", ["url": path]) }
    }

    func openPin(_ path: String) {
        if let primary = primary, pins.contains(where: { $0.path == path }) {
            primary.raise()
            primary.deliver("open", ["url": path])
        }
    }

    func newSession() {
        newTarget = documents.first { $0.events != nil } ?? documents.first
        newUntil = ProcessInfo.processInfo.systemUptime + 12
        if let target = newTarget { target.raise() } else { showMain() }
        if newTimer == nil {
            let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.flushNew() }
            RunLoop.main.add(timer, forMode: .common)
            newTimer = timer
        }
        flushNew()
    }

    private func flushNew() {
        guard let until = newUntil else { return }
        if newTarget == nil { newTarget = documents.first { $0.events != nil } }
        let target = newTarget
        if target?.deliver("newSession") == true {
            log("Delivered New Session to the Pi Pocket page.")
            cancelNew()
        } else if target?.modern == true && target?.auth != 0 && target?.active == false {
            cancelNew()
        } else if (target?.events != nil && target?.events?.contains("newSession") == false) || ProcessInfo.processInfo.systemUptime >= until {
            cancelNew()
            if !explained && !documents.isEmpty {
                explained = true
                let alert = NSAlert()
                alert.messageText = "New session"
                alert.informativeText = "If New session is available to you, open it with New in the Pi Pocket page."
                if let window = target?.view?.window ?? documents.first?.view?.window { alert.beginSheetModal(for: window) }
            }
        }
    }

    private func cancelNew() {
        newTarget = nil
        newUntil = nil
        newTimer?.invalidate()
        newTimer = nil
    }

    private func activate(_ ticket: NoticeTicket?, _ choice: String) {
        if let ticket = ticket, let doc = primary, ticket.matches(lease: doc.lease, auth: doc.auth, action: choice, now: Date()) {
            if choice == "open", doc.deliver("open", ["url": ticket.path]) { doc.raise(); return }
            if let approval = ticket.approval, choice != "open",
                doc.deliver("approve", ["id": approval, "allow": choice == "allow"])
            { doc.raise(); return }
        }
        showMain()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // URL and securityOrigin are separate facts: a sandboxed page can have a server URL but an opaque origin.
        guard let view = message.webView, let doc = document(view), let key = doc.lease,
            let url = view.url, BridgeProtocol.origin(url) == doc.origin,
            message.frameInfo.isMainFrame, let frameUrl = message.frameInfo.request.url,
            BridgeProtocol.origin(frameUrl) == doc.origin,
            message.frameInfo.securityOrigin.protocol == url.scheme,
            message.frameInfo.securityOrigin.host.lowercased() == url.host?.lowercased(),
            (message.frameInfo.securityOrigin.port == 0 ? (url.scheme == "http" ? 80 : 443) : message.frameInfo.securityOrigin.port)
                == (url.port ?? (url.scheme == "http" ? 80 : 443)),
            let body = message.body as? [String: Any], body["key"] as? String == key,
            let type = body["type"] as? String
        else { return }

        if type == "subscribe" && doc.events == nil {
            let offered = (body["events"] as? [Any])?.prefix(8).compactMap { $0 as? String } ?? BridgeProtocol.legacy
            doc.events = BridgeProtocol.events.intersection(offered)
            if doc.modern { log("A Pi Pocket page subscribed to the desktop bridge.") }
            reconcile()
            visibility(view)
            flushNew()
            return
        }
        guard doc.events != nil, let auth = BridgeProtocol.number(body["auth"], max: Int(Int32.max)) else { return }

        if type == "account" && doc.modern && auth > doc.auth {
            if doc.active {
                if primary === doc { clearFeed(remember: false) }
                if doc === newTarget { cancelNew() }
            }
            doc.auth = auth
            doc.active = BridgeProtocol.flag(body["active"])
            flushNew()
            return
        }
        if type == "action", let id = body["id"] as? String,
            ["new-session", "new-window", "server-settings"].contains(id) { action(id); return }
        guard primary === doc, auth == doc.auth, !doc.modern || doc.active else { return }
        if type == "badge", let count = BridgeProtocol.number(body["count"], max: Int(Int32.max)) {
            badge(count)
        } else if type == "pinned", let items = body["pins"] as? [[String: Any]] {
            pins = items.prefix(20).compactMap { item in
                guard let id = BridgeProtocol.number(item["id"], max: 9_007_199_254_740_991), id > 0,
                    let state = BridgeProtocol.text(item["state"], limit: 12), BridgeProtocol.pinStates.contains(state)
                else { return nil }
                return BridgePin(path: "/s/\(id)", title: NoticeData.plain(item["title"] as? String ?? "", 70),
                    state: state, label: NoticeData.plain(item["label"] as? String ?? "", 60))
            }
        } else if type == "notify", notificationsEnabled(),
            let message = body["notice"] as? [String: Any], let notice = NoticeData(message) {
            notices.receive(notice, lease: key, auth: auth, modern: doc.modern)
        }
    }
}
