// This interactive runner driver is not part of the shipped app.
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
        NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps])
        Thread.sleep(forTimeInterval: 0.3)
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        fail("The installed app is not in the foreground.")
    }
}

func key(_ code: CGKeyCode, flags: CGEventFlags = [], text: String? = nil) {
    for pressed in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: pressed) else { fail("Cannot create key event.") }
        event.flags = flags
        if let text = text {
            let units = Array(text.utf16)
            units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress!) }
        }
        event.post(tap: .cghidEventTap)
    }
}

switch operation {
case "find": break
case "shot":
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-o", "-l", String(number), args[4]]
    try capture.run()
    capture.waitUntilExit()
    if capture.terminationStatus != 0 { fail("Could not capture the installed window.") }
case "click":
    prepareInput()
    let frame = NSWindow.frameRect(forContentRect: NSRect(x: 0, y: 0, width: 930, height: 710),
        styleMask: [.titled, .closable, .miniaturizable, .resizable])
    let point = CGPoint(x: rect.minX + Double(args[4])!, y: rect.minY + frame.height - 710 + Double(args[5])!)
    for type: CGEventType in [.mouseMoved, .leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
        else { fail("Cannot create mouse event.") }
        if type != .mouseMoved { event.setIntegerValueField(.mouseEventClickState, value: 1) }
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.04)
    }
case "type":
    prepareInput()
    for character in args[4] { key(0, text: String(character)) }
case "close":
    prepareInput()
    key(13, flags: .maskCommand) // Cmd+W
default: fail("Unknown test operation.")
}
Thread.sleep(forTimeInterval: 0.25)
