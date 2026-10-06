// Author Studio's bridge to Apple's on-device Foundation Models framework.
//
//   author-studio-apple-intelligence status
//     Prints one JSON line: {"available", "reason", "contextSize", "osVersion"}.
//   author-studio-apple-intelligence generate
//     Reads {"instructions", "prompt", "temperature", "maxResponseTokens",
//     "guardrails"} as JSON on stdin and writes JSON lines:
//     {"type": "delta" | "replace", "text"}, then {"type": "done", "finishReason"}
//     or {"type": "error", "code", "message"}.
//
// The binary is built for macOS 12 and weak-links FoundationModels, so it runs
// (and reports "unsupportedOS") on Macs without Apple Intelligence support.
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

let helperVersion = "1.0.0"

func emit(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

struct GenerateRequest: Decodable {
    let instructions: String
    let prompt: String
    let temperature: Double?
    let maxResponseTokens: Int?
    let guardrails: String?
}

@main
enum Helper {
    static func main() async {
        switch CommandLine.arguments.dropFirst().first ?? "" {
        case "status":
            status()
        case "generate":
            await generate()
        case "version", "--version":
            emit(["version": helperVersion])
        default:
            FileHandle.standardError.write(Data("usage: author-studio-apple-intelligence status|generate|version\n".utf8))
            exit(64)
        }
    }

    static func status() {
        var result: [String: Any] = ["osVersion": ProcessInfo.processInfo.operatingSystemVersionString, "version": helperVersion]
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            let model = SystemLanguageModel.default
            if let reason = unavailableReason(model) {
                result["available"] = false
                result["reason"] = reason
            } else {
                result["available"] = true
            }
            result["contextSize"] = model.contextSize
            emit(result)
            return
        }
        #endif
        result["available"] = false
        result["reason"] = "unsupportedOS"
        emit(result)
    }

    static func generate() async {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard let request = try? JSONDecoder().decode(GenerateRequest.self, from: input) else {
            emit(["type": "error", "code": "invalidInput", "message": "The request could not be read."])
            exit(65)
        }
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            await run(request)
            return
        }
        #endif
        emit(["type": "error", "code": "unavailable", "reason": "unsupportedOS", "message": "Apple Intelligence needs macOS 26 or later."])
    }

    #if canImport(FoundationModels)
    @available(macOS 26.0, *)
    static func unavailableReason(_ model: SystemLanguageModel) -> String? {
        switch model.availability {
        case .available:
            return nil
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible: return "deviceNotEligible"
            case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
            case .modelNotReady: return "modelNotReady"
            @unknown default: return "unknown"
            }
        }
    }

    @available(macOS 26.0, *)
    static func errorCode(_ error: LanguageModelSession.GenerationError) -> String {
        switch error {
        case .exceededContextWindowSize: return "exceededContextWindowSize"
        case .assetsUnavailable: return "assetsUnavailable"
        case .guardrailViolation: return "guardrailViolation"
        case .unsupportedGuide: return "unsupportedGuide"
        case .unsupportedLanguageOrLocale: return "unsupportedLanguageOrLocale"
        case .decodingFailure: return "decodingFailure"
        case .rateLimited: return "rateLimited"
        case .concurrentRequests: return "concurrentRequests"
        case .refusal: return "refusal"
        @unknown default: return "failed"
        }
    }

    // The framework does not say whether a reply hit maximumResponseTokens, so
    // compare the reply's size with the limit.
    @available(macOS 26.0, *)
    static func finishReason(_ model: SystemLanguageModel, text: String, limit: Int?) async -> String {
        guard let limit, limit > 0 else { return "stop" }
        if #available(macOS 26.4, *) {
            if let count = try? await model.tokenCount(for: text) {
                return count >= limit - 4 ? "length" : "stop"
            }
        }
        return Double(text.utf8.count) / 3.6 >= Double(limit) * 0.97 ? "length" : "stop"
    }

    @available(macOS 26.0, *)
    static func run(_ request: GenerateRequest) async {
        let model = request.guardrails == "permissive"
            ? SystemLanguageModel(useCase: .general, guardrails: .permissiveContentTransformations)
            : SystemLanguageModel.default
        if let reason = unavailableReason(model) {
            emit(["type": "error", "code": "unavailable", "reason": reason, "message": "Apple Intelligence is not available: \(reason)."])
            return
        }
        let session = LanguageModelSession(model: model, instructions: request.instructions)
        let options = GenerationOptions(temperature: request.temperature, maximumResponseTokens: request.maxResponseTokens)
        var previous = ""
        do {
            for try await snapshot in session.streamResponse(to: request.prompt, options: options) {
                let current = snapshot.content
                if current.hasPrefix(previous) {
                    let delta = String(current.dropFirst(previous.count))
                    if !delta.isEmpty { emit(["type": "delta", "text": delta]) }
                } else {
                    emit(["type": "replace", "text": current])
                }
                previous = current
            }
            emit(["type": "done", "finishReason": await finishReason(model, text: previous, limit: request.maxResponseTokens)])
        } catch let error as LanguageModelSession.GenerationError {
            if case .exceededContextWindowSize = error, !previous.isEmpty {
                emit(["type": "done", "finishReason": "length"])
                return
            }
            emit(["type": "error", "code": errorCode(error), "message": error.localizedDescription])
        } catch {
            emit(["type": "error", "code": "failed", "message": String(describing: error)])
        }
    }
    #endif
}
