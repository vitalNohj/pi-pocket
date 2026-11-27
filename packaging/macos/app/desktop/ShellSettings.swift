import Cocoa
import WebKit

private let settingsAddress = URL(string: "pocket-settings://desktop/index.html")!

private final class SettingsAssets: NSObject, WKURLSchemeHandler {
    private let folder: URL
    private let types = ["/index.html": "text/html", "/settings.css": "text/css", "/settings.js": "application/javascript"]

    init(folder: URL) { self.folder = folder }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == "pocket-settings", url.host == "desktop", url.port == nil,
            url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
            task.request.httpMethod == "GET", let mime = types[url.path],
            let data = try? Data(contentsOf: folder.appendingPathComponent(String(url.path.dropFirst())))
        else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { }
}

final class ShellSettings: NSObject, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let window: NSWindow
    let view: WKWebView
    private let call: (String, Any?, @escaping ShellController.Reply) -> Void
    private let onClose: () -> Void
    private var committed = false
    private var loaded = false
    private var section = "home"

    init(assets: URL, call: @escaping (String, Any?, @escaping ShellController.Reply) -> Void, onClose: @escaping () -> Void) {
        self.call = call
        self.onClose = onClose
        let config = WKWebViewConfiguration()

        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(SettingsAssets(folder: assets), forURLScheme: "pocket-settings")
        view = WKWebView(frame: .zero, configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 930, height: 710),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        config.userContentController.add(self, name: "desktopSettings")
        view.navigationDelegate = self
        window.title = "Desktop Settings — Pi Pocket"
        window.contentView = view
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.minSize = NSSize(width: 490, height: 500)
        window.delegate = self
        window.center()
        view.load(URLRequest(url: settingsAddress))
    }

    func open(_ next: String?) {
        if let next = next { section = next }
        if loaded { send(["v": 1, "type": "section", "section": section]) }
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        committed = false
        view.configuration.userContentController.removeScriptMessageHandler(forName: "desktopSettings")
        onClose()
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.targetFrame?.isMainFrame == true && action.request.url == settingsAddress ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { committed = false; loaded = false }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { committed = webView.url == settingsAddress }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = committed
        send(["v": 1, "type": "section", "section": section])
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard committed, message.name == "desktopSettings", message.webView === view, message.frameInfo.isMainFrame,
            message.frameInfo.request.url == settingsAddress, view.url == settingsAddress,
            let packet = message.body as? [String: Any], packet["v"] as? Int == 1,
            let id = packet["id"] as? Int, (1...Int(Int32.max)).contains(id),
            let command = packet["command"] as? String, ["getState", "subscribe", "patchPreferences", "action"].contains(command),
            let bytes = try? JSONSerialization.data(withJSONObject: packet), bytes.count <= shellMaxPacket
        else { return }

        call(command, packet["value"]) { [weak self] answer in
            switch answer {
            case .success(let value): self?.send(["v": 1, "type": "result", "id": id, "ok": true, "value": value])
            case .failure(let error): self?.send(["v": 1, "type": "result", "id": id, "ok": false, "error": ["message": error.localizedDescription]])
            }
        }
    }

    func send(_ packet: [String: Any]) {
        guard committed, view.url == settingsAddress else { return }
        view.callAsyncJavaScript("window.__desktopSettingsReceive?.(packet)", arguments: ["packet": packet], in: nil, in: .page) { _ in }
    }
}
