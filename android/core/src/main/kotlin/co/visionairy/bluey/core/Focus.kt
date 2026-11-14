package co.visionairy.bluey.core

import org.json.JSONObject
import kotlin.math.ceil
import kotlin.math.max

/** Snapshots sent by the computer (Mac or Windows) as Swift Codable JSON. The computer owns the clock. */
data class FocusCheck(
    val elapsed: Double,
    val activity: String,          // on_task, off_task, uncertain, unavailable, paused
    val probability: Double,
    val confidence: Double,
    val probabilities: Map<String, Double>?,
    val nudged: Boolean,
    val providers: List<String>,
)

data class FocusSession(
    val id: String,
    val task: String,
    val duration: Double,
    val elapsed: Double,
    val status: String,            // running, paused, ended
    val detail: String,
    val checks: List<FocusCheck>,
    val developerMode: Boolean,
) {
    val remaining: Double get() = max(0.0, duration - elapsed)
    val isActive: Boolean get() = status != "ended"
    val lastResult: FocusCheck? get() = checks.lastOrNull { it.activity != "paused" }
    val onTaskShare: Double? get() {
        val judged = checks.filter { it.activity == "on_task" || it.activity == "off_task" || it.activity == "uncertain" }
        return if (judged.isEmpty()) null else judged.count { it.activity == "on_task" }.toDouble() / judged.size
    }
}

data class FocusSync(val current: FocusSession?, val history: List<FocusSession>, val revision: Int, val developerMode: Boolean)

object FocusJson {
    fun clock(seconds: Double): String {
        val n = max(0, ceil(seconds).toInt())
        return "%02d:%02d".format(n / 60, n % 60)
    }

    fun parseSync(text: String): FocusSync? = try {
        val o = JSONObject(text)
        val history = o.optJSONArray("history")
        FocusSync(
            current = o.optJSONObject("current")?.let(::session),
            history = (0 until (history?.length() ?: 0)).mapNotNull { history!!.optJSONObject(it)?.let(::session) },
            revision = o.getInt("revision"),
            developerMode = o.optBoolean("developerMode", false),
        )
    } catch (_: Exception) { null }

    private fun session(o: JSONObject): FocusSession {
        val checks = o.optJSONArray("checks")
        return FocusSession(
            id = o.getString("id"), task = o.getString("task"), duration = o.getDouble("duration"),
            elapsed = o.getDouble("elapsed"), status = o.getString("status"), detail = o.optString("detail"),
            checks = (0 until (checks?.length() ?: 0)).mapNotNull { checks!!.optJSONObject(it)?.let(::check) },
            developerMode = o.optBoolean("developerMode", false),
        )
    }

    private fun check(o: JSONObject): FocusCheck {
        val ps = o.optJSONObject("probabilities")
        val providers = o.optJSONArray("providers")
        return FocusCheck(
            elapsed = o.getDouble("elapsed"), activity = o.getString("activity"),
            probability = o.optDouble("probability", 0.0), confidence = o.optDouble("confidence", 0.0),
            probabilities = ps?.let { p -> p.keys().asSequence().associateWith { p.getDouble(it) } },
            nudged = o.optBoolean("nudged", false),
            providers = (0 until (providers?.length() ?: 0)).map { providers!!.getString(it) },
        )
    }
}

/** Turns "I'm editing the launch video for 45 minutes" into a task and a duration (default 30, 1–240). */
object TaskParser {
    data class Parsed(val task: String, val minutes: Double)

    private val words = mapOf("a" to 1.0, "an" to 1.0, "one" to 1.0, "two" to 2.0, "three" to 3.0, "four" to 4.0,
        "five" to 5.0, "ten" to 10.0, "fifteen" to 15.0, "twenty" to 20.0, "thirty" to 30.0, "forty" to 40.0,
        "forty-five" to 45.0, "fifty" to 50.0, "sixty" to 60.0, "ninety" to 90.0)
    private val duration = Regex(
        """\b(?:for\s+)?(?:(half\s+an?\s+hour)|(an?\s+hour\s+and\s+a\s+half)|(\d+(?:\.\d+)?|[a-z-]+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b)""",
        RegexOption.IGNORE_CASE)

    fun parse(spoken: String): Parsed? {
        var minutes = 30.0
        var text = spoken.trim()
        for (match in duration.findAll(text)) {
            val value = when {
                match.groupValues[1].isNotEmpty() -> 30.0
                match.groupValues[2].isNotEmpty() -> 90.0
                else -> {
                    val n = match.groupValues[3].toDoubleOrNull() ?: words[match.groupValues[3].lowercase()] ?: continue
                    if (match.groupValues[4].lowercase().startsWith("h")) n * 60 else n
                }
            }
            minutes = value
            text = text.removeRange(match.range)
            break
        }
        text = text.replace(Regex("""^\s*(?:(?:okay|ok|so|right|hey|hi|bluey|greenie|reddie|azure)[,.!]?\s+)+""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""\s+"""), " ").trim().trimEnd('.', ',', '!', ' ')
        if (text.isEmpty()) return null
        return Parsed(text.replaceFirstChar { it.uppercase() }, minutes.coerceIn(1.0, 240.0))
    }
}
