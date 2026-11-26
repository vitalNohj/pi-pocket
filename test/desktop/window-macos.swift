// External driver for the installed app. No test commands or privileges are added to its web bridge.
import Cocoa

let args = CommandLine.arguments
let pid = pid_t(args[1])!
let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
    .filter { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
    .compactMap { entry -> CGRect? in
        guard let bounds = entry[kCGWindowBounds as String] as? [String: Double],
            let x = bounds["X"], let y = bounds["Y"], let width = bounds["Width"], let height = bounds["Height"], width >= 400
        else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

switch args[2] {
case "count":
    print(windows.count)
case "click":
    guard let w = windows.first else { exit(1) }
    let app = NSRunningApplication(processIdentifier: pid)
    app?.activate(options: [])
    let location = CGPoint(x: w.minX + Double(args[3])!, y: w.minY + Double(args[4])!)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: location, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: location, mouseButton: .left)?.post(tap: .cghidEventTap)
case "escape":
    for down in [true, false] {
        CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: down)?.post(tap: .cghidEventTap)
    }
default: exit(1)
}
