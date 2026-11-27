import Foundation

// Compiled with the native bridge on the macOS test runner, without main.swift or the launcher.
func log(_ line: String) { print(line) }

@main
struct BridgeMacTests {
    static func main() {
        precondition(BridgeProtocol.isNewLink("pi-pocket://new"))
        for url in ["pi-pocket://new/", "pi-pocket://new:80", "pi-pocket://new?", "pi-pocket://user@new", "pi-pocket://new#x"] {
            precondition(!BridgeProtocol.isNewLink(url), "noncanonical New Session URL")
        }
        for url in ["/s/", "/s/0", "/s/01", "/s/9007199254740992", "//example.invalid", "/s/2?", "/?pip=1&more=1"] {
            precondition(!BridgeProtocol.target(url), "noncanonical notification URL")
        }
        precondition(BridgeProtocol.target("/s/9007199254740991") && BridgeProtocol.target("/?pip=1"))
        let origin = "https://pocket-fixture.invalid"
        let basePath = "/gateway/team%20one"
        precondition(BridgeProtocol.basePath(URL(string: origin + basePath + "/")!) == basePath)
        for path in [basePath, basePath + "/", basePath + "/s/2"] {
            precondition(BridgeProtocol.page(URL(string: origin + path)!, basePath: basePath), "page under the configured base path")
        }
        for path in ["/", "/s/2", basePath + "/preview", basePath + "-other/s/2"] {
            precondition(!BridgeProtocol.page(URL(string: origin + path)!, basePath: basePath), "outside the configured Pi Pocket pages")
        }
        precondition(BridgeProtocol.number(true, max: 20) == nil)
        precondition(BridgeProtocol.number(2.5, max: 20) == nil)
        precondition(BridgeProtocol.number(2, max: 20) == 2)
        precondition(BridgeProtocol.recognises { path in
            Data((path == "api/pocket/info" ? #"{"name":"pi-pocket","bridge":1}"# : "{}").utf8)
        })
        precondition(BridgeProtocol.recognises { path in
            Data((path == "manifest.webmanifest" ? #"{"name":"Pi Pocket"}"# : "null").utf8)
        })
        precondition(!BridgeProtocol.recognises { _ in Data(#"{"name":"unrelated","bridge":1}"#.utf8) })

        let first = NoticeData(["tag": "done-8", "url": "/s/8", "title": "Pi finished · Build"])!
        let second = NoticeData(["tag": "done-9", "url": "/s/9", "title": "Pi finished · Tests"])!
        let group = NoticeData.group([first, second])!
        precondition(first.finish && group.title == "2 sessions finished" && group.body == "Tests\nBuild" && group.path == "/s/9")
        func approval(_ call: String, may: Bool = true) -> NoticeData {
            NoticeData(["tag": "approval-test", "url": "/s/8", "approval": ["id": "test", "call": call, "may": may]])!
        }
        precondition(approval("read: notes").command(mode: "whenFullyShown", limit: 120).allow)
        let bidi = approval("read:\u{202E}notes").command(mode: "whenFullyShown", limit: 120)
        precondition(!bidi.allow && bidi.body.contains("[U+202E]"))
        let cut = approval(String(repeating: "a", count: 100)).command(mode: "whenFullyShown", limit: 20)
        precondition(!cut.allow && cut.body.contains("[shortened]"))
        precondition(!approval("read: notes", may: false).command(mode: "always", limit: 20).allow)

        let now = Date()
        let ticket = NoticeTicket(token: "opaque", lease: "document", auth: 7, path: "/s/8", approval: "test",
            allow: false, expires: now.addingTimeInterval(1))
        precondition(ticket.matches(lease: "document", auth: 7, action: "deny", now: now))
        precondition(!ticket.matches(lease: "document", auth: 7, action: "allow", now: now))
        precondition(!ticket.matches(lease: "second", auth: 7, action: "deny", now: now))
        precondition(!ticket.matches(lease: "document", auth: 8, action: "deny", now: now))
        precondition(!ticket.matches(lease: "document", auth: 7, action: "deny", now: now.addingTimeInterval(2)))
        print("macOS bridge message and notice tests passed.")
    }
}
