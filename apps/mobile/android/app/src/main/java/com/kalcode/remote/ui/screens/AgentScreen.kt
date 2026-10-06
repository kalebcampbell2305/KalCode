package com.kalcode.remote.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.union
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.automirrored.outlined.CallSplit
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Difference
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FlagCircle
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.client.RemoteCallException
import com.kalcode.remote.protocol.Agent
import com.kalcode.remote.protocol.AgentDetail
import com.kalcode.remote.protocol.AgentMessage
import com.kalcode.remote.protocol.AgentState
import com.kalcode.remote.protocol.Ops
import com.kalcode.remote.protocol.Summary
import com.kalcode.remote.protocol.ToolCall
import com.kalcode.remote.ui.LocalClient
import com.kalcode.remote.ui.LocalMessages
import com.kalcode.remote.ui.args
import com.kalcode.remote.ui.call
import com.kalcode.remote.ui.components.AgoText
import com.kalcode.remote.ui.components.ControlShape
import com.kalcode.remote.ui.components.ElapsedText
import com.kalcode.remote.ui.components.EmptyState
import com.kalcode.remote.ui.components.Eyebrow
import com.kalcode.remote.ui.components.KcCard
import com.kalcode.remote.ui.components.MonoChip
import com.kalcode.remote.ui.components.Notice
import com.kalcode.remote.ui.components.PrimaryButton
import com.kalcode.remote.ui.components.SecondaryButton
import com.kalcode.remote.ui.components.SectionHeader
import com.kalcode.remote.ui.components.StateChip
import com.kalcode.remote.ui.components.humanize
import com.kalcode.remote.ui.components.presentation
import com.kalcode.remote.ui.components.rememberHaptics
import com.kalcode.remote.ui.components.stale
import com.kalcode.remote.ui.headingSemantics
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.KcText
import com.kalcode.remote.ui.theme.SpaceBackground
import com.kalcode.remote.ui.theme.SpaceLevel
import com.kalcode.remote.ui.theme.Tone
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun AgentScreen(agentId: String, onBack: () -> Unit, onOpenDiff: () -> Unit, onOpenLog: () -> Unit, inPane: Boolean = false) {
    val client = LocalClient.current
    val messages = LocalMessages.current
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val fleet by client.fleet.collectAsStateWithLifecycle()
    val status by client.status.collectAsStateWithLifecycle()
    val queue by client.queue.collectAsStateWithLifecycle()
    val wsName = client.workstation.collectAsStateWithLifecycle().value?.name ?: "your workstation"
    val agent = fleet.agent(agentId)
    val online = status == ConnectionStatus.Online
    var detail by remember(agentId) { mutableStateOf<AgentDetail?>(null) }
    var loadError by remember(agentId) { mutableStateOf<String?>(null) }
    var confirmStop by remember { mutableStateOf(false) }
    var acting by remember(agentId) { mutableStateOf<String?>(null) }

    // Refresh the detail when the agent changes (debounced; reads are rate limited on the desktop).
    LaunchedEffect(agentId, agent?.lastActivityAt, agent?.state, online) {
        if (!online || agent == null) return@LaunchedEffect
        if (detail != null) delay(600)
        runCatching { client.call(Ops.AGENT_DETAIL, args("agentId" to agentId), AgentDetail.serializer()) }
            .onSuccess {
                detail = it
                loadError = null
            }
            .onFailure { e -> if (detail == null) loadError = e.message }
    }

    fun act(op: String, label: String) {
        acting = op
        haptics.press()
        scope.launch {
            runCatching { client.call(op, args("agentId" to agentId), Summary.serializer()) }
                .onSuccess {
                    haptics.confirm()
                    messages.post(it.summary.ifBlank { label })
                }
                .onFailure {
                    haptics.reject()
                    messages.post(it.message ?: "Couldn't reach your workstation")
                }
            acting = null
        }
    }

    SpaceBackground(SpaceLevel.STANDARD) {
        if (agent == null) {
            Column(Modifier.fillMaxSize()) {
                DetailTopBar(title = "", onBack = onBack, showBack = true)
                EmptyState(
                    Icons.Outlined.FlagCircle,
                    "This agent has finished",
                    "It's no longer on your workstation. Its work stays in KalCode on your desktop.",
                    action = { SecondaryButton("Back to Fleet", onBack) },
                )
            }
            return@SpaceBackground
        }
        val needs = remember(fleet.needsYou, agentId) { fleet.needsYouForAgent(agentId) }
        val queued = queue.items.filter { it.agentId == agentId && it.op == Ops.AGENT_PROMPT }
        Column(Modifier.fillMaxSize()) {
            DetailTopBar(title = if (inPane) "" else "Agent", onBack = onBack)
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth().stale(!online).testTag("agentDetail"),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item("head") { AgentHead(agent, detail) }
                if (needs.isNotEmpty()) {
                    item("needs-h") { SectionHeader("Needs You", count = needs.size, color = Kc.WaitingText) }
                    items(needs, key = { "n:" + it.id }) { item ->
                        NeedsYouCard(item, agentName = null, enabled = online, onOpenAgent = null)
                    }
                }
                item("actions") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        SecondaryButton(
                            "Changes", onOpenDiff, icon = Icons.Outlined.Difference,
                            modifier = Modifier.weight(1f).testTag("viewDiff"),
                        )
                        SecondaryButton(
                            "Full log", onOpenLog, icon = Icons.AutoMirrored.Outlined.Notes,
                            modifier = Modifier.weight(1f).testTag("fullLog"),
                        )
                        if (agent.state.isActive || agent.state == AgentState.WAITING || agent.state == AgentState.NEEDS_YOU) {
                            SecondaryButton(
                                "Stop", { confirmStop = true },
                                icon = Icons.Outlined.StopCircle, tone = Kc.FailedText,
                                enabled = online, busy = acting == Ops.AGENT_STOP,
                                modifier = Modifier.weight(1f).testTag("stop"),
                            )
                        } else if (agent.state == AgentState.FAILED || agent.state == AgentState.STOPPED) {
                            PrimaryButton(
                                "Retry", { act(Ops.AGENT_RETRY, "Resumed") },
                                icon = Icons.Outlined.Replay, enabled = online, busy = acting == Ops.AGENT_RETRY,
                                modifier = Modifier.weight(1f).testTag("retry"),
                            )
                        }
                    }
                }
                item("now") { NowCard(agent, detail) }
                val result = detail?.messages?.lastOrNull { it.role == "assistant" }
                if (agent.state == AgentState.DONE && result != null) {
                    item("result") {
                        KcCard(Modifier.fillMaxWidth(), lit = Kc.DoneLine) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Outlined.CheckCircle, null, tint = Kc.DoneText, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(8.dp))
                                Eyebrow("Result", color = Kc.DoneText)
                            }
                            Spacer(Modifier.height(8.dp))
                            Text(result.text, style = MaterialTheme.typography.bodyMedium, color = Kc.Starlight)
                        }
                    }
                }
                item("output-h") { SectionHeader("Recent output", modifier = Modifier.padding(top = 6.dp)) }
                val d = detail
                when {
                    d == null && !online -> item("wait") {
                        Text("Output loads when $wsName is connected.", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula)
                    }
                    d == null && loadError != null -> item("err") { Notice(loadError!!, Tone.Failed, icon = Icons.Outlined.ErrorOutline) }
                    d == null -> item("loading") {
                        Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = Kc.Constellation, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                        }
                    }
                    else -> {
                        val feed = buildFeed(d)
                        if (feed.isEmpty()) {
                            item("none") { Text("No output yet.", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula) }
                        }
                        items(feed, key = { it.key }) { entry -> FeedRow(entry) }
                    }
                }
            }
            PromptComposer(agent, queued.map { it.id to (it.text ?: "") }, blocked = agent.pendingApprovals > 0)
        }
    }

    if (confirmStop) {
        AlertDialog(
            onDismissRequest = { confirmStop = false },
            containerColor = Kc.Overlay,
            title = { Text("Stop ${agent?.name ?: "this agent"}?") },
            text = { Text("It stops where it is. Its changes stay in the worktree.", color = Kc.TextSecondary) },
            confirmButton = {
                TextButton(onClick = {
                    confirmStop = false
                    act(Ops.AGENT_STOP, "Stopped")
                }, modifier = Modifier.testTag("confirmStop")) { Text("Stop agent", color = Kc.FailedText) }
            },
            dismissButton = { TextButton(onClick = { confirmStop = false }) { Text("Keep running", color = Kc.TextSecondary) } },
        )
    }
}

@Composable
fun DetailTopBar(title: String, onBack: () -> Unit, showBack: Boolean = true, trailing: (@Composable () -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .padding(horizontal = 4.dp)
            .heightIn(min = 56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showBack) {
            IconButton(onClick = onBack, modifier = Modifier.testTag("back")) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back", tint = Kc.Starlight)
            }
        } else {
            Spacer(Modifier.width(12.dp))
        }
        Text(title, style = MaterialTheme.typography.titleMedium, color = Kc.Starlight, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        trailing?.invoke()
    }
}

@Composable
private fun AgentHead(agent: Agent, detail: AgentDetail?) {
    val lit = when (agent.state) {
        AgentState.NEEDS_YOU, AgentState.WAITING -> Kc.WaitingLine
        AgentState.FAILED -> Kc.FailedLine
        else -> null
    }
    KcCard(Modifier.fillMaxWidth(), lit = lit, padding = PaddingValues(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StateChip(agent.state)
            Spacer(Modifier.weight(1f))
            Icon(Icons.Outlined.Schedule, contentDescription = null, tint = Kc.TextFaint, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            ElapsedText(agent)
        }
        Spacer(Modifier.height(12.dp))
        Text(agent.name, style = MaterialTheme.typography.headlineSmall, color = Kc.Starlight, modifier = Modifier.headingSemantics().testTag("agentName"))
        Spacer(Modifier.height(12.dp))
        Box(Modifier.fillMaxWidth().height(1.dp).background(Kc.BorderSubtle))
        Spacer(Modifier.height(6.dp))
        HeadRow("Provider") {
            Text(agent.providerName + " · " + (agent.accountLabel ?: "Default account"), style = MaterialTheme.typography.bodyMedium, color = Kc.Starlight)
        }
        HeadRow("Model") {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                MonoChip(agent.model ?: "unknown", color = Kc.Icy)
                MonoChip(agent.effort ?: "default effort", color = Kc.Icy)
            }
        }
        HeadRow("Project") { Text(agent.workspaceName, style = MaterialTheme.typography.bodyMedium, color = Kc.Starlight) }
        agent.branch?.let { branch ->
            HeadRow("Branch") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(branch, style = KcText.Mono, color = Kc.AccentText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (agent.worktree) {
                        Spacer(Modifier.width(8.dp))
                        MonoChip("worktree", icon = Icons.Outlined.Layers, color = Kc.AccentText)
                    }
                }
            }
        }
        detail?.worktree?.baseBranch?.let { base -> HeadRow("From") { Text(base, style = KcText.Mono, color = Kc.TextSecondary) } }
        detail?.worktree?.path?.takeIf { it.isNotBlank() }?.let { path ->
            HeadRow("Path") {
                // The end of a path is the useful part.
                Text(if (path.length > 38) "…" + path.takeLast(37) else path, style = KcText.Mono, color = Kc.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun HeadRow(label: String, value: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
        Text(label.uppercase(), style = KcText.Eyebrow, color = Kc.TextFaint, modifier = Modifier.width(92.dp))
        Box(Modifier.weight(1f)) { value() }
    }
}

@Composable
private fun NowCard(agent: Agent, detail: AgentDetail?) {
    val p = agent.state.presentation()
    val failed = agent.state == AgentState.FAILED
    KcCard(Modifier.fillMaxWidth(), lit = if (failed) Kc.FailedLine else if (p.live) Kc.WorkingLine else null) {
        Eyebrow(if (failed) "Blocker" else "Now", color = if (failed) Kc.FailedText else p.tone.text)
        Spacer(Modifier.height(8.dp))
        val text = agent.error ?: agent.activity ?: when (agent.state) {
            AgentState.DONE -> "Finished."
            AgentState.IDLE, AgentState.READY -> "Idle. Send a prompt to continue."
            AgentState.STOPPED -> "Stopped."
            AgentState.NEEDS_YOU -> "Waiting for your decision."
            else -> humanize(agent.status)
        }
        Row(verticalAlignment = Alignment.Top) {
            Icon(
                if (failed) Icons.Outlined.ErrorOutline else Icons.Outlined.Bolt, contentDescription = null,
                tint = if (failed) Kc.FailedText else p.tone.text, modifier = Modifier.size(18.dp).padding(top = 2.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(text, style = MaterialTheme.typography.bodyLarge, color = if (failed) Kc.FailedText else Kc.Starlight)
        }
        Spacer(Modifier.height(10.dp))
        Row {
            Text("Status ", style = MaterialTheme.typography.bodySmall, color = Kc.TextFaint)
            Text(agent.status.ifBlank { "unknown" }, style = KcText.MonoSmall, color = Kc.TextSecondary)
            Spacer(Modifier.weight(1f))
            AgoText(agent.lastActivityAt, prefix = "Active ")
        }
        if (detail == null && agent.pendingApprovals > 0) {
            Spacer(Modifier.height(6.dp))
            Text("${agent.pendingApprovals} approval pending", style = MaterialTheme.typography.bodySmall, color = Kc.WaitingText)
        }
    }
}

private data class FeedEntry(val key: String, val at: Long?, val message: AgentMessage? = null, val tool: ToolCall? = null)

private fun buildFeed(d: AgentDetail): List<FeedEntry> {
    val entries = d.messages.mapIndexed { i, m -> FeedEntry("m$i", m.at, message = m) } +
        d.tools.mapIndexed { i, t -> FeedEntry("t$i", t.at, tool = t) }
    return entries.sortedWith(compareBy<FeedEntry> { it.at ?: Long.MIN_VALUE }).takeLast(30)
}

@Composable
private fun FeedRow(entry: FeedEntry) {
    val m = entry.message
    val t = entry.tool
    if (m != null && m.role == "user") {
        Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, horizontalAlignment = Alignment.End) {
            Text("You", style = MaterialTheme.typography.labelMedium, color = Kc.AccentText)
            Spacer(Modifier.height(4.dp))
            Text(
                m.text,
                style = MaterialTheme.typography.bodyMedium,
                color = Kc.Starlight,
                modifier = Modifier
                    .widthIn(max = 320.dp)
                    .background(Kc.AccentSoft, RoundedCornerShape(16.dp))
                    .border(1.dp, Kc.BorderLitSoft, RoundedCornerShape(16.dp))
                    .padding(horizontal = 14.dp, vertical = 9.dp),
            )
        }
    } else if (m != null) {
        val (label, color) = if (m.role == "assistant") "Agent" to Kc.WorkingText else "System" to Kc.Nebula
        Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
            Box(Modifier.padding(top = 7.dp).size(6.dp).background(color, CircleShape))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Row {
                    Text(label, style = MaterialTheme.typography.labelMedium, color = color)
                    Spacer(Modifier.weight(1f))
                    AgoText(m.at)
                }
                Spacer(Modifier.height(2.dp))
                Text(m.text, style = MaterialTheme.typography.bodyMedium, color = Kc.Starlight)
            }
        }
    } else if (t != null) {
        val (icon, tint) = toolIcon(t.status)
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(Kc.Surface1)
                .border(1.dp, Kc.BorderSubtle, RoundedCornerShape(12.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .semantics(mergeDescendants = true) { contentDescription = "${t.name}: ${t.summary}, ${t.status}" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(10.dp))
            Text(t.name, style = KcText.Mono.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium), color = Kc.Starlight)
            Spacer(Modifier.width(8.dp))
            Text(t.summary, style = KcText.Mono, color = Kc.TextSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
    }
}

private fun toolIcon(status: String): Pair<ImageVector, Color> = when (status) {
    "running" -> Icons.Outlined.HourglassTop to Kc.WorkingText
    "succeeded" -> Icons.Outlined.CheckCircle to Kc.WorkingText
    "failed" -> Icons.Outlined.ErrorOutline to Kc.FailedText
    "denied" -> Icons.Outlined.Block to Kc.WaitingText
    else -> Icons.Outlined.Bolt to Kc.Nebula
}

/** Send prompt, with IME handling. Queued prompts show "Queued — sends when connected". */
@Composable
private fun PromptComposer(agent: Agent, queued: List<Pair<String, String>>, blocked: Boolean) {
    val client = LocalClient.current
    val messages = LocalMessages.current
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val status by client.status.collectAsStateWithLifecycle()
    var text by rememberSaveable(agent.id) { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    val canQueue = status == ConnectionStatus.Online || status is ConnectionStatus.Reconnecting
    fun send() {
        val prompt = text.trim()
        if (prompt.isEmpty() || sending) return
        sending = true
        haptics.press()
        scope.launch {
            val queuedNow = status is ConnectionStatus.Reconnecting
            if (queuedNow) text = ""
            runCatching { client.call(Ops.AGENT_PROMPT, args("agentId" to agent.id, "text" to prompt), Summary.serializer()) }
                .onSuccess {
                    haptics.confirm()
                    if (!queuedNow) text = ""
                    messages.post(it.summary.ifBlank { "Sent" })
                }
                .onFailure { e ->
                    haptics.reject()
                    if (queuedNow && text.isEmpty()) text = prompt
                    messages.post((e as? RemoteCallException)?.message ?: e.message ?: "Not sent")
                }
            sending = false
        }
        if (status is ConnectionStatus.Reconnecting) sending = false
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(Kc.Surface1)
            .border(width = 1.dp, color = Kc.BorderSubtle, shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars).only(WindowInsetsSides.Bottom))
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        queued.forEach { (id, q) ->
            Row(
                Modifier.fillMaxWidth().padding(bottom = 8.dp).testTag("queued"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.HourglassTop, contentDescription = null, tint = Kc.WaitingText, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text("Queued — sends when connected", style = MaterialTheme.typography.labelMedium, color = Kc.WaitingText)
                    Text(q, style = MaterialTheme.typography.bodySmall, color = Kc.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                IconButton(onClick = { client.cancelQueued(id) }) { Icon(Icons.Outlined.Close, contentDescription = "Cancel queued prompt", tint = Kc.Nebula) }
            }
        }
        if (blocked) {
            // One quiet line instead of a disabled field: the approval above is the next step.
            Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Shield, contentDescription = null, tint = Kc.WaitingText, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text(
                    "Answer the approval first. Prompts never go to an agent with an open approval.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Kc.WaitingText,
                )
            }
            return@Column
        }
        Row(verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(
                value = text,
                onValueChange = { if (it.length <= 20_000) text = it },
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 52.dp, max = 160.dp)
                    // Hardware keyboards: Enter sends, Shift+Enter adds a line.
                    .onPreviewKeyEvent { e ->
                        if (e.key == Key.Enter && e.type == KeyEventType.KeyDown && !e.isShiftPressed) {
                            send()
                            true
                        } else {
                            false
                        }
                    }
                    .testTag("promptField"),
                placeholder = { Text("Message ${agent.name}…", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                textStyle = MaterialTheme.typography.bodyLarge,
                shape = ControlShape,
                enabled = canQueue && !blocked,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Kc.BorderLit,
                    unfocusedBorderColor = Kc.Border,
                    disabledBorderColor = Kc.BorderSubtle,
                    focusedContainerColor = Kc.Surface2,
                    unfocusedContainerColor = Kc.Surface2,
                    disabledContainerColor = Kc.Surface1,
                    cursorColor = Kc.Constellation,
                    focusedPlaceholderColor = Kc.TextFaint,
                    unfocusedPlaceholderColor = Kc.TextFaint,
                ),
            )
            Spacer(Modifier.width(8.dp))
            val ready = text.isNotBlank() && canQueue && !blocked && !sending
            IconButton(
                onClick = ::send,
                enabled = ready,
                modifier = Modifier
                    .size(52.dp)
                    .background(if (ready) Kc.Constellation else Kc.Surface3, ControlShape)
                    .testTag("sendPrompt"),
            ) {
                if (sending) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Kc.AccentFg, strokeWidth = 2.dp)
                } else {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "Send prompt", tint = if (ready) Kc.AccentFg else Kc.TextFaint)
                }
            }
        }
    }
}
