// Pi Pocket.app: the macOS desktop app. A WKWebView window and a menu bar item around a `pi-pocket --desktop` launcher.
//
// The owner token goes only in a header of a request to this Mac: never on a command line, in a title, or in the log.
// A newer pi-pocket package replaces nothing here, so this app uses only --desktop, launcher-running.json,
// /api/pocket/info, /api/sign-in-link, and /api/restart.
import Cocoa
import UserNotifications
import WebKit

let appVersion = "0.0.0-dev"  // build.sh puts the package's version here.
let openNotice = Notification.Name("io.github.tannermidd.pi-pocket.app.open")
let quitNotice = Notification.Name("io.github.tannermidd.pi-pocket.app.quit")
let home = FileManager.default.homeDirectoryForCurrentUser
let appFolder = home.appendingPathComponent("Library/Application Support/Pi Pocket")
let dataFolder: URL = {
    if let data = ProcessInfo.processInfo.environment["PI_POCKET_DIR"], !data.isEmpty {
        return URL(fileURLWithPath: (data as NSString).expandingTildeInPath)
    }

    return home.appendingPathComponent(".pi-pocket")
}()
let logFolder = home.appendingPathComponent("Library/Logs/Pi Pocket")
let logFile = logFolder.appendingPathComponent("launcher.log")

func bridgeScript(origin: String) -> String {
    return """
        (() => {
            if (window.top !== window || window.origin !== \(jsString(origin)) || location.origin !== \(jsString(origin))) { return; }
            const post = (message) => window.webkit.messageHandlers.pocket.postMessage(message);
            let listener = null;
            let shown = true;
            let handlesNewSession = false;
            Object.defineProperty(window, "__pocketHostEvent", {
                value: (event) => {
                    if (event.type === "visibility") { shown = event.visible; }
                    if (event.type === "newSession" && !handlesNewSession) { return; }
                    try { listener?.({ type: event.type, url: event.url }); } catch (error) { console.error(error); }
                },
            });
            window.pocketHost = Object.freeze({
                kind: "pi-pocket-macos",
                apiVersion: 1,
                capabilities: Object.freeze(["menu", "badge", "notify", "visibility", "open", "newSession"]),
                menuTitle: () => "Pi Pocket Desktop",
                menuItems: () => [{ id: "server-settings", label: "Desktop Settings…" }],
                invoke: (id) => { if (id !== "server-settings") { return false; } post({ type: "settings" }); return true; },
                setBadge: (count) => post({ type: "badge", count: Number(count) || 0 }),
                notify: (message) => post({
                    type: "notify",
                    title: String(message?.title ?? "Pi Pocket"),
                    body: String(message?.body ?? ""),
                    url: String(message?.url ?? "/"),
                    tag: String(message?.tag ?? ""),
                }),
                visible: () => shown,
                subscribe: (next, events) => {
                    listener = typeof next === "function" ? next : null;
                    handlesNewSession = Array.isArray(events) && events.includes("newSession");
                },
            });
        })();
        """
}

func jsString(_ text: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [text])
    let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"

    return String(array.dropFirst().dropLast())
}

/// Same order as compareVersions in place-app.mjs.
func compareVersions(_ a: String, _ b: String) -> Int {
    func parse(_ text: String) -> (core: [Int], pre: [String]) {
        let plain = String(text.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)[0])
        let parts = plain.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let core = parts[0].split(separator: ".", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
        let pre = parts.count > 1 ? parts[1].split(separator: ".", omittingEmptySubsequences: false).map(String.init) : []

        return (core, pre)
    }

    func digits(_ text: String) -> Bool {
        return !text.isEmpty && text.allSatisfy { $0 >= "0" && $0 <= "9" }
    }

    let left = parse(a)
    let right = parse(b)

    for index in 0..<3 {
        let x = index < left.core.count ? left.core[index] : 0
        let y = index < right.core.count ? right.core[index] : 0

        if x != y {
            return x < y ? -1 : 1
        }
    }

    if left.pre.isEmpty || right.pre.isEmpty {
        return left.pre.isEmpty == right.pre.isEmpty ? 0 : (left.pre.isEmpty ? 1 : -1)
    }

    for index in 0..<max(left.pre.count, right.pre.count) {
        if index >= left.pre.count || index >= right.pre.count {
            return index >= left.pre.count ? -1 : 1
        }

        let x = left.pre[index]
        let y = right.pre[index]
        let order: Int

        if digits(x), digits(y), let m = Int(x), let n = Int(y) {
            order = m < n ? -1 : m > n ? 1 : 0
        } else {
            order = x < y ? -1 : x > y ? 1 : 0
        }

        if order != 0 {
            return order
        }
    }

    return 0
}

/// An older package than this app is one the install did not replace: an older launcher refuses --desktop.
func packageProblem() -> (title: String, advice: String)? {
    let folder = appFolder.appendingPathComponent("app/lib/node_modules/pi-pocket")
    let again = "Install Pi Pocket \(appVersion) again: open its .pkg file. Your sessions and settings stay."

    guard FileManager.default.fileExists(atPath: folder.appendingPathComponent("bin/pi-pocket.js").path),
        let data = try? Data(contentsOf: folder.appendingPathComponent("package.json")),
        let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let version = manifest["version"] as? String
    else {
        return ("Pi Pocket is not fully installed: \(folder.path) holds no pi-pocket package.", again)
    }

    if appVersion != "0.0.0-dev" && compareVersions(version, appVersion) < 0 {
        return (
            "The pi-pocket package of Pi Pocket is version \(version), older than this app (\(appVersion)).",
            "The install did not finish putting the package in place, so Pi Pocket cannot start. \(again)"
        )
    }

    return nil
}

func ownerToken() throws -> String {
    let data = try Data(contentsOf: dataFolder.appendingPathComponent("config.json"))

    guard let config = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let token = config["ownerToken"] as? String
    else {
        throw NSError(domain: "PiPocket", code: 1, userInfo: [NSLocalizedDescriptionKey: "config.json has no owner token"])
    }

    return token
}

// A verified token request must never follow a redirect, even to the original origin.
final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

func request(_ method: String, _ url: URL, token: String?) throws -> Data {
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)

    request.httpMethod = method
    request.httpShouldHandleCookies = false

    if let token = token {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    if method != "GET" {
        request.setValue("1", forHTTPHeaderField: "X-Pocket")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
    }

    let configuration = URLSessionConfiguration.ephemeral

    configuration.connectionProxyDictionary = [:]
    let session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
    let done = DispatchSemaphore(value: 0)
    var result: Result<Data, Error> = .failure(URLError(.timedOut))

    session.dataTask(with: request) { data, response, error in
        if let error = error {
            result = .failure(error)
        } else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
            result = .failure(URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "HTTP \(response.statusCode)"]))
        } else {
            result = .success(data ?? Data())
        }

        done.signal()
    }.resume()
    defer { session.invalidateAndCancel() }
    guard done.wait(timeout: .now() + 15) == .success else { throw URLError(.timedOut) }
    let data = try result.get()
    guard data.count <= 16 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
    return data
}

/// Opened to append: this app and its launcher write to the log at once.
func appendHandle() throws -> FileHandle {
    try FileManager.default.createDirectory(at: logFolder, withIntermediateDirectories: true)
    let descriptor = open(logFile.path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)

    if descriptor < 0 {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }

    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
}

func log(_ line: String) {
    guard let handle = try? appendHandle() else {
        return
    }

    handle.write(Data("\(line)\n".utf8))
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate
{
    var window: NSWindow?
    var webView: WKWebView?
    // Windows that pages opened (an artifact's "Open tab"), each kept until it closes, with its close observer.
    var popups: [NSWindow: NSObjectProtocol] = [:]
    var statusItem: NSStatusItem?
    var launcher: Process?
    var lifeline: Pipe?
    var controller: ShellController?
    var snapshot: [String: Any] = [:]
    var settings: ShellSettings?
    var page: ShellPage?
    var notice: NSStackView?
    var pageStatus: String?
    var pageCommitted = false
    var pendingSession = false
    var recovered = false
    let localStore = WKWebsiteDataStore.nonPersistent()
    let localQueue = DispatchQueue(label: "Pi Pocket local launcher")
    var local: LocalServer?
    var openWhenReady = !CommandLine.arguments.contains("--hidden")
    var quitting = false
    var checkedSignIn = false
    var termSource: DispatchSourceSignal?

    func applicationWillFinishLaunching(_ notification: Notification) {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            // LaunchServices can list one that just quit for a moment: only a live process counts.
            .filter { $0.processIdentifier != getpid() && !$0.isTerminated && kill($0.processIdentifier, 0) == 0 }
        let center = DistributedNotificationCenter.default()

        if CommandLine.arguments.contains("--quit") {
            center.postNotificationName(quitNotice, object: nil, userInfo: nil, deliverImmediately: true)
            exit(0)
        }

        if let other = others.first {
            log("Pi Pocket.app runs already (process \(other.processIdentifier)): this one exits.")

            if openWhenReady {
                center.postNotificationName(openNotice, object: nil, userInfo: nil, deliverImmediately: true)
                other.activate(options: [])
            }

            exit(0)
        }

        center.addObserver(forName: openNotice, object: nil, queue: .main) { [weak self] _ in self?.openWindow() }
        center.addObserver(forName: quitNotice, object: nil, queue: .main) { _ in NSApp.terminate(nil) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(openWhenReady ? .regular : .accessory)
        NSApp.mainMenu = mainMenu()
        makeStatusItem()
        UNUserNotificationCenter.current().delegate = self
        signal(SIGTERM, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)

        term.setEventHandler { NSApp.terminate(nil) }
        term.resume()
        termSource = term

        if openWhenReady {
            NSApp.activate(ignoringOtherApps: true)
        }

        startShell()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWindow()

        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func startLauncher() throws {
        let script = appFolder.appendingPathComponent("pi-pocket")

        guard FileManager.default.isExecutableFile(atPath: script.path) else {
            throw NSError(domain: "PiPocket", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Pi Pocket is not fully installed in \(appFolder.path). Install it again.",
            ])
        }

        try FileManager.default.createDirectory(at: logFolder, withIntermediateDirectories: true)
        let old = logFolder.appendingPathComponent("launcher.old.log")

        try? FileManager.default.removeItem(at: old)
        try? FileManager.default.moveItem(at: logFile, to: old)
        log("Pi Pocket desktop app \(appVersion), \(Date())")
        let output = try appendHandle()

        // The user's login shell, as Terminal starts it, for the PATH of ~/.zprofile. Only shells that take sh's -c.
        var shell = "/bin/zsh"

        if let entry = getpwuid(getuid()), let path = entry.pointee.pw_shell {
            let own = String(cString: path)

            if ["zsh", "bash", "sh", "ksh", "dash"].contains((own as NSString).lastPathComponent),
                FileManager.default.isExecutableFile(atPath: own)
            {
                shell = own
            }
        }

        let process = Process()
        let input = Pipe()

        process.executableURL = URL(fileURLWithPath: shell)
        // The data folder by name: the login shell may set PI_POCKET_DIR to another one than this app reads.
        process.arguments = ["-l", "-c", "exec \"$0\" --desktop --data \"$1\"", script.path, dataFolder.path]
        process.currentDirectoryURL = home
        process.standardInput = input
        process.standardOutput = output
        process.standardError = output
        var environment = ProcessInfo.processInfo.environment

        environment["NO_COLOR"] = "1"
        process.environment = environment
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async { self?.launcherEnded(ended) }
        }
        // Before it runs: one that ends at once must still count as this app's launcher.
        launcher = process
        lifeline = input

        do {
            try process.run()
        } catch {
            launcher = nil
            lifeline = nil

            throw error
        }

        try? output.close()
    }

    func launcherEnded(_ process: Process) {
        if quitting || process !== launcher { return }
        let message = "The local launcher stopped (exit code \(process.terminationStatus)). Check the server log."

        log(message)
        report("local", localSnapshot("error", message: message))
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateLater }
        quitting = true
        controller?.close()
        closeSessionWindows()
        settings?.window.close()
        localQueue.async {
            do { try self.stopLocal() }
            catch {
                // Only this app's own direct child. A borrowed launcher has no Process handle here.
                self.launcher?.terminate()
            }
            DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    @objc func openFromMenu() {
        openWindow()
    }

    // The view of the window in front: the main one, or a page's own window.
    var frontView: WKWebView? {
        let key = NSApp.keyWindow
        return key == window ? webView : (key?.contentView as? WKWebView) ?? webView
    }

    @objc func reload() {
        frontView?.reload()
    }

    @objc func actualSize() {
        frontView?.pageZoom = 1
    }

    @objc func zoomIn() {
        frontView?.pageZoom = min(3, (frontView?.pageZoom ?? 1) + 0.1)
    }

    @objc func zoomOut() {
        frontView?.pageZoom = max(0.5, (frontView?.pageZoom ?? 1) - 0.1)
    }

    func openWindow() {
        openWhenReady = true
        guard let page = page else { openSettings("home"); return }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        if let window = window {
            window.makeKeyAndOrderFront(nil)
            visibilityChanged()
            return
        }
        let view = WKWebView(frame: .zero, configuration: pageConfig(page))
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.allowsMagnification = true
        if #available(macOS 13.3, *) { view.isInspectable = devTools }
        let made = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        let help = NSTextField(labelWithString: "")
        let settingsButton = NSButton(title: "Desktop Settings…", target: self, action: #selector(openSettingsMenu))
        let strip = NSStackView(views: [help, settingsButton])
        let layout = NSStackView(views: [strip, view])

        help.lineBreakMode = .byTruncatingTail
        strip.edgeInsets = NSEdgeInsets(top: 4, left: 8, bottom: 4, right: 8)
        strip.distribution = .fill
        layout.orientation = .vertical
        layout.alignment = .leading
        layout.spacing = 0
        layout.detachesHiddenViews = true
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalTo: layout.widthAnchor).isActive = true
        strip.widthAnchor.constraint(equalTo: layout.widthAnchor).isActive = true
        view.setContentHuggingPriority(.defaultLow, for: .vertical)
        view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        made.title = "Pi Pocket"
        made.minSize = NSSize(width: 420, height: 400)
        made.isReleasedWhenClosed = false
        made.contentView = layout
        made.delegate = self
        made.tabbingMode = .disallowed
        made.center()
        made.setFrameAutosaveName("Pi Pocket")
        window = made
        webView = view
        notice = strip
        pageNotice(page.bridge ? nil : "Sign in on this page to use Pi Pocket")
        made.makeKeyAndOrderFront(nil)
        if page.local, let server = local { signIn(server, generation: page.generation) }
        else { view.load(URLRequest(url: page.address)) }
    }

    func signIn(_ server: LocalServer, generation: Int) {
        DispatchQueue.global().async {
            var target = server.address
            if let answer = try? verifiedOwnerRequest(server, "api/sign-in-link"),
                let link = (try? JSONSerialization.jsonObject(with: answer)) as? [String: Any], let path = link["path"] as? String,
                path.range(of: #"^/login\?once=[A-Za-z0-9_-]{16,128}$"#, options: .regularExpression) != nil,
                let url = URL(string: path, relativeTo: server.address) {
                target = url.absoluteURL
            } else { log("No one-time sign-in link.") }
            let address = target
            DispatchQueue.main.async {
                if self.page?.generation == generation, !self.quitting { self.webView?.load(URLRequest(url: address)) }
            }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeToTray, sender == window {
            sender.orderOut(nil)
            visibilityChanged(visible: false)
            if settings == nil, popups.isEmpty { NSApp.setActivationPolicy(.accessory) }
            return false
        }
        return true
    }

    func windowWillClose(_ notification: Notification) {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "pocket")
        webView = nil
        window = nil
        notice = nil
        report("visibility", false)
        if popups.isEmpty { NSApp.terminate(nil) }
    }

    func windowDidMiniaturize(_ notification: Notification) { visibilityChanged(visible: false) }
    func windowDidDeminiaturize(_ notification: Notification) { visibilityChanged() }
    func windowDidBecomeKey(_ notification: Notification) { report("focus", true) }
    func windowDidResignKey(_ notification: Notification) { report("focus", false) }

    func visibilityChanged(visible: Bool? = nil) {
        let shown = visible ?? (window?.isVisible == true && window?.isMiniaturized == false)

        report("visibility", shown)
        sendPageEvent(webView, type: "visibility", fields: ["visible": shown])
    }

    func sameOrigin(_ url: URL?) -> Bool {
        guard let address = page?.address, let origin = pageOrigin(url) else { return false }
        return origin == pageOrigin(address)
    }

    func inApp(_ url: URL?, from: URL?) -> Bool {
        guard let origin = pageOrigin(url), !(from?.scheme == "https" && url?.scheme != "https") else { return false }
        return sameOrigin(url) || (page?.allowed.contains(origin) == true && (page?.address.scheme != "https" || url?.scheme == "https"))
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if action.targetFrame?.isMainFrame != false && !inApp(url, from: webView.url) {
            if action.navigationType == .linkActivated, let url = url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            } else if webView === self.webView { pageNotice("This sign-in address is not allowed. Review allowed origins under Server.") }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(action.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, !inApp(response.response.url, from: webView.url) {
            if webView === self.webView { pageNotice("This sign-in address is not allowed. Review allowed origins under Server.") }
            decisionHandler(.cancel)
            return
        }
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""

        decisionHandler(!response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === self.webView { pageCommitted = false }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if webView === self.webView {
            pageCommitted = sameOrigin(webView.url)
            reportPage(pageOrigin(webView.url))
            pageNotice(page?.bridge == true && pageCommitted ? nil : "Sign in on this page to use Pi Pocket")
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if webView === self.webView, (error as NSError).code != NSURLErrorCancelled {
            pageNotice("Could not load this server. Check the address or try again.")
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? home
        let name = (suggestedFilename as NSString).lastPathComponent
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var target = folder.appendingPathComponent(name.isEmpty ? "download" : name)
        var count = 1

        while FileManager.default.fileExists(atPath: target.path) {
            count += 1
            target = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(count)" : "\(base) \(count).\(ext)")
        }

        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound.beep()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView !== self.webView { return }
        visibilityChanged()
        recovered = false
        if pageCommitted && pendingSession { sendPageEvent(webView, type: "newSession"); pendingSession = false }

        if !checkedSignIn && page?.local == true && pageCommitted {
            checkedSignIn = true
            webView.callAsyncJavaScript(
                "return (await fetch('/api/me')).status", arguments: [:], in: nil, in: .page
            ) { result in
                if case .success(let status) = result {
                    log(status as? Int == 200 ? "The window is signed in." : "The window is not signed in (\(status)).")
                }
            }
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView !== self.webView { return }
        reportPage(pageOrigin(webView.url), hung: true)
        pageCommitted = false
        if !recovered { recovered = true; webView.reload() }
        else { pageNotice("The page is not responding. Reload it or return to Home.") }
    }

    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url {
            if inApp(url, from: webView.url) {
                return popup(configuration)
            } else if ["http", "https", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
        }

        return nil
    }

    // A window of its own for a same-origin page: WebKit loads the page in the view it gets back, with the same session.
    func popup(_ configuration: WKWebViewConfiguration) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: configuration)

        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.allowsMagnification = true

        if #available(macOS 13.3, *) {
            view.isInspectable = devTools
        }

        let made = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1000, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)

        made.title = "Pi Pocket"
        made.minSize = NSSize(width: 420, height: 400)
        made.isReleasedWhenClosed = false
        made.contentView = view
        made.tabbingMode = .disallowed
        made.center()
        popups[made] = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: made, queue: .main
        ) { [weak self] _ in
            // After the close: the window is not let go while it closes.
            DispatchQueue.main.async {
                if let observer = self?.popups.removeValue(forKey: made) {
                    NotificationCenter.default.removeObserver(observer)
                }
            }
        }
        made.makeKeyAndOrderFront(nil)

        return view
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView !== self.webView {
            webView.window?.close()
        }
    }

    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()

        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: webView.window ?? window ?? NSWindow()) { answer in
            completionHandler(answer == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()

        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()

        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(
        _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))

        field.stringValue = defaultText ?? ""
        alert.messageText = prompt
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "pocket", page?.bridge == true, message.frameInfo.isMainFrame,
            let view = message.webView, (view === webView ? pageCommitted : (view.window.map { popups[$0] != nil } ?? false)),
            let address = view.url, sameOrigin(address), let host = address.host, let scheme = address.scheme,
            let body = message.body as? [String: Any], let type = body["type"] as? String,
            let encoded = try? JSONSerialization.data(withJSONObject: body), encoded.count <= 16_384 else { return }
        let origin = message.frameInfo.securityOrigin
        let clean = CharacterSet(charactersIn: "[]")
        let port = scheme == "https" ? 443 : 80

        guard origin.protocol == scheme, origin.host.trimmingCharacters(in: clean).lowercased() == host.trimmingCharacters(in: clean).lowercased(),
            (origin.port == 0 ? port : origin.port) == (address.port ?? port) else { return }
        if type == "settings" { openSettings(nil) }
        else if view === webView && type == "badge" {
            let count = min(Int(Int32.max), max(0, body["count"] as? Int ?? 0))
            setBadge(count)
            if let generation = page?.generation { report("badge", ["generation": generation, "count": count]) }
        } else if view === webView && type == "notify" && notices { notify(body) }
    }

    func notify(_ body: [String: Any]) {
        let center = UNUserNotificationCenter.current()

        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else {
                return
            }

            let content = UNMutableNotificationContent()

            content.title = String((body["title"] as? String ?? "Pi Pocket").prefix(200))
            content.body = String((body["body"] as? String ?? "").prefix(400))
            content.sound = .default
            content.userInfo = ["url": body["url"] as? String ?? "/"]
            let tag = body["tag"] as? String ?? ""

            center.add(UNNotificationRequest(identifier: tag.isEmpty ? UUID().uuidString : tag, content: content, trigger: nil))
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let path = response.notification.request.content.userInfo["url"] as? String ?? "/"

        DispatchQueue.main.async {
            self.openWindow()

            if path.hasPrefix("/") && !path.hasPrefix("//") {
                self.sendPageEvent(self.webView, type: "open", fields: ["url": path])
            }
        }

        completionHandler()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()

app.delegate = delegate
app.run()
