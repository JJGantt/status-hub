import UIKit
import Social
import ImageIO
import UniformTypeIdentifiers

// "Status Hub" in the iPhone share sheet: images (a screenshot, usually) plus whatever he types go into
// the hub conversation, the same request the chat composer makes — each image to /api/attach, then one
// /api/voice-text carrying their object names. `shared: true` stamps the request source 'share', which
// is what gives the worker a look-at-this framing instead of the meal-logging one.
//
// The upload runs inside the extension before completeRequest, not in a background session: handing a
// transfer to the app needs a shared container, i.e. App Groups, which this account cannot enable yet
// (status-hub CLAUDE.md). A few downscaled JPEGs take a second or two, well inside an extension's time.
@objc(ShareViewController)
final class ShareViewController: SLComposeServiceViewController {
    override func isContentValid() -> Bool { true }

    override func didSelectPost() {
        let text = (contentText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
            .filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        Task { @MainActor in
            do {
                try await Self.send(text: text, providers: providers)
                extensionContext?.completeRequest(returningItems: nil)
            } catch {
                let alert = UIAlertController(title: "Not sent", message: error.localizedDescription, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
                    self?.extensionContext?.cancelRequest(withError: error)
                })
                present(alert, animated: true)
            }
        }
    }

    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ s: String) { errorDescription = s }
    }

    static func send(text: String, providers: [NSItemProvider]) async throws {
        guard let token = Auth.token() else { throw Failure("Not signed in") }
        var names: [String] = []
        for p in providers.prefix(12) {
            let jpeg = try await jpegData(p)
            names.append(try await upload(jpeg, token: token))
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        let body: [String: Any] = ["text": text, "attachments": names, "shared": true,
                                   "client_now": f.string(from: Date()), "client_msg_id": UUID().uuidString]
        var r = URLRequest(url: URL(string: Auth.host + "/api/voice-text")!)
        r.httpMethod = "POST"
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        try check(try await URLSession.shared.data(for: r))
    }

    // Downscaled through ImageIO rather than UIImage: a full-resolution photo decoded whole can approach an
    // extension's memory ceiling, and the thumbnail path also applies EXIF orientation and reads HEIC.
    // 1568px is the model's vision optimum, the same size the web composer shrinks to.
    static func jpegData(_ p: NSItemProvider) async throws -> Data {
        let raw: Data = try await withCheckedThrowingContinuation { cont in
            p.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, err in
                if let data { cont.resume(returning: data) } else { cont.resume(throwing: err ?? Failure("Unreadable image")) }
            }
        }
        guard let src = CGImageSourceCreateWithData(raw as CFData, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: 1568,
              ] as CFDictionary),
              let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.85)
        else { throw Failure("Unreadable image") }
        return jpeg
    }

    static func upload(_ jpeg: Data, token: String) async throws -> String {
        var r = URLRequest(url: URL(string: Auth.host + "/api/attach")!)
        r.httpMethod = "POST"
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await URLSession.shared.upload(for: r, from: jpeg)
        try check((data, resp))
        guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let path = j["path"] as? String
        else { throw Failure("Upload failed") }
        return path
    }

    static func check(_ result: (Data, URLResponse)) throws {
        let code = (result.1 as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let j = try? JSONSerialization.jsonObject(with: result.0) as? [String: Any]
            throw Failure((j?["error"] as? String) ?? "HTTP \(code)")
        }
    }
}
