import Foundation

/// One colour of berry friend. Light → deep, plus the nose. All as 0xRRGGBB.
public struct BerryColour: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let berry1: UInt32
    public let berry2: UInt32
    public let berry3: UInt32
    public let berry4: UInt32
    public let nose: UInt32

    public static let bluey   = BerryColour(id: "bluey",   name: "Bluey",   berry1: 0xA9BCFF, berry2: 0x6C86F5, berry3: 0x4254D6, berry4: 0x2B2F8F, nose: 0x1C1F66)
    public static let greenie = BerryColour(id: "greenie", name: "Greenie", berry1: 0xB6F2B0, berry2: 0x6FD873, berry3: 0x34A853, berry4: 0x1E6B34, nose: 0x0F3D1D)
    public static let reddie  = BerryColour(id: "reddie",  name: "Reddie",  berry1: 0xFFB3B3, berry2: 0xF2706E, berry3: 0xD63C3C, berry4: 0x8F1F2B, nose: 0x5A0F18)
    public static let azure   = BerryColour(id: "azure",   name: "Azure",   berry1: 0xB3ECFF, berry2: 0x5CC8F5, berry3: 0x1E9BD7, berry4: 0x0F5E8F, nose: 0x083A5A)
    public static let purply  = BerryColour(id: "purply",  name: "Purply",  berry1: 0xD9BBFF, berry2: 0xA779F5, berry3: 0x7442D6, berry4: 0x452B8F, nose: 0x2A1766)
    public static let pinky   = BerryColour(id: "pinky",   name: "Pinky",   berry1: 0xFFC2E5, berry2: 0xF57FC0, berry3: 0xD6409A, berry4: 0x8F2265, nose: 0x5A1240)
    public static let sunny   = BerryColour(id: "sunny",   name: "Sunny",   berry1: 0xFFF0A8, berry2: 0xFFD84D, berry3: 0xF2B01E, berry4: 0xA8700A, nose: 0x5E3D05)
    public static let orangey = BerryColour(id: "orangey", name: "Orangey", berry1: 0xFFD0A8, berry2: 0xFFA05C, berry3: 0xF07222, berry4: 0xA8460A, nose: 0x5E2505)

    public static let all: [BerryColour] = [bluey, greenie, reddie, azure, purply, pinky, sunny, orangey]
    public static func named(_ id: String?) -> BerryColour? { all.first { $0.id == id?.lowercased() } }
}

/// Berry colours from the design canvas, as 0xRRGGBB. The berry shades follow the chosen colour
/// (Bluey, Greenie, Reddie, Azure…), which is remembered and synced between the computer and the phone.
public enum Palette {
    public static let defaultsKey = "blueyColour"
    /// Posted (on the main queue) whenever the colour changes.
    public static let didChange = Notification.Name("BlueyColourDidChange")

    public static var current: BerryColour {
        get { BerryColour.named(UserDefaults.standard.string(forKey: defaultsKey)) ?? .bluey }
        set {
            guard newValue != current else { return }
            UserDefaults.standard.set(newValue.id, forKey: defaultsKey)
            NotificationCenter.default.post(name: didChange, object: nil)
        }
    }

    public static var berry1: UInt32 { current.berry1 }  // light
    public static var berry2: UInt32 { current.berry2 }
    public static var berry3: UInt32 { current.berry3 }
    public static var berry4: UInt32 { current.berry4 }  // deep
    public static var nose: UInt32 { current.nose }
    public static let ink: UInt32 = 0x17151F
    public static let inkSoft: UInt32 = 0xB9B2CC
    public static let panel: UInt32 = 0x1E1B29

    public static var gradient: [UInt32] { [berry1, berry2, berry3, berry4] }
    public static let gradientStops: [Double] = [0, 0.34, 0.68, 1]

    public static func rgb(_ hex: UInt32) -> (r: Double, g: Double, b: Double) {
        (Double((hex >> 16) & 0xFF) / 255, Double((hex >> 8) & 0xFF) / 255, Double(hex & 0xFF) / 255)
    }
}

/// Which AI model family judges the screen. Chosen in the desktop app's settings.
public enum AIProvider: String, CaseIterable, Codable, Sendable {
    case chatgpt, claude, gemini, deepseek, all

    public var title: String {
        switch self {
        case .chatgpt: return "ChatGPT (OpenAI)"
        case .claude: return "Claude (Anthropic)"
        case .gemini: return "Gemini (Google)"
        case .deepseek: return "DeepSeek"
        case .all: return "All 4 combined"
        }
    }
    /// The individual providers this choice asks.
    public var members: [AIProvider] { self == .all ? [.chatgpt, .claude, .gemini, .deepseek] : [self] }
}
