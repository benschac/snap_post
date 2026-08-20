import AVFoundation
import Darwin
import ExpoModulesCore
import Foundation
import os.signpost

private enum SnapNativeError: Error {
  case microphonePermissionDenied
  case invalidInputFormat
  case converterUnavailable
}

private final class PCM16kCapture {
  private let audioEngine = AVAudioEngine()
  private let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: 16_000,
    channels: 1,
    interleaved: false
  )!
  private let stateLock = NSLock()

  private var converter: AVAudioConverter?
  private var chunkFrames = 1_280
  private var pendingFrames = 0
  private var pendingSquaredSamples = 0.0
  private var pendingPeak = 0.0
  private var chunkIndex = 0
  private var totalFrames = 0
  private var tapStartedAtMs = 0.0
  private var isCapturing = false

  var onStats: (([String: Any]) -> Void)?
  var onError: ((String) -> Void)?

  func start(chunkDurationMs: Int) throws -> [String: Any] {
    _ = stop()

    guard AVAudioApplication.shared.recordPermission == .granted else {
      throw SnapNativeError.microphonePermissionDenied
    }

    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(.record, mode: .measurement)
    try audioSession.setPreferredSampleRate(targetFormat.sampleRate)
    try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

    let inputNode = audioEngine.inputNode
    let inputFormat = inputNode.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
      throw SnapNativeError.invalidInputFormat
    }
    guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
      throw SnapNativeError.converterUnavailable
    }

    self.converter = converter
    self.chunkFrames = max(640, min(1_600, Int(targetFormat.sampleRate * Double(chunkDurationMs) / 1_000)))
    self.pendingFrames = 0
    self.pendingSquaredSamples = 0
    self.pendingPeak = 0
    self.chunkIndex = 0
    self.totalFrames = 0
    self.tapStartedAtMs = ProcessInfo.processInfo.systemUptime * 1_000
    self.isCapturing = true

    inputNode.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) { [weak self] buffer, _ in
      self?.consume(buffer)
    }
    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      inputNode.removeTap(onBus: 0)
      isCapturing = false
      self.converter = nil
      try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
      throw error
    }

    return [
      "sampleRate": targetFormat.sampleRate,
      "channels": Int(targetFormat.channelCount),
      "chunkDurationMs": Double(self.chunkFrames) / targetFormat.sampleRate * 1_000,
      "startedAtMs": tapStartedAtMs
    ]
  }

  func stop() -> [String: Any] {
    stateLock.lock()
    let wasCapturing = isCapturing
    isCapturing = false
    converter = nil
    let result: [String: Any] = [
      "wasCapturing": wasCapturing,
      "chunks": chunkIndex,
      "totalFrames": totalFrames,
      "durationMs": Double(totalFrames) / targetFormat.sampleRate * 1_000
    ]
    stateLock.unlock()

    if wasCapturing {
      audioEngine.inputNode.removeTap(onBus: 0)
    }
    audioEngine.stop()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    return result
  }

  private func consume(_ inputBuffer: AVAudioPCMBuffer) {
    stateLock.lock()
    let shouldCapture = isCapturing
    let activeConverter = converter
    stateLock.unlock()
    guard shouldCapture, let converter = activeConverter else { return }

    let scale = targetFormat.sampleRate / inputBuffer.format.sampleRate
    let capacity = AVAudioFrameCount(ceil(Double(inputBuffer.frameLength) * scale)) + 1
    guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

    var conversionError: NSError?
    var suppliedInput = false
    let status = converter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
      if suppliedInput {
        inputStatus.pointee = .noDataNow
        return nil
      }
      suppliedInput = true
      inputStatus.pointee = .haveData
      return inputBuffer
    }

    if status == .error {
      let message = conversionError?.localizedDescription ?? "PCM conversion failed"
      DispatchQueue.main.async { [weak self] in
        self?.onError?(message)
      }
      return
    }
    guard outputBuffer.frameLength > 0, let samples = outputBuffer.floatChannelData?[0] else { return }

    var squaredSamples = 0.0
    var peak = 0.0
    for index in 0..<Int(outputBuffer.frameLength) {
      let sample = Double(samples[index])
      squaredSamples += sample * sample
      peak = max(peak, abs(sample))
    }

    var stats: [String: Any]?
    stateLock.lock()
    if isCapturing {
      let frames = Int(outputBuffer.frameLength)
      pendingFrames += frames
      pendingSquaredSamples += squaredSamples
      pendingPeak = max(pendingPeak, peak)
      totalFrames += frames

      if pendingFrames >= chunkFrames {
        chunkIndex += 1
        stats = [
          "chunkIndex": chunkIndex,
          "sampleRate": targetFormat.sampleRate,
          "frames": pendingFrames,
          "totalFrames": totalFrames,
          "rms": sqrt(pendingSquaredSamples / Double(pendingFrames)),
          "peak": pendingPeak,
          "monotonicTimeMs": ProcessInfo.processInfo.systemUptime * 1_000,
          "startupLatencyMs": chunkIndex == 1
            ? ProcessInfo.processInfo.systemUptime * 1_000 - tapStartedAtMs
            : 0
        ]
        pendingFrames = 0
        pendingSquaredSamples = 0
        pendingPeak = 0
      }
    }
    stateLock.unlock()

    if let stats {
      DispatchQueue.main.async { [weak self] in
        self?.onStats?(stats)
      }
    }
  }
}

public class SnapNativeModule: Module {
  private let pcmCapture = PCM16kCapture()
  private let signpostLog = OSLog(
    subsystem: Bundle.main.bundleIdentifier ?? "SnapToPost",
    category: .pointsOfInterest
  )
  private let spanLock = NSLock()
  private var spans: [String: OSSignpostID] = [:]

  public func definition() -> ModuleDefinition {
    Name("SnapNative")

    Events("onAudioStats", "onAudioError")

    OnCreate {
      pcmCapture.onStats = { [weak self] stats in
        self?.sendEvent("onAudioStats", stats)
      }
      pcmCapture.onError = { [weak self] message in
        self?.sendEvent("onAudioError", ["message": message])
      }
    }

    Function("getCapabilities") { () -> [String: Any] in
      return [
        "pcmCapture": true,
        "sampleRate": 16_000,
        "microphonePermission": self.microphonePermission(),
        "signposts": true,
        "thermalTelemetry": true
      ]
    }

    AsyncFunction("startPcmCapture") { (chunkDurationMs: Int) throws -> [String: Any] in
      let result = try self.pcmCapture.start(chunkDurationMs: chunkDurationMs)
      os_signpost(.event, log: self.signpostLog, name: "SnapEvent", "%{public}s", "audio.tap.started")
      return result
    }.runOnQueue(.main)

    AsyncFunction("stopPcmCapture") { () -> [String: Any] in
      let result = self.pcmCapture.stop()
      os_signpost(.event, log: self.signpostLog, name: "SnapEvent", "%{public}s", "audio.tap.stopped")
      return result
    }.runOnQueue(.main)

    Function("getTelemetry") { () -> [String: Any] in
      return [
        "thermalState": self.thermalState(),
        "residentMemoryBytes": self.residentMemoryBytes(),
        "monotonicTimeMs": ProcessInfo.processInfo.systemUptime * 1_000
      ]
    }

    Function("mark") { (name: String, attributes: String?) in
      os_signpost(
        .event,
        log: self.signpostLog,
        name: "SnapEvent",
        "%{public}s %{public}s",
        name,
        attributes ?? ""
      )
    }

    Function("beginSpan") { (name: String, attributes: String?) -> String in
      let spanId = UUID().uuidString
      let signpostId = OSSignpostID(log: self.signpostLog)
      self.spanLock.lock()
      self.spans[spanId] = signpostId
      self.spanLock.unlock()
      os_signpost(
        .begin,
        log: self.signpostLog,
        name: "SnapSpan",
        signpostID: signpostId,
        "%{public}s %{public}s",
        name,
        attributes ?? ""
      )
      return spanId
    }

    Function("endSpan") { (spanId: String, name: String, attributes: String?) in
      self.spanLock.lock()
      let signpostId = self.spans.removeValue(forKey: spanId)
      self.spanLock.unlock()
      guard let signpostId else { return }
      os_signpost(
        .end,
        log: self.signpostLog,
        name: "SnapSpan",
        signpostID: signpostId,
        "%{public}s %{public}s",
        name,
        attributes ?? ""
      )
    }

    OnAppEntersBackground {
      _ = pcmCapture.stop()
    }

    OnDestroy {
      _ = pcmCapture.stop()
      spanLock.lock()
      spans.removeAll()
      spanLock.unlock()
    }
  }

  private func microphonePermission() -> String {
    switch AVAudioApplication.shared.recordPermission {
    case .granted:
      return "granted"
    case .denied:
      return "denied"
    case .undetermined:
      return "undetermined"
    @unknown default:
      return "unknown"
    }
  }

  private func thermalState() -> String {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal:
      return "nominal"
    case .fair:
      return "fair"
    case .serious:
      return "serious"
    case .critical:
      return "critical"
    @unknown default:
      return "unknown"
    }
  }

  private func residentMemoryBytes() -> UInt64 {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { reboundPointer in
        task_info(
          mach_task_self_,
          task_flavor_t(MACH_TASK_BASIC_INFO),
          reboundPointer,
          &count
        )
      }
    }
    return result == KERN_SUCCESS ? UInt64(info.resident_size) : 0
  }
}
