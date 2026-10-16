// desk-listen: on-device speech to text for Agent Desk's voice input.
//
//   desk-listen <locale>          listen and print PARTIAL:<text> lines, then FINAL:<text> once stopped.
//                                 Reading "stop" (or end of input) on stdin ends the recording.
//                                 On failure prints ERROR:<message> and exits 1.
//   desk-listen --check <locale>  print OK or ERROR:<reason> without asking for any permission.
import AVFoundation
import Foundation
import Speech

func emit(_ line: String) {
    // One line per message: newlines inside a transcript would split it.
    print(line.replacingOccurrences(of: "\n", with: " "))
    fflush(stdout)
}

func fail(_ message: String) -> Never {
    emit("ERROR:\(message)")
    exit(1)
}

var args = Array(CommandLine.arguments.dropFirst())
let checkOnly = args.first == "--check"
if checkOnly { args.removeFirst() }
let localeId = args.first ?? "en-US"

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    fail("Speech recognition does not support \(localeId)")
}

if checkOnly {
    guard recognizer.isAvailable else { fail("Speech recognition for \(localeId) is not available right now") }
    emit("OK")
    exit(0)
}

let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
var task: SFSpeechRecognitionTask?
var transcript = ""
var stopping = false

// Everything below runs on the main queue, so these flags need no locks.
func finish() -> Never {
    emit("FINAL:\(transcript)")
    exit(0)
}

func stop() {
    guard !stopping else { return }
    stopping = true
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    request.endAudio()
    // The recognizer normally answers with a final result right away; don't wait forever if it doesn't.
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish() }
}

func listen() {
    request.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }

    let input = engine.inputNode
    input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
        request.append(buffer)
    }
    engine.prepare()
    do { try engine.start() } catch { fail("Could not start the microphone: \(error.localizedDescription)") }

    task = recognizer.recognitionTask(with: request) { result, error in
        DispatchQueue.main.async {
            if let result {
                transcript = result.bestTranscription.formattedString
                if result.isFinal { finish() }
                if !stopping { emit("PARTIAL:\(transcript)") }
            }
            // After stop, errors such as "no speech detected" just mean the transcript is what we have.
            if let error {
                if stopping { finish() }
                fail(error.localizedDescription)
            }
        }
    }

    // "stop" or end of input ends the recording.
    Thread.detachNewThread {
        while let line = readLine(), line.trimmingCharacters(in: .whitespaces) != "stop" {}
        DispatchQueue.main.async { stop() }
    }
}

SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
        guard status == .authorized else { fail("Speech recognition permission was not granted") }
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async {
                guard granted else { fail("Microphone permission was not granted") }
                listen()
            }
        }
    }
}

dispatchMain()
