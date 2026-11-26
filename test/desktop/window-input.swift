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
guard let (number, rect) = found else { fail("The installed app did not show '\(title)'.") }

func key(_ code: CGKeyCode, flags: CGEventFlags = [], text: String? = nil) {
    for pressed in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: pressed) else { fail("Cannot create key event.") }
        event.flags = flags
        if let text = text {
            let units = Array(text.utf16)
            units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress!) }
        }
        event.postToPid(pid)
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
    let frame = NSWindow.frameRect(forContentRect: NSRect(x: 0, y: 0, width: 930, height: 710),
        styleMask: [.titled, .closable, .miniaturizable, .resizable])
    let point = CGPoint(x: rect.minX + Double(args[4])!, y: rect.minY + frame.height - 710 + Double(args[5])!)
    for type: CGEventType in [.leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
        else { fail("Cannot create mouse event.") }
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        event.postToPid(pid)
    }
case "key":
    guard let code = ["Tab": CGKeyCode(48), "Space": 49, "Enter": 36][args[4]] else { fail("Unknown test key.") }
    key(code)
case "type": for character in args[4] { key(0, text: String(character)) }
case "close": key(13, flags: .maskCommand) // Cmd+W
 default: fail("Unknown test operation.")
}
Thread.sleep(forTimeInterval: 0.25)
