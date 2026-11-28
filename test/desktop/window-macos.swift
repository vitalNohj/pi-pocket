// External driver for the installed app. No test commands or privileges are added to its web bridge.
import ApplicationServices
import Cocoa

let args = CommandLine.arguments
let pid = pid_t(args[1])!
if args[2] == "display-effects" {
    let workspace = NSWorkspace.shared
    print("Reduce Transparency: \(workspace.accessibilityDisplayShouldReduceTransparency)")
    print("Increase Contrast: \(workspace.accessibilityDisplayShouldIncreaseContrast)")
    exit(0)
}
if args[2] == "wallpaper" {
    let image = URL(fileURLWithPath: args[3])
    do {
        for screen in NSScreen.screens {
            try NSWorkspace.shared.setDesktopImageURL(image, for: screen, options: [:])
        }
    } catch {
        fputs("Could not set runner wallpaper: \(error)\n", stderr)
        exit(1)
    }
    exit(0)
}
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

func click(_ location: CGPoint, source: CGEventSource = focusedEventSource()) {
    // Give WindowServer and WebKit a pointer move and a complete single click on separate turns.
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: location, mouseButton: .left)
        else { exit(1) }
        // This is a plain click, even if an earlier installer fixture used a keyboard shortcut.
        event.flags = []
        if type != .mouseMoved { event.setIntegerValueField(.mouseEventClickState, value: 1) }
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.15)
    }
}

func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func clickable(at point: CGPoint, named name: String, in app: AXUIElement, window: AXUIElement) -> Bool {
    func hasLabel(_ element: AXUIElement) -> Bool {
        [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].contains {
            axAttribute(element, $0) as? String == name
        }
    }
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success else { return false }
    var named = false
    for _ in 0..<8 {
        guard let element = hit else { return false }
        named = named || hasLabel(element)
        let role = axAttribute(element, kAXRoleAttribute) as? String
        if role == kAXButtonRole || role == "AXLink" {
            let enabled = (axAttribute(element, kAXEnabledAttribute) as? Bool) ?? (role == "AXLink")
            let children = axAttribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            guard enabled, named || children.contains(where: hasLabel),
                let owner = axElement(axAttribute(element, kAXWindowAttribute)) ??
                    axElement(axAttribute(element, kAXTopLevelUIElementAttribute)) else { return false }
            return CFEqual(owner, window)
        }
        hit = axElement(axAttribute(element, kAXParentAttribute))
    }
    return false
}

func clickVerified(_ point: CGPoint, name: String) {
    guard AXIsProcessTrusted() else {
        fputs("The window fixture needs accessibility read-back.\n", stderr)
        exit(1)
    }
    let source = focusedEventSource()
    let app = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetMessagingTimeout(app, 0.5)
    let start = ProcessInfo.processInfo.systemUptime

    // Finder or a Save sheet can leave WebKit without focus. Poll observations, then click once.
    while ProcessInfo.processInfo.systemUptime - start < 8 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
            let window = axElement(axAttribute(app, kAXFocusedWindowAttribute)),
            axAttribute(window, kAXRoleAttribute) as? String == kAXWindowRole,
            clickable(at: point, named: name, in: app, window: window) {
            click(point, source: source)
            print("Window fixture: verified and clicked \(name).")
            return
        }
        Thread.sleep(forTimeInterval: 0.1)
    }
    fputs("Window fixture: \(name) was not ready in the focused Pi Pocket window.\n", stderr)
    exit(1)
}

switch args[2] {
case "count":
    print(pages.count)
case "window-ids":
    print(ids.sorted().map { String($0) }.joined(separator: ","))
case "click", "click-verified":
    guard let w = pages.first?.bounds else { exit(1) }
    let point = CGPoint(x: w.minX + Double(args[3])!, y: w.minY + Double(args[4])!)
    if args[2] == "click-verified" { clickVerified(point, name: args[5]) }
    else { click(point) }
case "escape", "key", "hotkey":
    let source: CGEventSource
    if args[2] == "hotkey" {
        guard let global = CGEventSource(stateID: .hidSystemState) else { exit(1) }
        source = global
    } else { source = focusedEventSource() }
    let key = args[2] == "escape" ? CGKeyCode(53) : CGKeyCode(args[3])!
    var flags: CGEventFlags = []
    for modifier in args.dropFirst(4) {
        switch modifier {
        case "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "control": flags.insert(.maskControl)
        case "option": flags.insert(.maskAlternate)
        default: exit(1)
        }
    }
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { exit(1) }
        event.flags = flags
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
