import Cocoa
import CryptoKit
import UserNotifications

final class NoticesMac: NSObject, UNUserNotificationCenterDelegate {
    private static let group = "finishes"
    private let center = UNUserNotificationCenter.current()
    private let activate: (NoticeTicket?, String) -> Void
    private var tickets: [String: NoticeTicket] = [:]
    private var dedup: [Data: Date] = [:]
    private var finishes: [NoticeData] = []
    private var shownFinishes: [NoticeData] = []
    private var latestLease: String?
    private var latestAuth = 0
    private var held = false
    private var suspended = false
    private var locked = false
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []
    var enabled = true
    var sound = true
    var allowMode = "whenFullyShown"
    var commandLimit = 120
    private(set) var unavailable: String?

    init(activate: @escaping (NoticeTicket?, String) -> Void) {
        self.activate = activate
        super.init()
        let deny = UNNotificationAction(identifier: "deny", title: "Deny", options: [.foreground])
        let allow = UNNotificationAction(identifier: "allow", title: "Allow", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "deny-only", actions: [deny], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "allow-deny", actions: [allow, deny], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: Self.group, actions: [], intentIdentifiers: [], options: [.customDismissAction]),
        ])
        center.delegate = self
        let workspace = NSWorkspace.shared.notificationCenter
        observers = [
            workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in self?.suspended = true },
            workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                self?.suspended = false; self?.recheck()
            },
            workspace.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.locked = true },
            workspace.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.locked = false; self?.recheck()
            },
        ]
    }

    deinit {
        timer?.invalidate()
        observers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
    }

    private var away: Bool {
        // Read elapsed time only, never input events, key identifiers or text. Sleep and session changes are separate.
        let input: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .keyDown, .flagsChanged]
        return suspended || locked || input.allSatisfy {
            CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) >= 120
        }
    }

    private func setUnavailable(_ reason: String?) {
        if unavailable != reason {
            unavailable = reason
            log(reason ?? "macOS notifications are available.")
        }
    }

    func receive(_ data: NoticeData, lease: String, auth: Int, modern: Bool) {
        guard enabled else { return }
        prune()
        let fingerprint = Self.digest([data.tag, data.stamp, data.path, data.title, data.body, data.call].joined(separator: "\n"))
        guard dedup[fingerprint] == nil else { return }
        if dedup.count >= 256, let oldest = dedup.min(by: { $0.value < $1.value }) { dedup.removeValue(forKey: oldest.key) }
        dedup[fingerprint] = Date().addingTimeInterval(600)
        if !data.finish {
            let slot = Self.digest(data.tag).prefix(12).map { String(format: "%02x", $0) }.joined()
            show(slot: slot, title: data.title, body: data.body, path: data.path, notice: data, lease: lease, auth: auth, modern: modern)
            return
        }
        finishes.removeAll { $0.tag == data.tag }
        if finishes.count >= 100 { finishes.removeFirst() }
        finishes.append(data)
        latestLease = lease
        latestAuth = auth
        if away {
            held = true
            if timer == nil {
                let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in self?.recheck() }
                RunLoop.main.add(timer, forMode: .common)
                self.timer = timer
            }
        } else {
            showFinishes()
        }
    }

    private static func digest(_ text: String) -> Data { Data(SHA256.hash(data: Data(text.utf8))) }

    private func recheck() { if held && !away { showFinishes() } }

    private func showFinishes() {
        held = false
        timer?.invalidate()
        timer = nil
        guard let summary = NoticeData.group(finishes) else { return }
        shownFinishes = finishes
        show(slot: Self.group, title: summary.title, body: summary.body,
            path: summary.path, notice: nil, lease: latestLease, auth: latestAuth, modern: false)
    }

    func local(_ body: String) {
        show(slot: "local", title: "Pi Pocket", body: body, path: "/", notice: nil, lease: nil, auth: 0, modern: false)
    }

    private func show(slot: String, title: String, body: String, path: String, notice: NoticeData?, lease: String?, auth: Int, modern: Bool) {
        guard enabled else { return }
        let approval = modern ? notice?.approval : nil
        let command = notice?.approval != nil ? notice?.command(mode: allowMode, limit: commandLimit) : nil
        let ticket = NoticeTicket(token: UUID().uuidString, lease: lease, auth: auth, path: path,
            approval: approval, allow: approval != nil && command?.allow == true, expires: Date().addingTimeInterval(600))
        if tickets.count >= 128, let oldest = tickets.min(by: { $0.value.expires < $1.value.expires }) { remove(oldest.key) }
        tickets[slot] = ticket
        let content = UNMutableNotificationContent()
        content.title = title.isEmpty ? "Pi Pocket" : title
        content.body = command?.body ?? body
        content.sound = sound ? .default : nil
        content.userInfo = ["token": ticket.token]
        content.categoryIdentifier = slot == Self.group ? Self.group : approval == nil ? "" : ticket.allow ? "allow-deny" : "deny-only"
        content.threadIdentifier = "pi-pocket"
        let notification = UNNotificationRequest(identifier: slot, content: content, trigger: nil)
        center.getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                guard let self = self, self.tickets[slot]?.token == ticket.token else { return }
                switch settings.authorizationStatus {
                case .notDetermined:
                    self.center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
                        DispatchQueue.main.async { self?.post(notification, ticket, granted: granted) }
                    }
                case .authorized, .provisional:
                    self.post(notification, ticket, granted: settings.alertSetting != .disabled)
                default:
                    self.post(notification, ticket, granted: false)
                }
            }
        }
    }

    private func post(_ request: UNNotificationRequest, _ ticket: NoticeTicket, granted: Bool) {
        guard let current = tickets[request.identifier], current.token == ticket.token,
            Date() < current.expires, enabled else { return }
        guard granted else {
            setUnavailable("Pi Pocket notifications are disabled in macOS System Settings → Notifications.")
            return
        }
        setUnavailable(nil)
        center.add(request) { [weak self] error in
            guard error != nil else { return }
            DispatchQueue.main.async { self?.setUnavailable("macOS could not show a Pi Pocket notification.") }
        }
    }

    private func remove(_ slot: String) {
        tickets.removeValue(forKey: slot)
        center.removePendingNotificationRequests(withIdentifiers: [slot])
        center.removeDeliveredNotifications(withIdentifiers: [slot])
    }

    func seen() {
        finishes.removeAll()
        shownFinishes.removeAll()
        remove(Self.group)
        timer?.invalidate()
        timer = nil
        held = false
    }

    func clear(remember: Bool) {
        seen()
        latestLease = nil
        Array(tickets.keys).forEach { remove($0) }
        if !remember { dedup.removeAll() }
    }

    private func prune() {
        let now = Date()
        tickets.filter { $0.value.expires <= now }.keys.forEach { remove($0) }
        dedup = dedup.filter { $0.value > now }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        let request = response.notification.request
        let action = response.actionIdentifier
        DispatchQueue.main.async {
            defer { completionHandler() }
            self.prune()
            let token = request.content.userInfo["token"] as? String
            let ticket = self.tickets[request.identifier].flatMap { $0.token == token ? $0 : nil }
            if action == UNNotificationDismissActionIdentifier {
                if ticket != nil && request.identifier == Self.group {
                    self.remove(Self.group)
                    self.finishes.removeAll { self.shownFinishes.contains($0) }
                    self.shownFinishes.removeAll()
                }
                return
            }
            guard self.enabled, [UNNotificationDefaultActionIdentifier, "allow", "deny"].contains(action) else { return }
            if ticket != nil {
                if request.identifier == Self.group { self.seen() } else { self.remove(request.identifier) }
            }
            self.activate(ticket, action == UNNotificationDefaultActionIdentifier ? "open" : action)
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let request = notification.request
        DispatchQueue.main.async {
            guard self.enabled, let ticket = self.tickets[request.identifier], ticket.expires > Date(),
                request.content.userInfo["token"] as? String == ticket.token else { completionHandler([]); return }
            completionHandler(request.content.sound == nil ? [.banner, .list] : [.banner, .list, .sound])
        }
    }
}
