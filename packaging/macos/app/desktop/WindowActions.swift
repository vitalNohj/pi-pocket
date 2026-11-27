import Cocoa
import WebKit

extension AppDelegate {
    func startWindowActions() {
        windowHotkey = WindowHotkey { [weak self] in self?.toggleMainWindow() }
        if windowPrefs.globalShortcut == true, windowHotkey?.bind() == false {
            log("The show/hide shortcut is already in use.")
        }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(applyWindowOptions),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
    }

    func toggleMainWindow() {
        if NSApp.isActive, let main = window, main.isKeyWindow, main.isVisible, !main.isMiniaturized {
            main.orderOut(nil)
            visibilityChanged(visible: false)
        } else {
            openWindow()
        }
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
        window.contentView = WindowChrome(view: view, prefs: windowPrefs)
        window.chrome?.apply(windowPrefs)
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
    }

    @objc func applyWindowOptions() {
        for each in ([window].compactMap { $0 } + Array(popups.keys)) {
            if let chrome = (each as? PocketNativeWindow)?.chrome {
                chrome.apply(windowPrefs)
                chrome.webView.isInspectable = devTools
            }
        }
    }

    func saveWindowOptions() {
        do { try windowPrefs.save() }
        catch { log("Could not save the window options.") }
        applyWindowOptions()
    }

    func addWindowOptions(to menu: NSMenu) {
        func add(_ label: String, _ action: Selector, _ tag: Int, _ selected: Bool) {
            let item = menu.addItem(withTitle: label, action: action, keyEquivalent: "")
            item.target = self
            item.tag = tag
            item.state = selected ? .on : .off
        }

        add("Seamless title bar", #selector(selectTitleBar), 1, windowPrefs.seamless)
        add("System title bar", #selector(selectTitleBar), 0, !windowPrefs.seamless)
        menu.addItem(.separator())
        let workspace = NSWorkspace.shared
        let glass = !workspace.accessibilityDisplayShouldReduceTransparency && !workspace.accessibilityDisplayShouldIncreaseContrast
        if glass {
            add("See-through background", #selector(toggleWindowOption), 1, windowPrefs.seeThrough == true)
        } else {
            let unavailable = menu.addItem(withTitle: "See-through background (unavailable)", action: nil, keyEquivalent: "")
            unavailable.isEnabled = false
        }
        add("Window blur", #selector(selectMaterial), 0, windowPrefs.material == nil || windowPrefs.material == "window")
        add("Sidebar blur", #selector(selectMaterial), 1, windowPrefs.material == "sidebar")
        add("Dark glass", #selector(selectMaterial), 2, windowPrefs.material == "dark")
        add("Full-screen blur", #selector(selectMaterial), 3, windowPrefs.material == "full-screen")
        menu.addItem(.separator())
        add("Close to menu bar", #selector(toggleWindowOption), 2, closeToTray)
        add("Open other Pi Pocket pages in browser", #selector(toggleWindowOption), 3, windowPrefs.externalPages == true)
        add("Show/hide shortcut (⌘⇧P)", #selector(toggleWindowOption), 4, windowPrefs.globalShortcut == true)
        add("Launch at login", #selector(toggleWindowOption), 5, WindowLogin.enabled)
        add("Start hidden at login", #selector(toggleWindowOption), 6, windowPrefs.startHidden ?? WindowLogin.legacyHidden)
        add("Enable developer tools", #selector(toggleWindowOption), 7, devTools)
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === statusItem?.menu {
            fillMenu(menu, key: "tray")
        } else if menu.title == "Window options" {
            menu.removeAllItems()
            addWindowOptions(to: menu)
        }
    }

    @objc func selectTitleBar(_ item: NSMenuItem) {
        windowPrefs.titleBar = item.tag == 1 ? "seamless" : "system"
        saveWindowOptions()
    }

    @objc func selectMaterial(_ item: NSMenuItem) {
        let materials = ["window", "sidebar", "dark", "full-screen"]
        guard materials.indices.contains(item.tag) else { return }
        windowPrefs.material = materials[item.tag]
        saveWindowOptions()
    }

    @objc func toggleWindowOption(_ item: NSMenuItem) {
        switch item.tag {
        case 1: windowPrefs.seeThrough = windowPrefs.seeThrough != true
        case 2: windowPrefs.closeToTray = !closeToTray
        case 3: windowPrefs.externalPages = windowPrefs.externalPages != true
        case 4:
            if windowPrefs.globalShortcut == true {
                windowHotkey?.clear()
                windowPrefs.globalShortcut = false
            } else {
                guard windowHotkey?.bind() == true else {
                    windowOptionError("The show/hide shortcut is already in use.")
                    return
                }
                windowPrefs.globalShortcut = true
            }
        case 5:
            WindowLogin.set(!WindowLogin.enabled) { [weak self] ok in
                if !ok { self?.windowOptionError("Could not change launch at login.") }
            }
            return
        case 6:
            windowPrefs.startHidden = !(windowPrefs.startHidden ?? WindowLogin.legacyHidden)
            if WindowLogin.legacyHidden {
                WindowLogin.set(true) { [weak self] ok in
                    if !ok { self?.windowOptionError("Could not update the login item.") }
                }
            }
        case 7: windowPrefs.developerTools = !devTools
        default: return
        }
        saveWindowOptions()
    }

    private func windowOptionError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        if let window = NSApp.keyWindow { alert.beginSheetModal(for: window, completionHandler: nil) }
        else { log(message) }
    }

    func windowDidResize(_ notification: Notification) {
        (notification.object as? PocketNativeWindow)?.chrome?.needsLayout = true
    }

    func windowDidEnterFullScreen(_ notification: Notification) { applyWindowOptions() }
    func windowDidExitFullScreen(_ notification: Notification) { applyWindowOptions() }
}
