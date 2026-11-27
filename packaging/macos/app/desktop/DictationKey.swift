import Cocoa
import WebKit

// The binding applies throughout the app, not in other apps. Do not request Input Monitoring or intercept typing.
final class DictationKey {
    private let target: () -> WKWebView?
    private let prefs: () -> [String: Any]
    private let send: (WKWebView, String) -> Void
    private var monitor: Any?
    private weak var view: WKWebView?
    private var timer: Timer?
    private var down: UInt16?
    private var began = false
    private var mode = "both"

    init(target: @escaping () -> WKWebView?, prefs: @escaping () -> [String: Any], send: @escaping (WKWebView, String) -> Void) {
        self.target = target
        self.prefs = prefs
        self.send = send
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged]) { [weak self] event in
            self?.update(event)
            return event
        }
    }

    deinit {
        if let monitor = monitor { NSEvent.removeMonitor(monitor) }
        reset()
    }

    private func reset() {
        timer?.invalidate()
        timer = nil
        view = nil
        down = nil
        began = false
    }

    private func update(_ event: NSEvent) {
        guard let front = target() else { reset(); return }
        if let client = front.window?.firstResponder as? NSTextInputClient, client.hasMarkedText() { reset(); return }
        let preferences = prefs()
        let binding: UInt16
        switch preferences["key"] as? String {
        case "default": binding = 61 // Right Option, not either Option.
        case "F8": binding = 100
        case "F9": binding = 101
        case "primary-shift-d": binding = 2
        default: reset(); return
        }
        let flags = event.modifierFlags.intersection([.command, .shift, .control, .option])
        if event.type == .keyDown, event.keyCode == 109, flags == [.control, .shift], !event.isARepeat {
            send(front, "fixture-menu")
        }
        let optionDown = event.modifierFlags.rawValue & 0x40 != 0 // Device-specific Right Option flag.
        let press = event.type == .keyDown || (event.type == .flagsChanged && event.keyCode == 61 && optionDown)
        let released = event.type == .keyUp || (event.type == .flagsChanged && event.keyCode == 61 && !optionDown)
        if let down = down {
            let chord = event.keyCode != down && (event.type == .keyDown || event.type == .flagsChanged)
            if front !== view || binding != down || chord {
                if began, front === view { send(front, "cancel") }
                reset()
            } else if released && event.keyCode == down {
                if began { send(front, "release") }
                else if mode == "tap" || (mode != "hold" && timer != nil) { send(front, "toggle") }
                reset()
            }
            return
        }
        guard press, event.keyCode == binding, event.type != .keyDown || !event.isARepeat else { return }
        if binding == 61 {
            if flags != .option || event.modifierFlags.rawValue & 0x20 != 0 { return } // Left Option already down.
        } else if binding == 2 {
            if flags != [.command, .shift] { return }
        } else if !flags.isEmpty { return }
        view = front
        down = binding
        mode = preferences["keyMode"] as? String ?? "both"
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.timer = nil
            if let view = self.view, self.target() === view, self.mode != "tap" {
                self.began = true
                self.send(view, "hold")
            }
        }
    }
}
