// Encode a list of still frames into an H.264 MP4 with AVFoundation.
//   mp4enc <list.txt> <out.mp4> <fps>
// Each line of list.txt is "<image path>\t<frames to hold>". Held frames are
// written once with a longer duration, so long holds cost nothing.
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
if args.count < 4 { fail("usage: mp4enc <list.txt> <out.mp4> <fps> [bitrate]") }
let listText = (try? String(contentsOfFile: args[1], encoding: .utf8)) ?? ""
let entries: [(String, Int)] = listText.split(separator: "\n").compactMap { line in
  let parts = line.split(separator: "\t")
  guard parts.count == 2, let n = Int(parts[1]), n > 0 else { return nil }
  return (String(parts[0]), n)
}
if entries.isEmpty { fail("no frames in \(args[1])") }
let fps = Int32(args[3]) ?? 30
let bitrate = args.count > 4 ? (Int(args[4]) ?? 12_000_000) : 12_000_000

func load(_ path: String) -> CGImage {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot read \(path)") }
  return img
}

let first = load(entries[0].0)
let W = first.width, H = first.height
let out = URL(fileURLWithPath: args[2])
try? FileManager.default.removeItem(at: out)
guard let writer = try? AVAssetWriter(outputURL: out, fileType: .mp4) else { fail("cannot create \(args[2])") }
let settings: [String: Any] = [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: W, AVVideoHeightKey: H,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitrate, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
  AVVideoColorPropertiesKey: [
    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
  ],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
  kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

var t: Int64 = 0
for (path, n) in entries {
  let img = path == entries[0].0 && t == 0 ? first : load(path)
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  guard let buf = pb else { fail("no pixel buffer") }
  CVPixelBufferLockBaseAddress(buf, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: W, height: H, bitsPerComponent: 8,
                      bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
  CVPixelBufferUnlockBaseAddress(buf, [])
  while !input.isReadyForMoreMediaData { usleep(2000) }
  if !adaptor.append(buf, withPresentationTime: CMTime(value: t, timescale: fps)) { fail("append failed: \(writer.error?.localizedDescription ?? "?")") }
  t += Int64(n)
}
input.markAsFinished()
writer.endSession(atSourceTime: CMTime(value: t, timescale: fps))
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fail("writer failed: \(writer.error?.localizedDescription ?? "?")") }
print("\(args[2]): \(entries.count) images, \(t) frames at \(fps) fps (\(String(format: "%.1f", Double(t) / Double(fps))) s)")
