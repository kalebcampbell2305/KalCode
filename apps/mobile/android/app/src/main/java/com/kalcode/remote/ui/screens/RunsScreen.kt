package com.kalcode.remote.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.automirrored.outlined.CallSplit
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FlagCircle
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.RocketLaunch
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.protocol.Environment
import com.kalcode.remote.protocol.Ops
import com.kalcode.remote.protocol.Run
import com.kalcode.remote.protocol.RunDetail
import com.kalcode.remote.protocol.Service
import com.kalcode.remote.ui.Dest
import com.kalcode.remote.ui.LocalClient
import com.kalcode.remote.ui.args
import com.kalcode.remote.ui.call
import com.kalcode.remote.ui.components.AgoText
import com.kalcode.remote.ui.components.ConnectionPill
import com.kalcode.remote.ui.components.EmptyState
import com.kalcode.remote.ui.components.Eyebrow
import com.kalcode.remote.ui.components.InfoRow
import com.kalcode.remote.ui.components.KcCard
import com.kalcode.remote.ui.components.MonoChip
import com.kalcode.remote.ui.components.Notice
import com.kalcode.remote.ui.components.SecondaryButton
import com.kalcode.remote.ui.components.SectionHeader
import com.kalcode.remote.ui.components.StatusDot
import com.kalcode.remote.ui.components.StatusPill
import com.kalcode.remote.ui.components.humanize
import com.kalcode.remote.ui.components.stale
import com.kalcode.remote.ui.components.statusTone
import com.kalcode.remote.ui.headingSemantics
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.KcText
import com.kalcode.remote.ui.theme.SpaceBackground
import com.kalcode.remote.ui.theme.SpaceLevel
import com.kalcode.remote.ui.theme.Tone

@Composable
fun RunsScreen(selected: Dest?, onOpen: (Dest) -> Unit) {
    val client = LocalClient.current
    val fleet by client.fleet.collectAsStateWithLifecycle()
    val status by client.status.collectAsStateWithLifecycle()
    val online = status == ConnectionStatus.Online
    val runs = remember(fleet.runs) { fleet.runs.sortedByDescending { it.updatedAt ?: 0 } }
    SpaceBackground(SpaceLevel.STANDARD) {
        LazyColumn(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top)).testTag("runsList"),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item("head") {
                Column(Modifier.padding(top = 16.dp, bottom = 8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Eyebrow("Operations", color = Kc.AccentText)
                        Spacer(Modifier.weight(1f))
                        ConnectionPill(status)
                    }
                    Spacer(Modifier.height(14.dp))
                    Text("Runs", style = MaterialTheme.typography.displaySmall, color = Kc.Starlight, modifier = Modifier.headingSemantics())
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "${runs.count { it.status == "running" }} running  ·  ${fleet.services.count { it.status == "running" }} services up  ·  ${fleet.environments.size} environments",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Kc.Nebula,
                    )
                }
            }
            item("runs-h") { SectionHeader("Runs", count = runs.size) }
            if (runs.isEmpty()) item("runs-empty") { Text("No runs right now.", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula) }
            items(runs, key = { "run:" + it.id }) { run ->
                RunCard(run, selected = selected == Dest.Run(run.id), modifier = Modifier.stale(!online)) { onOpen(Dest.Run(run.id)) }
            }
            item("svc-h") { SectionHeader("Services", count = fleet.services.size, modifier = Modifier.padding(top = 8.dp)) }
            if (fleet.services.isEmpty()) item("svc-empty") { Text("No services running.", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula) }
            if (fleet.services.isNotEmpty()) {
                item("services") {
                    KcCard(Modifier.fillMaxWidth().stale(!online), padding = PaddingValues(vertical = 4.dp)) {
                        fleet.services.forEachIndexed { i, svc ->
                            ServiceRow(svc)
                            if (i < fleet.services.lastIndex) {
                                Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp).height(1.dp).background(Kc.BorderSubtle))
                            }
                        }
                    }
                }
            }
            item("env-h") { SectionHeader("Environments", count = fleet.environments.size, modifier = Modifier.padding(top = 8.dp)) }
            if (fleet.environments.isEmpty()) item("env-empty") { Text("No environments configured.", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula) }
            items(fleet.environments, key = { "env:" + it.id }) { env ->
                EnvironmentCard(env, selected = selected == Dest.Environment(env.id), modifier = Modifier.stale(!online)) { onOpen(Dest.Environment(env.id)) }
            }
            item("inset") { Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars)) }
        }
    }
}

private fun runIcon(kind: String) = when (kind) {
    "deploy" -> Icons.Outlined.RocketLaunch
    "test" -> Icons.Outlined.CheckCircle
    else -> Icons.Outlined.HourglassTop
}

@Composable
private fun RunCard(run: Run, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val tone = statusTone(run.status)
    KcCard(
        modifier.fillMaxWidth().testTag("run:${run.id}"),
        lit = if (selected) Kc.BorderLit else if (run.status == "failed") Kc.FailedLine else null,
        background = if (selected) Kc.Surface3 else Kc.Surface2,
        onClick = onClick,
        onClickLabel = "Open run",
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(runIcon(run.kind), contentDescription = null, tint = Kc.AccentText, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Eyebrow(run.kind.ifBlank { "run" })
            Spacer(Modifier.weight(1f))
            StatusPill(humanize(run.status), tone, live = run.status == "running")
        }
        Spacer(Modifier.height(10.dp))
        Text(run.title, style = MaterialTheme.typography.titleMedium, color = Kc.Starlight)
        val line = run.currentAction ?: run.outcome
        if (line != null) {
            Spacer(Modifier.height(4.dp))
            Text(line, style = KcText.Mono, color = Kc.TextSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            run.branch?.let { MonoChip(it, icon = Icons.AutoMirrored.Outlined.CallSplit) }
            Spacer(Modifier.weight(1f))
            AgoText(run.updatedAt, prefix = "Updated ")
        }
    }
}

@Composable
private fun ServiceRow(svc: Service) {
    val tone = statusTone(svc.status)
    val uri = LocalUriHandler.current
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics(mergeDescendants = true) { contentDescription = "${svc.name}, ${svc.status}${svc.url?.let { ", $it" } ?: ""}" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Dns, contentDescription = null, tint = Kc.Nebula, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(svc.name, style = MaterialTheme.typography.titleSmall, color = Kc.Starlight)
            svc.url?.let { Text(it, style = KcText.MonoSmall, color = Kc.TextFaint, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        StatusDot(tone, live = svc.status == "running")
        Spacer(Modifier.width(8.dp))
        Text(humanize(svc.status), style = MaterialTheme.typography.labelMedium, color = tone.text)
        // localhost URLs are on the workstation, not this phone: shown, never opened.
        val external = svc.url?.takeIf { it.startsWith("https://") }
        if (external != null) {
            androidx.compose.material3.IconButton(onClick = { runCatching { uri.openUri(external) } }) {
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = "Open ${svc.name}", tint = Kc.AccentText, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun EnvironmentCard(env: Environment, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val deploy = statusTone(env.deploymentStatus)
    KcCard(
        modifier.fillMaxWidth().testTag("env:${env.id}"),
        lit = if (selected) Kc.BorderLit else null,
        background = if (selected) Kc.Surface3 else Kc.Surface2,
        onClick = onClick,
        onClickLabel = "Open environment",
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Cloud, contentDescription = null, tint = Kc.AccentText, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Eyebrow(env.kind.ifBlank { "environment" })
            Spacer(Modifier.weight(1f))
            StatusPill(humanize(env.deploymentStatus), deploy, live = env.deploymentStatus == "deploying")
        }
        Spacer(Modifier.height(10.dp))
        Text(env.name, style = MaterialTheme.typography.titleMedium, color = Kc.Starlight)
        env.url?.let {
            Spacer(Modifier.height(2.dp))
            Text(it, style = KcText.Mono, color = Kc.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            env.health?.let {
                StatusDot(statusTone(it), size = 7.dp)
                Spacer(Modifier.width(6.dp))
                Text(humanize(it), style = MaterialTheme.typography.labelMedium, color = statusTone(it).text)
            }
            Spacer(Modifier.weight(1f))
            AgoText(env.lastDeployAt, prefix = "Deployed ")
        }
    }
}

@Composable
fun RunScreen(runId: String, onBack: () -> Unit, inPane: Boolean = false) {
    val client = LocalClient.current
    val fleet by client.fleet.collectAsStateWithLifecycle()
    val status by client.status.collectAsStateWithLifecycle()
    val run = fleet.run(runId)
    var detail by remember(runId) { mutableStateOf<RunDetail?>(null) }
    var error by remember(runId) { mutableStateOf<String?>(null) }
    LaunchedEffect(runId, run?.updatedAt, run?.status, status == ConnectionStatus.Online) {
        if (status != ConnectionStatus.Online || run == null) return@LaunchedEffect
        runCatching { client.call(Ops.RUN_DETAIL, args("runId" to runId), RunDetail.serializer()) }
            .onSuccess {
                detail = it
                error = null
            }
            .onFailure { if (detail == null) error = it.message }
    }
    SpaceBackground(SpaceLevel.QUIET) {
        Column(Modifier.fillMaxSize()) {
            DetailTopBar(title = if (inPane) "" else "Run", onBack = onBack)
            if (run == null) {
                EmptyState(Icons.Outlined.FlagCircle, "This run has finished", "It's no longer on your workstation.", action = { SecondaryButton("Back", onBack) })
                return@Column
            }
            LazyColumn(
                Modifier.fillMaxSize().testTag("runDetail"),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item("head") {
                    Column {
                        StatusPill(humanize(run.status), statusTone(run.status), live = run.status == "running")
                        Spacer(Modifier.height(10.dp))
                        Text(run.title, style = MaterialTheme.typography.headlineSmall, color = Kc.Starlight, modifier = Modifier.headingSemantics())
                        Spacer(Modifier.height(10.dp))
                        KcCard(Modifier.fillMaxWidth()) {
                            InfoRow("Kind", humanize(run.kind))
                            run.branch?.let { InfoRow("Branch", it, mono = true) }
                            run.currentAction?.let { InfoRow("Now", it, mono = true) }
                            run.outcome?.let { InfoRow("Outcome", it) }
                            run.agentId?.let { id -> InfoRow("Agent", fleet.agent(id)?.name ?: id) }
                        }
                    }
                }
                val d = detail
                when {
                    d == null && error != null -> item("err") { Notice(error!!, Tone.Failed, icon = Icons.Outlined.ErrorOutline) }
                    d == null -> item("loading") {
                        Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = Kc.Constellation, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                        }
                    }
                    else -> {
                        if (d.tests.isNotEmpty()) {
                            item("tests-h") { SectionHeader("Tests", count = d.tests.size) }
                            item("tests") {
                                KcCard(Modifier.fillMaxWidth(), padding = PaddingValues(vertical = 6.dp)) {
                                    d.tests.forEach { t ->
                                        val (icon, tint) = when (t.status) {
                                            "passed" -> Icons.Outlined.CheckCircle to Kc.WorkingText
                                            "failed" -> Icons.Outlined.ErrorOutline to Kc.FailedText
                                            "skipped" -> Icons.Outlined.RemoveCircleOutline to Kc.Nebula
                                            else -> Icons.Outlined.HourglassTop to Kc.AccentText
                                        }
                                        Row(
                                            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 9.dp)
                                                .semantics(mergeDescendants = true) { contentDescription = "${t.name}, ${t.status}" },
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            Icon(icon, null, tint = tint, modifier = Modifier.size(16.dp))
                                            Spacer(Modifier.width(10.dp))
                                            Text(t.name, style = KcText.Mono, color = Kc.Starlight, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                            t.durationMs?.let { Text("${it} ms", style = KcText.MonoSmall, color = Kc.TextFaint) }
                                        }
                                    }
                                }
                            }
                        }
                        item("logs-h") { SectionHeader("Logs", count = d.logs.size) }
                        item("logs") {
                            KcCard(Modifier.fillMaxWidth(), background = Kc.Sunken, padding = PaddingValues(vertical = 12.dp)) {
                                Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp)) {
                                    if (d.logs.isEmpty()) Text("No log output.", style = KcText.Mono, color = Kc.TextFaint)
                                    d.logs.forEach { Text(it, style = KcText.MonoCode, color = Kc.TextSecondary, softWrap = false) }
                                }
                            }
                        }
                    }
                }
                item("inset") { Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars)) }
            }
        }
    }
}

@Composable
fun EnvironmentScreen(envId: String, onBack: () -> Unit, inPane: Boolean = false) {
    val client = LocalClient.current
    val fleet by client.fleet.collectAsStateWithLifecycle()
    val env = fleet.environments.firstOrNull { it.id == envId }
    val uri = LocalUriHandler.current
    SpaceBackground(SpaceLevel.STANDARD) {
        Column(Modifier.fillMaxSize()) {
            DetailTopBar(title = if (inPane) "" else "Environment", onBack = onBack)
            if (env == null) {
                EmptyState(Icons.Outlined.FlagCircle, "This environment is gone", "It was removed on your workstation.", action = { SecondaryButton("Back", onBack) })
                return@Column
            }
            Column(Modifier.padding(horizontal = 16.dp).testTag("envDetail")) {
                StatusPill(humanize(env.deploymentStatus), statusTone(env.deploymentStatus), live = env.deploymentStatus == "deploying")
                Spacer(Modifier.height(10.dp))
                Text(env.name, style = MaterialTheme.typography.headlineSmall, color = Kc.Starlight, modifier = Modifier.headingSemantics())
                Spacer(Modifier.height(14.dp))
                KcCard(Modifier.fillMaxWidth()) {
                    InfoRow("Kind", humanize(env.kind))
                    InfoRow("Deployment", humanize(env.deploymentStatus))
                    InfoRow("Health", env.health?.let(::humanize) ?: "Unknown")
                    env.url?.let { InfoRow("URL", it, mono = true) }
                    Row(Modifier.padding(vertical = 7.dp)) {
                        Text("Last deploy", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula, modifier = Modifier.width(118.dp))
                        AgoText(env.lastDeployAt, color = Kc.Starlight)
                    }
                }
                env.url?.takeIf { it.startsWith("https://") }?.let { url ->
                    Spacer(Modifier.height(14.dp))
                    SecondaryButton("Open ${env.name}", { runCatching { uri.openUri(url) } }, icon = Icons.AutoMirrored.Outlined.OpenInNew, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}
