import UIKit
import VisionKit

/// What the note's capture menu starts: a scan of a document's pages, or a transcription of speech.
enum CaptureKind: String, Equatable, Sendable {
    case scan
    case transcribe
}

/// A scanned page as the JPEG the note keeps. A page stays well under what one bridge message
/// carries (4 MiB, in base64) and is still sharp enough for search to read its words.
enum ScanEncoding {
    static let longestSide: CGFloat = 2_400
    static let quality: CGFloat = 0.75

    static func size(fitting pixels: CGSize) -> CGSize {
        let longest = max(pixels.width, pixels.height)
        guard longest > longestSide else { return pixels }
        let scale = longestSide / longest
        return CGSize(width: (pixels.width * scale).rounded(), height: (pixels.height * scale).rounded())
    }

    /// Off the main thread: a full camera page takes tens of milliseconds to scale and compress.
    static func jpeg(_ image: UIImage) -> Data? {
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let target = size(fitting: pixels)
        let scaled = target == pixels ? image : image.preparingThumbnail(of: target) ?? image
        return scaled.jpegData(compressionQuality: quality)
    }

    static func name(page: Int) -> String {
        "\(L10n.phoneCaptureScanPage(number: String(page))).jpg"
    }
}

/// A finished scan: its pages as JPEGs in order, and how many could not be encoded.
struct ScannedPages: Equatable, Sendable {
    let pages: [Data]
    let failed: Int
}

/// The system's document camera over the editor (VisionKit), which finds the page's edges,
/// straightens it and lets the user retake pages; nothing leaves the device.
@MainActor
final class DocumentScanner: NSObject, VNDocumentCameraViewControllerDelegate {
    static var isSupported: Bool { VNDocumentCameraViewController.isSupported }

    private let scanned: (ScannedPages) -> Void
    /// The camera holds its delegate weakly, so the scanner keeps itself until the scan ends.
    private var retained: DocumentScanner?

    init(scanned: @escaping (ScannedPages) -> Void) {
        self.scanned = scanned
    }

    func present(from host: UIViewController) {
        let camera = VNDocumentCameraViewController()
        camera.delegate = self
        retained = self
        host.present(camera, animated: true)
    }

    nonisolated func documentCameraViewController(
        _ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan
    ) {
        // The camera calls this on the main thread, and nothing else holds the scan.
        nonisolated(unsafe) let scan = scan
        MainActor.assumeIsolated {
            let pages = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
            controller.dismiss(animated: true)
            encode(pages)
        }
    }

    nonisolated func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        MainActor.assumeIsolated {
            controller.dismiss(animated: true)
            retained = nil
        }
    }

    nonisolated func documentCameraViewController(
        _ controller: VNDocumentCameraViewController, didFailWithError error: any Error
    ) {
        MainActor.assumeIsolated {
            controller.dismiss(animated: true)
            retained = nil
        }
    }

    private func encode(_ images: [UIImage]) {
        // UIImage is immutable and safe to read on any thread; only the encoder's thread reads these.
        nonisolated(unsafe) let images = images
        Task {
            let encoded = await Task.detached(priority: .userInitiated) {
                images.map(ScanEncoding.jpeg)
            }.value
            let pages = encoded.compactMap { $0 }
            scanned(ScannedPages(pages: pages, failed: encoded.count - pages.count))
            retained = nil
        }
    }
}
