// pi-voice-audio: the only process of a call that opens the microphone and the speakers.
//
// The daemon (pi_voice) runs it as a child and talks to it over stdin/stdout with the framing of
// daemon/pi_voice/framing.py: mic audio out (16 kHz int16), speech in (24 kHz int16), JSON
// events and commands. Playback and capture go through one AVAudioEngine whose input node has
// voice processing on (VoiceProcessingIO, FaceTime's echo cancellation): Pi's voice played on
// the Mac's speakers is subtracted from what the microphone hears. The playback graph is
// attached before voice processing is enabled, or the echo reference would be empty.
//
// Started from Pi inside Herdr, macOS charges the microphone to Herdr (its permission); the
// embedded Info.plist lets it ask for itself when started from elsewhere.
//
//     pi-voice-audio            serve the daemon on stdin/stdout
//     pi-voice-audio --devices  list the audio devices and exit (opens nothing)

import AVFoundation
import CoreAudio
import Foundation

let micRate = 16000.0
let speakerRate = 24000.0

// MARK: framing

final class Out {
    private let lock = NSLock()
    func frame(_ kind: UInt8, _ payload: Data) {
        var head = Data([kind])
        var n = UInt32(payload.count).littleEndian
        head.append(Data(bytes: &n, count: 4))
        lock.lock()
        FileHandle.standardOutput.write(head + payload)
        lock.unlock()
    }
    func event(_ obj: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: obj) { frame(UInt8(ascii: "E"), data) }
    }
}

let out = Out()

func readExactly(_ n: Int) -> Data? {
    var data = Data()
    while data.count < n {
        let chunk = FileHandle.standardInput.readData(ofLength: n - data.count)
        if chunk.isEmpty { return nil }
        data.append(chunk)
    }
    return data
}

// MARK: audio

final class Audio {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let speakerFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: speakerRate, channels: 1, interleaved: false)!
    let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: micRate, channels: 1, interleaved: true)!
    var converter: AVAudioConverter?
    var mono: AVAudioFormat?
    var micOn = false
    var configured = false
    var pending = 0  // speech buffers scheduled and not yet played
    let queue = DispatchQueue(label: "pi-voice-audio")

    /// The engine (and so the microphone, and macOS's orange indicator) runs only while a call has
    /// the mic on: the daemon outlives calls, the microphone mustn't.
    func setMic(_ on: Bool) throws {
        micOn = on
        if on, !engine.isRunning {
            if !configured { try configure() }
            engine.prepare()
            try engine.start()
            player.play()
        } else if !on, engine.isRunning {
            player.stop()
            engine.stop()
            queue.sync { pending = 0 }
        }
    }

    func configure() throws {
        // Playback first: voice processing takes its echo reference from the output it finds attached.
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: speakerFormat)
        try engine.inputNode.setVoiceProcessingEnabled(true)
        // Pi's voice is ours to cancel; don't let voice processing duck other apps more than needed.
        if #available(macOS 14.0, *) {
            engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        }
        let input = engine.inputNode.outputFormat(forBus: 0)
        // With voice processing on, the input comes as several channels with a discrete layout,
        // and AVAudioConverter turns such a format into silence when it downmixes (seen live: every
        // mic frame was zero). So channel 0, the processed voice, is taken as mono first.
        mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: input.sampleRate, channels: 1, interleaved: false)
        converter = AVAudioConverter(from: mono!, to: micFormat)
        FileHandle.standardError.write("pi-voice-audio: mic tap \(input.channelCount) ch, \(input.sampleRate) Hz, interleaved \(input.isInterleaved)\n".data(using: .utf8)!)
        engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: input) { [weak self] buffer, _ in
            self?.mic(buffer)
        }
        configured = true
    }

    /// Channel 0 of the tap's buffer, as a mono float buffer at the same rate.
    func firstChannel(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let mono, let src = buffer.floatChannelData,
              let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else { return nil }
        out.frameLength = buffer.frameLength
        let stride = buffer.format.isInterleaved ? Int(buffer.format.channelCount) : 1
        let dst = out.floatChannelData![0]
        for i in 0..<Int(buffer.frameLength) { dst[i] = src[0][i * stride] }
        return out
    }

    func mic(_ tapped: AVAudioPCMBuffer) {
        guard micOn, let converter, let buffer = firstChannel(tapped) else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * micRate / buffer.format.sampleRate) + 16
        guard let converted = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: capacity) else { return }
        var given = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, converted.frameLength > 0, let samples = converted.int16ChannelData else { return }
        out.frame(UInt8(ascii: "M"), Data(bytes: samples[0], count: Int(converted.frameLength) * 2))
    }

    func play(seq: UInt32, pcm: Data) {
        guard engine.isRunning else { return }
        let frames = pcm.count / 2
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: speakerFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            let dst = buffer.floatChannelData![0]
            for i in 0..<frames { dst[i] = Float(Int16(littleEndian: src[i])) / 32768 }
        }
        queue.sync { pending += 1 }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            guard let self else { return }
            out.event(["event": "played", "seq": Int(seq)])
            let left = self.queue.sync { () -> Int in self.pending -= 1; return self.pending }
            if left == 0 { out.event(["event": "drained"]) }
        }
    }

    func stop() {
        player.stop()  // drops what's scheduled; their callbacks fire, then nothing is pending
        queue.sync { pending = 0 }
        player.play()
        out.event(["event": "drained"])
    }
}

// MARK: devices

func listDevices() {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids)
    for id in ids {
        var name: CFString = "" as CFString
        var nameSize = UInt32(MemoryLayout<CFString>.size)
        var nameAddress = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal,
                                                     mElement: kAudioObjectPropertyElementMain)
        AudioObjectGetPropertyData(id, &nameAddress, 0, nil, &nameSize, &name)
        print(id, name)
    }
}

// MARK: main

if CommandLine.arguments.contains("--devices") {
    listDevices()
    exit(0)
}

let audio = Audio()
out.event(["event": "ready"])

// Commands from the daemon, until it closes stdin.
DispatchQueue.global().async {
    while let head = readExactly(5) {
        let kind = head[0]
        let n = Int(head[1]) | Int(head[2]) << 8 | Int(head[3]) << 16 | Int(head[4]) << 24
        guard let payload = readExactly(n) else { break }
        switch kind {
        case UInt8(ascii: "S"):
            let seq = UInt32(payload[0]) | UInt32(payload[1]) << 8 | UInt32(payload[2]) << 16 | UInt32(payload[3]) << 24
            audio.play(seq: seq, pcm: payload.subdata(in: 5..<payload.count))
        case UInt8(ascii: "C"):
            guard let cmd = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { continue }
            switch cmd["cmd"] as? String {
            case "mic":
                let on = (cmd["on"] as? Bool) ?? false
                do {
                    try audio.setMic(on)
                    out.event(["event": on ? "mic_open" : "mic_closed"])
                } catch {
                    out.event(["event": "error", "message": "audio: \(error.localizedDescription)"])
                }
            case "stop":
                audio.stop()
            case "gain":
                audio.player.volume = Float((cmd["value"] as? Double) ?? 1)
            default:
                break
            }
        default:
            break
        }
    }
    exit(0)
}

RunLoop.main.run()
