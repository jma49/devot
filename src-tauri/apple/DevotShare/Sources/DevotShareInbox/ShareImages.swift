import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Turns shared images into the JPEGs an item carries: scaled down, without their metadata (a
/// photo's location stays on the phone), and together small enough for the inbox file.
public enum ShareImages {
    /// Images and the text share the file; this leaves the text its room.
    public static let budget = 2 * 1024 * 1024
    /// Each try is smaller than the last, until the images fit the budget.
    static let steps: [(pixels: Int, quality: Double)] = [(2_048, 0.8), (1_536, 0.7), (1_024, 0.6)]

    /// The images that fit, in order, and how many were left out (unreadable, or past the budget).
    public static func prepare(_ sources: [Data]) -> (images: [ShareItem.Image], skipped: Int) {
        let kept = Array(sources.prefix(ShareItem.maxImages))
        var skipped = sources.count - kept.count
        for step in steps {
            let encoded = kept.map { jpeg($0, pixels: step.pixels, quality: step.quality) }
            let readable = encoded.compactMap { $0 }
            if readable.reduce(0, { $0 + $1.count }) <= budget || step == steps.last! {
                skipped += encoded.count - readable.count
                var total = 0
                var images: [ShareItem.Image] = []
                for data in readable {
                    guard total + data.count <= budget else {
                        skipped += 1
                        continue
                    }
                    total += data.count
                    images.append(ShareItem.Image(name: "image-\(images.count + 1).jpg", data: data))
                }
                return (images, skipped)
            }
        }
        return ([], sources.count)
    }

    /// The image scaled so its longer side is at most `pixels`, as a JPEG with no metadata.
    static func jpeg(_ data: Data, pixels: Int, quality: Double) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: pixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }
}
