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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FlagCircle
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.protocol.DiffFile
import com.kalcode.remote.protocol.DiffLineKind
import com.kalcode.remote.protocol.DiffResult
import com.kalcode.remote.protocol.Ops
import com.kalcode.remote.ui.LocalClient
import com.kalcode.remote.ui.args
import com.kalcode.remote.ui.components.EmptyState
import com.kalcode.remote.ui.components.KcCard
import com.kalcode.remote.ui.components.Notice
import com.kalcode.remote.ui.components.SecondaryButton
import com.kalcode.remote.ui.headingSemantics
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.KcText
import com.kalcode.remote.ui.theme.SpaceBackground
import com.kalcode.remote.ui.theme.SpaceLevel
import com.kalcode.remote.ui.theme.Tone

/** The agent's changes: files, colored hunks in JetBrains Mono, each hunk scrolls sideways. */
@Composable
fun DiffScreen(agentId: String, onBack: () -> Unit) {
    val client = LocalClient.current
    val fleet by client.fleet.collectAsStateWithLifecycle()
    val status by client.status.collectAsStateWithLifecycle()
    val agent = fleet.agent(agentId)
    var diff by remember(agentId) { mutableStateOf<DiffResult?>(null) }
    var error by remember(agentId) { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(agentId, reload, status == ConnectionStatus.Online) {
        if (status != ConnectionStatus.Online) return@LaunchedEffect
        error = null
        runCatching { DiffResult.parse(client.request(Ops.AGENT_DIFF, args("agentId" to agentId, "maxBytes" to null))) }
            .onSuccess { diff = it }
            .onFailure { error = it.message }
    }

    // Code is a dense surface: quiet space, no nebula behind it.
    SpaceBackground(SpaceLevel.QUIET) {
        Column(Modifier.fillMaxSize()) {
            DetailTopBar(title = "Diff", onBack = onBack, trailing = {
                IconButton(onClick = { reload++ }) { Icon(Icons.Outlined.Refresh, contentDescription = "Refresh diff", tint = Kc.Nebula) }
            })
            val d = diff
            LazyColumn(
                Modifier.fillMaxSize().testTag("diff"),
                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item("head") {
                    Column(Modifier.padding(horizontal = 4.dp, vertical = 4.dp)) {
                        Text(agent?.name ?: "Changes", style = MaterialTheme.typography.titleLarge, color = Kc.Starlight, modifier = Modifier.headingSemantics())
                        if (d != null) {
                            val adds = d.files.sumOf { it.additions }
                            val dels = d.files.sumOf { it.deletions }
                            Spacer(Modifier.height(4.dp))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("+$adds", style = KcText.Mono, color = Kc.WorkingText)
                                Spacer(Modifier.width(8.dp))
                                Text("−$dels", style = KcText.Mono, color = Kc.FailedText)
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    "across ${d.files.size} file${if (d.files.size == 1) "" else "s"}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = Kc.Nebula,
                                )
                            }
                        }
                    }
                }
                when {
                    agent == null && d == null -> item("gone") {
                        EmptyState(Icons.Outlined.FlagCircle, "This agent has finished", "Its changes stay in KalCode on your desktop.", action = { SecondaryButton("Back", onBack) })
                    }
                    error != null && d == null -> item("err") { Notice(error!!, Tone.Failed, icon = Icons.Outlined.ErrorOutline) }
                    d == null -> item("loading") {
                        Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = Kc.Constellation, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                        }
                    }
                    d.files.isEmpty() -> item("clean") { EmptyState(Icons.Outlined.TaskAlt, "No changes", "The working tree matches its base.") }
                    else -> {
                        items(d.files, key = { it.path }) { file -> DiffFileCard(file) }
                        if (d.truncated) {
                            item("trunc") {
                                Notice("This diff is large, so the rest is on your desktop.", Tone.Muted, icon = Icons.Outlined.Info)
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
private fun DiffFileCard(file: DiffFile) {
    val (statusLabel, tone) = when (file.status) {
        "added" -> "Added" to Tone.Working
        "deleted" -> "Deleted" to Tone.Failed
        "renamed" -> "Renamed" to Tone.Active
        else -> "Modified" to Tone.Muted
    }
    KcCard(Modifier.fillMaxWidth(), padding = PaddingValues(0.dp), background = Kc.Surface1) {
        Row(
            Modifier.fillMaxWidth().background(Kc.Surface2).padding(horizontal = 14.dp, vertical = 12.dp)
                .semantics(mergeDescendants = true) { contentDescription = "${file.path}, $statusLabel, ${file.additions} added, ${file.deletions} removed" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(file.path, style = KcText.Mono, color = Kc.Starlight, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.width(8.dp))
            Text(statusLabel, style = MaterialTheme.typography.labelSmall, color = tone.text,
                modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(tone.soft).padding(horizontal = 6.dp, vertical = 2.dp))
            Spacer(Modifier.width(10.dp))
            Text("+${file.additions}", style = KcText.MonoSmall, color = Kc.WorkingText)
            Spacer(Modifier.width(6.dp))
            Text("−${file.deletions}", style = KcText.MonoSmall, color = Kc.FailedText)
        }
        // One horizontal scroll per file keeps all of its hunks aligned.
        val scroll = rememberScrollState()
        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth()) {
          val viewport = maxWidth
          Column(Modifier.fillMaxWidth().horizontalScroll(scroll)) {
            // As wide as the longest line, never narrower than the card: tints span every row.
            Column(Modifier.width(androidx.compose.foundation.layout.IntrinsicSize.Max).widthIn(min = viewport)) {
                file.hunks.forEach { hunk ->
                    Text(
                        hunk.header,
                        style = KcText.MonoCode,
                        color = Kc.AccentText,
                        softWrap = false,
                        modifier = Modifier.background(Kc.DiffHunkBg).padding(horizontal = 12.dp, vertical = 4.dp).fillMaxWidth(),
                    )
                    hunk.lines.forEach { line ->
                        val (bg, sign, color) = when (line.kind) {
                            DiffLineKind.ADD -> Triple(Kc.DiffAddBg, "+", Kc.WorkingText)
                            DiffLineKind.DEL -> Triple(Kc.DiffDelBg, "−", Kc.FailedText)
                            DiffLineKind.CTX -> Triple(androidx.compose.ui.graphics.Color.Transparent, " ", Kc.TextFaint)
                        }
                        Row(Modifier.fillMaxWidth().background(bg).padding(end = 16.dp)) {
                            Text(sign, style = KcText.MonoCode, color = color, modifier = Modifier.width(26.dp).padding(start = 10.dp))
                            Text(
                                line.text,
                                style = KcText.MonoCode,
                                color = if (line.kind == DiffLineKind.CTX) Kc.TextSecondary else Kc.Starlight,
                                softWrap = false,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
            }
          }
        }
    }
}
