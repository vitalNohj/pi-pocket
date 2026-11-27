import Cocoa
import WebKit

final class PocketNativeWindow: NSWindow {
    private var leftDown: NSEvent?
    var showTitlebarOptions: (() -> Void)?
    var chrome: WindowChrome? { contentView as? WindowChrome }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown { leftDown = event }
        if event.type == .leftMouseUp { leftDown = nil }
        if event.type == .rightMouseDown, isKeyWindow, chrome?.overlay == false,
            event.locationInWindow.y >= contentLayoutRect.maxY, let options = showTitlebarOptions {
            options()
            return
        }
        super.sendEvent(event)
    }

    func drag(from body: [String: Any]) {
        guard let chrome = chrome, chrome.overlay, isKeyWindow, let event = leftDown,
            ProcessInfo.processInfo.systemUptime - event.timestamp < 0.5,
            (NSEvent.pressedMouseButtons & 1) != 0,
            let x = body["x"] as? Double, let y = body["y"] as? Double
        else { return }

        let view = chrome.webView
        let point = view.convert(event.locationInWindow, from: nil)
        guard abs(point.x - x * view.pageZoom) < 16,
            abs(view.bounds.height - point.y - y * view.pageZoom) < 16
        else { return }
        leftDown = nil
        if event.clickCount == 2 { performZoom(nil) }
        else { performDrag(with: event) }
    }
}

final class WindowChrome: NSView {
    let webView: WKWebView
    private let effect = NSVisualEffectView()
    var notice: NSStackView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let notice = notice { addSubview(notice) }
            needsLayout = true
        }
    }
    private var prefs: WindowPreferences
    private var palette: WindowPalette?
    private var knownPage = false
    private var lastGeometry = ""
    private var tint: Int?
    var firstDownload: URL?
    var overlay: Bool { window?.styleMask.contains(.fullSizeContentView) == true && window?.styleMask.contains(.fullScreen) == false }

    init(view: WKWebView, prefs: WindowPreferences) {
        self.webView = view
        self.prefs = prefs
        super.init(frame: .zero)
        effect.blendingMode = .behindWindow
        effect.state = .followsWindowActiveState
        addSubview(effect)
        addSubview(view)
    }

    required init?(coder: NSCoder) { fatalError("WindowChrome is not loaded from a nib") }

    func reset() {
        firstDownload = nil
        knownPage = false
        lastGeometry = ""
        apply(prefs)
    }

    func apply(_ preferences: WindowPreferences, palette: WindowPalette? = nil) {
        guard let window = window else { return }
        prefs = preferences
        if let palette = palette { self.palette = palette }
        let workspace = NSWorkspace.shared
        let contrast = workspace.accessibilityDisplayShouldIncreaseContrast
        let seamless = preferences.seamless && !contrast
        if !window.styleMask.contains(.fullScreen) {
            if seamless { window.styleMask.insert(.fullSizeContentView) }
            else { window.styleMask.remove(.fullSizeContentView) }
            window.titleVisibility = seamless ? .hidden : .visible
            window.titlebarAppearsTransparent = seamless
        }
        window.appearance = contrast ? nil : self.palette.flatMap { NSAppearance(named: $0.dark ? .darkAqua : .aqua) }
        let glass = knownPage && preferences.seeThrough == true && !contrast &&
            !workspace.accessibilityDisplayShouldReduceTransparency && !window.styleMask.contains(.fullScreen)
        switch preferences.material {
        case "sidebar": effect.material = .sidebar
        case "dark": effect.material = .hudWindow
        case "full-screen": effect.material = .fullScreenUI
        default: effect.material = .windowBackground
        }
        tint = glass ? preferences.tint : nil
        window.isOpaque = !glass
        window.backgroundColor = glass ? .clear : (contrast ? .windowBackgroundColor : self.palette?.panel ?? .windowBackgroundColor)
        effect.isHidden = !glass
        webView.underPageBackgroundColor = glass ? .clear : window.backgroundColor
        layout()
    }

    func message(_ type: String, body: [String: Any], options: () -> Void) {
        switch type {
        case "ready":
            knownPage = true
            lastGeometry = ""
            apply(prefs)
        case "theme":
            if knownPage, let palette = WindowPalette(body) { apply(prefs, palette: palette) }
        case "drag":
            if knownPage { (window as? PocketNativeWindow)?.drag(from: body) }
        case "context":
            if knownPage && overlay && window?.isKeyWindow == true { options() }
        default: break
        }
    }

    private var controls: (width: CGFloat, height: CGFloat) {
        guard overlay, let button = window?.standardWindowButton(.zoomButton), button.window != nil else { return (0, 0) }
        let frame = convert(button.bounds, from: button)
        return (max(0, frame.maxX + 8), max(0, bounds.height - frame.minY + 4))
    }

    func geometry() -> String {
        let (width, height) = notice?.isHidden == false ? (0, 0) : controls
        let zoom = max(0.5, webView.pageZoom)
        return "{side:'\(width > 0 ? "left" : "none")',width:\(ceil(width / zoom)),height:\(ceil(height / zoom)),tint:\(tint.map { String($0) } ?? "null"),nativeDragContext:true}"
    }

    override func layout() {
        super.layout()
        effect.frame = bounds
        var frame = bounds
        if let notice = notice, !notice.isHidden {
            let top = max(0, frame.height - controls.height)
            let height = min(top, notice.fittingSize.height)
            notice.frame = NSRect(x: 0, y: top - height, width: frame.width, height: height)
            frame.size.height = top - height
        } else if !knownPage {
            frame.size.height = max(0, frame.height - controls.height)
        }
        webView.frame = frame

        if knownPage {
            let next = geometry()
            if next != lastGeometry {
                lastGeometry = next
                webView.evaluateJavaScript("window.__piPocketWindow?.update(\(next))")
            }
        }
    }
}

struct WindowPalette {
    let panel: NSColor
    let dark: Bool

    init?(_ body: [String: Any]) {
        guard let text = body["panel"] as? String, text.count == 7, text.first == "#",
            let rgb = UInt32(text.dropFirst(), radix: 16), let dark = body["dark"] as? Bool
        else { return nil }
        panel = NSColor(srgbRed: CGFloat(rgb >> 16) / 255, green: CGFloat((rgb >> 8) & 255) / 255,
            blue: CGFloat(rgb & 255) / 255, alpha: 1)
        self.dark = dark
    }
}
