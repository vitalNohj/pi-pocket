import Cocoa
import WebKit

extension AppDelegate {
    func startWindowActions() {
        windowHotkey = WindowHotkey { [weak self] in self?.toggleMainWindow() }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(applyWindowOptions),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
    }

    func applySavedWindowPreferences(first: Bool) {
        let next = WindowPreferences(prefs)
        let changed = next != windowPrefs
        windowPrefs = next
        if first {
            if loginLaunch && !next.startHidden { openWhenReady = true }
            do { try setWindowHotkey(next.shortcutEnabled, next.shortcut) }
            catch { log(error.localizedDescription) }
            refreshWindowLogin()
        }
        if changed || first { applyWindowOptions() }
    }

    func setWindowHotkey(_ enabled: Bool, _ shortcut: String) throws {
        if !enabled { windowHotkey?.clear() }
        else if windowHotkey?.bind(shortcut) != true {
            report("window.status", ["shortcutActive": windowHotkey?.active == true])
            throw shellError("The show/hide shortcut is already in use or reserved by macOS. Choose another shortcut.")
        }
        report("window.status", ["shortcutActive": windowHotkey?.active == true])
    }

    func refreshWindowLogin() {
        if readingWindowLogin { return }
        readingWindowLogin = true
        WindowLogin.status { [weak self] enabled in
            self?.readingWindowLogin = false
            self?.report("platform", ["loginEnabled": enabled])
        }
    }

    func toggleMainWindow() {
        if page == nil {
            if let settings = settings, settings.window.isKeyWindow && settings.window.isVisible {
                settings.window.orderOut(nil)
            } else { openSettings("runner") }
        } else if NSApp.isActive, let main = window, main.isKeyWindow, main.isVisible, !main.isMiniaturized {
            main.orderOut(nil)
            visibilityChanged(visible: false)
        } else { openWindow() }
    }

    func installWindowScript(in controller: WKUserContentController, origin: String, initial: String) {
        guard let url = Bundle.main.url(forResource: "window-host", withExtension: "js"),
            let source = try? String(contentsOf: url, encoding: .utf8),
            let data = try? JSONSerialization.data(withJSONObject: [origin, windowKey]),
            let arguments = String(data: data, encoding: .utf8)
        else { return }
        let bootstrap = source.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ";")))
        let script = "\(bootstrap)(...\(arguments), \(initial), (message) => window.webkit.messageHandlers.pocketWindow.postMessage(message));"
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(self, name: "pocketWindow")
    }

    func placeWebView(_ view: WKWebView, main: Bool) -> PocketNativeWindow {
        let window = PocketNativeWindow(
            contentRect: NSRect(x: 0, y: 0, width: main ? 1200 : 1000, height: main ? 820 : 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Pi Pocket"
        window.minSize = NSSize(width: 420, height: 400)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.showTitlebarOptions = { [weak self] in self?.showWindowContextMenu() }
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        let chrome = WindowChrome(view: view, prefs: windowPrefs)
        window.contentView = chrome
        if main {
            chrome.onEffect = { [weak self, weak window] effect in
                guard let self = self, window === self.window else { return }
                self.reportWindowEffect(effect)
            }
        }
        chrome.apply(windowPrefs)
        window.center()

        if main {
            window.setFrameAutosaveName("Pi Pocket")
            window.setFrameUsingName("Pi Pocket")
            if let visible = (window.screen ?? NSScreen.main)?.visibleFrame {
                var rect = window.frame
                rect.size.width = min(rect.width, visible.width)
                rect.size.height = min(rect.height, visible.height)
                rect.origin.x = max(visible.minX, min(rect.minX, visible.maxX - rect.width))
                rect.origin.y = max(visible.minY, min(rect.minY, visible.maxY - rect.height))
                window.setFrame(rect, display: false)
            }
        } else if let from = NSApp.keyWindow, let rect = (from.screen ?? NSScreen.main)?.visibleFrame {
            let top = NSPoint(x: min(from.frame.minX + 24, rect.maxX - window.frame.width), y: from.frame.maxY - 24)
            window.setFrameTopLeftPoint(top)
        }

        return window
    }

    func windowMessage(_ message: WKScriptMessage, body: [String: Any], type: String) {
        guard body["key"] as? String == windowKey,
            let view = message.webView, let window = view.window as? PocketNativeWindow, sameOrigin(view.url)
        else { return }
        window.chrome?.message(type, body: body, options: showWindowContextMenu)
        if type == "theme", window === self.window, let generation = page?.generation {
            let palette = ["background", "panel", "text", "accent", "dark"].reduce(into: [String: Any]()) {
                $0[$1] = body[$1]
            }
            report("window.theme", ["generation": generation, "palette": palette])
        }
    }

    func reportWindowEffect(_ effect: String) {
        if windowEffect != effect {
            windowEffect = effect
            report("window.status", ["effect": effect])
        }
    }

    @objc func applyWindowOptions() {
        if window == nil {
            let workspace = NSWorkspace.shared
            reportWindowEffect(workspace.accessibilityDisplayShouldIncreaseContrast ||
                workspace.accessibilityDisplayShouldReduceTransparency ? "unsupported" : "page")
        }
        for each in ([window].compactMap { $0 } + Array(popups.keys)) {
            if let chrome = (each as? PocketNativeWindow)?.chrome {
                chrome.apply(windowPrefs)
                chrome.webView.isInspectable = devTools
            }
        }
    }

    func addWindowOptions(to menu: NSMenu) {
        for (label, action) in [("Window Settings…", #selector(openWindowSettings)),
            ("Appearance Settings…", #selector(openAppearanceSettings))] {
            menu.addItem(withTitle: label, action: action, keyEquivalent: "").target = self
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === statusItem?.menu {
            fillMenu(menu, key: "tray")
        } else if menu.title == "Window options" {
            menu.removeAllItems()
            addWindowOptions(to: menu)
        }
    }

    @objc func openWindowSettings() { openSettings("window") }
    @objc func openAppearanceSettings() { openSettings("appearance") }

    func windowDidResize(_ notification: Notification) {
        (notification.object as? PocketNativeWindow)?.chrome?.needsLayout = true
    }

    func windowDidEnterFullScreen(_ notification: Notification) { applyWindowOptions() }
    func windowDidExitFullScreen(_ notification: Notification) { applyWindowOptions() }
}
