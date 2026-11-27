// External driver for the installed app. No test commands or privileges are added to its web bridge.
import Cocoa

let args = CommandLine.arguments
let pid = pid_t(args[1])!
typealias Window = (id: Int, layer: Int, bounds: CGRect)
let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
    .compactMap { entry -> Window? in
        guard (entry[kCGWindowOwnerPID as String] as? pid_t) == pid,
            let id = entry[kCGWindowNumber as String] as? Int,
            let layer = entry[kCGWindowLayer as String] as? Int,
            let bounds = entry[kCGWindowBounds as String] as? [String: Double],
            let x = bounds["X"], let y = bounds["Y"],
            let width = bounds["Width"], let height = bounds["Height"], width >= 200, height >= 100
        else { return nil }
        return (id, layer, CGRect(x: x, y: y, width: width, height: height))
    }
// The fixture's page windows are at least 600 points wide and 400 high on both runners. A Save sheet is not a page.
let pages = windows.filter { $0.layer == 0 && $0.bounds.width >= 600 && $0.bounds.height >= 400 }
let ids = Set(windows.map { $0.id })

func focusedEventSource() -> CGEventSource {
    guard let app = NSRunningApplication(processIdentifier: pid), let source = CGEventSource(stateID: .hidSystemState) else { exit(1) }
    if !app.isActive { app.activate(options: []) }
    for _ in 0..<20 {
        if app.isActive { return source }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    fputs("The fixture could not activate Pi Pocket.\n", stderr)
    exit(1)
}

func click(_ location: CGPoint) {
    let source = focusedEventSource()
    // Give WindowServer and WebKit a pointer move and a complete single click on separate turns.
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: location, mouseButton: .left)
        else { exit(1) }
        if type != .mouseMoved { event.setIntegerValueField(.mouseEventClickState, value: 1) }
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.15)
    }
}

switch args[2] {
case "count":
    print(pages.count)
case "window-ids":
    print(ids.sorted().map { String($0) }.joined(separator: ","))
case "click":
    guard let w = pages.first?.bounds else { exit(1) }
    click(CGPoint(x: w.minX + Double(args[3])!, y: w.minY + Double(args[4])!))
case "escape":
    let source = focusedEventSource()
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: down) else { exit(1) }
        event.flags = []
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.15)
    }
case "save-open", "save-closed", "cancel-save":
    let before = Set(args[3].split(separator: ",").compactMap { Int($0) })
    guard !before.isEmpty, before.isSubset(of: ids) else { exit(1) }
    let added = windows.filter { !before.contains($0.id) }
    if args[2] == "save-closed" { exit(added.isEmpty ? 0 : 1) }
    if args[2] == "cancel-save", added.isEmpty { exit(0) }
    guard added.count == 1, let sheet = added.first?.bounds, sheet.height < 400 else { exit(1) }
    if args[2] == "cancel-save" {
        // The default compact Save sheet on the runners has Cancel just to the left of Save.
        click(CGPoint(x: sheet.maxX - 136, y: sheet.maxY - 30))
    }
default: exit(1)
}
