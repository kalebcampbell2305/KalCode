package com.kalcode.remote.ui.screens

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kalcode.remote.R
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.protocol.Ops
import com.kalcode.remote.protocol.VoiceResult
import com.kalcode.remote.ui.LocalClient
import com.kalcode.remote.ui.args
import com.kalcode.remote.ui.call
import com.kalcode.remote.ui.components.ChipShape
import com.kalcode.remote.ui.components.ConnectionPill
import com.kalcode.remote.ui.components.ControlShape
import com.kalcode.remote.ui.components.Eyebrow
import com.kalcode.remote.ui.components.KcCard
import com.kalcode.remote.ui.components.SectionHeader
import com.kalcode.remote.ui.components.StatusPill
import com.kalcode.remote.ui.components.rememberHaptics
import com.kalcode.remote.ui.headingSemantics
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.LocalReducedMotion
import com.kalcode.remote.ui.theme.SpaceBackground
import com.kalcode.remote.ui.theme.SpaceLevel
import com.kalcode.remote.ui.theme.Tone
import kotlinx.coroutines.launch

@Immutable
data class VoiceEntry(val id: Long, val command: String, val summary: String?, val outcome: String?, val error: String?, val pending: Boolean)

/** This session's KalVoice exchanges (process lifetime). */
object VoiceLog {
    val entries = mutableStateListOf<VoiceEntry>()
    private var next = 0L
    fun nextId() = next++
}

private fun outcomeTone(outcome: String?): Pair<String, Tone> = when (outcome) {
    "done" -> "Done" to Tone.Working
    "partial" -> "Partly done" to Tone.Waiting
    "refused" -> "Refused" to Tone.Failed
    "clarify" -> "Needs detail" to Tone.Active
    else -> (outcome ?: "") to Tone.Muted
}

/**
 * KalVoice: on-device speech recognition where the phone has it, then `voice.command` with the
 * transcript. The desktop's KalVoice orchestrator acts with the same safety rules.
 */
@Composable
fun VoiceScreen() {
    val client = LocalClient.current
    val context = LocalContext.current
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val status by client.status.collectAsStateWithLifecycle()
    val reduced = LocalReducedMotion.current
    val wsName = client.workstation.collectAsStateWithLifecycle().value?.name ?: "your workstation"
    var typed by rememberSaveable { mutableStateOf("") }
    var listening by remember { mutableStateOf(false) }
    var partial by remember { mutableStateOf("") }
    var speechNote by remember { mutableStateOf<String?>(null) }
    val canSend = status == ConnectionStatus.Online || status is ConnectionStatus.Reconnecting
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    // Bring the newest exchange into view (it sits under the orb header).
    androidx.compose.runtime.LaunchedEffect(VoiceLog.entries.size) {
        if (VoiceLog.entries.isNotEmpty()) listState.animateScrollToItem(1)
    }

    fun run(command: String) {
        val text = command.trim()
        if (text.isEmpty()) return
        val id = VoiceLog.nextId()
        VoiceLog.entries.add(0, VoiceEntry(id, text, null, null, null, pending = true))
        haptics.press()
        scope.launch {
            val result = runCatching { client.call(Ops.VOICE_COMMAND, args("text" to text), VoiceResult.serializer()) }
            val i = VoiceLog.entries.indexOfFirst { it.id == id }
            if (i < 0) return@launch
            VoiceLog.entries[i] = result.fold(
                { r ->
                    if (r.outcome == "refused") haptics.reject() else haptics.confirm()
                    VoiceLog.entries[i].copy(summary = r.summary, outcome = r.outcome, pending = false)
                },
                { e ->
                    haptics.reject()
                    VoiceLog.entries[i].copy(error = e.message ?: "Not sent", pending = false)
                },
            )
        }
    }

    val recognizer = remember { SpeechRecognizerHolder(context) }
    DisposableEffect(Unit) { onDispose { recognizer.destroy() } }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            listening = recognizer.start(
                onPartial = { partial = it },
                onFinal = { text ->
                    listening = false
                    partial = ""
                    run(text)
                },
                onError = { msg ->
                    listening = false
                    partial = ""
                    speechNote = msg
                },
            )
            if (!listening) speechNote = "Speech recognition isn't available on this device. Type your command below."
        } else {
            speechNote = "Microphone access is off. You can type your command below."
        }
    }
    fun toggleMic() {
        speechNote = null
        if (listening) {
            recognizer.stop()
            listening = false
            return
        }
        haptics.press()
        // Already granted: the callback runs at once and starts listening.
        permission.launch(Manifest.permission.RECORD_AUDIO)
    }

    SpaceBackground(SpaceLevel.CINEMATIC) {
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top)).imePadding()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth().testTag("voice"),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                item("head") {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Eyebrow("KalVoice", color = Kc.AccentText)
                            Spacer(Modifier.weight(1f))
                            ConnectionPill(status)
                        }
                        Spacer(Modifier.height(8.dp))
                        Orb(listening, reduced)
                        Text(
                            if (listening) "Listening…" else "What should your agents do?",
                            style = MaterialTheme.typography.headlineSmall,
                            color = Kc.Starlight,
                            modifier = Modifier.headingSemantics(),
                        )
                        Spacer(Modifier.height(6.dp))
                        Text(
                            partial.ifBlank { speechNote ?: "Ask for status, steer an agent, approve, launch or tidy up — the same commands as KalVoice on $wsName." },
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (speechNote != null && partial.isBlank()) Kc.WaitingText else Kc.Nebula,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.widthIn(max = 420.dp).semantics { liveRegion = LiveRegionMode.Polite },
                        )
                        Spacer(Modifier.height(22.dp))
                        MicButton(listening, onClick = ::toggleMic)
                        Spacer(Modifier.height(8.dp))
                    }
                }
                if (VoiceLog.entries.isNotEmpty()) {
                    item("hist") { SectionHeader("This session", modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) }
                }
                items(VoiceLog.entries, key = { it.id }) { e -> VoiceCard(e, Modifier.widthIn(max = 640.dp)) }
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Kc.Surface1)
                    .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = typed,
                    onValueChange = { if (it.length <= 4_000) typed = it },
                    modifier = Modifier.weight(1f).heightIn(min = 52.dp).testTag("voiceField"),
                    placeholder = { Text("Or type a command…") },
                    singleLine = true,
                    enabled = canSend,
                    shape = ControlShape,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = {
                        run(typed)
                        typed = ""
                    }),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Kc.BorderLit, unfocusedBorderColor = Kc.Border,
                        focusedContainerColor = Kc.Surface2, unfocusedContainerColor = Kc.Surface2,
                        cursorColor = Kc.Constellation, focusedPlaceholderColor = Kc.TextFaint, unfocusedPlaceholderColor = Kc.TextFaint,
                    ),
                )
                Spacer(Modifier.width(8.dp))
                val ready = typed.isNotBlank() && canSend
                IconButton(
                    onClick = {
                        run(typed)
                        typed = ""
                    },
                    enabled = ready,
                    modifier = Modifier.size(52.dp).background(if (ready) Kc.Constellation else Kc.Surface3, ControlShape).testTag("voiceSend"),
                ) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "Send command", tint = if (ready) Kc.AccentFg else Kc.TextFaint)
                }
            }
        }
    }
}

@Composable
private fun Orb(listening: Boolean, reduced: Boolean) {
    val scale = if (listening && !reduced) {
        val t = rememberInfiniteTransition(label = "orb")
        val s by t.animateFloat(0.96f, 1.04f, infiniteRepeatable(tween(1400), RepeatMode.Reverse), label = "breathe")
        s
    } else {
        1f
    }
    Box(
        Modifier
            .padding(vertical = 8.dp)
            .size(232.dp)
            .drawBehind {
                drawCircle(
                    Brush.radialGradient(
                        listOf(Kc.Constellation.copy(alpha = if (listening) 0.30f else 0.16f), Color.Transparent),
                        center = Offset(size.width / 2, size.height / 2),
                        radius = size.minDimension / 2,
                    ),
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painterResource(R.drawable.kalvoice_orb),
            contentDescription = null,
            modifier = Modifier.size(196.dp).graphicsLayer { scaleX = scale; scaleY = scale },
        )
    }
}

@Composable
private fun MicButton(listening: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(96.dp).border(1.dp, Kc.BorderLitSoft, CircleShape).padding(8.dp),
        contentAlignment = Alignment.Center,
    ) {
        IconButton(
            onClick = onClick,
            modifier = Modifier
                .fillMaxSize()
                .background(if (listening) Kc.Failed else Kc.Constellation, CircleShape)
                .testTag("mic")
                .semantics { contentDescription = if (listening) "Stop listening" else "Speak a command" },
        ) {
            Icon(if (listening) Icons.Outlined.Stop else Icons.Outlined.Mic, contentDescription = null, tint = Kc.AccentFg, modifier = Modifier.size(30.dp))
        }
    }
}

@Composable
private fun VoiceCard(e: VoiceEntry, modifier: Modifier = Modifier) {
    val client = LocalClient.current
    val status by client.status.collectAsStateWithLifecycle()
    KcCard(modifier.fillMaxWidth().testTag("voiceEntry"), lit = if (e.error != null) Kc.FailedLine else null) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("“${e.command}”", style = MaterialTheme.typography.titleSmall, color = Kc.Starlight, modifier = Modifier.weight(1f))
            if (e.outcome != null) {
                val (label, tone) = outcomeTone(e.outcome)
                StatusPill(label, tone)
            }
        }
        Spacer(Modifier.height(8.dp))
        when {
            e.pending && status is ConnectionStatus.Reconnecting -> Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.HourglassTop, null, tint = Kc.WaitingText, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Queued — sends when connected", style = MaterialTheme.typography.bodySmall, color = Kc.WaitingText)
            }
            e.pending -> Text("Working on it…", style = MaterialTheme.typography.bodySmall, color = Kc.Nebula)
            e.error != null -> Text(e.error, style = MaterialTheme.typography.bodyMedium, color = Kc.FailedText)
            else -> Text(e.summary.orEmpty(), style = MaterialTheme.typography.bodyMedium, color = Kc.TextSecondary)
        }
    }
}

/** Wraps SpeechRecognizer: on-device when available, otherwise the system recognizer. */
private class SpeechRecognizerHolder(private val context: Context) {
    private var recognizer: SpeechRecognizer? = null

    fun start(onPartial: (String) -> Unit, onFinal: (String) -> Unit, onError: (String) -> Unit): Boolean {
        val r = recognizer ?: when {
            SpeechRecognizer.isOnDeviceRecognitionAvailable(context) -> SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            SpeechRecognizer.isRecognitionAvailable(context) -> SpeechRecognizer.createSpeechRecognizer(context)
            else -> return false
        }.also { recognizer = it }
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partialResults: Bundle?) {
                partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let(onPartial)
            }
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (text.isNullOrBlank()) onError("I didn't catch that. Try again or type it.") else onFinal(text)
            }
            override fun onError(error: Int) {
                onError(
                    when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "I didn't catch that. Try again or type it."
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone access is off. You can type your command below."
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition needs a connection on this phone. Type it instead."
                        else -> "Speech recognition stopped. Try again or type it."
                    },
                )
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
        return runCatching { r.startListening(intent) }.isSuccess
    }

    fun stop() {
        recognizer?.stopListening()
    }

    fun destroy() {
        recognizer?.destroy()
        recognizer = null
    }
}
