package com.kalcode.remote.ui.screens

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.kalcode.remote.R
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.client.RemovedReason
import com.kalcode.remote.protocol.PairingLink
import com.kalcode.remote.protocol.PairingLinkException
import com.kalcode.remote.protocol.PairingPayload
import com.kalcode.remote.ui.Copy
import com.kalcode.remote.ui.LocalClient
import com.kalcode.remote.ui.components.ControlShape
import com.kalcode.remote.ui.components.Eyebrow
import com.kalcode.remote.ui.components.KcCard
import com.kalcode.remote.ui.components.MonoChip
import com.kalcode.remote.ui.components.Notice
import com.kalcode.remote.ui.components.PrimaryButton
import com.kalcode.remote.ui.components.SecondaryButton
import com.kalcode.remote.ui.components.StatusPill
import com.kalcode.remote.ui.components.formatDuration
import com.kalcode.remote.ui.components.rememberHaptics
import com.kalcode.remote.ui.headingSemantics
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.KcMotion
import com.kalcode.remote.ui.theme.LocalNow
import com.kalcode.remote.ui.theme.LocalReducedMotion
import com.kalcode.remote.ui.theme.SpaceBackground
import com.kalcode.remote.ui.theme.SpaceLevel
import com.kalcode.remote.ui.theme.Tone
import kotlinx.coroutines.launch
import java.util.concurrent.Executors

private sealed interface PairStep {
    data object Home : PairStep
    data object Scanning : PairStep
    data class Confirm(val payload: PairingPayload) : PairStep
}

@Composable
fun PairingScreen(initialLink: String?, onLinkConsumed: () -> Unit) {
    val client = LocalClient.current
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val reduced = LocalReducedMotion.current
    var step by remember { mutableStateOf<PairStep>(PairStep.Home) }
    var error by remember { mutableStateOf<Pair<String?, String>?>(null) }
    var pasting by remember { mutableStateOf(false) }
    var pairing by remember { mutableStateOf(false) }

    fun accept(text: String): Boolean = try {
        step = PairStep.Confirm(PairingLink.parse(text))
        error = null
        haptics.confirm()
        true
    } catch (e: PairingLinkException) {
        error = null to (e.message ?: "")
        haptics.reject()
        false
    }

    LaunchedEffect(initialLink) {
        if (initialLink != null) {
            accept(initialLink)
            onLinkConsumed()
        }
    }
    BackHandler(enabled = step != PairStep.Home && !pairing) { step = PairStep.Home }

    AnimatedContent(
        targetState = step,
        transitionSpec = { fadeIn(KcMotion.spec(reduced)) togetherWith fadeOut(KcMotion.spec(reduced, KcMotion.FAST)) },
        contentKey = { it::class },
        label = "pair",
    ) { current ->
        when (current) {
            PairStep.Scanning -> QrScanner(
                onCode = { code -> if (PairingLink.looksLikePairingLink(code)) accept(code) },
                onClose = { step = PairStep.Home },
                onDenied = {
                    error = "Camera access is off" to "Allow the camera in Settings to scan the pairing code, or paste the link instead."
                    step = PairStep.Home
                },
            )
            else -> SpaceBackground(SpaceLevel.CINEMATIC) {
                Column(
                    Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .windowInsetsPadding(WindowInsets.safeDrawing)
                        .padding(horizontal = 24.dp, vertical = 16.dp)
                        .testTag("pairing"),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Column(Modifier.widthIn(max = 480.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Spacer(Modifier.height(24.dp))
                        if (current is PairStep.Confirm) {
                            Box(
                                Modifier
                                    .size(112.dp)
                                    .background(androidx.compose.ui.graphics.Brush.radialGradient(listOf(Kc.Constellation.copy(alpha = 0.22f), Color.Transparent)), CircleShape),
                                contentAlignment = Alignment.Center,
                            ) {
                                Box(
                                    Modifier.size(84.dp).background(Kc.Surface1, CircleShape).border(1.5.dp, Kc.BorderLit, CircleShape),
                                    contentAlignment = Alignment.Center,
                                ) { Icon(Icons.Outlined.DesktopWindows, contentDescription = null, tint = Kc.Icy, modifier = Modifier.size(40.dp)) }
                            }
                            Spacer(Modifier.height(20.dp))
                        } else {
                            Image(painterResource(R.drawable.kalcode_mascot), contentDescription = "KalCode", modifier = Modifier.size(196.dp))
                            Spacer(Modifier.height(20.dp))
                        }
                        if (current is PairStep.Confirm) {
                            ConfirmPairing(
                                payload = current.payload,
                                pairing = pairing,
                                onPair = {
                                    pairing = true
                                    error = null
                                    haptics.press()
                                    scope.launch {
                                        runCatching { client.pair(current.payload) }
                                            .onSuccess { haptics.confirm() }
                                            .onFailure {
                                                haptics.reject()
                                                error = if (it is com.kalcode.remote.client.PairingFailedException) {
                                                    Copy.pairFailure(it.reason, current.payload.name)
                                                } else {
                                                    Copy.pairFailure(null, current.payload.name)
                                                }
                                            }
                                        pairing = false
                                    }
                                },
                                onCancel = {
                                    error = null
                                    step = PairStep.Home
                                },
                            )
                        } else {
                            Text(
                                "KalCode Remote",
                                style = MaterialTheme.typography.headlineMedium,
                                color = Kc.Starlight,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.headingSemantics(),
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "Mission Control for your agents — approve, steer and ship from anywhere on your network.",
                                style = MaterialTheme.typography.bodyLarge,
                                color = Kc.Nebula,
                                textAlign = TextAlign.Center,
                            )
                            Spacer(Modifier.height(28.dp))
                            PrimaryButton(
                                "Scan pairing code",
                                {
                                    error = null
                                    step = PairStep.Scanning
                                },
                                icon = Icons.Outlined.QrCodeScanner,
                                modifier = Modifier.fillMaxWidth().testTag("scanQr"),
                            )
                            Spacer(Modifier.height(10.dp))
                            SecondaryButton(
                                "Paste pairing link",
                                { pasting = true },
                                icon = Icons.Outlined.Link,
                                modifier = Modifier.fillMaxWidth().testTag("pasteLink"),
                            )
                            Spacer(Modifier.height(14.dp))
                            KcCard(Modifier.fillMaxWidth(), background = Kc.Surface1, padding = androidx.compose.foundation.layout.PaddingValues(14.dp)) {
                                Text(
                                    "On your workstation",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = Kc.Nebula,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    "KalCode → Settings → Remote → Pair a device",
                                    style = com.kalcode.remote.ui.theme.KcText.Mono,
                                    color = Kc.AccentText,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        }
                        error?.let { (title, message) ->
                            Spacer(Modifier.height(16.dp))
                            Notice(
                                if (title != null) "$title. $message" else message,
                                Tone.Failed,
                                icon = Icons.Outlined.ErrorOutline,
                                modifier = Modifier.testTag("pairError"),
                            )
                        }
                        Spacer(Modifier.height(20.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Lock, contentDescription = null, tint = Kc.TextFaint, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(
                                "End-to-end encrypted. No cloud account.",
                                style = MaterialTheme.typography.bodySmall,
                                color = Kc.TextFaint,
                            )
                        }
                    }
                }
            }
        }
    }

    if (pasting) {
        PasteDialog(onDismiss = { pasting = false }, onSubmit = { text -> if (accept(text)) pasting = false })
    }
}

@Composable
private fun Step(n: Int, text: String) {
    Row(Modifier.padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(28.dp).background(Kc.AccentSoft, CircleShape).border(1.dp, Kc.BorderLitSoft, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Text("$n", style = MaterialTheme.typography.labelLarge, color = Kc.AccentText) }
        Spacer(Modifier.width(14.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = Kc.TextSecondary)
    }
}

@Composable
private fun ConfirmPairing(payload: PairingPayload, pairing: Boolean, onPair: () -> Unit, onCancel: () -> Unit) {
    val now by LocalNow.current
    val left = payload.exp * 1000 - now
    Text(
        "Pair with ${payload.name}?",
        style = MaterialTheme.typography.headlineMedium,
        color = Kc.Starlight,
        textAlign = TextAlign.Center,
        modifier = Modifier.headingSemantics().testTag("confirmTitle"),
    )
    Spacer(Modifier.height(8.dp))
    Text(
        "Check this name matches your workstation.",
        style = MaterialTheme.typography.bodyMedium,
        color = Kc.Nebula,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(20.dp))
    KcCard(Modifier.fillMaxWidth(), background = Kc.Surface1) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Workstation", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula, modifier = Modifier.weight(1f))
            Text(payload.name, style = MaterialTheme.typography.titleSmall, color = Kc.Starlight)
        }
        Divider()
        Eyebrow("Addresses")
        Spacer(Modifier.height(6.dp))
        payload.addrs.forEach { Text(it, style = com.kalcode.remote.ui.theme.KcText.Mono, color = Kc.AccentText) }
        Divider()
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Code expires", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula, modifier = Modifier.weight(1f))
            val s = (left / 1000).coerceAtLeast(0)
            Text(
                if (left > 0) "%d:%02d".format(s / 60, s % 60) else "Expired",
                style = com.kalcode.remote.ui.theme.KcText.Mono,
                color = if (left > 0) Kc.TextSecondary else Kc.FailedText,
            )
        }
    }
    Spacer(Modifier.height(20.dp))
    PrimaryButton(
        if (pairing) "Connecting securely…" else "Pair",
        onPair,
        enabled = left > 0,
        busy = pairing,
        modifier = Modifier.fillMaxWidth().testTag("pairButton"),
    )
    Spacer(Modifier.height(10.dp))
    SecondaryButton("Cancel", onCancel, enabled = !pairing, modifier = Modifier.fillMaxWidth())
}

@Composable
private fun Divider() {
    Spacer(Modifier.height(12.dp))
    Box(Modifier.fillMaxWidth().height(1.dp).background(Kc.BorderSubtle))
    Spacer(Modifier.height(12.dp))
}

@Composable
private fun PasteDialog(onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    val context = LocalContext.current
    var text by remember {
        val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
            ?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
        mutableStateOf(if (PairingLink.looksLikePairingLink(clip)) clip.trim() else "")
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Kc.Overlay,
        title = { Text("Paste pairing link") },
        text = {
            Column {
                Text("Copy the pairing link from KalCode → Settings → Remote → Pair a device, then paste it here.", color = Kc.TextSecondary, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text("kalcode-remote://pair?d=…") },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).testTag("linkField"),
                    textStyle = com.kalcode.remote.ui.theme.KcText.Mono,
                    shape = ControlShape,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Kc.BorderLit, unfocusedBorderColor = Kc.Border,
                        focusedContainerColor = Kc.Surface2, unfocusedContainerColor = Kc.Surface2, cursorColor = Kc.Constellation,
                    ),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSubmit(text) }, enabled = text.isNotBlank(), modifier = Modifier.testTag("linkContinue")) {
                Text("Continue", color = Kc.AccentText)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = Kc.TextSecondary) } },
    )
}

/** Full-screen camera with a QR reticle. ML Kit's bundled model decodes on device. */
@OptIn(ExperimentalGetImage::class)
@Composable
private fun QrScanner(onCode: (String) -> Unit, onClose: () -> Unit, onDenied: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        if (!ok) onDenied()
    }
    LaunchedEffect(Unit) { if (!granted) ask.launch(Manifest.permission.CAMERA) }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (granted) {
            val executor = remember { Executors.newSingleThreadExecutor() }
            val scanner = remember {
                BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
            }
            var done by remember { mutableStateOf(false) }
            DisposableEffect(Unit) {
                onDispose {
                    scanner.close()
                    executor.shutdown()
                    runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
                }
            }
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    val view = PreviewView(ctx).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
                    val future = ProcessCameraProvider.getInstance(ctx)
                    future.addListener({
                        val provider = future.get()
                        val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
                        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                        analysis.setAnalyzer(executor) { proxy ->
                            val media = proxy.image
                            if (media == null || done) {
                                proxy.close()
                                return@setAnalyzer
                            }
                            scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                                .addOnSuccessListener { codes ->
                                    val value = codes.firstNotNullOfOrNull { it.rawValue }
                                    if (value != null && !done && PairingLink.looksLikePairingLink(value)) {
                                        done = true
                                        ContextCompat.getMainExecutor(ctx).execute { onCode(value) }
                                    }
                                }
                                .addOnCompleteListener { proxy.close() }
                        }
                        runCatching {
                            provider.unbindAll()
                            provider.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                        }
                    }, ContextCompat.getMainExecutor(ctx))
                    view
                },
            )
        }
        // Reticle: corner brackets in Constellation over a dimmed frame.
        Canvas(
            Modifier
                .fillMaxSize()
                .graphicsLayer { compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen }
                .semantics { contentDescription = "QR code scanner" },
        ) {
            val side = size.minDimension * 0.68f
            val topLeft = Offset((size.width - side) / 2, (size.height - side) / 2.4f)
            drawRect(Color.Black.copy(alpha = 0.45f))
            drawRoundRect(Color.Transparent, topLeft, Size(side, side), CornerRadius(28.dp.toPx()), blendMode = androidx.compose.ui.graphics.BlendMode.Clear)
            val arm = side * 0.16f
            val stroke = 4.dp.toPx()
            val c = Kc.Constellation
            val corners = listOf(
                topLeft to Offset(1f, 1f),
                Offset(topLeft.x + side, topLeft.y) to Offset(-1f, 1f),
                Offset(topLeft.x, topLeft.y + side) to Offset(1f, -1f),
                Offset(topLeft.x + side, topLeft.y + side) to Offset(-1f, -1f),
            )
            corners.forEach { (p, d) ->
                drawLine(c, p, Offset(p.x + arm * d.x, p.y), stroke, StrokeCap.Round)
                drawLine(c, p, Offset(p.x, p.y + arm * d.y), stroke, StrokeCap.Round)
            }
            drawRoundRect(c.copy(alpha = 0.25f), topLeft, Size(side, side), CornerRadius(28.dp.toPx()), style = Stroke(1.dp.toPx()))
        }
        Column(
            Modifier.fillMaxWidth().align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.safeDrawing).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Point at the code on your workstation", style = MaterialTheme.typography.titleLarge, color = Kc.Starlight)
            Spacer(Modifier.height(6.dp))
            Text(
                "KalCode → Settings → Remote → Pair a device",
                style = MaterialTheme.typography.bodyMedium,
                color = Kc.TextSecondary,
                textAlign = TextAlign.Center,
            )
        }
        IconButton(
            onClick = onClose,
            modifier = Modifier
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .padding(12.dp)
                .background(Kc.Overlay.copy(alpha = 0.8f), CircleShape),
        ) { Icon(Icons.Outlined.Close, contentDescription = "Close scanner", tint = Kc.Starlight) }
    }
}

/** The workstation removed this device (revoked) or no longer knows it. */
@Composable
fun RemovedScreen(status: ConnectionStatus.Removed, onPairAgain: () -> Unit) {
    SpaceBackground(SpaceLevel.STANDARD) {
        Column(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(24.dp).testTag("removed"),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Column(Modifier.widthIn(max = 460.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier.size(72.dp).background(Kc.FailedSoft, CircleShape).border(1.dp, Kc.FailedLine, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Outlined.LinkOff, contentDescription = null, tint = Kc.FailedText, modifier = Modifier.size(32.dp)) }
                Spacer(Modifier.height(18.dp))
                StatusPill("Removed", Tone.Failed)
                Spacer(Modifier.height(14.dp))
                val noun = com.kalcode.remote.ui.deviceNoun(LocalContext.current)
                Text(
                    "This $noun was removed",
                    style = MaterialTheme.typography.headlineMedium,
                    color = Kc.Starlight,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.headingSemantics(),
                )
                Spacer(Modifier.height(10.dp))
                Text(
                    when (status.reason) {
                        RemovedReason.REVOKED -> "${status.workstationName} removed this $noun. It no longer has access to your agents, and its key has been erased from this device."
                        RemovedReason.UNPAIRED -> "${status.workstationName} no longer knows this $noun. Its key has been erased from this device."
                    },
                    style = MaterialTheme.typography.bodyLarge,
                    color = Kc.Nebula,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(10.dp))
                Text(
                    "If that wasn't you, check KalCode → Settings → Remote on your workstation.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Kc.TextFaint,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(24.dp))
                PrimaryButton("Pair again", onPairAgain, modifier = Modifier.fillMaxWidth().testTag("pairAgain"))
            }
        }
    }
}
