import AVFoundation
import Foundation

// AVAudioConverter supplies signed LE Int16 mono at 16 kHz. The fixture replaces only the input device.
final class DictationCapture {
    private let engine = AVAudioEngine()
    private var fixtureTimer: DispatchSourceTimer?
    private var tapped = false
    private let packetizer: DictationFrames

    init(write: @escaping (Data) -> Void, failure: @escaping () -> Void) {
        packetizer = DictationFrames(write: write, failure: failure)
    }

    func start(fixture: URL?, ended: @escaping () -> Void) throws {
        if let fixture = fixture {
            let file = try FileHandle(forReadingFrom: fixture)
            let size = try file.seekToEnd()
            guard size <= 3_840_000, size % 2 == 0 else { throw shellError("Invalid PCM fixture.") }
            try file.seek(toOffset: 0)
            let timer = DispatchSource.makeTimerSource(queue: .main)
            fixtureTimer = timer
            timer.setCancelHandler { try? file.close() }
            timer.setEventHandler { [weak self] in
                guard let self = self else { return }
                guard let data = try? file.read(upToCount: 640), !data.isEmpty else { ended(); return }
                self.packetizer.append(data)
            }
            timer.schedule(deadline: .now(), repeating: .milliseconds(20))
            timer.resume()
            return
        }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
            let pcm = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
            let converter = AVAudioConverter(from: format, to: pcm),
            let output = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: 8192) else {
            throw shellError("No microphone is available.")
        }
        let packetizer = self.packetizer
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            var sent = false
            var error: NSError?
            output.frameLength = 0
            let result = converter.convert(to: output, error: &error) { _, status in
                status.pointee = sent ? .noDataNow : .haveData
                if sent { return nil }
                sent = true
                return buffer
            }
            if result == .error { packetizer.fail(); return }
            if let samples = output.int16ChannelData?.pointee, output.frameLength > 0 {
                packetizer.append(Data(bytes: samples, count: Int(output.frameLength) * 2))
            }
        }
        tapped = true
        engine.prepare()
        try engine.start()
    }

    func stop(flush: Bool) {
        fixtureTimer?.cancel()
        fixtureTimer = nil
        if tapped {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            tapped = false
        }
        packetizer.stop(flush: flush)
    }
}

private final class DictationFrames {
    private let frameBytes = 1600
    private let lock = NSLock()
    private let mailbox = DispatchSemaphore(value: 8)
    private let write: (Data) -> Void
    private let failure: () -> Void
    private var tail = Data()
    private var stopped = false

    init(write: @escaping (Data) -> Void, failure: @escaping () -> Void) {
        self.write = write
        self.failure = failure
    }

    func append(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        if stopped { return }
        tail.append(data)
        while tail.count >= frameBytes {
            emit(Data(tail.prefix(frameBytes)))
            if stopped { return }
            tail.removeFirst(frameBytes)
        }
    }

    private func emit(_ frame: Data) {
        if mailbox.wait(timeout: .now()) != .success {
            stopped = true
            tail.removeAll()
            DispatchQueue.main.async(execute: failure)
            return
        }
        DispatchQueue.main.async { [self] in
            defer { mailbox.signal() }
            write(frame)
        }
    }

    func fail() {
        lock.lock()
        defer { lock.unlock() }
        if !stopped {
            stopped = true
            DispatchQueue.main.async(execute: failure)
        }
    }

    func stop(flush: Bool) {
        lock.lock()
        defer { lock.unlock() }
        if !stopped, flush, !tail.isEmpty {
            tail.append(Data(count: frameBytes - tail.count))
            emit(tail)
        }
        stopped = true
        tail.removeAll()
    }
}
