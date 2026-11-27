import Cocoa

extension AppDelegate {
    func requestUnattendedQuit() {
        unattendedQuit = true
        NSApp.terminate(nil)
    }

    func confirmRunnerQuit() -> Bool {
        guard !unattendedQuit, let runner = snapshot["runner"] as? [String: Any],
              runner["running"] as? Bool == true else { return true }
        guard !confirmingRunnerQuit else { return false }
        confirmingRunnerQuit = true
        defer { confirmingRunnerQuit = false }

        let alert = NSAlert()
        let activity = runner["working"] as? Bool == true ? "The runner is working now. " : ""

        alert.alertStyle = .warning
        alert.messageText = "Quit Pi Pocket?"
        alert.informativeText = activity + "Quitting can interrupt runner commands. Runner background tasks stop even when the runner is idle."
        alert.addButton(withTitle: "Quit").keyEquivalent = ""
        alert.addButton(withTitle: "Cancel").keyEquivalent = "\u{1b}"
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }
}
