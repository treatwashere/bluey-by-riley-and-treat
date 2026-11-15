package co.visionairy.bluey.android

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.sp
import co.visionairy.bluey.core.BerryColour
import co.visionairy.bluey.core.Palette
import kotlin.math.PI
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

fun rgb(hex: Int, alpha: Float = 1f) = Color(
    red = ((hex shr 16) and 0xFF) / 255f, green = ((hex shr 8) and 0xFF) / 255f, blue = (hex and 0xFF) / 255f, alpha = alpha)

fun berryBrush(colour: BerryColour, start: Offset, end: Offset): Brush {
    val stops = Palette.gradientStops.zip(colour.berry).map { (stop, hex) -> stop to rgb(hex) }.toTypedArray()
    return Brush.linearGradient(*stops, start = start, end = end)
}

private fun Random.range(a: Double, b: Double) = a + nextDouble() * (b - a)

/** A tiny damped spring, so every part of the face moves with a little life (same as the iPhone app). */
private class Spring(var value: Double, val stiffness: Double = 200.0, val damping: Double = 0.7) {
    var velocity = 0.0
    fun step(target: Double, dt: Double) {
        val c = 2 * sqrt(stiffness) * damping
        velocity += (stiffness * (target - value) - c * velocity) * dt
        value += velocity * dt
    }
}

/** One frame of the face. Mirrors FaceAnimator.Frame in iOS/Sources/FaceView.swift. */
class FaceFrame(
    val gazeX: Double, val gazeY: Double, val mood: String, val talk: Double, val closed: Double, val breathe: Double,
    val time: Double, val pupil: Double, val browLift: Double, val browTilt: Double, val lean: Double, val hop: Double,
    val blush: Double, val squint: Double,
)

/**
 * Smooths what the computer asks for into lifelike motion: darting eyes, brows, blinks, leaning, hops.
 * A line-by-line port of the original Bluey FaceAnimator.
 */
class FaceAnimator {
    private val random = Random.Default
    private var targetX = 0.0; private var targetY = 0.0; private var targetMood = "listening"; private var targetTalk = 0.0
    private var lastPacket = -100.0
    private val gazeX = Spring(0.0, 260.0, 0.82)
    private val gazeY = Spring(0.0, 260.0, 0.82)
    private val pupil = Spring(1.0, 160.0, 0.5)
    private val browLift = Spring(0.0, 180.0, 0.55)
    private val browTilt = Spring(0.0, 150.0, 0.6)
    private val lean = Spring(0.0, 60.0, 0.8)
    private val hop = Spring(0.0, 260.0, 0.35)
    private val blush = Spring(0.25, 40.0, 1.0)
    private val squint = Spring(0.0, 150.0, 0.7)
    private var talk = 0.0
    private var mood = "listening"
    private var blinkStart = -1.0
    private var doubleBlink = false
    private var nextBlink = 2.0
    private var lastTime: Double? = null
    private var nextSaccade = 0.0
    private var wanderX = 0.0; private var wanderY = -0.3
    private var jitterX = 0.0; private var jitterY = 0.0
    private var nextJitter = 0.0
    private var nextHop = 6.0

    /** Mood set on the phone itself (listening while you hold him). */
    var localMood: String? = null
    var awake = false

    fun receive(gx: Double, gy: Double, mood: String, talk: Double, time: Double) {
        targetX = gx; targetY = gy; targetMood = mood; targetTalk = talk; lastPacket = time
    }

    fun step(now: Double): FaceFrame {
        val dt = min(now - (lastTime ?: now), 1.0 / 20)
        lastTime = now

        val live = now - lastPacket < 2.5
        val wantedMood = localMood ?: if (live) targetMood else "listening"
        if (wantedMood != mood) {
            mood = wantedMood
            blinkStart = now
            if (mood != "sleepy" && mood != "resting") { hop.velocity += 260; pupil.velocity += 3 }
        }

        var wantX: Double; var wantY: Double
        if (live) { wantX = targetX; wantY = targetY } else {
            if (now > nextSaccade) {
                wanderX = random.range(-0.9, 0.9); wanderY = random.range(-0.9, 0.4)
                nextSaccade = now + random.range(0.6, 2.2)
            }
            wantX = wanderX; wantY = wanderY
        }
        if (mood == "thinking") { wantX = 0.6 + 0.08 * sin(now * 1.3); wantY = -0.85 }
        if (now > nextJitter) {
            val amount = if (!awake) 0.015 else if (mood == "talking") 0.07 else if (mood == "thinking") 0.05 else 0.02
            jitterX = random.range(-amount, amount); jitterY = random.range(-amount, amount)
            nextJitter = now + random.range(0.5, 1.4)
        }
        gazeX.step(wantX + jitterX, dt)
        gazeY.step(wantY + jitterY, dt)

        val wantTalk = if (live) targetTalk else 0.0
        talk += (wantTalk - talk) * min(1.0, dt * 25)

        var wantPupil = 1.0; var wantLift = 0.0; var wantTilt = 0.0; var wantBlush = 0.25; var wantSquint = 0.0
        when (mood) {
            "listening" -> { wantPupil = 1.12; wantLift = 10.0 }
            "talking" -> { wantPupil = 1.05; wantLift = 6 + talk * 18; wantTilt = 0.05 * sin(now * 2.3) }
            "pointing" -> { wantPupil = 0.95; wantLift = -4.0; wantTilt = -0.14 }
            "thinking" -> { wantPupil = 0.9; wantLift = 4.0; wantTilt = 0.22 }
            "happy" -> { wantPupil = 1.2; wantLift = 16.0; wantBlush = 0.85; wantSquint = 1.0 }
            "resting" -> { wantPupil = 0.9; wantLift = -8.0; wantBlush = 0.15 }
            "sleepy" -> { wantPupil = 0.88; wantLift = -10.0; wantTilt = 0.12; wantBlush = 0.15 }
        }
        pupil.step(wantPupil, dt); browLift.step(wantLift, dt); browTilt.step(wantTilt, dt)
        blush.step(wantBlush, dt); squint.step(wantSquint, dt)
        lean.step(-gazeX.value * 0.045, dt)

        if (now > nextHop) {
            if (talk < 0.05 && mood != "sleepy" && mood != "resting") hop.velocity += random.range(180.0, 320.0)
            nextHop = now + random.range(7.0, 14.0)
        }
        hop.step(0.0, dt)

        val drowsy = mood == "sleepy"
        if (now > nextBlink) {
            blinkStart = now
            doubleBlink = !drowsy && random.nextDouble() < 0.25
            nextBlink = now + if (drowsy) random.range(1.6, 3.0) else random.range(2.0, 5.0)
        }
        val p = (now - blinkStart) / (if (drowsy) 0.7 else 0.15)
        var closed = if (p in 0.0..1.0) sin(PI * p) else 0.0
        if (doubleBlink && p in 1.3..2.3) closed = sin(PI * (p - 1.3))

        val breathe = sin(now * if (mood == "resting") 1.1 else 1.8)
        return FaceFrame(gazeX.value, gazeY.value, mood, talk, closed, breathe, now, pupil.value, browLift.value,
            browTilt.value, lean.value, hop.value, blush.value, squint.value.coerceIn(0.0, 1.0))
    }
}

/** The blob outline: CSS `border-radius: 52% 48% 46% 54% / 58% 56% 44% 42%`. */
private fun blobPath(r: Rect): Path {
    val w = r.width; val h = r.height
    val tlw = 0.52f * w; val tlh = 0.58f * h
    val trw = 0.48f * w; val trh = 0.56f * h
    val brw = 0.46f * w; val brh = 0.44f * h
    val blw = 0.54f * w; val blh = 0.42f * h
    val k = 0.5523f
    return Path().apply {
        moveTo(r.left + tlw, r.top)
        lineTo(r.right - trw, r.top)
        cubicTo(r.right - trw * (1 - k), r.top, r.right, r.top + trh * (1 - k), r.right, r.top + trh)
        lineTo(r.right, r.bottom - brh)
        cubicTo(r.right, r.bottom - brh * (1 - k), r.right - brw * (1 - k), r.bottom, r.right - brw, r.bottom)
        lineTo(r.left + blw, r.bottom)
        cubicTo(r.left + blw * (1 - k), r.bottom, r.left, r.bottom - blh * (1 - k), r.left, r.bottom - blh)
        lineTo(r.left, r.top + tlh)
        cubicTo(r.left, r.top + tlh * (1 - k), r.left + tlw * (1 - k), r.top, r.left + tlw, r.top)
        close()
    }
}

/** The little crown on top of his head (SVG path from the design, 60×40 box). */
private fun crownPath(r: Rect): Path {
    val pts = listOf(30f to 4f, 36f to 16f, 52f to 12f, 40f to 24f, 46f to 36f, 30f to 28f, 14f to 36f, 20f to 24f, 8f to 12f, 24f to 16f)
    return Path().apply {
        pts.forEachIndexed { i, (x, y) ->
            val px = r.left + x / 60f * r.width; val py = r.top + y / 40f * r.height
            if (i == 0) moveTo(px, py) else lineTo(px, py)
        }
        close()
    }
}

private fun oval(x: Float, y: Float, w: Float, h: Float) = Path().apply { addOval(Rect(x, y, x + w, y + h)) }

/**
 * The landscape face on pure black: he fills the screen and peeks up from the bottom edge.
 * Exactly the original Bluey, in whichever colour you picked.
 */
@Composable
fun BerryFace(colour: BerryColour, animator: FaceAnimator, modifier: Modifier = Modifier) {
    val time = remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) { while (true) withFrameNanos { time.longValue = it } }
    val text = rememberTextMeasurer()
    Canvas(modifier) {
        val frame = animator.step(time.longValue / 1e9)
        drawFace(frame, colour, text)
    }
}

private const val DESIGN_W = 844f
private const val DESIGN_H = 390f

private fun DrawScope.drawFace(f: FaceFrame, colour: BerryColour, text: TextMeasurer) {
    drawRect(Color.Black)
    val scale = max(size.width / DESIGN_W, size.height / DESIGN_H)
    val navy = rgb(colour.nose)
    val ink = rgb(Palette.INK)

    withTransform({
        translate((size.width - DESIGN_W * scale) / 2, size.height - DESIGN_H * scale)
        scale(scale, scale, Offset.Zero)
    }) {
        val bounce = (-f.talk * 16 + f.breathe * 3 - f.hop).toFloat()
        val body = Rect(12f, 44f + bounce, 12f + 820f, 44f + bounce + 700f)
        val pivot = Offset(body.center.x, body.bottom)
        val stretch = (1 + (f.hop / 900).coerceIn(-0.03, 0.03)).toFloat()
        val skin = berryBrush(colour, Offset(body.left + 0.25f * body.width, body.top + 0.067f * body.height),
            Offset(body.left + 0.75f * body.width, body.top + 0.933f * body.height))
        val shine = Brush.radialGradient(listOf(Color.White.copy(alpha = 0.5f), Color.White.copy(alpha = 0f)),
            center = Offset(body.left + 246, body.top + 126), radius = 243f)
        fun DrawScope.fillSkin(path: Path) { drawPath(path, skin); drawPath(path, shine) }

        withTransform({
            rotate((f.lean * 180 / PI).toFloat(), pivot)
            scale(2 - stretch, stretch, pivot)
        }) {
            val blob = blobPath(body)
            drawPath(blob, rgb(colour.berry[2]))
            drawPath(blob, skin)
            clipPath(blob) {
                drawPath(blob, shine)
                drawOval(Color.White.copy(alpha = 0.35f), Offset(body.left + 190, body.top + 40), Size(46f, 22f))
            }
            val lift = f.browLift.toFloat()
            drawPath(crownPath(Rect(body.left + 368, body.top - 20 - lift * 0.3f, body.left + 368 + 84, body.top - 20 - lift * 0.3f + 56)), navy)

            val eyeY = body.top + 157
            val eyes = listOf(Offset(body.left + 280, eyeY), Offset(body.left + 540, eyeY))
            val squash = (1 - f.talk * 0.12).toFloat()

            // Blushy cheeks, rosier when he's happy (soft-edged like the original's blur).
            for ((i, c) in eyes.withIndex()) {
                val side = if (i == 0) -1f else 1f
                val centre = Offset(c.x + side * 62, c.y + 96 + 21)
                val alpha = (0.25 + 0.45 * f.blush).toFloat()
                withTransform({ scale(1f, 42f / 90f, centre) }) {
                    drawCircle(Brush.radialGradient(listOf(rgb(0xF3A6D8, alpha), rgb(0xF3A6D8, alpha * 0.8f), rgb(0xF3A6D8, 0f)),
                        center = centre, radius = 65f), radius = 65f, center = centre)
                }
            }

            for ((i, c) in eyes.withIndex()) {
                val side = if (i == 0) -1f else 1f

                // Little arched eyebrows do a lot of the acting.
                val browY = c.y - 112 - lift.coerceIn(-10f, 18f) * 0.7f
                val tilt = f.browTilt * side * -1 + if (f.mood == "thinking" && i == 1) -0.25 else 0.0
                translate(c.x + side * 6, browY) {
                    rotate((tilt * 180 / PI).toFloat(), Offset.Zero) {
                        val arch = Path().apply { moveTo(-38f, 6f); quadraticBezierTo(0f, -12f, 38f, 6f) }
                        drawPath(arch, navy, style = Stroke(width = 14f, cap = StrokeCap.Round))
                    }
                }

                when {
                    f.mood == "resting" -> {
                        val shut = Path().apply { moveTo(c.x - 62, c.y + 6); quadraticBezierTo(c.x, c.y + 52, c.x + 62, c.y + 6) }
                        drawPath(shut, ink, style = Stroke(width = 18f, cap = StrokeCap.Round))
                    }
                    f.mood == "happy" && f.squint > 0.6 -> {
                        val arc = Path().apply { moveTo(c.x - 60, c.y + 34); quadraticBezierTo(c.x, c.y - 54, c.x + 60, c.y + 34) }
                        drawPath(arc, ink, style = Stroke(width = 24f, cap = StrokeCap.Round))
                    }
                    else -> {
                        val open = (max(0.06, 1 - f.closed) * squash).toFloat()
                        val white = Rect(c.x - 95, c.y - 95 * open, c.x + 95, c.y + 95 * open)
                        val whitePath = Path().apply { addOval(white) }
                        drawPath(whitePath, Color.White)
                        if (open <= 0.2f) continue

                        var gx = f.gazeX; var gy = f.gazeY
                        val len = hypot(gx, gy)
                        if (len > 1) { gx /= len; gy /= len }
                        val reach = 50f
                        val r = (46 * f.pupil).toFloat()
                        var px = c.x + gx.toFloat() * reach - side * 3
                        var py = c.y + gy.toFloat() * reach * open
                        if (f.mood == "sleepy") py = max(py, c.y) + 28
                        clipPath(whitePath) {
                            drawCircle(ink, r, Offset(px, py))
                            // Two catchlights make them shine.
                            drawOval(Color.White, Offset(px - r * 0.58f, py - r * 0.72f), Size(r * 0.56f, r * 0.56f))
                            drawOval(Color.White.copy(alpha = 0.85f), Offset(px + r * 0.28f, py + r * 0.22f), Size(r * 0.24f, r * 0.24f))
                            // Happy cheeks push up from below as he smiles.
                            if (f.squint > 0.02) {
                                fillSkin(oval(c.x - 110, c.y + 95 * open - 70 * f.squint.toFloat(), 220f, 160f))
                            }
                            // Heavy, droopy lids when he's getting sleepy.
                            if (f.mood == "sleepy") {
                                val droop = (0.5 + 0.06 * sin(f.time * 1.3)).toFloat()
                                fillSkin(Path().apply { addRect(Rect(c.x - 100, white.top - 10, c.x + 100, white.top + white.height * droop)) })
                                drawLine(navy.copy(alpha = 0.7f), Offset(c.x - 92, white.top + white.height * droop),
                                    Offset(c.x + 92, white.top + white.height * droop), strokeWidth = 8f, cap = StrokeCap.Round)
                            }
                            // A soft upper lid when he's focused on pointing.
                            if (f.mood == "pointing") {
                                fillSkin(Path().apply { addRect(Rect(c.x - 100, white.top - 20, c.x + 100, white.top + 20)) })
                            }
                        }
                    }
                }
            }

            if (f.mood == "resting") {
                // Little z's floating up while he naps.
                for (i in 0 until 3) {
                    val phase = (f.time * 0.35 + i / 3.0) % 1.0
                    val size = 26 + i * 8
                    val point = Offset(body.left + 660 + phase.toFloat() * 70 + sin(phase * 6).toFloat() * 8,
                        body.top + 90 - phase.toFloat() * 110)
                    val layout = text.measure("z", TextStyle(color = Color.White.copy(alpha = (0.9 * sin(PI * phase)).toFloat()),
                        fontSize = (size / density / fontScale).sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.SansSerif))
                    drawText(layout, topLeft = Offset(point.x - layout.size.width / 2f, point.y - layout.size.height / 2f))
                }
            }

            if (f.mood == "thinking") {
                for (i in 0 until 3) {
                    val wobble = (sin(f.time * 3 + i) * 4).toFloat()
                    drawOval(Color.White.copy(alpha = 1f - i * 0.3f), Offset(body.left + 690 + i * 26, body.top + 40 - i * 12 + wobble), Size(16f, 16f))
                }
            }

            // His little mouth-nose: opens as he talks, curls into a smile when he's happy.
            val noseW = (60 - f.talk * 8).toFloat()
            val noseH = (38 + f.talk * 34).toFloat()
            val nose = Rect(body.left + 410 - noseW / 2, body.top + 272 - f.talk.toFloat() * 6, body.left + 410 + noseW / 2,
                body.top + 272 - f.talk.toFloat() * 6 + noseH)
            if (f.mood == "happy" && f.talk < 0.1) {
                val smile = Path().apply {
                    moveTo(nose.left - 8, nose.top + 8)
                    quadraticBezierTo(nose.center.x, nose.top + 58, nose.right + 8, nose.top + 8)
                    close()
                }
                drawPath(smile, navy)
            } else {
                drawOval(navy, nose.topLeft, nose.size)
                if (f.talk > 0.25) {
                    drawOval(rgb(0xE58BC4, 0.9f), Offset(nose.center.x - noseW * 0.28f, nose.bottom - noseH * 0.38f), Size(noseW * 0.56f, noseH * 0.3f))
                }
            }
        }
    }
}
