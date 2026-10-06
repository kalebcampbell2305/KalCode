package com.kalcode.remote.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.RocketLaunch
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.protocol.LaunchOptions
import com.kalcode.remote.protocol.LaunchResult
import com.kalcode.remote.protocol.Ops
import com.kalcode.remote.ui.LocalClient
import com.kalcode.remote.ui.LocalMessages
import com.kalcode.remote.ui.args
import com.kalcode.remote.ui.call
import com.kalcode.remote.ui.components.ControlShape
import com.kalcode.remote.ui.components.Eyebrow
import com.kalcode.remote.ui.components.Notice
import com.kalcode.remote.ui.components.OptionChip
import com.kalcode.remote.ui.components.PrimaryButton
import com.kalcode.remote.ui.components.rememberHaptics
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.Tone
import kotlinx.coroutines.launch

/**
 * Launch agent: workspace, provider, account, exact model and effort from `launch.options`
 * (labels only, never credentials), plus an optional first prompt.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
fun LaunchSheet(onDismiss: () -> Unit, onLaunched: (summary: String, agentId: String?) -> Unit) {
    val client = LocalClient.current
    val messages = LocalMessages.current
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val status by client.status.collectAsStateWithLifecycle()
    val fleet by client.fleet.collectAsStateWithLifecycle()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var options by remember { mutableStateOf<LaunchOptions?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var workspace by rememberSaveable { mutableStateOf<String?>(null) }
    var provider by rememberSaveable { mutableStateOf<String?>(null) }
    var account by rememberSaveable { mutableStateOf<String?>(null) }
    var model by rememberSaveable { mutableStateOf<String?>(null) }
    var effort by rememberSaveable { mutableStateOf<String?>(null) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var launching by remember { mutableStateOf(false) }

    LaunchedEffect(status == ConnectionStatus.Online) {
        if (status != ConnectionStatus.Online || options != null) return@LaunchedEffect
        runCatching { client.call(Ops.LAUNCH_OPTIONS, args(), LaunchOptions.serializer()) }
            .onSuccess { o ->
                options = o
                workspace = workspace ?: (fleet.workstation?.activeWorkspaceId?.takeIf { id -> o.workspaces.any { it.id == id } } ?: o.workspaces.firstOrNull()?.id)
                val p = o.providers.firstOrNull()
                provider = provider ?: p?.id
            }
            .onFailure { error = it.message }
    }
    val p = options?.providers?.firstOrNull { it.id == provider }
    // Keep account/model/effort valid for the chosen provider and model.
    LaunchedEffect(p?.id) {
        if (p == null) return@LaunchedEffect
        if (p.accounts.none { it.id == account }) account = p.accounts.firstOrNull()?.id
        if (p.models.none { it.id == model }) model = p.models.firstOrNull()?.id
    }
    val m = p?.models?.firstOrNull { it.id == model }
    LaunchedEffect(m?.id) {
        if (m == null) return@LaunchedEffect
        if (effort !in m.efforts) effort = m.efforts.firstOrNull { it == "high" } ?: m.efforts.lastOrNull()
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheet,
        containerColor = Kc.Surface1,
        contentColor = Kc.Starlight,
        scrimColor = androidx.compose.ui.graphics.Color(0x99000000),
        dragHandle = { androidx.compose.material3.BottomSheetDefaults.DragHandle(color = Kc.BorderStrong) },
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .navigationBarsPadding()
                .padding(bottom = 16.dp)
                .semantics { testTagsAsResourceId = true }
                .testTag("launchSheet"),
        ) {
            Text("Launch agent", style = MaterialTheme.typography.headlineSmall, color = Kc.Starlight)
            Spacer(Modifier.height(4.dp))
            Text(
                "A new coding agent on your workstation, with the account, model and effort you pick.",
                style = MaterialTheme.typography.bodyMedium,
                color = Kc.Nebula,
            )
            Spacer(Modifier.height(18.dp))
            val o = options
            when {
                status != ConnectionStatus.Online -> Notice("Launching needs a live connection to your workstation.", Tone.Waiting)
                o == null && error != null -> Notice(error!!, Tone.Failed, icon = Icons.Outlined.ErrorOutline)
                o == null -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Kc.Constellation, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                }
                else -> {
                    Picker("Workspace") {
                        o.workspaces.forEach { w -> OptionChip(w.name, w.id == workspace, { workspace = w.id; haptics.tick() }) }
                    }
                    Picker("Provider") {
                        o.providers.forEach { pr -> OptionChip(pr.name, pr.id == provider, { provider = pr.id; haptics.tick() }) }
                    }
                    if (p != null && p.accounts.isNotEmpty()) {
                        Picker("Account") {
                            p.accounts.forEach { a -> OptionChip(a.label, a.id == account, { account = a.id; haptics.tick() }) }
                        }
                    }
                    if (p != null && p.models.isNotEmpty()) {
                        Picker("Model") {
                            p.models.forEach { mm -> OptionChip(mm.name, mm.id == model, { model = mm.id; haptics.tick() }, sub = mm.id) }
                        }
                    }
                    if (m != null && m.efforts.isNotEmpty()) {
                        Picker("Effort") {
                            m.efforts.forEach { e -> OptionChip(e.replaceFirstChar { it.uppercase() }, e == effort, { effort = e; haptics.tick() }) }
                        }
                    }
                    Eyebrow("First prompt", color = Kc.TextSecondary)
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = prompt,
                        onValueChange = { if (it.length <= 20_000) prompt = it },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).testTag("launchPrompt"),
                        placeholder = { Text("What should it do? (optional)") },
                        shape = ControlShape,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Kc.BorderLit,
                            unfocusedBorderColor = Kc.Border,
                            focusedContainerColor = Kc.Surface2,
                            unfocusedContainerColor = Kc.Surface2,
                            cursorColor = Kc.Constellation,
                            focusedPlaceholderColor = Kc.TextFaint,
                            unfocusedPlaceholderColor = Kc.TextFaint,
                        ),
                    )
                    Spacer(Modifier.height(18.dp))
                    PrimaryButton(
                        "Launch agent",
                        onClick = {
                            val ws = workspace ?: return@PrimaryButton
                            val pr = provider ?: return@PrimaryButton
                            launching = true
                            haptics.press()
                            scope.launch {
                                runCatching {
                                    client.call(
                                        Ops.AGENT_LAUNCH,
                                        args(
                                            "workspaceId" to ws, "providerId" to pr, "accountId" to account,
                                            "model" to model, "effort" to effort, "prompt" to prompt.trim().ifEmpty { null },
                                        ),
                                        LaunchResult.serializer(),
                                    )
                                }.onSuccess { r ->
                                    haptics.confirm()
                                    launching = false
                                    sheet.hide()
                                    onLaunched(r.summary.ifBlank { "Agent started" }, r.agentId)
                                }.onFailure {
                                    haptics.reject()
                                    launching = false
                                    error = it.message
                                    messages.post(it.message ?: "Couldn't launch the agent")
                                }
                            }
                        },
                        enabled = workspace != null && provider != null,
                        busy = launching,
                        icon = Icons.Outlined.RocketLaunch,
                        modifier = Modifier.fillMaxWidth().testTag("launchSubmit"),
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Picker(label: String, content: @Composable () -> Unit) {
    Eyebrow(label, color = Kc.TextSecondary)
    Spacer(Modifier.height(8.dp))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
    Spacer(Modifier.height(18.dp))
}
