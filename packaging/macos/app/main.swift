// Pi Pocket.app: the macOS desktop app. A WKWebView window and a menu bar item around a `pi-pocket --desktop` launcher.
//
// The owner token goes only in a header of a request to this Mac: never on a command line, in a title, or in the log.
// A newer pi-pocket package replaces nothing here, so this app uses only --desktop, launcher-running.json,
// /api/pocket/info, /api/sign-in-link, and /api/restart.
import Cocoa
import CoreFoundation
import WebKit

let appVersion = "0.0.0-dev"  // build.sh puts the package's version here.
let openNotice = Notification.Name("io.github.tannermidd.pi-pocket.app.open")
let newSessionNotice = Notification.Name("io.github.tannermidd.pi-pocket.app.new-session")
let quitNotice = Notification.Name("io.github.tannermidd.pi-pocket.app.quit")
let home = FileManager.default.homeDirectoryForCurrentUser
let appFolder = home.appendingPathComponent("Library/Application Support/Pi Pocket")
let logFolder = home.appendingPathComponent("Library/Logs/Pi Pocket")
let logFile = logFolder.appendingPathComponent("launcher.log")

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

    // A desktop-only update leaves the full install's runtime version floor in place.
    let marker = appFolder.appendingPathComponent("runtime-floor.txt")
    let minimum = (try? String(contentsOf: marker, encoding: .utf8))?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? appVersion
    if minimum != "0.0.0-dev" && compareVersions(version, minimum) < 0 {
        return (
            "The pi-pocket package of Pi Pocket is version \(version), older than this app (\(minimum)).",
            "The install did not finish putting the package in place, so Pi Pocket cannot start. \(again)"
        )
    }

    return nil
}

func ownerToken(_ folder: URL) throws -> String {
    let data = try Data(contentsOf: folder.appendingPathComponent("config.json"))

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
    WKScriptMessageHandler
{
    var window: NSWindow?
    var webView: WKWebView?
    // Windows that pages opened (an artifact's "Open tab"), each kept until it closes, with its close observer.
    var popups: [NSWindow: NSObjectProtocol] = [:]
    var statusItem: NSStatusItem?
    var launcher: Process?
    var launcherSettings: LocalLaunchSettings?
    var lifeline: Pipe?
    var controller: ShellController?
    lazy var dictation = DictationHost(self)
    var snapshot: [String: Any] = [:]
    var settings: ShellSettings?
    var page: ShellPage?
    var notice: NSStackView?
    var pageStatus: String?
    var pageCommitted = false
    private var shellStarted = false
    private var initialNewSession = CommandLine.arguments.dropFirst().contains(where: BridgeProtocol.isNewLink)
    var recovered = false
    let localStore = WKWebsiteDataStore.nonPersistent()
    let localQueue = DispatchQueue(label: "Pi Pocket local launcher")
    var local: LocalServer?
    var windowPrefs = WindowPreferences()
    var windowHotkey: WindowHotkey?
    var windowEffect: String?
    var readingWindowLogin = false
    lazy var windowDownloads = WindowDownloads { [weak self] in
        self?.sessionBridge.notices.local("Download complete.")
    }
    let windowKey = UUID().uuidString
    let loginLaunch = CommandLine.arguments.contains("--login") && !CommandLine.arguments.contains("--hidden")
    var openWhenReady = !CommandLine.arguments.contains("--hidden") && !CommandLine.arguments.contains("--login")
    var quitting = false
    var unattendedQuit = false
    var confirmingRunnerQuit = false
    var checkedSignIn = false
    var termSource: DispatchSourceSignal?
    lazy var sessionBridge = BridgeMac(showMain: { [weak self] in self?.openWindow() }, badge: { [weak self] count in
        self?.setBadge(count)
        if let self = self, let generation = self.page?.generation {
            self.report("badge", ["generation": generation, "count": count])
        }
    }, action: { [weak self] action in self?.bridgeAction(action) }, reportPins: { [weak self] feed, pins in
        self?.reportPins(feed: feed, pins: pins)
    }, reportNotices: { [weak self] key, value in self?.report("notifications", [key: value]) },
        dictation: { [weak self] view, data in self?.dictation.receive(view, data) })

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

            if initialNewSession || openWhenReady {
                center.postNotificationName(initialNewSession ? newSessionNotice : openNotice, object: nil, userInfo: nil, deliverImmediately: true)
                other.activate(options: [])
            }

            exit(0)
        }

        center.addObserver(forName: openNotice, object: nil, queue: .main) { [weak self] _ in self?.openWindow() }
        center.addObserver(forName: newSessionNotice, object: nil, queue: .main) { [weak self] _ in self?.requestNewSession() }
        center.addObserver(forName: quitNotice, object: nil, queue: .main) { [weak self] _ in self?.requestUnattendedQuit() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if takeStagedDesktopUpdate(hidden: !openWhenReady) {
            NSApp.terminate(nil)
            return
        }

        NSApp.setActivationPolicy(openWhenReady ? .regular : .accessory)
        NSApp.mainMenu = mainMenu()
        makeStatusItem()
        #if DESKTOP_STATUS_SMOKE
        StatusMenuFixture.start(for: self)
        #endif
        _ = sessionBridge.notices
        startWindowActions()
        signal(SIGTERM, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)

        term.setEventHandler { [weak self] in self?.requestUnattendedQuit() }
        term.resume()
        termSource = term

        if openWhenReady {
            NSApp.activate(ignoringOtherApps: true)
        }

        startShell()
        shellStarted = true
        if initialNewSession { newSession() }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        if urls.contains(where: { BridgeProtocol.isNewLink($0.absoluteString) }) { requestNewSession() }
    }

    private func requestNewSession() {
        if shellStarted { newSession() }
        else { initialNewSession = true }
    }

    func applicationDidHide(_ notification: Notification) { updateSessionVisibility(false) }
    func applicationDidUnhide(_ notification: Notification) { updateSessionVisibility() }

    private func updateSessionVisibility(_ shown: Bool? = nil) {
        visibilityChanged(visible: shown)
        for extra in popups.keys {
            if let view = (extra as? PocketNativeWindow)?.chrome?.webView { sessionBridge.visibility(view, shown: shown) }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWindow()

        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func startLauncher(_ settings: LocalLaunchSettings) throws {
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
        // The shell supplies the PATH, but never interprets the values from Desktop Settings.
        process.arguments = ["-l", "-c", "exec \"$0\" --desktop \"$@\"", script.path,
            "--data", settings.data, "--cwd", settings.folder, "--port", String(settings.port), "--access", settings.access]
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
        launcherSettings = settings
        lifeline = input

        do {
            try process.run()
        } catch {
            launcher = nil
            launcherSettings = nil
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
        guard confirmRunnerQuit() else { return .terminateCancel }
        if quitting { return .terminateLater }
        quitting = true
        windowHotkey?.clear()
        windowDownloads.close()
        dictation.close()
        let ownedController = controller
        ownedController?.close()
        closeSessionWindows()
        settings?.window.close()
        let loop = CFRunLoopGetMain()
        let mode = RunLoop.Mode.modalPanel.rawValue as CFString
        localQueue.async {
            do { try self.stopLocal() }
            catch {
                // Only this app's own direct child. A borrowed launcher has no Process handle here.
                self.launcher?.terminate()
            }
            ownedController?.waitForExit()
            // AppKit waits in modal panel mode after .terminateLater. Use that mode for the reply.
            CFRunLoopPerformBlock(loop, mode) { sender.reply(toApplicationShouldTerminate: true) }
            CFRunLoopWakeUp(loop)
        }
        return .terminateLater
    }

    @objc func openFromMenu() {
        openWindow()
    }

    // The view of the window in front: the main one, or a page's own window.
    var frontView: WKWebView? {
        (NSApp.keyWindow as? PocketNativeWindow)?.chrome?.webView ?? primaryEventView
    }

    var primaryEventView: WKWebView? {
        webView ?? NSApp.orderedWindows.lazy.compactMap { ($0 as? PocketNativeWindow)?.chrome?.webView }.first
    }

    @objc func reload() {
        frontView?.reload()
    }

    private func zoomPage(_ change: (CGFloat) -> CGFloat) {
        guard let view = frontView else { return }
        view.pageZoom = change(view.pageZoom)
        // The native buttons keep their size in points, so their reservation in CSS pixels changes.
        (view.window as? PocketNativeWindow)?.chrome?.needsLayout = true
    }

    @objc func actualSize() {
        zoomPage { _ in 1 }
    }

    @objc func zoomIn() {
        zoomPage { min(3, $0 + 0.1) }
    }

    @objc func zoomOut() {
        zoomPage { max(0.5, $0 - 0.1) }
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
        let made = placeWebView(view, main: true)
        let help = NSTextField(labelWithString: "")
        let settingsButton = NSButton(title: "Desktop Settings…", target: self, action: #selector(openSettingsMenu))
        let strip = NSStackView(views: [help, settingsButton])

        help.lineBreakMode = .byTruncatingTail
        strip.edgeInsets = NSEdgeInsets(top: 4, left: 8, bottom: 4, right: 8)
        strip.distribution = .fill
        made.chrome?.notice = strip
        window = made
        webView = view
        notice = strip
        if page.bridge { sessionBridge.add(view, address: page.address) }
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
        guard let closing = notification.object as? PocketNativeWindow else { return }
        if let view = closing.chrome?.webView {
            dictation.detach(view)
            sessionBridge.remove(view)
        }
        guard closing === window else { return }
        visibilityChanged(visible: false)
        closing.saveFrame(usingName: "Pi Pocket")
        webView = nil
        window = nil
        notice = nil
        if popups.isEmpty && settings == nil { NSApp.terminate(nil) }
    }

    func windowDidMiniaturize(_ notification: Notification) { windowVisibility(notification, shown: false) }
    func windowDidDeminiaturize(_ notification: Notification) { windowVisibility(notification) }
    func windowDidBecomeKey(_ notification: Notification) {
        report("focus", true)
        if let focused = notification.object as? PocketNativeWindow, let view = focused.chrome?.webView {
            sessionBridge.focus(view)
        }
        windowVisibility(notification)
    }
    func windowDidResignKey(_ notification: Notification) { report("focus", false) }

    private func windowVisibility(_ notification: Notification, shown: Bool? = nil) {
        if let changed = notification.object as? NSWindow {
            if changed == window { visibilityChanged(visible: shown) }
            else if let view = (changed as? PocketNativeWindow)?.chrome?.webView { sessionBridge.visibility(view, shown: shown) }
        }
    }

    func visibilityChanged(visible: Bool? = nil) {
        let shown = visible ?? (window?.isVisible == true && window?.isMiniaturized == false)

        report("visibility", shown)
        if let view = webView { sessionBridge.visibility(view, shown: shown) }
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
        if action.targetFrame?.isMainFrame == true, let chrome = (webView.window as? PocketNativeWindow)?.chrome {
            // Only the initiating top-frame link can establish download provenance.
            chrome.firstDownload = eligibleDownload(action) ? url : nil
        }
        // A file the active Pi Pocket page made can use the Save dialog without navigating to its blob URL.
        if action.shouldPerformDownload, page?.bridge == true, sameOrigin(webView.url),
            isMainServerFrame(action.sourceFrame), let scheme = url?.scheme, scheme == "blob" || scheme == "data" {
            decisionHandler(.download)
            return
        }
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
        sessionBridge.started(webView, navigation)
        dictation.detach(webView)
        if webView === self.webView { pageCommitted = false }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        (webView.window as? PocketNativeWindow)?.chrome?.reset()
        if webView === self.webView {
            pageCommitted = sameOrigin(webView.url)
            reportPage(pageOrigin(webView.url))
            pageNotice(page?.bridge == true && pageCommitted ? nil : "Sign in on this page to use Pi Pocket")
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        sessionBridge.failed(webView, navigation)
        if webView === self.webView, (error as NSError).code != NSURLErrorCancelled {
            pageNotice("Could not load this server. Check the address or try again.")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        sessionBridge.failed(webView, navigation)
    }

    func isMainServerFrame(_ frame: WKFrameInfo) -> Bool {
        guard frame.isMainFrame, let address = page?.address, let host = address.host, let scheme = address.scheme else { return false }
        let origin = frame.securityOrigin
        let clean = CharacterSet(charactersIn: "[]")
        let port = scheme == "https" ? 443 : 80
        return origin.protocol == scheme &&
            origin.host.trimmingCharacters(in: clean).lowercased() == host.trimmingCharacters(in: clean).lowercased() &&
            (origin.port == 0 ? port : origin.port) == (address.port ?? port)
    }

    func eligibleDownload(_ action: WKNavigationAction) -> Bool {
        return page?.bridge == true && action.navigationType == .linkActivated && isMainServerFrame(action.sourceFrame) &&
            action.targetFrame?.isMainFrame != false && WindowDownloads.fileRoute(action.request.url, onServer: sameOrigin)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        (webView.window as? PocketNativeWindow)?.chrome?.firstDownload = nil
        let first = eligibleDownload(navigationAction) ? navigationAction.request.url : nil
        windowDownloads.attach(download, to: webView.window, directFrom: first)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        let chrome = (webView.window as? PocketNativeWindow)?.chrome
        let first = navigationResponse.isForMainFrame ? chrome?.firstDownload : nil
        chrome?.firstDownload = nil
        windowDownloads.attach(download, to: webView.window, directFrom: first)
    }

    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        (webView.window as? PocketNativeWindow)?.chrome?.firstDownload = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        sessionBridge.loaded(webView, navigation)
        if webView !== self.webView { return }
        visibilityChanged()
        recovered = false

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
        sessionBridge.failed(webView, nil)
        dictation.detach(webView)
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
            if inApp(url, from: webView.url) && !(windowPrefs.externalPages && sameOrigin(url)) {
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

        let made = placeWebView(view, main: false)
        if let page = page, page.bridge { sessionBridge.add(view, address: page.address) }
        popups[made] = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: made, queue: .main
        ) { [weak self] _ in
            // After the close: the window is not let go while it closes.
            DispatchQueue.main.async {
                if let observer = self?.popups.removeValue(forKey: made) {
                    NotificationCenter.default.removeObserver(observer)
                    if let self = self, !self.quitting, self.window == nil, self.settings == nil, self.popups.isEmpty {
                        NSApp.terminate(nil)
                    }
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
        guard message.name == "pocketWindow", page?.bridge == true,
            isMainServerFrame(message.frameInfo),
            let view = message.webView, (view === webView ? pageCommitted : (view.window.map { popups[$0] != nil } ?? false)),
            sameOrigin(view.url),
            let body = message.body as? [String: Any], let type = body["type"] as? String,
            let encoded = try? JSONSerialization.data(withJSONObject: body), encoded.count <= 16_384 else { return }
        windowMessage(message, body: body, type: type)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()

app.delegate = delegate
app.run()
