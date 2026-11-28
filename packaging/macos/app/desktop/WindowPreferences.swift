// A typed copy of the desktop controller snapshot. The controller alone writes desktop.json.
struct WindowPreferences: Equatable {
    var seamless = false
    var closeToTray = true
    var startHidden = false
    var externalPages = false
    var shortcutEnabled = false
    var shortcut = "Meta+Shift+P"
    var seeThrough = false
    var tint = 82
    var material = "window"
    var developerTools = false

    init() {}

    init(_ prefs: [String: Any]) {
        let window = prefs["window"] as? [String: Any] ?? [:]
        let appearance = prefs["appearance"] as? [String: Any] ?? [:]
        seamless = window["titleBar"] as? String == "seamless"
        closeToTray = window["closeToTray"] as? Bool ?? true
        startHidden = window["startHidden"] as? Bool ?? false
        externalPages = window["links"] as? String == "browser"
        shortcutEnabled = window["shortcutEnabled"] as? Bool ?? false
        shortcut = window["shortcut"] as? String ?? "Meta+Shift+P"
        developerTools = window["developerTools"] as? Bool ?? false
        seeThrough = appearance["transparent"] as? Bool ?? false
        tint = appearance["opacity"] as? Int ?? 82
        material = appearance["material"] as? String ?? "window"
    }
}
