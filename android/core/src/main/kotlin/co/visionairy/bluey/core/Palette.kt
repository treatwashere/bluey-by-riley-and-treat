package co.visionairy.bluey.core

/** One colour of berry friend: light → deep shades and the nose, as 0xRRGGBB. Same as Shared/Palette.swift. */
data class BerryColour(val id: String, val name: String, val berry: List<Int>, val nose: Int)

object Palette {
    val bluey = BerryColour("bluey", "Bluey", listOf(0xA9BCFF, 0x6C86F5, 0x4254D6, 0x2B2F8F), 0x1C1F66)
    val greenie = BerryColour("greenie", "Greenie", listOf(0xB6F2B0, 0x6FD873, 0x34A853, 0x1E6B34), 0x0F3D1D)
    val reddie = BerryColour("reddie", "Reddie", listOf(0xFFB3B3, 0xF2706E, 0xD63C3C, 0x8F1F2B), 0x5A0F18)
    val azure = BerryColour("azure", "Azure", listOf(0xB3ECFF, 0x5CC8F5, 0x1E9BD7, 0x0F5E8F), 0x083A5A)
    val purply = BerryColour("purply", "Purply", listOf(0xD9BBFF, 0xA779F5, 0x7442D6, 0x452B8F), 0x2A1766)
    val pinky = BerryColour("pinky", "Pinky", listOf(0xFFC2E5, 0xF57FC0, 0xD6409A, 0x8F2265), 0x5A1240)
    val sunny = BerryColour("sunny", "Sunny", listOf(0xFFF0A8, 0xFFD84D, 0xF2B01E, 0xA8700A), 0x5E3D05)
    val orangey = BerryColour("orangey", "Orangey", listOf(0xFFD0A8, 0xFFA05C, 0xF07222, 0xA8460A), 0x5E2505)

    val all = listOf(bluey, greenie, reddie, azure, purply, pinky, sunny, orangey)
    fun named(id: String?): BerryColour? = all.firstOrNull { it.id == id?.lowercase() }

    const val INK = 0x17151F
    const val INK_SOFT = 0xB9B2CC
    const val PANEL = 0x1E1B29
    val gradientStops = listOf(0f, 0.34f, 0.68f, 1f)
}

/** Which AI judges the screen. The keys live on the computer; the phone only picks. */
enum class AIProvider(val id: String, val title: String) {
    CHATGPT("chatgpt", "ChatGPT (OpenAI)"),
    CLAUDE("claude", "Claude (Anthropic)"),
    GEMINI("gemini", "Gemini (Google)"),
    DEEPSEEK("deepseek", "DeepSeek"),
    ALL("all", "All 4 combined");

    companion object {
        fun from(id: String?): AIProvider? = entries.firstOrNull { it.id == id }
    }
}
