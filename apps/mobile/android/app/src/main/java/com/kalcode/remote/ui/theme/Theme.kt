package com.kalcode.remote.ui.theme

import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.kalcode.remote.R
import kotlinx.coroutines.delay

/**
 * KalCode brand tokens (packages/ui/src/styles/tokens.css), dark theme only. Every colour in the
 * app comes from here; no one-off colours in screens.
 */
object Kc {
    // Surfaces
    val Graphite = Color(0xFF08090C)
    val Sunken = Color(0xFF050608)
    val Surface1 = Color(0xFF0C0E12)
    val Surface2 = Color(0xFF111318)
    val Surface3 = Color(0xFF16191F)
    val Hull = Color(0xFF0F1115)
    val Raised = Color(0xFF14171C)
    val Overlay = Color(0xFF181B21)
    val Hover = Color(0x0FC8D2EB)
    val Pressed = Color(0x1AC8D2EB)

    // Hairlines
    val Border = Color(0x1CB4C3E1)
    val BorderStrong = Color(0x33B4C3E1)
    val BorderSubtle = Color(0x12B4C3E1)
    val BorderLit = Color(0x8C5C96FF)
    val BorderLitSoft = Color(0x425C96FF)

    // Text
    val Starlight = Color(0xFFEEF1F6)
    val TextSecondary = Color(0xFFB4BCCB)
    val Nebula = Color(0xFF959EAE)
    val TextFaint = Color(0xFF8A93A3)

    // Accent: Constellation
    val Constellation = Color(0xFF4C8DFF)
    val AccentHover = Color(0xFF6AA1FF)
    val AccentPressed = Color(0xFF3A78EA)
    val AccentFg = Color(0xFF03060D)
    val AccentSoft = Color(0x244C8DFF)
    val AccentText = Color(0xFF8DB6FF)
    val Icy = Color(0xFFA9C8FF)

    // Status tones
    val Working = Color(0xFF3CCF8E)
    val WorkingSoft = Color(0x1F3CCF8E)
    val WorkingText = Color(0xFF62DCA4)
    val WorkingLine = Color(0x663CCF8E)
    val Waiting = Color(0xFFF2B544)
    val WaitingSoft = Color(0x1FF2B544)
    val WaitingText = Color(0xFFF6C566)
    val WaitingLine = Color(0x66F2B544)
    val Muted = Color(0xFF8A93A3)
    val MutedSoft = Color(0x1F8A93A3)
    val MutedText = Color(0xFFB4BCCB)
    val MutedLine = Color(0x478A93A3)
    val Done = Color(0xFFEEF3FB)
    val DoneSoft = Color(0x14EEF3FB)
    val DoneText = Color(0xFFF3F6FB)
    val DoneLine = Color(0x4DEEF3FB)
    val Failed = Color(0xFFEF5F6B)
    val FailedSoft = Color(0x21EF5F6B)
    val FailedText = Color(0xFFFF8A93)
    val FailedLine = Color(0x6BEF5F6B)
    val Recovering = Color(0xFF5F9BFF)
    val RecoveringSoft = Color(0x215F9BFF)
    val RecoveringText = Color(0xFF8DB6FF)
    val RecoveringLine = Color(0x6B5F9BFF)

    // Diff
    val DiffAddBg = Color(0x1A3CCF8E)
    val DiffDelBg = Color(0x1CEF5F6B)
    val DiffHunkBg = Color(0x144C8DFF)
}

/** A status tone: dot/line colour, soft fill, and readable text. */
@Immutable
data class Tone(val color: Color, val soft: Color, val text: Color, val line: Color) {
    companion object {
        val Working = Tone(Kc.Working, Kc.WorkingSoft, Kc.WorkingText, Kc.WorkingLine)
        val Waiting = Tone(Kc.Waiting, Kc.WaitingSoft, Kc.WaitingText, Kc.WaitingLine)
        val Muted = Tone(Kc.Muted, Kc.MutedSoft, Kc.MutedText, Kc.MutedLine)
        val Done = Tone(Kc.Done, Kc.DoneSoft, Kc.DoneText, Kc.DoneLine)
        val Failed = Tone(Kc.Failed, Kc.FailedSoft, Kc.FailedText, Kc.FailedLine)
        val Active = Tone(Kc.Recovering, Kc.RecoveringSoft, Kc.RecoveringText, Kc.RecoveringLine)
        val Accent = Tone(Kc.Constellation, Kc.AccentSoft, Kc.AccentText, Kc.BorderLit)
    }
}

val Lexend = FontFamily(
    Font(R.font.lexend_deca_300, FontWeight.Light),
    Font(R.font.lexend_deca_400, FontWeight.Normal),
    Font(R.font.lexend_deca_500, FontWeight.Medium),
    Font(R.font.lexend_deca_600, FontWeight.SemiBold),
    Font(R.font.lexend_deca_700, FontWeight.Bold),
)

val JetBrainsMono = FontFamily(
    Font(R.font.jetbrains_mono_400, FontWeight.Normal),
    Font(R.font.jetbrains_mono_500, FontWeight.Medium),
    Font(R.font.jetbrains_mono_700, FontWeight.Bold),
)

private fun lexend(size: Int, weight: FontWeight, tracking: Double = 0.0, line: Double = 1.35) = TextStyle(
    fontFamily = Lexend,
    fontWeight = weight,
    fontSize = size.sp,
    letterSpacing = tracking.em,
    lineHeight = (size * line).sp,
)

val KcTypography = Typography(
    displaySmall = lexend(30, FontWeight.SemiBold, -0.03, 1.15),
    headlineMedium = lexend(26, FontWeight.SemiBold, -0.025, 1.18),
    headlineSmall = lexend(22, FontWeight.SemiBold, -0.02, 1.22),
    titleLarge = lexend(19, FontWeight.SemiBold, -0.015, 1.25),
    titleMedium = lexend(16, FontWeight.SemiBold, -0.005, 1.3),
    titleSmall = lexend(14, FontWeight.Medium, 0.0, 1.35),
    bodyLarge = lexend(16, FontWeight.Normal, 0.0, 1.5),
    bodyMedium = lexend(14, FontWeight.Normal, 0.0, 1.5),
    bodySmall = lexend(12, FontWeight.Normal, 0.0, 1.45),
    labelLarge = lexend(14, FontWeight.Medium, 0.005, 1.3),
    labelMedium = lexend(12, FontWeight.Medium, 0.01, 1.3),
    labelSmall = lexend(11, FontWeight.Medium, 0.08, 1.3),
)

/** Code shows the literal characters: no `!==` → ≢ or `=>` → ⇒ ligatures. */
private const val NO_LIGATURES = "liga 0, calt 0"

object KcText {
    val Mono = TextStyle(fontFamily = JetBrainsMono, fontFeatureSettings = NO_LIGATURES, fontWeight = FontWeight.Normal, fontSize = 12.5.sp, lineHeight = 18.sp)
    val MonoSmall = TextStyle(fontFamily = JetBrainsMono, fontFeatureSettings = NO_LIGATURES, fontWeight = FontWeight.Normal, fontSize = 11.5.sp, lineHeight = 16.sp)
    val MonoCode = TextStyle(fontFamily = JetBrainsMono, fontFeatureSettings = NO_LIGATURES, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 19.sp)
    val Eyebrow = TextStyle(
        fontFamily = Lexend, fontWeight = FontWeight.Medium, fontSize = 11.sp,
        letterSpacing = 0.12.em, lineHeight = 14.sp,
    )
}

private val KcColors = darkColorScheme(
    primary = Kc.Constellation,
    onPrimary = Kc.AccentFg,
    primaryContainer = Kc.AccentSoft,
    onPrimaryContainer = Kc.AccentText,
    secondary = Kc.Icy,
    onSecondary = Kc.AccentFg,
    secondaryContainer = Kc.Surface3,
    onSecondaryContainer = Kc.Starlight,
    tertiary = Kc.Working,
    background = Kc.Graphite,
    onBackground = Kc.Starlight,
    surface = Kc.Graphite,
    onSurface = Kc.Starlight,
    surfaceVariant = Kc.Surface2,
    onSurfaceVariant = Kc.TextSecondary,
    surfaceContainerLowest = Kc.Sunken,
    surfaceContainerLow = Kc.Surface1,
    surfaceContainer = Kc.Surface2,
    surfaceContainerHigh = Kc.Surface3,
    surfaceContainerHighest = Kc.Overlay,
    surfaceBright = Kc.Overlay,
    surfaceDim = Kc.Sunken,
    inverseSurface = Kc.Starlight,
    inverseOnSurface = Kc.Graphite,
    outline = Kc.BorderStrong,
    outlineVariant = Kc.Border,
    error = Kc.Failed,
    onError = Kc.AccentFg,
    errorContainer = Kc.FailedSoft,
    onErrorContainer = Kc.FailedText,
    scrim = Color(0xB3000000),
)

/** Motion roles: 160–260 ms, the emphasized curve; snapped when the person reduced motion. */
object KcMotion {
    val Emphasized = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val Standard = CubicBezierEasing(0.2f, 0f, 0.1f, 1f)
    const val FAST = 160
    const val BASE = 220
    const val SLOW = 260
    fun <T> spec(reduced: Boolean, millis: Int = BASE): FiniteAnimationSpec<T> =
        if (reduced) snap() else tween(millis, easing = Emphasized)
}

/** True when the system "Remove animations" setting (or a zero animator scale) is on. */
val LocalReducedMotion = staticCompositionLocalOf { false }

/** A one-second wall clock for live elapsed times. Leaves read `.value` so only they recompose. */
val LocalNow = staticCompositionLocalOf<State<Long>> { error("LocalNow not provided") }

@Composable
fun KalCodeTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val reduced = remember(context) {
        val scale = runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        }.getOrDefault(1f)
        scale == 0f
    }
    val now = produceState(System.currentTimeMillis()) {
        while (true) {
            value = System.currentTimeMillis()
            delay(1000 - value % 1000)
        }
    }
    CompositionLocalProvider(LocalReducedMotion provides reduced, LocalNow provides now) {
        MaterialTheme(colorScheme = KcColors, typography = KcTypography, content = content)
    }
}

/** For previews/tests that need a fixed clock. */
@Composable
fun rememberFixedNow(at: Long): State<Long> = remember { mutableLongStateOf(at) }
