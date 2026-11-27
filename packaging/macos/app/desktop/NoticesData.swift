import Foundation

struct NoticeData: Hashable {
    let tag: String
    let path: String
    let title: String
    let body: String
    let stamp: String
    let approval: String?
    let call: String
    let may: Bool
    let cut: Bool
    var finish: Bool { approval == nil && tag.hasPrefix("done-") }

    init?(_ message: [String: Any]) {
        guard let path = BridgeProtocol.text(message["url"], limit: 100), BridgeProtocol.target(path),
            let tag = BridgeProtocol.text(message["tag"], limit: 200), !tag.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        self.path = path
        self.tag = tag
        self.title = Self.plain(BridgeProtocol.text(message["title"], limit: 200) ?? "Pi Pocket", 100)
        self.body = Self.plain(BridgeProtocol.text(message["body"], limit: 400) ?? "", 400)
        self.stamp = BridgeProtocol.text(message["stamp"], limit: 80) ?? ""
        if message["approval"] != nil {
            guard let action = message["approval"] as? [String: Any],
                let id = BridgeProtocol.text(action["id"], limit: 200), !id.isEmpty,
                let text = BridgeProtocol.text(action["call"], limit: 8192) else { return nil }
            approval = id
            call = text
            may = BridgeProtocol.flag(action["may"])
            cut = BridgeProtocol.flag(action["cut"])
        } else {
            approval = nil
            call = ""
            may = false
            cut = false
        }
    }

    static func group(_ finishes: [Self]) -> (title: String, body: String, path: String)? {
        guard let latest = finishes.last else { return nil }
        if finishes.count == 1 { return (latest.title, latest.body, latest.path) }
        let prefix = "Pi finished · "
        let listed = 6
        var names = finishes.reversed().prefix(listed).map {
            $0.title.hasPrefix(prefix) ? String($0.title.dropFirst(prefix.count)) : $0.title
        }
        if finishes.count > listed { names.append("and \(finishes.count - listed) more") }
        return ("\(finishes.count) sessions finished", names.joined(separator: "\n"), latest.path)
    }

    static func plain(_ value: String, _ limit: Int) -> String { mark(value, limit, alreadyCut: false).text }

    static func mark(_ value: String, _ limit: Int, alreadyCut: Bool) -> (text: String, whole: Bool) {
        var text = ""
        var units = 0
        var changed = false
        var cut = alreadyCut
        for scalar in value.unicodeScalars {
            let category = scalar.properties.generalCategory
            let hidden = scalar.properties.isDefaultIgnorableCodePoint || category == .control || category == .format ||
                category == .lineSeparator || category == .paragraphSeparator || (category == .spaceSeparator && scalar.value != 32)
            let part = hidden ? String(format: "[U+%04X]", scalar.value) : String(scalar)
            let next = units + part.utf16.count
            if next > limit { cut = true; break }
            text += part
            units = next
            changed = changed || hidden
        }
        if cut { text += " … [shortened]" }
        return (text, !changed && !cut && !value.isEmpty)
    }

    func command(mode: String, limit: Int) -> (body: String, allow: Bool) {
        let shown = Self.mark(call, min(2000, max(20, limit)), alreadyCut: cut)
        let entireLine = shown.whole && call.utf8.count <= 24 && call == call.trimmingCharacters(in: .whitespaces) &&
            call.utf8.allSatisfy { (32...126).contains($0) }
        return (shown.text, may && (mode == "always" || (mode == "full" && entireLine)))
    }
}

struct NoticeTicket {
    let token: String
    let lease: String?
    let auth: Int
    let path: String
    let approval: String?
    let allow: Bool
    let expires: Date

    func matches(lease: String?, auth: Int, action: String, now: Date) -> Bool {
        lease != nil && self.lease == lease && self.auth == auth && now < expires &&
            (action == "open" || (approval != nil && (action == "deny" || (action == "allow" && allow))))
    }
}
