import Cocoa

// WKWebView on macOS does not offer a public way to extend the ordinary spelling and editing menu.
// Leave that menu intact. On a drag strip, the same native Window options are available with a right click.
extension AppDelegate {
    func showWindowContextMenu() {
        guard let window = NSApp.keyWindow else { return }
        let menu = NSMenu(title: "Window options")
        addWindowOptions(to: menu)
        menu.popUp(positioning: nil, at: window.mouseLocationOutsideOfEventStream, in: window.contentView)
    }
}
