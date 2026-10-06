package com.kalcode.remote.ui.components

import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.protocol.Agent
import com.kalcode.remote.protocol.AgentState
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.KcText
import com.kalcode.remote.ui.theme.LocalNow
import com.kalcode.remote.ui.theme.LocalReducedMotion
import com.kalcode.remote.ui.theme.Tone

val CardShape = RoundedCornerShape(16.dp)
val ControlShape = RoundedCornerShape(12.dp)
val ChipShape = RoundedCornerShape(999.dp)

// ---- state presentation ---------------------------------------------------------------------

@Immutable
data class StatePresentation(val label: String, val tone: Tone, val live: Boolean)

fun AgentState.presentation(): StatePresentation = when (this) {
    AgentState.STARTING -> StatePresentation("Starting", Tone.Active, true)
    AgentState.READY -> StatePresentation("Ready", Tone.Muted, false)
    AgentState.WORKING -> StatePresentation("Working", Tone.Working, true)
    AgentState.TESTING -> StatePresentation("Testing", Tone.Working, true)
    AgentState.WAITING -> StatePresentation("Waiting", Tone.Waiting, false)
    AgentState.NEEDS_YOU -> StatePresentation("Needs you", Tone.Waiting, false)
    AgentState.IDLE -> StatePresentation("Idle", Tone.Muted, false)
    AgentState.DONE -> StatePresentation("Done", Tone.Done, false)
    AgentState.FAILED -> StatePresentation("Failed", Tone.Failed, false)
    AgentState.STOPPED -> StatePresentation("Stopped", Tone.Muted, false)
    AgentState.UNKNOWN -> StatePresentation("Unknown", Tone.Muted, false)
}

/** Tone for free-form run/service/deployment statuses. */
fun statusTone(status: String?): Tone = when (status?.lowercase()) {
    "running", "deploying", "building", "in_progress", "starting", "testing" -> Tone.Working
    "succeeded", "success", "passed", "deployed", "healthy", "done", "approved" -> Tone.Done
    "failed", "error", "unhealthy", "crashed", "denied" -> Tone.Failed
    "waiting", "queued", "pending", "degraded", "paused" -> Tone.Waiting
    else -> Tone.Muted
}

fun humanize(raw: String?): String =
    raw.orEmpty().replace('_', ' ').replaceFirstChar { it.uppercase() }

// ---- time -----------------------------------------------------------------------------------

fun formatDuration(millis: Long): String {
    val s = (millis / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "%dm %02ds".format(s / 60, s % 60)
        s < 86_400 -> "%dh %02dm".format(s / 3600, (s % 3600) / 60)
        else -> "%dd %dh".format(s / 86_400, (s % 86_400) / 3600)
    }
}

fun formatAgo(at: Long?, now: Long): String {
    if (at == null) return "—"
    val s = ((now - at) / 1000).coerceAtLeast(0)
    return when {
        s < 5 -> "just now"
        s < 60 -> "${s}s ago"
        s < 3600 -> "${s / 60}m ago"
        s < 86_400 -> "${s / 3600}h ago"
        else -> "${s / 86_400}d ago"
    }
}

/** Live while the agent is running; frozen at its last activity once it stopped. */
fun elapsedMillis(agent: Agent, now: Long): Long? {
    val start = agent.createdAt ?: return null
    val live = agent.state.isActive || agent.state == AgentState.NEEDS_YOU || agent.state == AgentState.WAITING
    val end = if (live) now else (agent.lastActivityAt ?: now)
    return (end - start).coerceAtLeast(0)
}

@Composable
fun ElapsedText(agent: Agent, modifier: Modifier = Modifier, color: Color = Kc.Nebula) {
    val now by LocalNow.current
    val elapsed = elapsedMillis(agent, now) ?: return
    Text(formatDuration(elapsed), style = KcText.Mono, color = color, modifier = modifier, maxLines = 1)
}

@Composable
fun AgoText(at: Long?, modifier: Modifier = Modifier, prefix: String = "", color: Color = Kc.TextFaint) {
    val now by LocalNow.current
    Text(prefix + formatAgo(at, now), style = MaterialTheme.typography.bodySmall, color = color, modifier = modifier, maxLines = 1)
}

// ---- haptics --------------------------------------------------------------------------------

class Haptics(private val view: View) {
    fun confirm() = view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
    fun reject() = view.performHapticFeedback(HapticFeedbackConstants.REJECT)
    fun tick() = view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    fun press() = view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
}

@Composable
fun rememberHaptics(): Haptics {
    val view = LocalView.current
    return remember(view) { Haptics(view) }
}

// ---- surfaces -------------------------------------------------------------------------------

/** Graphite card: hairline border, a faint top sheen, optional lit edge in a status tone. */
@Composable
fun KcCard(
    modifier: Modifier = Modifier,
    lit: Color? = null,
    onClick: (() -> Unit)? = null,
    onClickLabel: String? = null,
    padding: PaddingValues = PaddingValues(16.dp),
    shape: Shape = CardShape,
    background: Color = Kc.Surface2,
    content: @Composable ColumnScope.() -> Unit,
) {
    val border = lit ?: Kc.Border
    Column(
        modifier
            .clip(shape)
            .background(background)
            .drawWithCache {
                val sheen = Brush.verticalGradient(
                    0f to Color.White.copy(alpha = 0.045f),
                    1f to Color.Transparent,
                    endY = 56.dp.toPx(),
                )
                val litGlow = lit?.let {
                    Brush.verticalGradient(0f to it.copy(alpha = 0.10f), 1f to Color.Transparent, endY = 72.dp.toPx())
                }
                onDrawBehind {
                    drawRect(sheen)
                    if (litGlow != null) drawRect(litGlow)
                }
            }
            .border(BorderStroke(1.dp, border), shape)
            .then(if (onClick != null) Modifier.clickable(onClickLabel = onClickLabel, role = Role.Button, onClick = onClick) else Modifier)
            .padding(padding),
        content = content,
    )
}

@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier, color: Color = Kc.Nebula) {
    Text(text.uppercase(), style = KcText.Eyebrow, color = color, modifier = modifier)
}

@Composable
fun SectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    count: Int? = null,
    color: Color = Kc.TextSecondary,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Eyebrow(title, color = color)
        if (count != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                "$count",
                style = KcText.MonoSmall,
                color = color,
                modifier = Modifier.background(color.copy(alpha = 0.14f), ChipShape).padding(horizontal = 7.dp, vertical = 1.dp),
            )
        }
        Spacer(Modifier.weight(1f))
        trailing?.invoke(this)
    }
}

@Composable
fun StatusDot(tone: Tone, modifier: Modifier = Modifier, live: Boolean = false, size: Dp = 8.dp) {
    val reduced = LocalReducedMotion.current
    val alpha = if (live && !reduced) {
        val t = rememberInfiniteTransition(label = "live")
        val a by t.animateFloat(1f, 0.35f, infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "pulse")
        a
    } else {
        1f
    }
    Box(modifier.size(size).graphicsLayer { this.alpha = alpha }.background(tone.color, CircleShape))
}

/** A status pill: dot + label in the tone's soft fill. */
@Composable
fun StatusPill(label: String, tone: Tone, modifier: Modifier = Modifier, live: Boolean = false) {
    Row(
        modifier
            .clip(ChipShape)
            .background(tone.soft)
            .border(1.dp, tone.line, ChipShape)
            .padding(horizontal = 10.dp, vertical = 4.dp)
            .semantics(mergeDescendants = true) { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(tone, live = live, size = 7.dp)
        Spacer(Modifier.width(6.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = tone.text, maxLines = 1)
    }
}

@Composable
fun StateChip(state: AgentState, modifier: Modifier = Modifier) {
    val p = state.presentation()
    StatusPill(p.label, p.tone, modifier, live = p.live)
}

fun ConnectionStatus.label(): String = when (this) {
    ConnectionStatus.Online -> "Online"
    ConnectionStatus.Connecting -> "Connecting"
    is ConnectionStatus.Reconnecting -> "Reconnecting"
    is ConnectionStatus.Offline -> "Offline"
    is ConnectionStatus.Removed -> "Removed"
    ConnectionStatus.Unpaired -> "Not paired"
}

fun ConnectionStatus.tone(): Tone = when (this) {
    ConnectionStatus.Online -> Tone.Working
    ConnectionStatus.Connecting, is ConnectionStatus.Reconnecting -> Tone.Waiting
    is ConnectionStatus.Offline, ConnectionStatus.Unpaired -> Tone.Muted
    is ConnectionStatus.Removed -> Tone.Failed
}

@Composable
fun ConnectionPill(status: ConnectionStatus, modifier: Modifier = Modifier) {
    StatusPill(
        status.label(),
        status.tone(),
        modifier.semantics { contentDescription = "Workstation ${status.label()}" },
        live = status is ConnectionStatus.Reconnecting || status == ConnectionStatus.Connecting,
    )
}

/** Monospaced inline token: branch, model, path. */
@Composable
fun MonoChip(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null, color: Color = Kc.TextSecondary) {
    Row(
        modifier
            .clip(RoundedCornerShape(8.dp))
            .background(Kc.Surface3)
            .border(1.dp, Kc.BorderSubtle, RoundedCornerShape(8.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = Kc.TextFaint, modifier = Modifier.size(13.dp))
            Spacer(Modifier.width(5.dp))
        }
        Text(text, style = KcText.MonoSmall, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ---- buttons --------------------------------------------------------------------------------

@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
    icon: ImageVector? = null,
    container: Color = Kc.Constellation,
    content: Color = Kc.AccentFg,
) {
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = modifier.heightIn(min = 48.dp),
        shape = ControlShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = container,
            contentColor = content,
            disabledContainerColor = container.copy(alpha = 0.35f),
            disabledContentColor = content.copy(alpha = 0.6f),
        ),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
    ) {
        ButtonContent(text, icon, busy, content)
    }
}

@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
    icon: ImageVector? = null,
    tone: Color = Kc.Starlight,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = modifier.heightIn(min = 48.dp),
        shape = ControlShape,
        border = BorderStroke(1.dp, if (enabled) Kc.BorderStrong else Kc.Border),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = Kc.Surface3, contentColor = tone, disabledContentColor = tone.copy(alpha = 0.4f)),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
    ) {
        ButtonContent(text, icon, busy, tone)
    }
}

@Composable
fun GhostButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = Kc.AccentText, icon: ImageVector? = null, enabled: Boolean = true) {
    TextButton(onClick = onClick, modifier = modifier.heightIn(min = 44.dp), enabled = enabled, shape = ControlShape) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(text, style = MaterialTheme.typography.labelLarge, color = if (enabled) color else color.copy(alpha = 0.4f))
    }
}

@Composable
private fun ButtonContent(text: String, icon: ImageVector?, busy: Boolean, color: Color) {
    if (busy) {
        CircularProgressIndicator(Modifier.size(18.dp), color = color, strokeWidth = 2.dp)
        Spacer(Modifier.width(10.dp))
    } else if (icon != null) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
    }
    Text(text, style = MaterialTheme.typography.labelLarge, maxLines = 1)
}

// ---- chips ----------------------------------------------------------------------------------

@Composable
fun FilterPill(label: String, count: Int?, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, tone: Tone? = null) {
    val bg = if (selected) Kc.AccentSoft else Kc.Surface2
    val border = if (selected) Kc.BorderLit else Kc.Border
    Row(
        modifier
            .defaultMinSize(minHeight = 40.dp)
            .clip(ChipShape)
            .background(bg)
            .border(1.dp, border, ChipShape)
            .clickable(role = Role.Tab, onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = "$label${count?.let { ", $it" } ?: ""}${if (selected) ", selected" else ""}"
            }
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (tone != null) {
            StatusDot(tone, size = 7.dp)
            Spacer(Modifier.width(7.dp))
        }
        Text(label, style = MaterialTheme.typography.labelLarge, color = if (selected) Kc.Starlight else Kc.TextSecondary)
        if (count != null) {
            Spacer(Modifier.width(7.dp))
            Text("$count", style = KcText.MonoSmall, color = if (selected) Kc.AccentText else Kc.TextFaint)
        }
    }
}

/** Selectable option for pickers (launch sheet). */
@Composable
fun OptionChip(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, sub: String? = null) {
    Column(
        modifier
            .widthIn(min = 64.dp)
            .clip(ControlShape)
            .background(if (selected) Kc.AccentSoft else Kc.Surface2)
            .border(1.dp, if (selected) Kc.BorderLit else Kc.Border, ControlShape)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = label + (sub?.let { ", $it" } ?: "") + if (selected) ", selected" else "" }
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = if (selected) Kc.Starlight else Kc.TextSecondary, maxLines = 1)
        if (sub != null) Text(sub, style = KcText.MonoSmall, color = Kc.TextFaint, maxLines = 1)
    }
}

// ---- misc -----------------------------------------------------------------------------------

@Composable
fun EmptyState(icon: ImageVector, title: String, body: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(56.dp).clip(CircleShape).background(Kc.Surface2).border(1.dp, Kc.Border, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, contentDescription = null, tint = Kc.AccentText, modifier = Modifier.size(26.dp)) }
        Text(title, style = MaterialTheme.typography.titleMedium, color = Kc.Starlight)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (action != null) {
            Spacer(Modifier.height(4.dp))
            action()
        }
    }
}

@Composable
fun InfoRow(label: String, value: String, modifier: Modifier = Modifier, mono: Boolean = false) {
    Row(modifier.fillMaxWidth().padding(vertical = 7.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.Top) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula, modifier = Modifier.width(118.dp))
        Text(
            value,
            style = if (mono) KcText.Mono else MaterialTheme.typography.bodyMedium,
            color = Kc.Starlight,
            modifier = Modifier.weight(1f),
        )
    }
}

/** An inline notice (error, info, queued) with a tone edge. */
@Composable
fun Notice(text: String, tone: Tone, modifier: Modifier = Modifier, icon: ImageVector? = null, action: (@Composable () -> Unit)? = null) {
    Row(
        modifier
            .fillMaxWidth()
            .clip(ControlShape)
            .background(tone.soft)
            .border(1.dp, tone.line, ControlShape)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = tone.text, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
        }
        Text(text, style = MaterialTheme.typography.bodyMedium, color = tone.text, modifier = Modifier.weight(1f))
        action?.invoke()
    }
}

/** Dims stale content while not Online (the device never shows stale state as live). */
fun Modifier.stale(stale: Boolean): Modifier = if (stale) alpha(0.55f) else this
