package com.kalcode.remote.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.protocol.LogEntry
import com.kalcode.remote.protocol.LogPage
import com.kalcode.remote.protocol.Ops
import com.kalcode.remote.ui.Copy
import com.kalcode.remote.ui.LocalClient
import com.kalcode.remote.ui.args
import com.kalcode.remote.ui.call
import com.kalcode.remote.ui.components.AgoText
import com.kalcode.remote.ui.components.Notice
import com.kalcode.remote.ui.components.SecondaryButton
import com.kalcode.remote.ui.headingSemantics
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.KcText
import com.kalcode.remote.ui.theme.SpaceBackground
import com.kalcode.remote.ui.theme.SpaceLevel
import com.kalcode.remote.ui.theme.Tone
import kotlinx.coroutines.launch

/** The deep transcript (`agent.log`), loaded on demand, newest last, older pages on request. */
@Composable
fun LogScreen(agentId: String, onBack: () -> Unit) {
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val fleet by client.fleet.collectAsStateWithLifecycle()
    val status by client.status.collectAsStateWithLifecycle()
    val ws = client.workstation.collectAsStateWithLifecycle().value?.name ?: "your workstation"
    val online = status == ConnectionStatus.Online
    var entries by remember(agentId) { mutableStateOf<List<LogEntry>?>(null) }
    var more by remember(agentId) { mutableStateOf(false) }
    var loadingEarlier by remember { mutableStateOf(false) }
    var error by remember(agentId) { mutableStateOf<String?>(null) }
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    var landed by remember(agentId) { mutableStateOf(false) }
    // Open at the newest line; loading earlier pages keeps the reader's place.
    LaunchedEffect(entries != null) {
        if (entries != null && !landed) {
            listState.scrollToItem(listState.layoutInfo.totalItemsCount.coerceAtLeast(1) - 1)
            landed = true
        }
    }

    LaunchedEffect(agentId, online) {
        if (!online || entries != null) return@LaunchedEffect
        runCatching { client.call(Ops.AGENT_LOG, args("agentId" to agentId), LogPage.serializer()) }
            .onSuccess {
                entries = it.entries
                more = it.more
            }
            .onFailure { error = Copy.error(it, ws) }
    }

    SpaceBackground(SpaceLevel.QUIET) {
        Column(Modifier.fillMaxSize()) {
            DetailTopBar(title = "Full log", onBack = onBack)
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().testTag("log"),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item("head") {
                    Text(
                        fleet.agent(agentId)?.name ?: "Agent",
                        style = MaterialTheme.typography.titleLarge,
                        color = Kc.Starlight,
                        modifier = Modifier.padding(bottom = 6.dp).headingSemantics(),
                    )
                }
                val list = entries
                when {
                    list == null && !online -> item("wait") {
                        Text("Logs load when $ws is connected.", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula)
                    }
                    list == null && error != null -> item("err") { Notice(error!!, Tone.Failed, icon = Icons.Outlined.ErrorOutline) }
                    list == null -> item("loading") {
                        Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = Kc.Constellation, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                        }
                    }
                    else -> {
                        if (more) {
                            item("earlier") {
                                SecondaryButton(
                                    "Load earlier",
                                    {
                                        val before = list.firstOrNull()?.id ?: return@SecondaryButton
                                        loadingEarlier = true
                                        scope.launch {
                                            runCatching { client.call(Ops.AGENT_LOG, args("agentId" to agentId, "beforeId" to before), LogPage.serializer()) }
                                                .onSuccess {
                                                    entries = it.entries + (entries ?: emptyList())
                                                    more = it.more
                                                }
                                                .onFailure { error = Copy.error(it, ws) }
                                            loadingEarlier = false
                                        }
                                    },
                                    busy = loadingEarlier,
                                    enabled = online,
                                    modifier = Modifier.fillMaxWidth().testTag("loadEarlier"),
                                )
                            }
                        }
                        if (list.isEmpty()) item("none") { Text("No log output.", style = MaterialTheme.typography.bodyMedium, color = Kc.Nebula) }
                        items(list, key = { it.id }) { e -> LogRow(e) }
                    }
                }
                item("inset") { Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars)) }
            }
        }
    }
}

@Composable
private fun LogRow(e: LogEntry) {
    val color = when (e.kind) {
        "message" -> Kc.WorkingText
        "tool" -> Kc.AccentText
        "status" -> Kc.WaitingText
        else -> Kc.TextFaint
    }
    Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Text(e.kind.ifBlank { "log" }, style = KcText.MonoSmall, color = color, modifier = Modifier.width(64.dp))
        Column(Modifier.weight(1f)) {
            Text(e.text, style = KcText.MonoCode, color = Kc.TextSecondary)
            AgoText(e.at)
        }
    }
}
