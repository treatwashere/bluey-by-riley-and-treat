package co.visionairy.bluey.android

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import co.visionairy.bluey.core.AIProvider
import co.visionairy.bluey.core.BerryColour
import co.visionairy.bluey.core.FocusJson
import co.visionairy.bluey.core.FocusSync
import co.visionairy.bluey.core.Palette
import co.visionairy.bluey.core.PairingRecord
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.sin

/** Everything the screen shows. All changes happen on the main thread. */
class BlueyModel(private val context: Context) {
    private val prefs = context.getSharedPreferences("bluey", Context.MODE_PRIVATE)
    private val pairing = PairingStore(context)
    val link = ComputerLink(context, pairing)
    private val main = Handler(Looper.getMainLooper())

    var connected by mutableStateOf(false); private set
    var computerName by mutableStateOf<String?>(null); private set
    var paired by mutableStateOf(pairing.load() != null); private set
    var colour by mutableStateOf(Palette.named(prefs.getString("colour", null)) ?: Palette.bluey); private set
    var provider by mutableStateOf(AIProvider.from(prefs.getString("aiProvider", null)) ?: AIProvider.CHATGPT); private set
    var gazeX by mutableStateOf(0f); private set
    var gazeY by mutableStateOf(0f); private set
    var mood by mutableStateOf("listening"); private set
    var focus by mutableStateOf<FocusSync?>(null); private set
    var fresh by mutableStateOf(false); private set
    var bubble by mutableStateOf<String?>(null); private set
    var message by mutableStateOf("")

    private var revision = -1
    private var receivedAt = 0L
    private var bubbleToken = 0

    init {
        link.onConnectionChanged = { isConnected, name ->
            connected = isConnected; computerName = name
            fresh = false; revision = -1
            if (!isConnected) mood = "sleepy"
        }
        link.onPacket = ::receive
        tick()
    }

    fun start() = link.start()
    fun stop() {
        if (focus?.current?.status == "running") command("focusPause")
        link.stop()
    }

    /** Heartbeat: the computer pauses monitoring if it doesn't hear from the phone for five seconds. */
    private fun tick() {
        if (link.connected) link.send(JSONObject().put("command", "focusPing"))
        if (System.currentTimeMillis() - receivedAt > 5000) fresh = false
        main.postDelayed(::tick, 1000)
    }

    private fun receive(packet: JSONObject) {
        packet.optJSONObject("face")?.let { face ->
            gazeX = face.optDouble("gazeX", 0.0).toFloat().coerceIn(-1f, 1f)
            gazeY = face.optDouble("gazeY", 0.0).toFloat().coerceIn(-1f, 1f)
            mood = face.optString("mood", "listening")
        }
        when (packet.optString("command")) {
            "focusState" -> FocusJson.parseSync(packet.optString("text"))?.let { sync ->
                if (sync.revision <= revision) return@let
                val finished = focus?.current?.let { it.status != "ended" && it.id == sync.current?.id && sync.current?.status == "ended" } == true
                revision = sync.revision; receivedAt = System.currentTimeMillis(); fresh = true
                focus = sync
                if (finished) say("Lovely bit of focus. Your timeline's in the sheet.", 8000)
            }
            "focusChirp" -> {
                say(packet.optString("text").ifEmpty { "Are you sure you're on task right now?" }, 10_000)
                chirp(); buzz()
            }
            "colour" -> Palette.named(packet.optString("text"))?.let { setColourLocally(it) }
            "aiProvider" -> AIProvider.from(packet.optString("text"))?.let { provider = it; prefs.edit().putString("aiProvider", it.id).apply() }
            "codexChirp", "codexNote" -> say(packet.optString("text"), 8000)
            "wake", "sleep" -> {}
        }
    }

    fun say(text: String?, millis: Long = 8000) {
        bubble = text
        val token = ++bubbleToken
        if (text != null) main.postDelayed({ if (bubbleToken == token) bubble = null }, millis)
    }

    private fun setColourLocally(value: BerryColour) {
        colour = value
        prefs.edit().putString("colour", value.id).apply()
    }

    fun chooseColour(value: BerryColour) {
        setColourLocally(value)
        link.send(JSONObject().put("command", "colour").put("text", value.id))
    }

    fun chooseProvider(value: AIProvider) {
        provider = value
        prefs.edit().putString("aiProvider", value.id).apply()
        link.send(JSONObject().put("command", "aiProvider").put("text", value.id))
    }

    fun pair(text: String): Boolean {
        val record = PairingRecord.parse(text) ?: run { message = "That isn't a Bluey pairing code."; return false }
        if (!link.repair(record)) { message = "Couldn't save the pairing on this phone."; return false }
        paired = true
        message = "Paired with ${record.service}. Connecting…"
        return true
    }

    fun command(name: String, task: String? = null, minutes: Double = 30.0, developerMode: Boolean? = null) {
        if (!link.connected) { message = "Connect your paired computer first."; return }
        val args = JSONObject().put("task", task ?: "").put("minutes", minutes)
        developerMode?.let { args.put("developerMode", it) }
        link.request(JSONObject().put("command", name).put("text", args.toString())) { reply ->
            message = reply?.optString("text")?.takeIf { it.isNotEmpty() }
                ?: if (reply == null) "The computer didn't answer. Monitoring pauses if disconnected." else message
        }
    }

    // MARK: Sounds

    /** A short cartoon chirp (two rising notes), synthesised so there's no audio file to ship. */
    private fun chirp() {
        Thread {
            val rate = 44_100
            val notes = listOf(880.0 to 0.07, 1320.0 to 0.09)
            val samples = ShortArray(notes.sumOf { (it.second * rate).toInt() })
            var i = 0
            for ((freq, length) in notes) {
                val n = (length * rate).toInt()
                for (k in 0 until n) {
                    val envelope = sin(PI * k / n)
                    val sweep = freq * (1 + 0.25 * k / n)
                    samples[i++] = (sin(2 * PI * sweep * k / rate) * envelope * 0.35 * Short.MAX_VALUE).toInt().toShort()
                }
            }
            try {
                val track = AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .setBufferSizeInBytes(samples.size * 2)
                    .build()
                track.write(samples, 0, samples.size)
                track.play()
                Thread.sleep(400)
                track.release()
            } catch (_: Exception) {}
        }.start()
    }

    private fun buzz() {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION") context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        try { vibrator.vibrate(VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE)) } catch (_: Exception) {}
    }
}
