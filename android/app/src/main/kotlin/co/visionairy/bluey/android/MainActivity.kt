package co.visionairy.bluey.android

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import co.visionairy.bluey.core.AIProvider
import co.visionairy.bluey.core.FocusJson
import co.visionairy.bluey.core.FocusSession
import co.visionairy.bluey.core.Palette
import co.visionairy.bluey.core.TaskParser
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : ComponentActivity() {
    private lateinit var model: BlueyModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = BlueyModel(applicationContext)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = rgb(model.colour.berry[1]), secondary = rgb(model.colour.berry[2]))) {
                BlueyScreen(model)
            }
        }
    }

    override fun onStart() { super.onStart(); model.start() }
    // Like the iPhone app: leaving Bluey pauses focus and disconnects. Resuming is always manual.
    override fun onStop() { model.stop(); super.onStop() }
}

/** Hold-to-talk with Android's own speech recogniser (no audio leaves the phone for Bluey's servers). */
class Listener(context: Context, private val onText: (String) -> Unit, private val onState: (Boolean) -> Unit) {
    private val recognizer = if (SpeechRecognizer.isRecognitionAvailable(context)) SpeechRecognizer.createSpeechRecognizer(context) else null
    val available get() = recognizer != null
    private var heard = ""

    init {
        recognizer?.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { onState(true) }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) { onState(false); if (heard.isNotBlank()) onText(heard); heard = "" }
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: heard
                onState(false); heard = ""
                if (text.isNotBlank()) onText(text)
            }
            override fun onPartialResults(partialResults: Bundle?) {
                partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { heard = it }
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
    }

    fun start() {
        heard = ""
        recognizer?.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true))
    }
    fun stop() { recognizer?.stopListening() }
    fun destroy() { recognizer?.destroy() }
}

private val Soft = rgb(Palette.INK_SOFT)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BlueyScreen(model: BlueyModel) {
    val context = LocalContext.current
    var showSheet by remember { mutableStateOf(!model.paired) }
    var listening by remember { mutableStateOf(false) }
    val listener = remember {
        Listener(context, onText = { spoken -> handleSpeech(model, spoken) }, onState = { listening = it })
    }
    DisposableEffect(Unit) { onDispose { listener.destroy() } }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) model.message = "Allow the microphone to tell Bluey your task, or type it in the sheet."
    }
    val session = model.focus?.current?.takeIf { it.isActive }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        BerryFace(
            colour = model.colour, gazeX = model.gazeX, gazeY = model.gazeY,
            mood = if (listening) "listening" else if (!model.connected) "sleepy" else model.mood,
            listening = listening,
            modifier = Modifier.fillMaxSize()
                .semantics { contentDescription = "${model.colour.name}. Hold to say what you're working on." }
                .pointerInput(Unit) {
                    detectTapGestures(
                        onPress = {
                            val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                            if (!granted) { micPermission.launch(Manifest.permission.RECORD_AUDIO); return@detectTapGestures }
                            if (!listener.available) { model.message = "Speech recognition isn't available on this phone. Type the task instead."; return@detectTapGestures }
                            listener.start()
                            tryAwaitRelease()
                            listener.stop()
                        },
                        onDoubleTap = { showSheet = true },
                    )
                },
        )

        // Listening border, like the iPhone app.
        if (listening) Box(Modifier.fillMaxSize().border(10.dp, rgb(model.colour.berry[1]), RoundedCornerShape(32.dp)))

        // Task and status, top left.
        Column(Modifier.align(Alignment.TopStart).padding(start = 28.dp, top = 20.dp).widthIn(max = 420.dp)) {
            Text(session?.task ?: if (model.connected) "Hold ${model.colour.name} and say your task" else statusLine(model),
                color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Text(resultLine(model, session), color = Soft, fontSize = 13.sp)
        }

        // Speech bubble for nudges and replies.
        model.bubble?.let { text ->
            Text(text, color = rgb(Palette.INK), fontSize = 17.sp, textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 64.dp).widthIn(max = 460.dp)
                    .background(Color.White, RoundedCornerShape(20.dp))
                    .border(2.5.dp, rgb(model.colour.berry[1]), RoundedCornerShape(20.dp))
                    .padding(horizontal = 18.dp, vertical = 12.dp))
        }

        // Countdown, bottom right.
        session?.let {
            Column(Modifier.align(Alignment.BottomEnd).padding(end = 28.dp, bottom = 12.dp), horizontalAlignment = Alignment.End) {
                if (it.developerMode) Text("DEVELOPER MODE · 4×", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Text((if (it.status == "paused") "Ⅱ " else "") + FocusJson.clock(it.remaining),
                    color = Color.White, fontSize = 64.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        // Small controls, bottom left.
        Row(Modifier.align(Alignment.BottomStart).padding(start = 20.dp, bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (session != null) {
                RoundIcon(if (session.status == "running") "Ⅱ" else "▶", if (session.status == "running") "Pause focus" else "Resume focus") {
                    model.command(if (session.status == "running") "focusPause" else "focusResume")
                }
                RoundIcon("■", "End focus") { model.command("focusEnd") }
            }
            RoundIcon("☰", "Focus and settings") { showSheet = true }
            Box(Modifier.size(10.dp).align(Alignment.CenterVertically).clip(CircleShape)
                .background(if (model.connected && model.fresh) Color(0xFF5BE49B) else Soft.copy(alpha = 0.4f)))
        }
    }

    if (showSheet) {
        ModalBottomSheet(onDismissRequest = { showSheet = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = Color(0xFF15131C)) {
            FocusSheet(model) { showSheet = false }
        }
    }
}

private fun statusLine(model: BlueyModel) = when {
    !model.paired -> "Pair your Mac or PC to focus together"
    else -> "Looking for ${model.computerName ?: "your computer"} on this Wi‑Fi…"
}

private fun resultLine(model: BlueyModel, session: FocusSession?): String {
    if (session == null) return if (model.connected) "Connected to ${model.computerName ?: "your computer"}" else model.message
    if (!model.fresh) return "Connection lost · monitoring will pause"
    if (session.status == "paused") return "Paused"
    val check = session.lastResult ?: return "Focusing together"
    val by = if (check.providers.size > 1) " · ${check.providers.size} AIs agreed" else ""
    return when (check.activity) {
        "off_task" -> "Off task · ${(check.probability * 100).toInt()}% estimate${if (check.nudged) " · nudged" else ""}$by"
        "on_task" -> "On task$by"
        "uncertain" -> "Not sure yet · checking again"
        else -> "Last check unavailable · trying again"
    }
}

/** Voice: "pause", "resume", "stop" control the session; anything else becomes the task. */
private fun handleSpeech(model: BlueyModel, spoken: String) {
    val text = spoken.lowercase().trim()
    val session = model.focus?.current?.takeIf { it.isActive }
    when {
        session != null && Regex("""\b(pause|take a break)\b""").containsMatchIn(text) -> model.command("focusPause")
        session != null && Regex("""\b(resume|carry on|continue|keep going)\b""").containsMatchIn(text) -> model.command("focusResume")
        session != null && Regex("""\b(stop|end|finish|done)\b""").containsMatchIn(text) -> model.command("focusEnd")
        session != null -> model.say("End this session first, then tell me the next task.", 5000)
        else -> TaskParser.parse(spoken)?.let {
            model.say("${it.task} · ${it.minutes.toInt()} minutes. Let's go!", 5000)
            model.command("focusStart", task = it.task, minutes = it.minutes)
        } ?: model.say("Didn't catch that. Hold me and say what you're working on.", 5000)
    }
}

@Composable
private fun RoundIcon(symbol: String, label: String, onClick: () -> Unit) {
    Box(Modifier.size(40.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.08f)).clickable(onClick = onClick)
        .semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Text(symbol, color = Color.White.copy(alpha = 0.75f), fontSize = 16.sp)
    }
}

@Composable
private fun FocusSheet(model: BlueyModel, close: () -> Unit) {
    val context = LocalContext.current
    var task by remember { mutableStateOf("") }
    var minutes by remember { mutableStateOf(30f) }
    var code by remember { mutableStateOf("") }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { if (model.pair(it)) close() }
    }
    val session = model.focus?.current
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("${model.colour.name} · focus friend", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)

        // Pairing
        Text(if (model.connected) "Connected to ${model.computerName}" else if (model.paired) "Paired · looking for your computer" else "Not paired yet",
            color = Soft, fontSize = 13.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt("Scan the pairing code shown by Bluey on your Mac or PC").setBeepEnabled(false).setOrientationLocked(false))
            }) { Text(if (model.paired) "Pair again (scan)" else "Pair (scan QR)") }
            OutlinedButton(onClick = {
                val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
                code = clip?.getItemAt(0)?.coerceToText(context)?.toString() ?: ""
            }) { Text("Paste code") }
        }
        if (code.isNotEmpty()) {
            OutlinedTextField(code, { code = it }, label = { Text("Pairing code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Button(onClick = { if (model.pair(code)) { code = ""; close() } }) { Text("Pair with this code") }
        }

        HorizontalDivider(color = Color.White.copy(alpha = 0.1f))
        Text("Colour", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            for (c in Palette.all) {
                Column(horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.clickable { model.chooseColour(c) }.semantics { contentDescription = c.name }) {
                    Canvas(Modifier.size(width = 44.dp, height = 38.dp)) {
                        drawOval(berryBrush(c, Offset.Zero, Offset(size.width, size.height)))
                        if (c == model.colour) drawOval(Color.White, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3.dp.toPx()))
                        for (x in listOf(0.36f, 0.64f)) {
                            drawOval(Color.White, Offset(size.width * x - 5.dp.toPx(), size.height * 0.3f), Size(10.dp.toPx(), 11.dp.toPx()))
                            drawOval(rgb(Palette.INK), Offset(size.width * x - 2.5.dp.toPx(), size.height * 0.36f), Size(5.dp.toPx(), 6.dp.toPx()))
                        }
                    }
                    Text(c.name, color = Color.White, fontSize = 11.sp)
                }
            }
        }

        Text("AI brain", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Text("Which AI checks your screen. “All 4 combined” averages every AI that has a key on the computer.", color = Soft, fontSize = 12.sp)
        for (p in AIProvider.entries) {
            Row(Modifier.fillMaxWidth().clickable(enabled = model.connected) { model.chooseProvider(p) }, verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = model.provider == p, onClick = { model.chooseProvider(p) }, enabled = model.connected)
                Text(p.title, color = Color.White)
            }
        }
        Text("Keys stay on the computer: Bluey's menu on Mac, or Settings on Windows.", color = Soft, fontSize = 12.sp)

        HorizontalDivider(color = Color.White.copy(alpha = 0.1f))
        Text("Focus", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Developer Mode (4× clock, checks every 10 s)", color = Color.White, modifier = Modifier.weight(1f))
            Switch(checked = model.focus?.developerMode == true, enabled = model.connected && model.fresh,
                onCheckedChange = { model.command("focusDeveloperMode", developerMode = it) })
        }
        if (model.focus?.developerMode == true) TextButton(onClick = { model.command("focusTestNudge") }) { Text("Test a nudge") }
        if (session != null && session.isActive) {
            SessionSummary(session, model)
            Text(if (model.fresh) session.detail else "Connection lost. Reconnect before resuming.", color = Soft, fontSize = 13.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { model.command(if (session.status == "running") "focusPause" else "focusResume") }) {
                    Text(if (session.status == "running") "Pause" else "Resume")
                }
                OutlinedButton(onClick = { model.command("focusEnd") }) { Text("End focus") }
            }
        } else {
            Text("Hold ${model.colour.name} and say what you're working on, or type it here.", color = Soft, fontSize = 13.sp)
            OutlinedTextField(task, { task = it }, label = { Text("What are we working on?") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Text("${minutes.toInt()} minutes", color = Color.White)
            Slider(value = minutes, onValueChange = { minutes = ((it / 5f).toInt() * 5).toFloat().coerceIn(5f, 240f) }, valueRange = 5f..240f)
            Button(onClick = { model.command("focusStart", task = task.trim(), minutes = minutes.toDouble().coerceAtLeast(1.0)) },
                enabled = task.isNotBlank() && model.connected,
                colors = ButtonDefaults.buttonColors(containerColor = rgb(model.colour.berry[2]))) { Text("Start focus") }
        }
        if (model.message.isNotEmpty()) Text(model.message, color = Soft, fontSize = 13.sp)
        Text("While focusing, your computer sends its main screen, the task, time and recent results to the AI you picked every 30 seconds (10 in Developer Mode). Screenshots aren't saved. Leaving this app, locking or disconnecting pauses everything; resuming is always manual.",
            color = Soft, fontSize = 12.sp)

        HorizontalDivider(color = Color.White.copy(alpha = 0.1f))
        Text("Your focus sessions", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        val history = model.focus?.history.orEmpty()
        if (history.isEmpty()) Text("Your first timeline will appear here when you finish.", color = Soft, fontSize = 13.sp)
        for (h in history.take(10)) SessionSummary(h, model)
        Spacer(Modifier.height(24.dp))
    }
}

/** Task, time and a timeline: green on task, peach off task, grey unknown. */
@Composable
private fun SessionSummary(session: FocusSession, model: BlueyModel) {
    Column(Modifier.fillMaxWidth().background(Color.White.copy(alpha = 0.05f), RoundedCornerShape(12.dp)).padding(14.dp)) {
        Text(session.task, color = Color.White, fontWeight = FontWeight.SemiBold)
        val share = session.onTaskShare?.let { " · ${(it * 100).toInt()}% on task" } ?: ""
        Text("${FocusJson.clock(session.elapsed)} focused$share", color = Soft, fontSize = 12.sp)
        Spacer(Modifier.height(6.dp))
        val checks = session.checks.filter { it.activity != "paused" }
        Canvas(Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(4.dp)).background(Color(0xFF2A2638))) {
            if (checks.isEmpty()) return@Canvas
            val w = size.width / checks.size
            checks.forEachIndexed { i, c ->
                val colour = when (c.activity) { "on_task" -> Color(0xFF5BE49B); "off_task" -> Color(0xFFEBAC73); else -> Color(0xFF555068) }
                drawRect(colour, Offset(i * w, 0f), Size(w + 0.5f, size.height))
            }
        }
    }
}
