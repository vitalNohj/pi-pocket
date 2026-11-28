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

// Owned by one view, even when several views share the same server and cookie store.
final class PageRecovery {
    let generation: Int
    let entry: URL
    let strip: NSStackView
    let label: NSTextField
    let reload: NSButton
    var timer: Timer?
    var navigation: WKNavigation?
    var address: URL
    var committedOrigin: String?
    var status = "loading"
    var attempt: Int
    var epoch = 0
    var started = 0.0
    var answered = 0.0
    var lastTick = 0.0
    var readySince: TimeInterval?
    var loaded = false
    var sawReady = false
    var checking = false
    var exited = false
    var blocked = false
    var serverError = false

    init(page: ShellPage, strip: NSStackView, label: NSTextField, reload: NSButton, attempt: Int) {
        generation = page.generation
        entry = page.address
        address = entry
        self.strip = strip
        self.label = label
        self.reload = reload
        self.attempt = attempt
    }
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
        let previousStatus = pageStatus
        pageStatus = status

        if page?.generation != nextPage?.generation {
            let wasOpen = openWhenReady || settings?.window.isVisible == true

            closeSessionWindows(keepUnboundNewSession: page == nil && nextPage != nil)
            page = nextPage
            checkedSignIn = false
            pageCommitted = false
            setBadge(0)
            if wasOpen, page != nil { backToPage() }
            else if wasOpen { openSettings("home") }
        } else if previousStatus != status {
            let windows = [window].compactMap { $0 } + Array(popups.keys)
            for each in windows {
                guard let view = (each as? PocketNativeWindow)?.chrome?.webView, let recovery = recovery(for: view) else { continue }
                if status == "reconnecting", recovery.status == "ready" || recovery.status == "loading" {
                    pageNotice("Connection lost. Pi Pocket will retry. Open Desktop Settings to retry now.", in: view)
                } else if previousStatus == "reconnecting", status == "connected", !recovery.blocked {
                    if recovery.status == "ready" { showPageReady(view, recovery) }
                    else { reloadPage(view) }
                }
            }
        }
        if openWhenReady, page == nil, (activeHome["local"] as? [String: Any])?["status"] as? String == "error" { openSettings("home") }
    }

    func closeSessionWindows(keepUnboundNewSession: Bool = false) {
        sessionBridge.reset(keepUnboundNewSession: keepUnboundNewSession)
        for extra in Array(popups.keys) {
            if let observer = popups.removeValue(forKey: extra) { NotificationCenter.default.removeObserver(observer) }
            releasePage((extra as? PocketNativeWindow)?.chrome?.webView)
            extra.delegate = nil
            extra.close()
        }
        releasePage(webView)
        window?.delegate = nil
        window?.close()
        window = nil
        webView = nil
        lastPageWindow = nil
        applyWindowOptions()
    }

    func releasePage(_ view: WKWebView?) {
        guard let view = view else { return }
        recoveries.removeValue(forKey: ObjectIdentifier(view))?.timer?.invalidate()
        view.navigationDelegate = nil
        view.uiDelegate = nil
        view.stopLoading()
        dictation.detach(view)
        sessionBridge.remove(view)
        let messages = view.configuration.userContentController
        // A WebKit-created pop-up can share the opener's content controller.
        let others = [window].compactMap { $0 } + Array(popups.keys)
        if others.contains(where: { candidate in
            guard let other = (candidate as? PocketNativeWindow)?.chrome?.webView else { return false }
            return other !== view && recoveries[ObjectIdentifier(other)] != nil && other.configuration.userContentController === messages
        }) { return }
        messages.removeScriptMessageHandler(forName: "pocketWindow")
        messages.removeScriptMessageHandler(forName: "pocket")
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

    var recoveryTarget: WKWebView? {
        for owner in [NSApp.keyWindow, lastPageWindow, window] + NSApp.orderedWindows.map({ Optional($0) }) {
            if let view = (owner as? PocketNativeWindow)?.chrome?.webView, recovery(for: view) != nil { return view }
        }
        return nil
    }

    func reportSelectedPage() {
        guard let page = page else { return }
        let current = recoveryTarget.flatMap { recovery(for: $0) }
        report("page", ["generation": page.generation, "committedOrigin": current?.committedOrigin as Any? ?? NSNull(),
            "recovery": current?.status ?? "none"])
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
        case "window.reload": reload()
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

    func pageNotice(_ text: String?, in requested: WKWebView? = nil) {
        guard let view = requested ?? webView, let recovery = recovery(for: view),
            let chrome = (view.window as? PocketNativeWindow)?.chrome else { return }
        recovery.label.stringValue = text ?? ""
        recovery.strip.isHidden = text == nil
        chrome.needsLayout = true
    }

    func makeSessionView(_ configuration: WKWebViewConfiguration) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.allowsMagnification = true
        if #available(macOS 13.3, *) { view.isInspectable = devTools }
        return view
    }

    func watchPage(_ view: WKWebView, in owner: PocketNativeWindow, page: ShellPage, attempt: Int = 0) {
        let text = NSTextField(labelWithString: "")
        let reload = NSButton(title: "Reload", target: self, action: #selector(reloadNotice(_:)))
        let settings = NSButton(title: "Desktop Settings…", target: self, action: #selector(openSettingsMenu))
        let strip = NSStackView(views: [settings, reload, text])
        text.lineBreakMode = .byTruncatingTail
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        strip.edgeInsets = NSEdgeInsets(top: 4, left: 8, bottom: 4, right: 8)
        strip.distribution = .fill
        owner.chrome?.notice = strip
        let recovery = PageRecovery(page: page, strip: strip, label: text, reload: reload, attempt: attempt)
        recoveries[ObjectIdentifier(view)] = recovery
        beginPageAttempt(view, recovery)
        if page.bridge { sessionBridge.add(view, address: page.address) }
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self, weak view] _ in
            if let view = view { self?.checkPage(view) }
        }
        RunLoop.main.add(timer, forMode: .common)
        recovery.timer = timer
    }

    func recovery(for view: WKWebView) -> PageRecovery? {
        guard !quitting, let recovery = recoveries[ObjectIdentifier(view)], page?.generation == recovery.generation else { return nil }
        return recovery
    }

    func beginPageAttempt(_ view: WKWebView, _ recovery: PageRecovery) {
        recovery.epoch += 1
        recovery.started = ProcessInfo.processInfo.systemUptime
        recovery.answered = recovery.started
        recovery.readySince = nil
        recovery.navigation = nil
        recovery.loaded = false
        recovery.sawReady = false
        recovery.checking = false
        recovery.exited = false
        recovery.blocked = false
        recovery.serverError = false
        presentPage(view, recovery, recovery.attempt == 0 ? "loading" : "recovering",
            recovery.attempt == 0 ? nil : "Trying to recover the page…")
    }

    func safeRecoveryAddress(_ address: URL?, _ recovery: PageRecovery) -> URL? {
        guard let address = address, sameOrigin(address), address.fragment == nil,
            address.query == nil || address.query == "pip=1",
            BridgeProtocol.page(address, basePath: BridgeProtocol.basePath(recovery.entry)) else { return nil }
        return address
    }

    func presentPage(_ view: WKWebView, _ recovery: PageRecovery, _ status: String, _ text: String?) {
        let changed = recovery.status != status
        recovery.status = status
        recovery.reload.isHidden = status != "hung" && status != "failed"
        if changed || recovery.label.stringValue != (text ?? "") { pageNotice(text, in: view) }
        if changed, recoveryTarget === view { reportSelectedPage() }
    }

    func showPageReady(_ view: WKWebView, _ recovery: PageRecovery) {
        presentPage(view, recovery, "ready", pageStatus == "reconnecting"
            ? "Connection lost. Pi Pocket will retry. Open Desktop Settings to retry now."
            : page?.bridge != true || !sameOrigin(view.url) ? "Sign in on this page to use Pi Pocket" : nil)
    }

    @objc func reloadNotice(_ sender: NSButton) {
        if let view = (sender.window as? PocketNativeWindow)?.chrome?.webView { reloadPage(view) }
    }

    func reloadPage(_ view: WKWebView) {
        guard let recovery = recovery(for: view) else { return }
        recovery.attempt = 0
        retryPageNavigation(view, recovery)
    }

    private func retryPageNavigation(_ view: WKWebView, _ recovery: PageRecovery) {
        // WKWebView.url can be the provisional URL. Reload needs a current history item.
        let reloadInPlace = safeRecoveryAddress(view.backForwardList.currentItem?.url, recovery) == recovery.address &&
            safeRecoveryAddress(view.url, recovery) == recovery.address
        beginPageAttempt(view, recovery)
        view.stopLoading()
        // Keep the native history for a loaded page. Do not replay an SSO or one-time sign-in URL.
        if reloadInPlace, view.reload() != nil { return }
        view.load(URLRequest(url: recovery.address))
    }

    private func replacePage(_ view: WKWebView, _ recovery: PageRecovery) {
        guard let page = page, let owner = view.window as? PocketNativeWindow else { return }
        let replacement = makeSessionView(pageConfig(page))
        replacement.pageZoom = view.pageZoom
        let chrome = WindowChrome(view: replacement, prefs: windowPrefs)
        chrome.onEffect = owner.chrome?.onEffect
        let main = view === webView
        releasePage(view)
        if main {
            webView = replacement
            pageCommitted = false
        }
        owner.contentView = chrome
        chrome.apply(windowPrefs)
        watchPage(replacement, in: owner, page: page, attempt: 2)
        if owner.isKeyWindow {
            owner.makeFirstResponder(replacement)
            sessionBridge.focus(replacement)
        }
        if recoveryTarget === replacement { reportSelectedPage() }
        replacement.load(URLRequest(url: recovery.address))
    }

    private func checkPage(_ view: WKWebView) {
        guard let recovery = recovery(for: view), !recovery.blocked, let owner = view.window else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let interrupted = now - recovery.lastTick > 10
        recovery.lastTick = now
        if !recovery.exited && (interrupted || !owner.isVisible || owner.isMiniaturized || NSApp.isHidden) {
            recovery.started = now
            recovery.answered = now
            recovery.readySince = nil
            return
        }
        let silent = now - recovery.answered
        if recovery.loaded, silent >= 10 {
            recovery.readySince = nil
            if recovery.status != "failed" {
                presentPage(view, recovery, "hung", "The page is not responding. Reload it or open Desktop Settings.")
            }
        }
        let expired = (!recovery.sawReady && now - recovery.started >= 15) || (recovery.loaded && silent >= 15)
        if pageStatus != "reconnecting", recovery.exited || expired, recovery.status != "failed" {
            let role = view === webView ? "main" : "extra"
            switch recovery.attempt {
            case 0:
                recovery.attempt = 1
                log("Page recovery (\(role)): reloading.")
                retryPageNavigation(view, recovery)
            case 1:
                log("Page recovery (\(role)): recreating.")
                replacePage(view, recovery)
            default:
                log("Page recovery (\(role)): stopped.")
                presentPage(view, recovery, "failed", "The page could not recover. Reload it or open Desktop Settings to check the connection.")
            }
            return
        }
        if recovery.loaded, !recovery.checking { checkPageDocument(view, recovery) }
    }

    private func checkPageDocument(_ view: WKWebView, _ recovery: PageRecovery) {
        let token = recovery.epoch
        recovery.checking = true
        var script = page?.bridge == true && sameOrigin(view.url)
            ? "[...document.querySelectorAll('[data-part=boot]')].some(e => !e.classList.contains('inline')) ? 'boot' : 'ready'"
            : "'ready'"
        #if DESKTOP_STATUS_SMOKE
        if ProcessInfo.processInfo.environment["PI_POCKET_RECOVERY_SMOKE"] == "1",
            ProcessInfo.processInfo.environment["PI_POCKET_DESKTOP_STATE"] != nil,
            page?.local == false, recovery.entry.host == "127.0.0.1" {
            script = "document.body?.hasAttribute('data-fixture-exit') ? 'exit' : (\(script))"
        }
        #endif
        // One read-only check in the current top document, even if it never replies.
        view.evaluateJavaScript(script, in: nil, in: .defaultClient) { [weak self, weak view] result in
            guard let self = self, let view = view, let current = self.recovery(for: view), current.epoch == token else { return }
            current.checking = false
            guard case .success(let value) = result, let answer = value as? String else { return }
            #if DESKTOP_STATUS_SMOKE
            if answer == "exit" {
                // Test build only. Exercise the real WKNavigationDelegate callback.
                let terminate = NSSelectorFromString("_killWebContentProcess")
                if view.responds(to: terminate) { _ = view.perform(terminate) }
                return
            }
            #endif
            guard answer == "ready" || answer == "boot" else { return }
            current.answered = ProcessInfo.processInfo.systemUptime
            if answer == "boot" {
                if current.sawReady { current.started = current.answered }
                current.sawReady = false
                current.readySince = nil
                return
            }
            current.sawReady = true
            if let address = self.safeRecoveryAddress(view.url, current) { current.address = address }
            let since = current.readySince ?? current.answered
            current.readySince = since
            if current.answered - since >= 5 { current.attempt = 0 }
            self.showPageReady(view, current)
        }
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
        if let page = page { popup(pageConfig(page), page: page).load(URLRequest(url: page.address)) }
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
