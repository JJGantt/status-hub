import ImageIO
import SwiftUI

/// **An image in a reply** (`MarkdownBlock.image`): a picture a session or the orchestrator stored with
/// data-layer share_image, fetched from the hub's `/img/<name>` with the watch's token. Drawn at the
/// reply's width; a tap opens it full screen, where the Digital Crown zooms and a drag moves it.
///
/// Decoded straight to a thumbnail (ImageIO) rather than as the full picture: a phone photo is 12
/// megapixels, which is far more memory than a watch app gets to spend on one line of a reply.
struct HubImage: View {
    let path: String
    let caption: String
    var size: CGFloat = 13
    @State private var image: UIImage?
    @State private var failed = false
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Group {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .onTapGesture { open = true }
                } else if failed {
                    Image(systemName: "photo").font(.system(size: 22)).foregroundStyle(.gray)
                        .frame(maxWidth: .infinity, minHeight: 60)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 60)
                }
            }
            if !caption.isEmpty {
                Text(caption).font(.system(size: size - 2)).foregroundStyle(.gray)
            }
        }
        .task(id: path) {
            do { image = try await HubImageCache.load(path, maxPixels: 480) } catch {
                failed = true
                Hub.log("error", ["msg": "reply image \(path) did not load: \(String(describing: error).prefix(160))"])
            }
        }
        .fullScreenCover(isPresented: $open) { HubImageFull(path: path, preview: image) }
    }
}

/// Full screen: fitted at first; the crown zooms (1-6x), a drag pans, a double tap goes back to fitted.
/// Loads a sharper copy than the inline one, showing the inline one until it arrives.
private struct HubImageFull: View {
    let path: String
    let preview: UIImage?
    @State private var sharp: UIImage?
    @State private var zoom = 1.0
    @State private var offset = CGSize.zero
    @State private var drag = CGSize.zero

    var body: some View {
        GeometryReader { geo in
            if let img = sharp ?? preview {
                Image(uiImage: img).resizable().scaledToFit()
                    .frame(width: geo.size.width, height: geo.size.height)
                    .scaleEffect(zoom)
                    .offset(x: offset.width + drag.width, y: offset.height + drag.height)
                    .gesture(DragGesture()
                        .onChanged { drag = $0.translation }
                        .onEnded { v in
                            offset.width += v.translation.width
                            offset.height += v.translation.height
                            drag = .zero
                        })
                    .onTapGesture(count: 2) { zoom = 1; offset = .zero }
            } else {
                ProgressView().frame(width: geo.size.width, height: geo.size.height)
            }
        }
        .ignoresSafeArea()
        .focusable()
        .digitalCrownRotation($zoom, from: 1, through: 6, by: 0.1, sensitivity: .medium,
                              isContinuous: false, isHapticFeedbackEnabled: true)
        .onChange(of: zoom) { _, z in if z <= 1.01 { offset = .zero } }
        .task { sharp = try? await HubImageCache.load(path, maxPixels: 1400) }
    }
}

/// Decoded images by path and size, so scrolling a reply back into view does not fetch it again.
enum HubImageCache {
    private static let cache = NSCache<NSString, UIImage>()

    static func load(_ path: String, maxPixels: Int) async throws -> UIImage {
        let key = "\(path)@\(maxPixels)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let data = try await Hub.image(path)
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxPixels,
              ] as CFDictionary)
        else { throw HubImageError.undecodable }
        let img = UIImage(cgImage: cg)
        cache.setObject(img, forKey: key)
        return img
    }
}

enum HubImageError: Error { case undecodable }

/// A small fixed-size thumbnail of a hub image, cropped to fill (the handoff card's screenshot).
struct HubThumb: View {
    let path: String
    @State private var image: UIImage?
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFill() } else { Color(hex: "#11151b") }
        }
        .task(id: path) {
            do { image = try await HubImageCache.load(path, maxPixels: 160) } catch {
                if !Task.isCancelled { Hub.log("error", ["msg": "thumbnail \(path) did not load: \(String(describing: error).prefix(160))"]) }
            }
        }
    }
}
