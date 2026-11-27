// This interactive runner driver is not part of the shipped app.
import ApplicationServices
import Cocoa
import CoreGraphics

let args = CommandLine.arguments
let pid = Int32(args[1])!
let operation = args[2]
let title = args[3]

func fail(_ text: String) -> Never {
    FileHandle.standardError.write(Data("\(text)\n".utf8))
    exit(1)
}

func window() -> (Int, CGRect)? {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let windows: [(Int, CGRect)] = list.compactMap { item in
        guard item[kCGWindowOwnerPID as String] as? Int32 == pid,
            item[kCGWindowLayer as String] as? Int == 0,
            let bounds = item[kCGWindowBounds as String] as? [String: Any],
            let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width >= 420,
            let number = item[kCGWindowNumber as String] as? Int else { return nil }
        if let name = item[kCGWindowName as String] as? String, !name.isEmpty, name != title { return nil }
        return (number, rect)
    }
    return windows.first
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func elementAttribute(_ item: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(item, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func hasName(_ item: AXUIElement, _ name: String) -> Bool {
    [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].contains { attribute(item, $0) as? String == name }
}

func named(_ roots: [AXUIElement], _ name: String, role: String? = nil) -> AXUIElement? {
    var queue = roots
    var index = 0
    while index < queue.count && index < 1500 {
        let item = queue[index]
        index += 1
        if role == nil || attribute(item, kAXRoleAttribute) as? String == role {
            if hasName(item, name) { return item }
            if let label = elementAttribute(item, kAXTitleUIElementAttribute), hasName(label, name) { return item }
        }
        queue.append(contentsOf: attribute(item, kAXChildrenAttribute) as? [AXUIElement] ?? [])
    }
    return nil
}

func waitForNamed(_ roots: [AXUIElement], _ name: String, role: String? = nil) -> AXUIElement {
    let start = ProcessInfo.processInfo.systemUptime
    while ProcessInfo.processInfo.systemUptime - start < 15 {
        if let item = named(roots, name, role: role) { return item }
        Thread.sleep(forTimeInterval: 0.25)
    }
    fail("Could not see '\(name)' (\(role ?? "any role")) in the installed app or menu bar.")
}

func bounds(_ item: AXUIElement) -> CGRect? {
    guard let position = attribute(item, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let extent = attribute(item, kAXSizeAttribute), CFGetTypeID(extent) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(extent as! AXValue, .cgSize, &size), size != .zero
    else { return nil }
    return CGRect(origin: point, size: size)
}

func clickCenter(_ item: AXUIElement) {
    guard let rect = bounds(item) else { fail("The control has no screen bounds.") }
    click(CGPoint(x: rect.midX, y: rect.midY))
}

func press(_ item: AXUIElement) {
    if AXUIElementPerformAction(item, kAXPressAction as CFString) != .success { clickCenter(item) }
}

func capture(_ arguments: [String]) {
    let command = Process()
    command.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    command.arguments = ["-x"] + arguments
    do { try command.run() }
    catch { fail("Could not start screencapture.") }
    command.waitUntilExit()
    if command.terminationStatus != 0 { fail("Could not capture the installed app.") }
}

if operation == "tray-shot" {
    guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { fail("The menu bar driver needs Accessibility permission.") }
    let app = AXUIElementCreateApplication(pid)
    guard let extras = attribute(app, "AXExtrasMenuBar"), CFGetTypeID(extras) == AXUIElementGetTypeID()
    else { fail("The app has no accessible π menu bar item.") }
    let bar = extras as! AXUIElement
    let item = named([bar], "π") ?? (attribute(bar, kAXChildrenAttribute) as? [AXUIElement])?.first
    guard let item = item else { fail("Could not find the π menu bar item.") }
    clickCenter(item)
    let row = waitForNamed([item, bar, app], args[3], role: kAXMenuItemRole)
    guard let menu = elementAttribute(row, kAXParentAttribute), let menuBounds = bounds(menu), let itemBounds = bounds(item)
    else { fail("The open π menu has no screen bounds.") }
    let region = menuBounds.union(itemBounds).integral
    let crop = "\(Int(region.minX)),\(Int(region.minY)),\(Int(region.width)),\(Int(region.height))"
    capture(["-R", crop, args[4]])
    clickCenter(row)
    exit(0)
}

var found: (Int, CGRect)?
for _ in 0..<60 {
    found = window()
    if found != nil { break }
    Thread.sleep(forTimeInterval: 0.3)
}
guard let (number, rect) = found else {
    let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    let owned = windows.filter { $0[kCGWindowOwnerPID as String] as? Int32 == pid }
    let details = owned.map { window in
        let title = window[kCGWindowName as String] as? String ?? "(untitled)"
        let bounds = window[kCGWindowBounds as String] ?? "(no bounds)"
        return "\(title) \(bounds)"
    }.joined(separator: "; ")
    fail("The installed app did not show '\(title)'. Its \(owned.count) windows: \(details)")
}

func prepareInput() {
    guard CGPreflightPostEventAccess() else { fail("macOS has not authorized the installer input driver to post Quartz events.") }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        NSRunningApplication(processIdentifier: pid)?.activate(options: [])
        Thread.sleep(forTimeInterval: 0.3)
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        fail("The installed app is not in the foreground.")
    }
}

func waitForFocusedField(_ expected: String) {
    guard AXIsProcessTrusted() else { fail("macOS has not authorized accessibility read-back for the installer input driver.") }
    let app = AXUIElementCreateApplication(pid)

    // Poll observations only. Do not post more input or change the field.
    let start = ProcessInfo.processInfo.systemUptime
    while ProcessInfo.processInfo.systemUptime - start < 5 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
            let focus = attribute(app, kAXFocusedUIElementAttribute), CFGetTypeID(focus) == AXUIElementGetTypeID() {
            let field = focus as! AXUIElement
            if attribute(field, kAXRoleAttribute) as? String == kAXTextFieldRole,
                attribute(field, kAXValueAttribute) as? String == expected { return }
        }
        Thread.sleep(forTimeInterval: 0.1)
    }
    fail("The focused Server address field did not contain the fixture address.")
}

func key(_ code: CGKeyCode, flags: CGEventFlags = [], text: String? = nil) {
    for pressed in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: pressed) else { fail("Cannot create key event.") }
        // The installer runs other UI fixtures in this same desktop session.
        event.flags = pressed ? flags : []
        if let text = text {
            let units = Array(text.utf16)
            units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress!) }
        }
        event.post(tap: .cghidEventTap)
    }
}

func click(_ point: CGPoint) {
    for type: CGEventType in [.mouseMoved, .leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
        else { fail("Cannot create mouse event.") }
        event.flags = []
        if type != .mouseMoved { event.setIntegerValueField(.mouseEventClickState, value: 1) }
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.04)
    }
}

switch operation {
case "find": break
case "shot":
    capture(["-o", "-l", String(number), args[4]])
case "dictation-menu":
    prepareInput()
    key(109, flags: [.maskControl, .maskShift]) // Ctrl+Shift+F10 in the isolated fixture profile.
    Thread.sleep(forTimeInterval: 0.6)
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", args[4]]
    try capture.run()
    capture.waitUntilExit()
    click(CGPoint(x: rect.midX, y: rect.maxY - 45)) // A click outside ends mouse tracking.
    Thread.sleep(forTimeInterval: 2.0) // Let the menu's fixture-only dismissal finish before Quit.
    if capture.terminationStatus != 0 { fail("Could not capture the π menu.") }
case "click":
    prepareInput()
    let frame = NSWindow.frameRect(forContentRect: NSRect(x: 0, y: 0, width: 930, height: 710),
        styleMask: [.titled, .closable, .miniaturizable, .resizable])
    click(CGPoint(x: rect.minX + Double(args[4])!, y: rect.minY + frame.height - 710 + Double(args[5])!))
case "press", "expect-text", "focus-field":
    prepareInput()
    guard AXIsProcessTrusted() else { fail("The app's input driver needs Accessibility permission.") }
    let app = AXUIElementCreateApplication(pid)
    if operation == "focus-field" {
        // Match the editable control, not the adjacent static text with the same name.
        let field = waitForNamed([app], args[4], role: kAXTextFieldRole)
        clickCenter(field)
        if let focused = elementAttribute(app, kAXFocusedUIElementAttribute), CFEqual(focused, field) { break }
        guard AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
            fail("Could not focus '\(args[4])'.")
        }
    } else {
        let item = waitForNamed([app], args[4])
        if operation == "press" { press(item) }
    }
case "type":
    prepareInput()
    // Paste the fixture address as one edit. WKWebView can delay individual Quartz key events while checking spelling.
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    guard pasteboard.setString(args[4], forType: .string) else { fail("Cannot copy the test address.") }
    key(9, flags: .maskCommand) // Cmd+V
case "type-private":
    prepareInput()
    guard let code = readLine(), code.range(of: "^[A-Z0-9]{4}(-[A-Z0-9]{4}){2}$", options: .regularExpression) != nil else {
        fail("Expected a disposable code on stdin.")
    }
    for character in code { key(0, text: String(character)) }
case "expect-field":
    prepareInput()
    waitForFocusedField(args[4])
case "close":
    prepareInput()
    key(13, flags: .maskCommand) // Cmd+W
default: fail("Unknown test operation.")
}
Thread.sleep(forTimeInterval: 0.25)
