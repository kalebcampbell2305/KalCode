package com.kalcode.remote.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.automirrored.outlined.CallSplit
import androidx.compose.material.icons.outlined.CleaningServices
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.RateReview
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.SyncProblem
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kalcode.remote.R
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.client.PairedWorkstation
import com.kalcode.remote.protocol.Agent
import com.kalcode.remote.protocol.AgentState
import com.kalcode.remote.protocol.DecideResult
import com.kalcode.remote.protocol.FleetFilter
import com.kalcode.remote.protocol.FleetState
import com.kalcode.remote.protocol.NeedsYouItem
import com.kalcode.remote.protocol.Ops
import com.kalcode.remote.protocol.Summary
import com.kalcode.remote.ui.LocalClient
import com.kalcode.remote.ui.LocalMessages
import com.kalcode.remote.ui.args
import com.kalcode.remote.ui.call
import com.kalcode.remote.ui.components.AgoText
import com.kalcode.remote.ui.components.ConnectionPill
import com.kalcode.remote.ui.components.ElapsedText
import com.kalcode.remote.ui.components.EmptyState
import com.kalcode.remote.ui.components.Eyebrow
import com.kalcode.remote.ui.components.FilterPill
import com.kalcode.remote.ui.components.GhostButton
import com.kalcode.remote.ui.components.KcCard
import com.kalcode.remote.ui.components.MonoChip
import com.kalcode.remote.ui.components.Notice
import com.kalcode.remote.ui.components.PrimaryButton
import com.kalcode.remote.ui.components.SecondaryButton
import com.kalcode.remote.ui.components.SectionHeader
import com.kalcode.remote.ui.components.StateChip
import com.kalcode.remote.ui.components.elapsedMillis
import com.kalcode.remote.ui.components.formatDuration
import com.kalcode.remote.ui.components.presentation
import com.kalcode.remote.ui.components.rememberHaptics
import com.kalcode.remote.ui.components.stale
import com.kalcode.remote.ui.headingSemantics
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.KcText
import com.kalcode.remote.ui.theme.LocalNow
import com.kalcode.remote.ui.theme.SpaceBackground
import com.kalcode.remote.ui.theme.SpaceLevel
import com.kalcode.remote.ui.theme.Tone
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FleetScreen(selectedAgentId: String?, onOpenAgent: (String) -> Unit) {
    val client = LocalClient.current
    val messages = LocalMessages.current
    val scope = rememberCoroutineScope()
    val fleet by client.fleet.collectAsStateWithLifecycle()
    val status by client.status.collectAsStateWithLifecycle()
    val workstation by client.workstation.collectAsStateWithLifecycle()
    val lastUpdate by client.lastUpdate.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableStateOf(FleetFilter.ALL) }
    var launching by remember { mutableStateOf(false) }
    val agents = remember(fleet.agents, filter) { fleet.sortedAgents(filter) }
    val needs = remember(fleet.needsYou) { fleet.sortedNeedsYou }
    val agentNames = remember(fleet.agents) { fleet.agents.associate { it.id to it.name } }
    val online = status == ConnectionStatus.Online
    val listState = rememberLazyListState()

    SpaceBackground(SpaceLevel.CINEMATIC) {
        // Lists stop at the status bar: the space background shows there, never scrolled text.
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top)).testTag("fleetList"),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 104.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item(key = "header", contentType = "header") {
                FleetHeader(
                    workstation = workstation,
                    fleet = fleet,
                    status = status,
                    lastUpdate = lastUpdate,
                    onRetry = client::retryNow,
                    onFilter = { filter = it },
                    onCloseIdle = {
                        scope.launch {
                            runCatching { client.call(Ops.TIDY_CLOSE_IDLE, args(), Summary.serializer()) }
                                .onSuccess { messages.post(it.summary) }
                                .onFailure { messages.post(it.message ?: "Couldn't close idle agents") }
                        }
                    },
                )
            }
            if (needs.isNotEmpty()) {
                item(key = "needs-header", contentType = "section") {
                    SectionHeader("Needs you", count = needs.size, modifier = Modifier.padding(top = 4.dp))
                }
                items(needs, key = { "needs:" + it.id }, contentType = { "needs" }) { item ->
                    NeedsYouCard(
                        item = item,
                        agentName = item.agentId?.let(agentNames::get),
                        enabled = online,
                        onOpenAgent = item.agentId?.takeIf { agentNames.containsKey(it) }?.let { id -> { onOpenAgent(id) } },
                        modifier = Modifier.animateItem().stale(!online),
                    )
                }
            }
            stickyHeader(key = "filters", contentType = "filters") {
                FilterRow(fleet, filter) { filter = it }
            }
            if (agents.isEmpty()) {
                item(key = "empty", contentType = "empty") {
                    if (fleet.agents.isEmpty()) {
                        EmptyState(
                            Icons.Outlined.AutoAwesome,
                            if (fleet.hasSnapshot) "No agents running" else "Connecting to your workstation",
                            if (fleet.hasSnapshot) "Launch one here or on your desktop. It shows up live." else "Agents appear as soon as the workstation answers.",
                        )
                    } else {
                        EmptyState(Icons.Outlined.Inbox, "Nothing here", "No agent is ${filter.title.lowercase()} right now.")
                    }
                }
            }
            items(agents, key = { it.id }, contentType = { "agent" }) { agent ->
                AgentCard(
                    agent = agent,
                    selected = agent.id == selectedAgentId,
                    onClick = { onOpenAgent(agent.id) },
                    modifier = Modifier.animateItem().stale(!online),
                )
            }
        }
        val fabExpanded = listState.firstVisibleItemIndex < 2
        ExtendedFloatingActionButton(
            onClick = { launching = true },
            expanded = fabExpanded,
            icon = { Icon(Icons.Outlined.Add, contentDescription = if (fabExpanded) null else "Launch agent") },
            text = { Text("Launch agent", style = MaterialTheme.typography.labelLarge) },
            containerColor = Kc.Constellation,
            contentColor = Kc.AccentFg,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.End))
                .padding(20.dp)
                .testTag("launchFab"),
        )
    }
    if (launching) {
        LaunchSheet(
            onDismiss = { launching = false },
            onLaunched = { summary, id ->
                launching = false
                messages.post(summary)
                // Open the new agent once the workstation reports it (it arrives in the next patch).
                if (id != null) {
                    scope.launch {
                        if (withTimeoutOrNull(5_000) { client.fleet.first { it.agent(id) != null } } != null) onOpenAgent(id)
                    }
                }
            },
        )
    }
}

@Composable
private fun FleetHeader(
    workstation: PairedWorkstation?,
    fleet: FleetState,
    status: ConnectionStatus,
    lastUpdate: Long?,
    onRetry: () -> Unit,
    onFilter: (FleetFilter) -> Unit,
    onCloseIdle: () -> Unit,
) {
    val ws = fleet.workstation
    var menu by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 12.dp, bottom = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Image(painterResource(R.drawable.kalcode_mark), contentDescription = null, modifier = Modifier.size(30.dp))
            Spacer(Modifier.width(10.dp))
            Eyebrow("Mission Control", color = Kc.AccentText)
            Spacer(Modifier.weight(1f))
            ConnectionPill(status)
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "More", tint = Kc.Nebula) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = Kc.Overlay) {
                    DropdownMenuItem(
                        text = { Text("Close idle agents") },
                        leadingIcon = { Icon(Icons.Outlined.CleaningServices, null) },
                        enabled = status == ConnectionStatus.Online,
                        onClick = {
                            menu = false
                            onCloseIdle()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Reconnect now") },
                        leadingIcon = { Icon(Icons.Outlined.Refresh, null) },
                        onClick = {
                            menu = false
                            onRetry()
                        },
                    )
                }
            }
        }
        Spacer(Modifier.height(18.dp))
        Text(
            ws?.name ?: workstation?.name ?: "Workstation",
            style = MaterialTheme.typography.displaySmall,
            color = Kc.Starlight,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.headingSemantics(),
        )
        Spacer(Modifier.height(4.dp))
        val platform = (ws?.platform ?: workstation?.hostPlatform).orEmpty().replaceFirstChar { it.uppercase() }
        val version = ws?.version ?: workstation?.hostVersion
        val active = fleet.activeWorkspace?.name
        Text(
            listOfNotNull(
                platform.takeIf { it.isNotBlank() },
                version?.takeIf { it.isNotBlank() }?.let { "KalCode $it" },
                active?.let { "Active: $it" },
            ).joinToString("  ·  "),
            style = MaterialTheme.typography.bodyMedium,
            color = Kc.Nebula,
        )
        Spacer(Modifier.height(18.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth().stale(status != ConnectionStatus.Online)) {
            StatTile("Working", fleet.count(FleetFilter.WORKING), Tone.Working, Modifier.weight(1f)) { onFilter(FleetFilter.WORKING) }
            StatTile("Needs you", fleet.count(FleetFilter.NEEDS_YOU), Tone.Waiting, Modifier.weight(1f)) { onFilter(FleetFilter.NEEDS_YOU) }
            StatTile("Failed", fleet.count(FleetFilter.FAILED), Tone.Failed, Modifier.weight(1f)) { onFilter(FleetFilter.FAILED) }
            StatTile("Done", fleet.count(FleetFilter.DONE), Tone.Done, Modifier.weight(1f)) { onFilter(FleetFilter.DONE) }
        }
        when (status) {
            is ConnectionStatus.Reconnecting, ConnectionStatus.Connecting -> {
                Spacer(Modifier.height(12.dp))
                val now by LocalNow.current
                val ago = lastUpdate?.let { formatDuration(now - it) }
                Notice(
                    if (ago != null && fleet.hasSnapshot) "Reconnecting. Showing the state from $ago ago." else "Connecting to your workstation…",
                    Tone.Waiting,
                    icon = Icons.Outlined.SyncProblem,
                    action = { GhostButton("Retry", onRetry, color = Kc.WaitingText) },
                )
            }
            is ConnectionStatus.Offline -> {
                Spacer(Modifier.height(12.dp))
                Notice(status.reason.message, Tone.Muted, icon = Icons.Outlined.CloudOff, action = { GhostButton("Try again", onRetry) })
            }
            else -> Unit
        }
    }
}

@Composable
private fun StatTile(label: String, value: Int, tone: Tone, modifier: Modifier, onClick: () -> Unit) {
    KcCard(
        modifier = modifier.semantics(mergeDescendants = true) { contentDescription = "$value $label" },
        onClick = onClick,
        padding = PaddingValues(horizontal = 10.dp, vertical = 12.dp),
        background = Kc.Surface1,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "$value",
                style = MaterialTheme.typography.headlineSmall.copy(fontFamily = com.kalcode.remote.ui.theme.JetBrainsMono),
                color = if (value > 0) tone.text else Kc.TextFaint,
            )
            Spacer(Modifier.weight(1f))
            Box(Modifier.size(7.dp).background(if (value > 0) tone.color else Kc.MutedLine, androidx.compose.foundation.shape.CircleShape))
        }
        Spacer(Modifier.height(2.dp))
        Text(label, style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.5.sp), color = Kc.Nebula, maxLines = 1, softWrap = false)
    }
}

@Composable
private fun FilterRow(fleet: FleetState, filter: FleetFilter, onSelect: (FleetFilter) -> Unit) {
    val haptics = rememberHaptics()
    LazyRow(
        Modifier
            .fillMaxWidth()
            .background(androidx.compose.ui.graphics.Brush.verticalGradient(0f to Kc.Graphite, 0.8f to Kc.Graphite, 1f to Color.Transparent))
            .padding(vertical = 8.dp)
            .testTag("filters"),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(FleetFilter.entries, key = { it.name }) { f ->
            val tone = when (f) {
                FleetFilter.NEEDS_YOU -> Tone.Waiting
                FleetFilter.WORKING -> Tone.Working
                FleetFilter.FAILED -> Tone.Failed
                FleetFilter.DONE -> Tone.Done
                FleetFilter.ALL -> null
            }
            FilterPill(f.title, fleet.count(f), f == filter, onClick = {
                haptics.tick()
                onSelect(f)
            }, tone = tone)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AgentCard(agent: Agent, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val p = agent.state.presentation()
    val lit = when {
        selected -> Kc.BorderLit
        agent.state == AgentState.NEEDS_YOU -> Kc.WaitingLine
        agent.state == AgentState.FAILED -> Kc.FailedLine
        else -> null
    }
    val now by LocalNow.current
    val elapsed = elapsedMillis(agent, now)
    KcCard(
        modifier = modifier
            .fillMaxWidth()
            .testTag("agent:${agent.id}")
            .semantics(mergeDescendants = true) {
                contentDescription = buildString {
                    append(agent.name).append(", ").append(p.label)
                    append(", ").append(agent.providerName)
                    agent.accountLabel?.let { append(" ").append(it) }
                    agent.model?.let { append(", ").append(it) }
                    agent.effort?.let { append(" ").append(it) }
                    elapsed?.let { append(", ").append(formatDuration(it)) }
                    (agent.error ?: agent.activity)?.let { append(", ").append(it) }
                }
            },
        lit = lit,
        background = if (selected) Kc.Surface3 else Kc.Surface2,
        onClick = onClick,
        onClickLabel = "Open agent",
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StateChip(agent.state)
            Spacer(Modifier.weight(1f))
            Icon(Icons.Outlined.Schedule, contentDescription = null, tint = Kc.TextFaint, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            ElapsedText(agent)
        }
        Spacer(Modifier.height(10.dp))
        Text(agent.name, style = MaterialTheme.typography.titleMedium, color = Kc.Starlight, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(3.dp))
        Text(
            agent.providerName + "  ·  " + (agent.accountLabel ?: "Default account") + "  ·  " + agent.workspaceName,
            style = MaterialTheme.typography.bodySmall,
            color = Kc.Nebula,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(10.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            MonoChip(
                listOfNotNull(agent.model ?: "model unknown", agent.effort).joinToString(" · "),
                icon = Icons.Outlined.AutoAwesome,
                color = Kc.Icy,
            )
            agent.branch?.let { MonoChip(if (agent.worktree) "$it · worktree" else it, icon = Icons.AutoMirrored.Outlined.CallSplit) }
        }
        val line = agent.error ?: agent.activity
        if (line != null) {
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (agent.error != null) Icons.Outlined.ErrorOutline else Icons.Outlined.Bolt,
                    contentDescription = null,
                    tint = if (agent.error != null) Kc.FailedText else p.tone.text,
                    modifier = Modifier.size(15.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    line,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (agent.error != null) Kc.FailedText else Kc.TextSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (agent.filesChanged > 0 || agent.pendingApprovals > 0) {
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                if (agent.filesChanged > 0) {
                    Meta(Icons.AutoMirrored.Outlined.InsertDriveFile, "${agent.filesChanged} file${if (agent.filesChanged == 1) "" else "s"} changed")
                }
                if (agent.pendingApprovals > 0) {
                    Meta(Icons.Outlined.Shield, "${agent.pendingApprovals} approval${if (agent.pendingApprovals == 1) "" else "s"}", Kc.WaitingText)
                }
            }
        }
    }
}

@Composable
private fun Meta(icon: ImageVector, text: String, color: Color = Kc.TextSecondary) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = color.copy(alpha = 0.8f), modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(5.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

private fun needsIcon(kind: String): ImageVector = when (kind) {
    "approval" -> Icons.Outlined.Shield
    "question" -> Icons.AutoMirrored.Outlined.HelpOutline
    "failed" -> Icons.Outlined.ErrorOutline
    "auth" -> Icons.Outlined.Key
    "stalled" -> Icons.Outlined.SyncProblem
    "review" -> Icons.Outlined.RateReview
    else -> Icons.Outlined.Bolt
}

private fun needsLabel(kind: String): String = when (kind) {
    "approval" -> "Approval"
    "question" -> "Question"
    "failed" -> "Failed"
    "auth" -> "Sign-in needed"
    "stalled" -> "Stalled"
    "review" -> "Review"
    else -> kind.replaceFirstChar { it.uppercase() }
}

/** A decision or blocker the person owns. Approve once / Deny only (§1 least privilege). */
@Composable
fun NeedsYouCard(item: NeedsYouItem, agentName: String?, enabled: Boolean, onOpenAgent: (() -> Unit)?, modifier: Modifier = Modifier) {
    val client = LocalClient.current
    val messages = LocalMessages.current
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    var busy by remember(item.id) { mutableStateOf<String?>(null) }
    val tone = if (item.kind == "failed") Tone.Failed else Tone.Waiting
    fun decide(decision: String) {
        val approval = item.approvalId ?: return
        busy = decision
        haptics.press()
        scope.launch {
            runCatching { client.call(Ops.NEEDS_DECIDE, args("approvalId" to approval, "decision" to decision), DecideResult.serializer()) }
                .onSuccess {
                    if (decision == "approve_once") haptics.confirm() else haptics.reject()
                    messages.post(
                        when (it.status) {
                            "approved" -> "Approved once"
                            "denied" -> "Denied"
                            "already_answered" -> "Already answered"
                            else -> it.status
                        },
                    )
                }
                .onFailure {
                    haptics.reject()
                    messages.post(it.message ?: "Couldn't send your answer")
                }
            busy = null
        }
    }
    KcCard(modifier.fillMaxWidth().testTag("needs:${item.id}"), lit = tone.line) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(needsIcon(item.kind), contentDescription = null, tint = tone.text, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Eyebrow(needsLabel(item.kind), color = tone.text)
            Spacer(Modifier.weight(1f))
            AgoText(item.createdAt)
        }
        Spacer(Modifier.height(10.dp))
        Text(item.title, style = MaterialTheme.typography.titleMedium, color = Kc.Starlight)
        if (item.detail.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(item.detail, style = MaterialTheme.typography.bodyMedium, color = Kc.TextSecondary)
        }
        if (agentName != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                agentName,
                style = KcText.Mono,
                color = Kc.AccentText,
                modifier = if (onOpenAgent != null) Modifier.clickable(onClickLabel = "Open agent", onClick = onOpenAgent) else Modifier,
            )
        }
        if (item.canApprove || item.canDeny || onOpenAgent != null) {
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                if (item.canApprove) {
                    PrimaryButton(
                        "Approve once", { decide("approve_once") },
                        enabled = enabled && busy == null, busy = busy == "approve_once",
                        modifier = Modifier.weight(1f).testTag("approve:${item.id}"),
                    )
                }
                if (item.canDeny) {
                    SecondaryButton(
                        "Deny", { decide("deny") },
                        enabled = enabled && busy == null, busy = busy == "deny",
                        modifier = Modifier.weight(1f).testTag("deny:${item.id}"),
                        tone = Kc.FailedText,
                    )
                }
                if (!item.canApprove && !item.canDeny && onOpenAgent != null) {
                    SecondaryButton("Open agent", onOpenAgent, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}
