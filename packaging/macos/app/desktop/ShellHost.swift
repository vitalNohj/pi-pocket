import Cocoa
import WebKit

struct ShellPage {
    let generation: Int
    let address: URL
    let local: Bool
    let bridge: Bool
    let allowed: [String]

    init?(_ state: [String: Any]) {
        guard let raw = state["address"] as? String, let url = URL(string: raw), let generation = state["generation"] as? Int else { return nil }
        self.generation = generation
        address = url
        local = state["mode"] as? String == "local"
        bridge = state["kind"] as? String == "pocket"
        allowed = state["allowedOrigins"] as? [String] ?? []
    }
}

func pageOrigin(_ url: URL?) -> String? {
    guard let url = url, let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
        let host = url.host?.lowercased(), url.user == nil, url.password == nil else { return nil }
    let name = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    let port = url.port == (scheme == "http" ? 80 : 443) ? nil : url.port

    return "\(scheme)://\(name)\(port.map { ":\($0)" } ?? "")"
}

extension AppDelegate {
    var prefs: [String: Any] { snapshot["preferences"] as? [String: Any] ?? [:] }
    var windowPrefs: [String: Any] { prefs["window"] as? [String: Any] ?? [:] }
    var devTools: Bool { windowPrefs["developerTools"] as? Bool == true || UserDefaults.standard.bool(forKey: "WebInspector") }
    var closeToTray: Bool { windowPrefs["closeToTray"] as? Bool ?? true }
    var notices: Bool { (prefs["notifications"] as? [String: Any])?["enabled"] as? Bool ?? true }
    var activeHome: [String: Any] { snapshot["home"] as? [String: Any] ?? [:] }
    var assets: URL { Bundle.main.resourceURL!.appendingPathComponent("desktop-assets") }
    var stateFolder: URL {
        let custom = ProcessInfo.processInfo.environment["PI_POCKET_DESKTOP_STATE"]

        return custom.flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath: $0, isDirectory: true) : nil }
            ?? appFolder.appendingPathComponent("desktop")
    }

    func startShell() {
        let files = FileManager.default
        let existing = ProcessInfo.processInfo.environment["PI_POCKET_DESKTOP_STATE"] == nil &&
            [logFile, appFolder.appendingPathComponent("desktop-upgrade.txt")].contains { files.fileExists(atPath: $0.path) }

        do {
            controller = try ShellController(folder: stateFolder, assets: assets, existing: existing,
                receive: { [weak self] in self?.controllerPacket($0) }, disconnected: { [weak self] in self?.controllerFailed() })
            controller?.call("subscribe") { [weak self] answer in
                guard let self = self, !self.quitting else { return }
                if case .success(let state) = answer, let state = state as? [String: Any] { self.applySnapshot(state) }
                if self.openWhenReady, (self.prefs["home"] as? [String: Any])?["mode"] as? String != "local", self.page == nil {
                    self.openSettings("home")
                }
                let login = home.appendingPathComponent("Library/LaunchAgents/io.github.tannermidd.pi-pocket.plist")
                self.report("platform", ["loginEnabled": files.fileExists(atPath: login.path)])
            }
        } catch { controllerFailed() }
    }

    func controllerFailed() {
        guard !quitting else { return }
        log("Desktop controller stopped.")
        if openWhenReady { openSettings("home") }
    }

    func controllerPacket(_ packet: [String: Any]) {
        if quitting { return }
        if packet["type"] as? String == "state", let next = packet["state"] as? [String: Any] { applySnapshot(next) }
        if packet["type"] as? String == "host", let id = packet["id"] as? Int, let action = packet["action"] as? String {
            handleOperation(action, packet["data"] as? [String: Any] ?? [:]) { [weak self] answer in
                switch answer {
                case .success(let result): self?.controller?.call("host.result", ["id": id, "ok": true, "value": result])
                case .failure(let error): self?.controller?.call("host.result", ["id": id, "ok": false,
                    "error": ["code": "native", "message": error.localizedDescription]])
                }
            }
        }
    }

    func applySnapshot(_ next: [String: Any]) {
        if (next["revision"] as? Int ?? -1) < (snapshot["revision"] as? Int ?? -1) { return }
        snapshot = next
        settings?.send(["v": 1, "type": "state", "state": next])
        let active = activeHome["active"] as? [String: Any] ?? [:]
        let nextPage = ShellPage(active)
        let status = active["status"] as? String

        if page?.generation != nextPage?.generation {
            let wasOpen = openWhenReady || settings?.window.isVisible == true

            closeSessionWindows()
            page = nextPage
            pendingSession = false
            checkedSignIn = false
            recovered = false
            pageCommitted = false
            setBadge(0)
            if wasOpen, page != nil { backToPage() }
            else if wasOpen { openSettings("home") }
        } else if pageStatus == "reconnecting", status == "connected" {
            webView?.reload()
        } else if status == "reconnecting", pageStatus != status {
            pageNotice("Connection lost. Pi Pocket will retry. Open Desktop Settings to retry now.")
        }
        pageStatus = status
        if openWhenReady, page == nil, (activeHome["local"] as? [String: Any])?["status"] as? String == "error" { openSettings("home") }
        if #available(macOS 13.3, *) {
            webView?.isInspectable = devTools
            for window in popups.keys { (window.contentView as? WKWebView)?.isInspectable = devTools }
        }
    }

    func closeSessionWindows() {
        for extra in Array(popups.keys) {
            if let observer = popups.removeValue(forKey: extra) { NotificationCenter.default.removeObserver(observer) }
            (extra.contentView as? WKWebView)?.configuration.userContentController.removeScriptMessageHandler(forName: "pocket")
            extra.close()
        }
        webView?.stopLoading()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "pocket")
        window?.delegate = nil
        window?.close()
        window = nil
        webView = nil
        notice = nil
    }

    func shellAction(_ action: String, data: Any? = nil) {
        if quitting { return }
        if action == "window.open" { openWindow(); return }
        if action == "app.quit" { NSApp.terminate(nil); return }
        if action == "settings.open" { openSettings((data as? [String: Any])?["section"] as? String); return }
        var value: [String: Any] = ["id": action]

        if let data = data { value["data"] = data }
        controller?.call("action", value) { [weak self] answer in
            if case .failure(let error) = answer, self?.quitting == false {
                let alert = NSAlert()
                alert.messageText = error.localizedDescription
                if let window = NSApp.keyWindow { alert.beginSheetModal(for: window) }
                else { alert.runModal() }
            }
        }
    }

    func report(_ event: String, _ data: Any) {
        if !quitting { controller?.call("host.report", ["event": event, "data": data]) }
    }

    func reportPage(_ origin: String?, hung: Bool? = nil) {
        guard let page = page else { return }
        var data: [String: Any] = ["generation": page.generation, "committedOrigin": origin as Any? ?? NSNull()]

        if let hung = hung { data["hung"] = hung }
        else { setBadge(0) }
        report("page", data)
    }

    func handleOperation(_ action: String, _ data: [String: Any], reply: @escaping ShellController.Reply) {
        switch action {
        case "settings.open": openSettings(data["section"] as? String)
        case "settings.back": backToPage()
        case "window.open": openWindow()
        case "window.reload": frontView?.reload()
        case "window.newSession": newSession()
        case "window.newWindow": if let page = page { popup(pageConfig(page)).load(URLRequest(url: page.address)) }
        case "window.pinned":
            if let id = data["id"] as? String { openWindow(); sendPageEvent(webView, type: "open", fields: ["url": "/s/\(id)"]) }
        case "window.back": frontView?.goBack()
        case "window.forward": frontView?.goForward()
        case "window.actualSize": actualSize()
        case "window.zoomIn": zoomIn()
        case "window.zoomOut": zoomOut()
        case "window.minimize": NSApp.keyWindow?.miniaturize(nil)
        case "window.fullScreen": NSApp.keyWindow?.toggleFullScreen(nil)
        case "window.close": NSApp.keyWindow?.performClose(nil)
        case "window.preferences": break
        case "window.devTools": pageNotice("To inspect this view, use the Web Inspector from its context menu.")
        case "app.quit": NSApp.terminate(nil)
        case "help.repository": openHelp("https://github.com/vitalNohj/pi-pocket")
        case "help.documentation": openHelp("https://github.com/vitalNohj/pi-pocket/blob/desktop-native/docs/desktop-app.md")
        case "help.releases": openHelp("https://github.com/vitalNohj/pi-pocket/releases")
        case "preferences.open", "logs.open", "local.log":
            let file = action == "local.log" ? logFile : stateFolder.appendingPathComponent(action == "preferences.open" ? "desktop.json" : "diagnostics.log")
            if !FileManager.default.fileExists(atPath: file.path) { reply(.failure(shellError("There is no file to show yet."))); return }
            NSWorkspace.shared.activateFileViewerSelecting([file])
        case "local.inspect", "local.open", "local.stop", "local.restart":
            if action == "local.restart", local?.pid != launcher?.processIdentifier {
                let alert = NSAlert()
                alert.messageText = "Restart the server started by the console or another launcher?"
                alert.addButton(withTitle: "Restart Server")
                alert.addButton(withTitle: "Cancel")
                if alert.runModal() != .alertFirstButtonReturn { reply(.success(NSNull())); return }
            }
            localQueue.async {
                let outcome: Result<Any, Error>
                do {
                    switch action {
                    case "local.inspect": outcome = .success(self.inspectLocal())
                    case "local.open": outcome = .success(self.openLocal())
                    case "local.stop": try self.stopLocal(); outcome = .success(self.localSnapshot("stopped"))
                    default:
                        guard let local = self.local else { throw shellError("The local server is not running.") }
                        _ = try verifiedOwnerRequest(local, "api/restart")
                        outcome = .success(NSNull())
                    }
                } catch { outcome = .failure(shellError("Pi Pocket could not \(action == "local.stop" ? "stop" : "restart") the local server.")) }
                DispatchQueue.main.async { reply(outcome) }
            }
            return
        default: reply(.failure(shellError("This action is not available yet."))); return
        }
        reply(.success(NSNull()))
    }

    func openHelp(_ address: String) {
        if let url = URL(string: address) { NSWorkspace.shared.open(url) }
    }

    @objc func openSettingsMenu() { openSettings(nil) }

    func openSettings(_ section: String?) {
        if quitting { return }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        if settings == nil {
            settings = ShellSettings(assets: assets.appendingPathComponent("settings"), call: { [weak self] command, value, reply in
                if let controller = self?.controller { controller.call(command, value, reply: reply) }
                else { reply(.failure(shellError("The desktop controller is not available."))) }
            }, onClose: { [weak self] in
                self?.settings = nil
                if self?.window?.isVisible != true, self?.popups.isEmpty == true { NSApp.setActivationPolicy(.accessory) }
            })
        }
        settings?.open(section)
    }

    func backToPage() {
        settings?.window.close()
        if page != nil { openWindow() }
    }

    func pageNotice(_ text: String?) {
        notice?.arrangedSubviews.first.flatMap { $0 as? NSTextField }?.stringValue = text ?? ""
        notice?.isHidden = text == nil
    }

    func pageConfig(_ page: ShellPage) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = page.local ? localStore : .default()
        configuration.applicationNameForUserAgent = "PiPocketMac/\(appVersion)"
        configuration.preferences.isElementFullscreenEnabled = true
        if page.bridge, let origin = pageOrigin(page.address) {
            configuration.userContentController.addUserScript(
                WKUserScript(source: bridgeScript(origin: origin), injectionTime: .atDocumentStart, forMainFrameOnly: true))
            configuration.userContentController.add(self, name: "pocket")
        }
        return configuration
    }

    func newSession() {
        let target = frontView
        if let target = target, target.window?.isVisible == true {
            target.window?.makeKeyAndOrderFront(nil)
            sendPageEvent(target, type: "newSession")
        } else {
            pendingSession = true
            openWindow()
            if pageCommitted { sendPageEvent(webView, type: "newSession"); pendingSession = false }
        }
    }

    func sendPageEvent(_ view: WKWebView?, type: String, fields: [String: Any] = [:]) {
        guard let view = view, page?.bridge == true, sameOrigin(view.url), let origin = pageOrigin(view.url) else { return }
        var event = fields

        event["type"] = type
        view.callAsyncJavaScript("if (location.origin === origin && window.origin === origin) window.__pocketHostEvent?.(event)",
            arguments: ["origin": origin, "event": event], in: nil, in: .page) { _ in }
    }

    func setBadge(_ count: Int) {
        NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        statusItem?.button?.title = count > 0 ? "π \(count)" : "π"
        statusItem?.button?.toolTip = count > 0 ? "Pi Pocket (\(count) need you)" : "Pi Pocket"
    }
}
