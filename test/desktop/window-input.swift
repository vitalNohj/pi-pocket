// This interactive runner driver is not part of the shipped app.
import ApplicationServices
import Cocoa
import CoreGraphics
import Vision

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

func hasName(_ item: AXUIElement, _ name: String, prefix: Bool = false) -> Bool {
    [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].contains {
        guard let text = attribute(item, $0) as? String else { return false }
        return prefix ? text.hasPrefix(name) : text == name
    }
}

func named(_ roots: [AXUIElement], _ name: String, role: String? = nil, prefix: Bool = false) -> AXUIElement? {
    var queue = roots
    var index = 0
    while index < queue.count && index < 1500 {
        let item = queue[index]
        index += 1
        if role == nil || attribute(item, kAXRoleAttribute) as? String == role {
            if hasName(item, name, prefix: prefix) { return item }
            if let label = elementAttribute(item, kAXTitleUIElementAttribute), hasName(label, name, prefix: prefix) { return item }
        }
        queue.append(contentsOf: attribute(item, kAXChildrenAttribute) as? [AXUIElement] ?? [])
    }
    return nil
}

func waitForNamed(_ roots: [AXUIElement], _ name: String, role: String? = nil, prefix: Bool = false) -> AXUIElement {
    let start = ProcessInfo.processInfo.systemUptime
    while ProcessInfo.processInfo.systemUptime - start < 15 {
        if let item = named(roots, name, role: role, prefix: prefix) { return item }
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
    pointAt(CGPoint(x: rect.midX, y: rect.midY), click: true)
}

func press(_ item: AXUIElement) {
    if AXUIElementPerformAction(item, kAXPressAction as CFString) != .success { clickCenter(item) }
}

func capture(_ arguments: [String]) throws {
    let command = Process()
    command.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    command.arguments = ["-x"] + arguments
    try command.run()
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
    try capture(["-R", crop, args[4]])
    clickCenter(row)
    exit(0)
}

func waitForWindow() -> (Int, CGRect) {
    for _ in 0..<60 {
        if let found = window() { return found }
        Thread.sleep(forTimeInterval: 0.3)
    }
    let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    let owned = windows.filter { $0[kCGWindowOwnerPID as String] as? Int32 == pid }
    let details = owned.map { window in
        let title = window[kCGWindowName as String] as? String ?? "(untitled)"
        let bounds = window[kCGWindowBounds as String] ?? "(no bounds)"
        return "\(title) \(bounds)"
    }.joined(separator: "; ")
    fail("The installed app did not show '\(title)'. Its \(owned.count) windows: \(details)")
}

func requirePostEvent() {
    guard CGPreflightPostEventAccess() else { fail("macOS has not authorized the installer input driver to post Quartz events.") }
}

func prepareInput() {
    requirePostEvent()
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

func capture(_ path: String, window: Int? = nil) throws {
    try capture((window.map { ["-o", "-l", String($0)] } ?? ["-m"]) + [path])
}

func pointAt(_ point: CGPoint, click: Bool) {
    for type: CGEventType in click ? [.mouseMoved, .leftMouseDown, .leftMouseUp] : [.mouseMoved] {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
        else { fail("Cannot create mouse event.") }
        event.flags = []
        if type != .mouseMoved { event.setIntegerValueField(.mouseEventClickState, value: 1) }
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.04)
    }
}

func useStatusMenu(badge: String, submenu: String, select: String, proof: String, other: String, anchor: CGPoint?) throws {
    requirePostEvent()
    let screen = CGDisplayBounds(CGMainDisplayID())
    let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    let status = windows.first { window in
        guard window[kCGWindowOwnerPID as String] as? Int32 == pid,
            let bounds = window[kCGWindowBounds as String] as? [String: Any],
            let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
        return rect.minY < screen.minY + 8 && rect.height >= 18 && rect.height <= 48 && rect.width < 180
    }
    let bounds = status?[kCGWindowBounds as String] as? [String: Any]
    let rect = bounds.flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
    let point = rect.map { CGPoint(x: $0.midX, y: $0.midY) } ?? anchor
    guard let point = point, screen.contains(point), point.y < screen.minY + 48 else {
        if proof != "-" { try capture(proof) }
        fail("No π status item for the installed app.")
    }
    pointAt(point, click: true)

    // Read the real menu on this display. Unlike AX inspection, this needs only the screenshot
    // and Quartz input access already used by the installer smoke, not an additional TCC grant.
    let temp = FileManager.default.temporaryDirectory.appendingPathComponent("pocket-menu-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: temp) }
    func waitForText(_ sought: String) throws -> CGPoint {
        var lines: [String] = []
        for _ in 0..<7 {
            Thread.sleep(forTimeInterval: 0.25)
            try capture(temp.path)
            let recognition = VNRecognizeTextRequest()
            recognition.recognitionLevel = .accurate
            try VNImageRequestHandler(url: temp, options: [:]).perform([recognition])
            lines = []
            for result in recognition.results ?? [] {
                guard let text = result.topCandidates(1).first?.string else { continue }
                lines.append(text)
                if text.localizedCaseInsensitiveContains(sought) {
                    let rect = result.boundingBox
                    return CGPoint(x: screen.minX + rect.midX * screen.width, y: screen.minY + (1 - rect.midY) * screen.height)
                }
            }
        }
        if proof != "-" { try capture(proof) }
        key(53) // Leave menu tracking before the test uses native actions without a click.
        fail("The π menu did not show '\(sought)' after a click on the status item at \(point). Visible text: \(lines.joined(separator: " | "))")
    }
    _ = try waitForText(badge)
    if submenu != "-" { pointAt(try waitForText(submenu), click: false) }
    if other != "-" { _ = try waitForText(other) }
    let item = try waitForText(select)
    if proof != "-" { try capture(proof) }
    pointAt(item, click: true)
}

if operation == "tray" {
    var anchor: CGPoint?
    if args.count > 9, let x = Double(args[8]), let y = Double(args[9]) { anchor = CGPoint(x: x, y: y) }
    try useStatusMenu(badge: title, submenu: args[4], select: args[5], proof: args[6], other: args[7], anchor: anchor)
    Thread.sleep(forTimeInterval: 0.25)
    exit(0)
}

let (number, rect) = waitForWindow()
switch operation {
case "find": break
case "shot":
    try capture(args[4], window: number)
case "dictation-menu":
    prepareInput()
    key(109, flags: [.maskControl, .maskShift]) // Ctrl+Shift+F10 in the isolated fixture profile.
    Thread.sleep(forTimeInterval: 0.6)
    try capture(args[4])
    pointAt(CGPoint(x: rect.midX, y: rect.maxY - 45), click: true) // A click outside ends mouse tracking.
    Thread.sleep(forTimeInterval: 2.0) // Let the menu's fixture-only dismissal finish before Quit.
case "click":
    prepareInput()
    let frame = NSWindow.frameRect(forContentRect: NSRect(x: 0, y: 0, width: 930, height: 710),
        styleMask: [.titled, .closable, .miniaturizable, .resizable])
    let point = CGPoint(x: rect.minX + Double(args[4])!, y: rect.minY + frame.height - 710 + Double(args[5])!)
    pointAt(point, click: true)
case "press", "expect-text", "expect-prefix", "focus-field":
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
        let item = waitForNamed([app], args[4], prefix: operation == "expect-prefix")
        if operation == "press" { press(item) }
    }
case "new":
    prepareInput()
    key(45, flags: .maskCommand) // Cmd+N
case "selectAll":
    prepareInput()
    key(0, flags: .maskCommand) // Cmd+A
case "chooseNext":
    prepareInput()
    key(125) // Down
    key(36) // Return
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
case "select-file":
    prepareInput()
    key(5, flags: [.maskCommand, .maskShift]) // Go to Folder in the open panel
    Thread.sleep(forTimeInterval: 0.5)
    let clipboard = NSPasteboard.general
    clipboard.clearContents()
    guard clipboard.setString(args[4], forType: .string) else { fail("Could not copy the fixture path.") }
    key(9, flags: .maskCommand) // Paste the full path without dropping key events.
    Thread.sleep(forTimeInterval: 0.5)
    key(36) // Go to the file
    Thread.sleep(forTimeInterval: 0.8)
    key(36) // Open
case "close":
    prepareInput()
    key(13, flags: .maskCommand) // Cmd+W
default: fail("Unknown test operation.")
}
Thread.sleep(forTimeInterval: 0.25)
