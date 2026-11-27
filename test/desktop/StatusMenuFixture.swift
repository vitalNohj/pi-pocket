import Cocoa

// Compiled only into the macOS smoke installer. Test input and output stay in the
// disposable state directory, and only the loopback fixture can enable menu actions.
@MainActor
final class StatusMenuFixture: NSObject {
    private enum Action: String {
        case firstPin, secondPin, newSession, settings

        var id: String {
            switch self {
            case .firstPin, .secondPin: return "window.pinned"
            case .newSession: return "window.newSession"
            case .settings: return "settings.open"
            }
        }
    }

    private weak var app: AppDelegate?
    private let request: URL
    private let evidence: URL
    private var lastReport: Data?

    private init(app: AppDelegate, folder: URL) {
        self.app = app
        request = folder.appendingPathComponent("status-menu-action.txt")
        evidence = folder.appendingPathComponent("status-menu-model.json")
    }

    static func start(for app: AppDelegate) {
        let environment = ProcessInfo.processInfo.environment
        guard environment["PI_POCKET_TEST_STATUS_MENU"] == "1",
            environment["PI_POCKET_DESKTOP_STATE"]?.hasPrefix("/") == true else { return }
        let probe = StatusMenuFixture(app: app, folder: app.stateFolder)
        // The default run-loop mode does not run this timer during user menu tracking.
        _ = Timer.scheduledTimer(timeInterval: 0.2, target: probe, selector: #selector(StatusMenuFixture.poll(_:)),
            userInfo: nil, repeats: true)
    }

    @objc private func poll(_ timer: Timer) {
        guard let app = app, !app.quitting else { timer.invalidate(); return }
        guard let page = app.page, !page.local, page.address.scheme == "http", page.address.host == "127.0.0.1",
            page.address.path == "/pocket", let item = app.statusItem, item.menu != nil, let button = item.button else { return }

        // Build real NSMenuItems with the status item's update hook, without touching a live menu.
        let menu = NSMenu()
        menu.autoenablesItems = false
        app.menuNeedsUpdate(menu)
        var model: [String: Any] = [
            "badge": button.title,
            "hidden": app.window?.isVisible == false,
            "tray": describe(menu),
            "dock": app.applicationDockMenu(NSApp).map(describe) ?? [],
        ]
        if let screen = NSScreen.screens.first, let window = button.window {
            let bounds = window.convertToScreen(button.convert(button.bounds, to: nil))
            model["anchor"] = ["x": Double(bounds.midX), "y": Double(screen.frame.maxY - bounds.midY)]
        }
        if let data = try? JSONSerialization.data(withJSONObject: model, options: [.prettyPrinted, .sortedKeys]), data != lastReport {
            if (try? data.write(to: evidence, options: .atomic)) != nil { lastReport = data }
        }

        guard let value = try? String(contentsOf: request, encoding: .utf8),
            (try? FileManager.default.removeItem(at: request)) != nil, let action = Action(rawValue: value),
            let (owner, index) = find(action, in: menu) else { return }
        owner.performActionForItem(at: index)
    }

    private func describe(_ menu: NSMenu) -> [[String: Any]] {
        menu.items.filter { !$0.isSeparatorItem }.map { item in
            var row: [String: Any] = ["title": item.title, "enabled": item.isEnabled]
            if let id = (item.representedObject as? [String: Any])?["id"] as? String { row["action"] = id }
            if let submenu = item.submenu { row["items"] = describe(submenu) }
            return row
        }
    }

    private func find(_ action: Action, in menu: NSMenu) -> (NSMenu, Int)? {
        for (index, item) in menu.items.enumerated() where item.isEnabled {
            if let submenu = item.submenu, let found = find(action, in: submenu) { return found }
            guard let entry = item.representedObject as? [String: Any], entry["id"] as? String == action.id else { continue }
            let data = entry["data"] as? [String: Any]
            switch action {
            case .firstPin where data?["id"] as? String == "4": return (menu, index)
            case .secondPin where data?["id"] as? String == "17": return (menu, index)
            case .newSession: return (menu, index)
            case .settings where data == nil: return (menu, index)
            default: continue
            }
        }
        return nil
    }
}
