// mux VIDEO.mp4 AUDIO OUT.mp4 — the video's picture with the audio file's whole
// sound, both passed through untouched. They must already be the same length
// (the video is built to the song); nothing is trimmed.
import AVFoundation
let a = CommandLine.arguments
guard a.count >= 4 else { print("usage: mux video audio out"); exit(2) }
let video = AVURLAsset(url: URL(fileURLWithPath: a[1])), audio = AVURLAsset(url: URL(fileURLWithPath: a[2]))
let out = URL(fileURLWithPath: a[3])
try? FileManager.default.removeItem(at: out)
let comp = AVMutableComposition()
let sem = DispatchSemaphore(value: 0)
Task {
  do {
    let vt = try await video.loadTracks(withMediaType: .video).first!
    let at = try await audio.loadTracks(withMediaType: .audio).first!
    let vdur = try await video.load(.duration), adur = try await audio.load(.duration)
    if abs(vdur.seconds - adur.seconds) > 0.05 { print(String(format: "lengths differ: video %.3f s, audio %.3f s (build the video to the audio's length; nothing is trimmed)", vdur.seconds, adur.seconds)); exit(1) }
    let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
    try cv.insertTimeRange(CMTimeRange(start: .zero, duration: vdur), of: vt, at: .zero)
    cv.preferredTransform = try await vt.load(.preferredTransform)
    let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
    try ca.insertTimeRange(CMTimeRange(start: .zero, duration: adur), of: at, at: .zero)
    let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough)!
    ex.outputURL = out; ex.outputFileType = .mp4
    await ex.export()
    if ex.status != .completed { print("export failed: \(ex.error?.localizedDescription ?? "?")"); exit(1) }
    print("muxed \(String(format: "%.2f", vdur.seconds)) s video with \(String(format: "%.2f", adur.seconds)) s audio → \(a[3])")
  } catch { print("error: \(error)"); exit(1) }
  sem.signal()
}
sem.wait()
