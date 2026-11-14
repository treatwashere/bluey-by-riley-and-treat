import Foundation
import GooglyShared

/// One question with an optional screenshot to Claude, Gemini or DeepSeek, answered as text (JSON is asked
/// for in the prompt). ChatGPT keeps using the OpenAI Decisions/Responses calls in FocusAPI.
/// Keys come from the private keys file; error messages never echo response bodies (they may quote the screen).
enum AIChat {
    static func ask(_ provider: AIProvider, system: String, text: String, jpeg: Data?, timeout: Double) async throws -> String {
        switch provider {
        case .claude: return try await claude(system: system, text: text, jpeg: jpeg, timeout: timeout)
        case .gemini: return try await gemini(system: system, text: text, jpeg: jpeg, timeout: timeout)
        case .deepseek: return try await deepseek(system: system, text: text, timeout: timeout)
        case .chatgpt, .all: return try await openAIChat(system: system, text: text, jpeg: jpeg, timeout: timeout)
        }
    }

    private static func send(_ name: String, url: URL, headers: [String: String], body: [String: Any],
                             timeout: Double) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (field, value) in headers { request.setValue(value, forHTTPHeaderField: field) }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let help = code == 401 || code == 403 ? "Check your \(name) key." : code == 429 ? "Rate or spending limit reached." : "Try resuming in a moment."
            throw FocusAPI.Failure.message("\(name) returned HTTP \(code). \(help)")
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw FocusAPI.Failure.message("\(name) sent an unreadable answer.")
        }
        return json
    }

    private static func key(_ key: Keychain.Key) throws -> String {
        guard let value = Keychain.get(key) else { throw FocusAPI.Failure.message("Add your \(key.title) key in Bluey's menu: AI Keys.") }
        return value
    }

    /// Claude Messages API (raw HTTP; there's no official Swift SDK).
    private static func claude(system: String, text: String, jpeg: Data?, timeout: Double) async throws -> String {
        var content: [[String: Any]] = []
        if let jpeg {
            content.append(["type": "image", "source": ["type": "base64", "media_type": "image/jpeg",
                                                         "data": jpeg.base64EncodedString()]])
        }
        content.append(["type": "text", "text": text])
        let apiKey = try key(.anthropic)
        let json = try await send("Claude", url: URL(string: "https://api.anthropic.com/v1/messages")!, headers: [
            "x-api-key": apiKey,
            "anthropic-version": "2026-10-21",
            // Lets the API retry a declined request on a fallback model inside the same call.
            "anthropic-beta": "server-side-fallback-2026-07-01",
        ], body: [
            "model": Settings.shared.claudeModel,
            "max_tokens": 4000,
            "system": system,
            "output_config": ["effort": "low"],
            "fallbacks": "default",
            "messages": [["role": "user", "content": content]],
        ], timeout: timeout)
        guard json["stop_reason"] as? String != "refusal" else { throw FocusAPI.Failure.message("Claude declined this check.") }
        let blocks = json["content"] as? [[String: Any]] ?? []
        return blocks.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined()
    }

    /// Gemini generateContent.
    private static func gemini(system: String, text: String, jpeg: Data?, timeout: Double) async throws -> String {
        var parts: [[String: Any]] = []
        if let jpeg { parts.append(["inline_data": ["mime_type": "image/jpeg", "data": jpeg.base64EncodedString()]]) }
        parts.append(["text": text])
        let apiKey = try key(.gemini)
        let model = Settings.shared.geminiModel.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "gemini-flash-latest"
        let json = try await send("Gemini", url: URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):generateContent")!,
            headers: ["x-goog-api-key": apiKey], body: [
            "systemInstruction": ["parts": [["text": system]]],
            "contents": [["role": "user", "parts": parts]],
            "generationConfig": ["responseMimeType": "application/json"],
        ], timeout: timeout)
        let candidates = json["candidates"] as? [[String: Any]] ?? []
        let content = candidates.first?["content"] as? [String: Any]
        return (content?["parts"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined()
    }

    /// DeepSeek's chat API reads text only, so it judges from the screen's text (OCR) and the app name.
    private static func deepseek(system: String, text: String, timeout: Double) async throws -> String {
        let apiKey = try key(.deepseek)
        let json = try await send("DeepSeek", url: URL(string: "https://api.deepseek.com/chat/completions")!,
            headers: ["Authorization": "Bearer \(apiKey)"], body: [
            "model": Settings.shared.deepseekModel,
            "response_format": ["type": "json_object"],
            "messages": [["role": "system", "content": system + "\nYou only get the screen's text, not the image. Answer in JSON."],
                         ["role": "user", "content": text]],
        ], timeout: timeout)
        let choices = json["choices"] as? [[String: Any]] ?? []
        return (choices.first?["message"] as? [String: Any])?["content"] as? String ?? ""
    }

    /// ChatGPT with the same plain JSON prompt (used only as a fallback path).
    private static func openAIChat(system: String, text: String, jpeg: Data?, timeout: Double) async throws -> String {
        var content: [[String: Any]] = [["type": "input_text", "text": text]]
        if let jpeg { content.append(["type": "input_image", "image_url": "data:image/jpeg;base64,\(jpeg.base64EncodedString())"]) }
        let data = try await FocusAPI.post("responses", ["model": "gpt-5.5", "store": false, "instructions": system,
            "input": [["role": "user", "content": content]], "text": ["format": ["type": "json_object"]]], timeout: timeout)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let output = json?["output"] as? [[String: Any]] ?? []
        return output.filter { $0["type"] as? String == "message" }.flatMap { $0["content"] as? [[String: Any]] ?? [] }
            .compactMap { $0["text"] as? String }.joined()
    }
}
