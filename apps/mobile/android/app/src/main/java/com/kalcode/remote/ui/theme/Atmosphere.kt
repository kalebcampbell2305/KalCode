package com.kalcode.remote.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.random.Random

/** Space intensity (AGENTS.md design system): quiet for dense/forms, cinematic for Mission Control. */
enum class SpaceLevel(val starAlpha: Float, val starCount: Int, val nebulaAlpha: Float) {
    QUIET(0.45f, 60, 0f),
    STANDARD(0.75f, 110, 0.55f),
    CINEMATIC(1f, 160, 1f),
}

private class Star(val x: Float, val y: Float, val r: Float, val a: Float, val blue: Boolean)

private val STARS: List<Star> = Random(0x4B41_4C43).let { rnd ->
    List(160) {
        val bright = rnd.nextFloat() < 0.08f
        Star(
            x = rnd.nextFloat(),
            y = rnd.nextFloat(),
            r = if (bright) 1.1f + rnd.nextFloat() * 0.5f else 0.45f + rnd.nextFloat() * 0.55f,
            a = if (bright) 0.5f + rnd.nextFloat() * 0.25f else 0.12f + rnd.nextFloat() * 0.28f,
            blue = rnd.nextFloat() < 0.22f,
        )
    }
}

/**
 * A static star field: drawn once per size into the draw cache, never animated. Stars thin out
 * toward the bottom so lists stay calm.
 */
fun Modifier.starField(level: SpaceLevel): Modifier = drawWithCache {
    val density = density
    onDrawBehind {
        val stars = STARS.take(level.starCount)
        for (s in stars) {
            val fade = 1f - s.y * 0.55f
            val color = if (s.blue) Kc.Icy else Kc.Starlight
            drawCircle(
                color = color.copy(alpha = s.a * level.starAlpha * fade),
                radius = s.r * density,
                center = Offset(s.x * size.width, s.y * size.height),
            )
        }
    }
}

/**
 * The restrained blue nebula, painted only in a header band of [height] (never behind dense text
 * or code): a soft Constellation glow up and to the right, a fainter cool counter-glow left.
 */
fun Modifier.nebulaHeader(level: SpaceLevel, height: Dp = 300.dp): Modifier = drawWithCache {
    val h = height.toPx()
    val w = size.width
    val a = level.nebulaAlpha
    val main = Brush.radialGradient(
        colors = listOf(Kc.Constellation.copy(alpha = 0.20f * a), Kc.Constellation.copy(alpha = 0.06f * a), Color.Transparent),
        center = Offset(w * 0.86f, h * 0.05f),
        radius = maxOf(w, h) * 0.75f,
    )
    val counter = Brush.radialGradient(
        colors = listOf(Color(0xFF3A5BD8).copy(alpha = 0.10f * a), Color.Transparent),
        center = Offset(w * 0.08f, h * 0.0f),
        radius = maxOf(w, h) * 0.5f,
    )
    val fadeOut = Brush.verticalGradient(0f to Color.Transparent, 1f to Kc.Graphite, startY = h * 0.55f, endY = h)
    onDrawBehind {
        if (a > 0f) {
            drawRect(main, size = size.copy(height = minOf(h, size.height)))
            drawRect(counter, size = size.copy(height = minOf(h, size.height)))
            drawRect(fadeOut, topLeft = Offset(0f, h * 0.55f), size = size.copy(height = h * 0.45f))
        }
    }
}

/** The app background: graphite, static stars, and (above STANDARD) a header nebula. */
@Composable
fun SpaceBackground(level: SpaceLevel, modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier
            .fillMaxSize()
            .background(Kc.Graphite)
            .nebulaHeader(level)
            .starField(level),
        content = content,
    )
}
