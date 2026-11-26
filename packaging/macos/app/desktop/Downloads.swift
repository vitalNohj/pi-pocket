import Cocoa
import WebKit

final class WindowDownloads: NSObject, WKDownloadDelegate {
    private struct Request {
        weak var window: NSWindow?
        var direct: Bool
        var folder: URL?
        var temporary: URL?
        var destination: URL?
    }

    private var requests: [WKDownload: Request] = [:]

    static func fileRoute(_ url: URL?, onServer: (URL?) -> Bool) -> Bool {
        guard let url = url, onServer(url), let parts = URLComponents(url: url, resolvingAgainstBaseURL: true),
            parts.fragment == nil, parts.path.range(of: #"^/api/c/[0-9]+/download$"#, options: .regularExpression) != nil,
            let items = parts.queryItems?.filter({ $0.name == "path" }), items.count == 1,
            let path = items.first?.value, !path.isEmpty
        else { return false }
        return true
    }

    func attach(_ download: WKDownload, to window: NSWindow?, direct: Bool) {
        requests[download] = Request(window: window, direct: direct)
        download.delegate = self
    }

    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        guard let request = requests[download] else { completionHandler(nil); return }
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        let leaf = (suggestedFilename as NSString).lastPathComponent
        let name = ["", ".", "..", "/"].contains(leaf) ? "download" : leaf

        if request.direct, let folder = folder {
            prepare(download, destination: folder.appendingPathComponent(name), completion: completionHandler)
            return
        }

        let panel = NSSavePanel()
        panel.directoryURL = folder
        panel.nameFieldStringValue = name
        let choose: (NSApplication.ModalResponse) -> Void = { answer in
            if answer == .OK, let path = panel.url {
                self.prepare(download, destination: path, completion: completionHandler)
            } else {
                self.requests.removeValue(forKey: download)
                completionHandler(nil)
            }
        }

        if let window = request.window, window.isVisible, !window.isMiniaturized {
            panel.beginSheetModal(for: window, completionHandler: choose)
        } else {
            panel.begin(completionHandler: choose)
        }
    }

    private func prepare(_ download: WKDownload, destination: URL, completion: (URL?) -> Void) {
        let parent = destination.deletingLastPathComponent()
        var template = parent.appendingPathComponent(".pi-pocket-download-XXXXXX").path.utf8CString
        guard var request = requests[download], mkdtemp(&template) != nil else {
            requests.removeValue(forKey: download)
            log("Could not reserve a location for the download.")
            completion(nil)
            return
        }
        let folder = URL(fileURLWithPath: String(cString: template), isDirectory: true)
        let temporary = folder.appendingPathComponent(destination.lastPathComponent)
        request.folder = folder
        request.temporary = temporary
        request.destination = destination
        requests[download] = request
        completion(temporary)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let request = requests.removeValue(forKey: download), let stage = request.temporary,
            let destination = request.destination
        else { return }
        defer { clean(request) }

        if request.direct {
            let directory = destination.deletingLastPathComponent()
            let stem = destination.deletingPathExtension().lastPathComponent
            let suffix = destination.pathExtension.isEmpty ? "" : "." + destination.pathExtension

            for number in 1...1000 {
                let path = number == 1 ? destination : directory.appendingPathComponent("\(stem) (\(number))\(suffix)")
                // The destination must not exist, even if another download saved the same name a moment ago.
                if link(stage.path, path.path) == 0 {
                    NSWorkspace.shared.activateFileViewerSelecting([path])
                    return
                }
                if errno != EEXIST { break }
            }
        } else if rename(stage.path, destination.path) == 0 {
            return  // The Save dialog authorized replacement at this path.
        }
        log("Could not save the download.")
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let request = requests.removeValue(forKey: download) { clean(request) }
    }

    func close() {
        for (download, request) in requests {
            download.delegate = nil
            download.cancel { _ in self.clean(request) }
        }
        requests.removeAll()
    }

    private func clean(_ request: Request) {
        if let folder = request.folder { try? FileManager.default.removeItem(at: folder) }
    }
}
