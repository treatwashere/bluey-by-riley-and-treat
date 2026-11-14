package co.visionairy.bluey.android

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import co.visionairy.bluey.core.BerryColour
import co.visionairy.bluey.core.Palette
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sin

fun rgb(hex: Int, alpha: Float = 1f) = Color(
    red = ((hex shr 16) and 0xFF) / 255f, green = ((hex shr 8) and 0xFF) / 255f, blue = (hex and 0xFF) / 255f, alpha = alpha)

fun berryBrush(colour: BerryColour, start: Offset, end: Offset): Brush {
    val stops = Palette.gradientStops.zip(colour.berry).map { (stop, hex) -> stop to rgb(hex) }.toTypedArray()
    return Brush.linearGradient(*stops, start = start, end = end)
}

/**
 * The berry friend, full screen. Eyes follow the computer's mouse (gaze -1…1), he breathes, blinks and
 * changes expression with the mood the computer sends: listening, happy, talking, thinking, pointing, sleepy.
 */
@Composable
fun BerryFace(colour: BerryColour, gazeX: Float, gazeY: Float, mood: String, listening: Boolean, modifier: Modifier = Modifier) {
    val time = remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) { while (true) withFrameMillis { time.longValue = it } }
    val gx by animateFloatAsState(gazeX, spring(dampingRatio = 0.7f, stiffness = 120f), label = "gx")
    val gy by animateFloatAsState(gazeY, spring(dampingRatio = 0.7f, stiffness = 120f), label = "gy")
    val listenScale by animateFloatAsState(if (listening) 1.06f else 1f, label = "listen")

    Canvas(modifier) {
        val t = time.longValue / 1000.0
        val unit = min(size.width / 1.6f, size.height) * 0.86f * listenScale
        val breathe = (sin(t * 2 * PI / 3.6) * 0.012).toFloat()
        val bodySize = Size(unit * 1.45f * (1 + breathe), unit * (1 - breathe))
        val centre = Offset(size.width / 2, size.height / 2 + unit * 0.04f)
        val topLeft = Offset(centre.x - bodySize.width / 2, centre.y - bodySize.height / 2)

        // Body: a soft blob with the colour's gradient and a highlight.
        val blob = blobPath(topLeft, bodySize, t)
        drawPath(blob, berryBrush(colour, topLeft, Offset(topLeft.x + bodySize.width, topLeft.y + bodySize.height)))
        drawPath(blob, Brush.radialGradient(listOf(Color.White.copy(alpha = 0.35f), Color.Transparent),
            center = Offset(topLeft.x + bodySize.width * 0.3f, topLeft.y + bodySize.height * 0.22f), radius = bodySize.height * 0.5f))

        val sleepy = mood == "sleepy"
        val happy = mood == "happy"
        val blink = ((t % 4.7) < 0.12) || sleepy
        val eyeW = unit * 0.25f; val eyeH = unit * 0.3f
        val lookX = if (mood == "thinking") 0.6f else gx
        val lookY = if (mood == "thinking") -0.7f else gy
        for (side in listOf(-1f, 1f)) {
            val eye = Offset(centre.x + side * unit * 0.22f, centre.y - unit * 0.08f)
            if (happy) {
                drawArc(rgb(Palette.INK), 200f, 140f, false, Offset(eye.x - eyeW / 2, eye.y - eyeH / 4), Size(eyeW, eyeH / 1.6f),
                    style = Stroke(width = unit * 0.035f, cap = StrokeCap.Round))
            } else if (blink) {
                drawLine(rgb(Palette.INK), Offset(eye.x - eyeW / 2.4f, eye.y), Offset(eye.x + eyeW / 2.4f, eye.y),
                    strokeWidth = unit * 0.03f, cap = StrokeCap.Round)
            } else {
                drawOval(Color.White, Offset(eye.x - eyeW / 2, eye.y - eyeH / 2), Size(eyeW, eyeH))
                val pupil = Size(eyeW * 0.5f, eyeH * 0.5f)
                val p = Offset(eye.x + lookX * eyeW * 0.22f, eye.y + lookY * eyeH * 0.22f)
                drawOval(rgb(Palette.INK), Offset(p.x - pupil.width / 2, p.y - pupil.height / 2), pupil)
                drawCircle(Color.White.copy(alpha = 0.9f), pupil.width * 0.16f, Offset(p.x - pupil.width * 0.18f, p.y - pupil.height * 0.2f))
            }
        }
        // Cheeks, nose and mouth.
        val blush = if (happy) 0.55f else 0.22f
        for (side in listOf(-1f, 1f)) {
            drawOval(rgb(0xF3A6D8, blush), Offset(centre.x + side * unit * 0.38f - unit * 0.07f, centre.y + unit * 0.06f), Size(unit * 0.14f, unit * 0.08f))
        }
        drawOval(rgb(colour.nose), Offset(centre.x - unit * 0.035f, centre.y + unit * 0.1f), Size(unit * 0.07f, unit * 0.045f))
        val mouthTop = centre.y + unit * 0.17f
        when (mood) {
            "talking" -> {
                val open = (abs(sin(t * 9)) * 0.06 + 0.02).toFloat() * unit
                drawOval(rgb(Palette.INK), Offset(centre.x - unit * 0.05f, mouthTop), Size(unit * 0.1f, open))
            }
            "sleepy" -> drawZs(this, Offset(centre.x + unit * 0.55f, centre.y - unit * 0.45f), unit, t, colour)
            else -> drawArc(rgb(Palette.INK), 20f, 140f, false, Offset(centre.x - unit * 0.07f, mouthTop - unit * 0.04f),
                Size(unit * 0.14f, if (happy) unit * 0.1f else unit * 0.06f), style = Stroke(width = unit * 0.022f, cap = StrokeCap.Round))
        }
    }
}

private fun blobPath(topLeft: Offset, size: Size, t: Double): Path {
    val path = Path()
    val cx = topLeft.x + size.width / 2; val cy = topLeft.y + size.height / 2
    val steps = 72
    for (i in 0..steps) {
        val a = 2 * PI * i / steps
        val wobble = 1 + 0.012 * sin(a * 3 + t * 1.3) + 0.008 * sin(a * 5 - t * 0.9)
        val flatten = if (sin(a) > 0) 0.94 else 1.0 // slightly flatter bottom, like he's sitting
        val x = cx + (size.width / 2 * kotlin.math.cos(a) * wobble).toFloat()
        val y = cy + (size.height / 2 * sin(a) * wobble * flatten).toFloat()
        if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    path.close()
    return path
}

private fun drawZs(scope: DrawScope, at: Offset, unit: Float, t: Double, colour: BerryColour) = with(scope) {
    for (i in 0 until 3) {
        val phase = ((t * 0.5 + i / 3.0) % 1.0).toFloat()
        val s = unit * (0.05f + 0.03f * i)
        val o = Offset(at.x + phase * unit * 0.12f, at.y - phase * unit * 0.25f - i * unit * 0.06f)
        val path = Path().apply {
            moveTo(o.x, o.y); lineTo(o.x + s, o.y); lineTo(o.x, o.y + s); lineTo(o.x + s, o.y + s)
        }
        drawPath(path, rgb(colour.berry[1], 1f - phase), style = Stroke(width = unit * 0.015f, cap = StrokeCap.Round))
    }
}
