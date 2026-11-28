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
    var devTools: Bool { windowPrefs.developerTools }
    var closeToTray: Bool { windowPrefs.closeToTray }
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
        let fresh = !existing && !files.fileExists(atPath: stateFolder.appendingPathComponent("desktop.json").path)

        do {
            controller = try ShellController(folder: stateFolder, assets: assets, existing: existing,
                receive: { [weak self] in self?.controllerPacket($0) }, disconnected: { [weak self] in self?.controllerFailed() })
            dictation.installKeys()
            if openWhenReady && fresh { openSettings("home") }
            controller?.call("subscribe") { [weak self] answer in
                guard let self = self, !self.quitting else { return }
                if case .success(let state) = answer, let state = state as? [String: Any] { self.applySnapshot(state) }
                if self.openWhenReady, !fresh, (self.prefs["home"] as? [String: Any])?["mode"] as? String != "local", self.page == nil {
                    self.openSettings("home")
                }
            }
        } catch { controllerFailed() }
    }

    func controllerFailed() {
        guard !quitting else { return }
        dictation.cancel()
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
        let first = snapshot.isEmpty
        snapshot = next
        let notices = prefs["notifications"] as? [String: Any] ?? [:]
        sessionBridge.notices.configure(enabled: notices["enabled"] as? Bool ?? true,
            sound: notices["sound"] as? Bool ?? true, mode: notices["approve"] as? String ?? "full",
            limit: notices["commandLimit"] as? Int ?? 120)
        applySavedWindowPreferences(first: first)
        settings?.send(["v": 1, "type": "state", "state": next])
        let active = activeHome["active"] as? [String: Any] ?? [:]
        let nextPage = ShellPage(active)
        let status = active["status"] as? String

        if page?.generation != nextPage?.generation {
            let wasOpen = openWhenReady || settings?.window.isVisible == true

            closeSessionWindows(keepUnboundNewSession: page == nil && nextPage != nil)
            page = nextPage
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
    }

    func closeSessionWindows(keepUnboundNewSession: Bool = false) {
        sessionBridge.reset(keepUnboundNewSession: keepUnboundNewSession)
        for extra in Array(popups.keys) {
            if let observer = popups.removeValue(forKey: extra) { NotificationCenter.default.removeObserver(observer) }
            let view = (extra as? PocketNativeWindow)?.chrome?.webView
            dictation.detach(view)
            clearPageHandlers(view)
            extra.delegate = nil
            extra.close()
        }
        dictation.detach(webView)
        webView?.stopLoading()
        clearPageHandlers(webView)
        window?.delegate = nil
        window?.close()
        window = nil
        webView = nil
        notice = nil
        applyWindowOptions()
    }

    func clearPageHandlers(_ view: WKWebView?) {
        let messages = view?.configuration.userContentController
        messages?.removeScriptMessageHandler(forName: "pocketWindow")
        messages?.removeScriptMessageHandler(forName: "pocket")
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
        report("page", data)
    }

    func reportPins(feed: String?, pins: [BridgePin]) {
        guard let page = page else { return }
        let items = pins.map { pin in
            ["id": String(pin.path.dropFirst(3)), "title": pin.title, "state": pin.state, "label": pin.label, "url": pin.path]
        }
        report("pins", ["generation": page.generation, "feed": feed as Any? ?? NSNull(), "items": items])
    }

    func handleOperation(_ action: String, _ data: [String: Any], reply: @escaping ShellController.Reply) {
        switch action {
        case "dictation.toggle", "dictation.copy", "dictation.event":
            do { try dictation.operation(String(action.dropFirst("dictation.".count)), data) }
            catch { reply(.failure(error)); return }
        case "settings.open": openSettings(data["section"] as? String)
        case "settings.back": backToPage()
        case "window.open": openWindow()
        case "window.reload": frontView?.reload()
        case "window.newSession": newSession()
        case "window.newWindow": newSessionWindow()
        case "window.pinned":
            if let id = data["id"] as? String, let feed = data["feed"] as? String {
                sessionBridge.openPin("/s/\(id)", feed: feed)
            }
        case "window.back": frontView?.goBack()
        case "window.forward": frontView?.goForward()
        case "window.actualSize": actualSize()
        case "window.zoomIn": zoomIn()
        case "window.zoomOut": zoomOut()
        case "window.minimize": NSApp.keyWindow?.miniaturize(nil)
        case "window.fullScreen": NSApp.keyWindow?.toggleFullScreen(nil)
        case "window.close": NSApp.keyWindow?.performClose(nil)
        case "window.shortcut":
            do { try setWindowHotkey(data["enabled"] as? Bool == true, data["shortcut"] as? String ?? "") }
            catch { reply(.failure(error)); return }
        case "window.login.set": WindowLogin.set(data["enabled"] as? Bool == true, completion: reply); return
        case "window.login.prepare": WindowLogin.prepare(completion: reply); return
        case "notifications.refresh": sessionBridge.notices.refreshPermission()
        case "notifications.systemSettings":
            let pane = "x-apple.systempreferences:" + (ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 13
                ? "com.apple.Notifications-Settings.extension" : "com.apple.preference.notifications")
            if let url = URL(string: pane) { NSWorkspace.shared.open(url) }
        case "window.devTools": pageNotice("To inspect this view, use the Web Inspector from its context menu.")
        case "app.quit": NSApp.terminate(nil)
        case "help.repository": openHelp("https://github.com/vitalNohj/pi-pocket")
        case "help.documentation": openHelp("https://github.com/vitalNohj/pi-pocket/blob/desktop-native/docs/desktop-app.md")
        case "help.releases": openHelp("https://github.com/vitalNohj/pi-pocket/releases")
        case "preferences.open", "logs.open", "local.log":
            let file = action == "local.log" ? logFile : stateFolder.appendingPathComponent(action == "preferences.open" ? "desktop.json" : "diagnostics.log")
            if !FileManager.default.fileExists(atPath: file.path) { reply(.failure(shellError("There is no file to show yet."))); return }
            NSWorkspace.shared.activateFileViewerSelecting([file])
        case "updates.openDownload", "updates.pickInstaller":
            handleUpdateOperation(action, data, reply: reply)
            return
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
        refreshWindowLogin()
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
        sessionBridge.notices.refreshPermission()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        if settings?.window.isVisible == true { sessionBridge.notices.refreshPermission() }
    }

    func backToPage() {
        settings?.window.close()
        if page != nil { openWindow() }
    }

    func pageNotice(_ text: String?) {
        notice?.arrangedSubviews.first.flatMap { $0 as? NSTextField }?.stringValue = text ?? ""
        notice?.isHidden = text == nil
        (window as? PocketNativeWindow)?.chrome?.needsLayout = true
    }

    func pageConfig(_ page: ShellPage) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = page.local ? localStore : .default()
        configuration.applicationNameForUserAgent = "PiPocketMac/\(appVersion)"
        configuration.preferences.isElementFullscreenEnabled = true
        if page.bridge {
            sessionBridge.install(configuration, address: page.address, speechScript: dictation.script(for: page.address))
            if let origin = pageOrigin(page.address) {
                installWindowScript(in: configuration.userContentController, origin: origin,
                    initial: "{side:'none',width:0,height:0,tint:null,nativeDragContext:true}")
            }
        }
        return configuration
    }

    func newSession() { sessionBridge.newSession() }

    func newSessionWindow() {
        if let page = page { popup(pageConfig(page)).load(URLRequest(url: page.address)) }
    }

    func bridgeAction(_ action: String) {
        if quitting { return }
        switch action {
        case "new-session": newSession()
        case "new-window": newSessionWindow()
        case "server-settings": openSettings(nil)
        default: break
        }
    }

    func setBadge(_ count: Int) {
        NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        let label = count > 0 ? "Pi Pocket (\(count) need you)" : "Pi Pocket"
        statusItem?.button?.title = count > 99 ? "π 99+" : count > 0 ? "π \(count)" : "π"
        statusItem?.button?.toolTip = label
        statusItem?.button?.setAccessibilityLabel(label)
    }
}
