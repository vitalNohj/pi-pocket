import Cocoa

extension AppDelegate: NSMenuDelegate, NSMenuItemValidation {
    func menuAction(_ title: String, _ id: String, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(performMenuAction(_:)), keyEquivalent: key)

        item.target = self
        item.representedObject = ["id": id]
        item.keyEquivalentModifierMask = modifiers
        return item
    }

    func mainMenu() -> NSMenu {
        let bar = NSMenu()
        func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: title)

            items.forEach { submenu.addItem($0) }
            holder.submenu = submenu
            bar.addItem(holder)
            return submenu
        }
        func item(_ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let made = NSMenuItem(title: title, action: action, keyEquivalent: key)

            made.keyEquivalentModifierMask = modifiers
            return made
        }

        _ = menu("Pi Pocket", [
            item("About Pi Pocket", #selector(NSApplication.orderFrontStandardAboutPanel(_:))), .separator(),
            menuAction("Desktop Settings…", "settings.open", ","),
            menuAction("Restart Server", "home.local.restart"), .separator(),
            item("Hide Pi Pocket", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))), .separator(),
            item("Quit Pi Pocket", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = menu("File", [
            menuAction("New Session", "window.newSession", "n"),
            menuAction("New Window", "window.newWindow", "n", [.command, .shift]), .separator(),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        _ = menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]), .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        _ = menu("View", [
            menuAction("Back", "window.back", "["), menuAction("Forward", "window.forward", "]"),
            menuAction("Reload", "window.reload", "r"), menuAction("Developer Tools", "window.devTools"), .separator(),
            menuAction("Actual Size", "window.actualSize", "0"), menuAction("Zoom In", "window.zoomIn", "+"),
            menuAction("Zoom Out", "window.zoomOut", "-"), .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        NSApp.windowsMenu = menu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))), .separator(),
        ])
        NSApp.helpMenu = menu("Help", [
            menuAction("Fork on GitHub", "help.repository"), menuAction("Documentation", "help.documentation"),
            menuAction("Desktop Releases", "help.releases"), menuAction("Open Diagnostics Log", "logs.open"),
        ])
        return bar
    }

    func makeStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()

        statusItem = item
        menu.autoenablesItems = false
        menu.delegate = self
        item.menu = menu
        setBadge(0)
    }

    func menuWillOpen(_ menu: NSMenu) { fillMenu(menu, key: "tray") }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()

        menu.autoenablesItems = false
        fillMenu(menu, key: "dock")
        return menu
    }

    func fillMenu(_ menu: NSMenu, key: String) {
        menu.removeAllItems()
        let menus = snapshot["menus"] as? [String: Any]
        let entries = menus?[key] as? [[String: Any]] ?? [
            ["id": "window.open", "label": "Open Pi Pocket", "enabled": true],
            ["id": "settings.open", "label": "Desktop Settings…", "enabled": true],
            ["id": "app.quit", "label": "Quit Pi Pocket", "enabled": true],
        ]

        for entry in entries { menu.addItem(statusEntry(entry)) }
    }

    func statusEntry(_ entry: [String: Any]) -> NSMenuItem {
        if entry["separator"] as? Bool == true { return .separator() }
        let label = entry["label"] as? String ?? ""

        if let children = entry["items"] as? [[String: Any]] {
            let submenu = NSMenu(title: label)
            let holder = NSMenuItem(title: label, action: nil, keyEquivalent: "")

            submenu.autoenablesItems = false
            children.forEach { submenu.addItem(statusEntry($0)) }
            holder.submenu = submenu
            return holder
        }
        let item = menuAction(label, entry["id"] as? String ?? "")

        item.isEnabled = entry["enabled"] as? Bool == true
        item.representedObject = entry
        return item
    }

    @objc func performMenuAction(_ item: NSMenuItem) {
        if let entry = item.representedObject as? [String: Any], let id = entry["id"] as? String {
            shellAction(id, data: entry["data"])
        }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        let action = (item.representedObject as? [String: Any])?["id"] as? String

        switch action {
        case "home.local.restart": return page?.local == true && (activeHome["local"] as? [String: Any])?["verified"] as? Bool == true
        case "window.newSession": return page?.bridge == true
        case "window.newWindow", "window.reload", "window.zoomIn", "window.zoomOut", "window.actualSize": return page != nil
        case "window.back": return frontView?.canGoBack == true
        case "window.forward": return frontView?.canGoForward == true
        case "window.devTools": return devTools && frontView != nil
        default: return true
        }
    }
}
