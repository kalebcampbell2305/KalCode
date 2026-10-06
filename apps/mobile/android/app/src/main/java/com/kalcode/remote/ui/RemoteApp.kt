package com.kalcode.remote.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.kalcode.remote.KalCodeRemoteApp
import com.kalcode.remote.client.ConnectionStatus
import com.kalcode.remote.client.RemoteClient
import com.kalcode.remote.protocol.DeepLink
import com.kalcode.remote.protocol.FleetState
import com.kalcode.remote.protocol.PairingLink
import com.kalcode.remote.ui.components.ControlShape
import com.kalcode.remote.ui.screens.AgentScreen
import com.kalcode.remote.ui.screens.DiffScreen
import com.kalcode.remote.ui.screens.EnvironmentScreen
import com.kalcode.remote.ui.screens.FleetScreen
import com.kalcode.remote.ui.screens.PairingScreen
import com.kalcode.remote.ui.screens.RemovedScreen
import com.kalcode.remote.ui.screens.RunScreen
import com.kalcode.remote.ui.screens.RunsScreen
import com.kalcode.remote.ui.screens.SettingsScreen
import com.kalcode.remote.ui.screens.VoiceScreen
import com.kalcode.remote.ui.theme.Kc
import com.kalcode.remote.ui.theme.KcMotion
import com.kalcode.remote.ui.theme.LocalReducedMotion
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Short messages from any screen ("Sent to …", "This agent has finished"). */
class Messages(val host: SnackbarHostState, private val scope: kotlinx.coroutines.CoroutineScope) {
    /** Shows [text] from the app-wide scope, so it outlives the card or sheet that posted it. */
    fun post(text: String) {
        scope.launch { show(text) }
    }

    suspend fun show(text: String, action: String? = null): Boolean =
        host.showSnackbar(text, actionLabel = action, duration = if (action != null) SnackbarDuration.Long else SnackbarDuration.Short) == SnackbarResult.ActionPerformed
}

val LocalMessages = staticCompositionLocalOf<Messages> { error("Messages not provided") }
val LocalClient = staticCompositionLocalOf<RemoteClient> { error("RemoteClient not provided") }

/** Layout facts every screen may adapt to. */
data class Layout(val twoPane: Boolean, val rail: Boolean)

val LocalLayout = staticCompositionLocalOf { Layout(twoPane = false, rail = false) }

@Composable
fun RemoteApp(app: KalCodeRemoteApp) {
    val client = app.client
    val status by client.status.collectAsStateWithLifecycle()
    val workstation by client.workstation.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val appScope = rememberCoroutineScope()
    val messages = remember { Messages(snackbar, appScope) }
    val navigator = remember { Navigator() }
    var pairLink by remember { mutableStateOf<String?>(null) }

    // Pairing links are handled here; everything else by the main shell once paired.
    LaunchedEffect(Unit) {
        app.pendingLink.filterNotNull().collect { link ->
            when {
                link is DeepLink.Pair -> {
                    pairLink = link.link
                    app.pendingLink.value = null
                }
                client.workstation.value == null -> app.pendingLink.value = null
            }
        }
    }

    CompositionLocalProvider(LocalClient provides client, LocalMessages provides messages) {
        @OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
        Box(Modifier.fillMaxSize().background(Kc.Graphite).semantics { testTagsAsResourceId = true }) {
            when {
                status is ConnectionStatus.Removed -> RemovedScreen(status as ConnectionStatus.Removed, onPairAgain = {
                    navigator.resetAll()
                    client.acknowledgeRemoved()
                })
                workstation == null -> PairingScreen(initialLink = pairLink, onLinkConsumed = { pairLink = null })
                else -> {
                    MainShell(app, navigator)
                    pairLink?.let { link -> ReplacePairingDialog(link, workstation!!.name, onDone = { pairLink = null }) }
                }
            }
            SnackbarHost(
                snackbar,
                // Top banner: never covers a composer, the keyboard, the FAB or the tab bar.
                Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 8.dp).widthIn(max = 560.dp),
            ) { data -> Banner(data) }
        }
    }
}

/** A KalCode banner: graphite glass, hairline, action in Constellation, tap X to dismiss. */
@Composable
private fun Banner(data: androidx.compose.material3.SnackbarData) {
    Row(
        Modifier
            .padding(horizontal = 12.dp)
            .fillMaxWidth()
            .background(Kc.Overlay, ControlShape)
            .border(1.dp, Kc.BorderStrong, ControlShape)
            .padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
            .heightIn(min = 52.dp)
            .semantics(mergeDescendants = false) { liveRegion = androidx.compose.ui.semantics.LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(data.visuals.message, style = MaterialTheme.typography.bodyMedium, color = Kc.Starlight, modifier = Modifier.weight(1f).padding(vertical = 10.dp))
        data.visuals.actionLabel?.let { label ->
            androidx.compose.material3.TextButton(onClick = { data.performAction() }) {
                Text(label, style = MaterialTheme.typography.labelLarge, color = Kc.AccentText)
            }
        }
        androidx.compose.material3.IconButton(onClick = { data.dismiss() }) {
            Icon(Icons.Outlined.Close, contentDescription = "Dismiss", tint = Kc.Nebula, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun ReplacePairingDialog(link: String, current: String, onDone: () -> Unit) {
    val client = LocalClient.current
    val messages = LocalMessages.current
    val scope = rememberCoroutineScope()
    val payload = remember(link) { runCatching { PairingLink.parse(link) } }
    AlertDialog(
        onDismissRequest = onDone,
        containerColor = Kc.Overlay,
        title = { Text("Pair with a different workstation?") },
        text = {
            Text(
                payload.fold(
                    { "This replaces $current with ${it.name}. This device forgets $current and its key." },
                    { it.message ?: "This pairing link can't be used." },
                ),
                color = Kc.TextSecondary,
            )
        },
        confirmButton = {
            if (payload.isSuccess) {
                androidx.compose.material3.TextButton(onClick = {
                    onDone()
                    scope.launch {
                        runCatching { client.pair(payload.getOrThrow()) }.onFailure { messages.post(it.message ?: "Pairing failed") }
                    }
                }) { Text("Pair", color = Kc.AccentText) }
            }
        },
        dismissButton = { androidx.compose.material3.TextButton(onClick = onDone) { Text("Keep $current", color = Kc.TextSecondary) } },
    )
}

@Composable
private fun MainShell(app: KalCodeRemoteApp, nav: Navigator) {
    val client = app.client
    val messages = LocalMessages.current

    // Deep links (notification taps, intents). Never act on a substitute target.
    LaunchedEffect(Unit) {
        app.pendingLink.filterNotNull().collect { link ->
            if (link is DeepLink.Pair) return@collect
            withTimeoutOrNull(10_000) {
                combine(client.fleet, client.status) { f, s -> f.hasSnapshot || s is ConnectionStatus.Offline }.first { it }
            }
            app.pendingLink.value = null
            val note = resolveLink(link, client.fleet.value, nav)
            if (note != null) messages.post(note)
        }
    }
    // Ask once for notifications after pairing (Android 13+ runtime permission).
    val context = androidx.compose.ui.platform.LocalContext.current
    val askNotify = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) {}
    LaunchedEffect(Unit) {
        val prefs = context.getSharedPreferences("ui", 0)
        if (!com.kalcode.remote.Notifications.canPost(context) && !prefs.getBoolean("askedNotify", false)) {
            prefs.edit().putBoolean("askedNotify", true).apply()
            askNotify.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    // In-app banners for notify while the app is in front.
    LaunchedEffect(Unit) {
        app.inAppNotices.collect { note ->
            launch {
                if (messages.show(note.title, action = "Open")) {
                    DeepLink.parse(note.link)?.let { app.pendingLink.value = it }
                }
            }
        }
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val width = maxWidth
        val rail = width >= 600.dp
        val twoPane = width >= 720.dp
        CompositionLocalProvider(LocalLayout provides Layout(twoPane, rail)) {
            if (rail) {
                Row(Modifier.fillMaxSize()) {
                    KcRail(nav)
                    VerticalDivider(color = Kc.BorderSubtle)
                    Box(Modifier.weight(1f).fillMaxHeight()) { TabContent(nav, twoPane, width - 81.dp) }
                }
            } else {
                Column(Modifier.fillMaxSize()) {
                    Box(Modifier.weight(1f).fillMaxWidth()) { TabContent(nav, twoPane, width) }
                    // Detail screens own the bottom edge (prompt composer, keyboard) on phones.
                    androidx.compose.animation.AnimatedVisibility(
                        visible = twoPane || nav.stack().isEmpty(),
                        enter = androidx.compose.animation.expandVertically(KcMotion.spec(LocalReducedMotion.current)),
                        exit = androidx.compose.animation.shrinkVertically(KcMotion.spec(LocalReducedMotion.current)),
                    ) { KcBottomBar(nav) }
                }
            }
        }
    }
    BackHandler(enabled = nav.tab != Tab.FLEET && nav.stack().isEmpty()) { nav.select(Tab.FLEET) }
}

/** Returns a message when the target is gone ("This agent has finished" / "Already answered"). */
fun resolveLink(link: DeepLink, fleet: FleetState, nav: Navigator): String? = when (link) {
    DeepLink.Fleet -> {
        nav.show(Tab.FLEET)
        null
    }
    is DeepLink.AgentLink -> if (fleet.agent(link.id) != null) {
        nav.show(Tab.FLEET, Dest.Agent(link.id))
        null
    } else {
        nav.show(Tab.FLEET)
        "This agent has finished"
    }
    is DeepLink.Diff -> if (fleet.agent(link.id) != null) {
        nav.show(Tab.FLEET, Dest.Agent(link.id), Dest.Diff(link.id))
        null
    } else {
        nav.show(Tab.FLEET)
        "This agent has finished"
    }
    is DeepLink.Needs -> {
        val item = fleet.needsYouItem(link.id)
        when {
            item == null -> {
                nav.show(Tab.FLEET)
                "Already answered"
            }
            item.agentId != null && fleet.agent(item.agentId) != null -> {
                nav.show(Tab.FLEET, Dest.Agent(item.agentId))
                null
            }
            else -> {
                nav.show(Tab.FLEET)
                null
            }
        }
    }
    is DeepLink.RunLink -> if (fleet.run(link.id) != null) {
        nav.show(Tab.RUNS, Dest.Run(link.id))
        null
    } else {
        nav.show(Tab.FLEET)
        "This run has finished"
    }
    is DeepLink.Pair -> null
}

@Composable
private fun TabContent(nav: Navigator, twoPane: Boolean, width: Dp) {
    val reduced = LocalReducedMotion.current
    AnimatedContent(
        targetState = nav.tab,
        transitionSpec = {
            fadeIn(KcMotion.spec(reduced, KcMotion.FAST)) togetherWith fadeOut(KcMotion.spec(reduced, KcMotion.FAST))
        },
        label = "tab",
    ) { tab ->
        when (tab) {
            Tab.FLEET -> FleetTab(nav, twoPane, width)
            Tab.RUNS -> RunsTab(nav, twoPane, width)
            Tab.VOICE -> VoiceScreen()
            Tab.SETTINGS -> SettingsScreen()
        }
    }
}

private fun listPaneWidth(width: Dp): Dp = (width * 0.42f).coerceIn(340.dp, 460.dp)

@Composable
private fun FleetTab(nav: Navigator, twoPane: Boolean, width: Dp) {
    val stack = nav.stack(Tab.FLEET)
    if (twoPane) {
        val agentId = stack.filterIsInstance<Dest.Agent>().lastOrNull()?.id
        val diff = stack.lastOrNull() as? Dest.Diff
        BackHandler(enabled = stack.isNotEmpty()) { nav.pop() }
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.width(listPaneWidth(width)).fillMaxHeight()) {
                if (diff != null) {
                    AgentScreen(diff.id, onBack = { nav.pop() }, onOpenDiff = {}, inPane = true)
                } else {
                    FleetScreen(selectedAgentId = agentId, onOpenAgent = { nav.show(Tab.FLEET, Dest.Agent(it)) })
                }
            }
            VerticalDivider(color = Kc.BorderSubtle)
            Box(Modifier.weight(1f).fillMaxHeight()) {
                PaneSwitch(target = diff ?: agentId?.let { Dest.Agent(it) }) { dest ->
                    when (dest) {
                        is Dest.Diff -> DiffScreen(dest.id, onBack = { nav.pop() })
                        is Dest.Agent -> AgentScreen(
                            dest.id,
                            onBack = { nav.reset(Tab.FLEET) },
                            onOpenDiff = { nav.show(Tab.FLEET, Dest.Agent(dest.id), Dest.Diff(dest.id)) },
                            inPane = true,
                        )
                        else -> PanePlaceholder("Select an agent", "Its live output, changes and controls appear here.")
                    }
                }
            }
        }
    } else {
        BackStack(stack, onPop = { nav.pop() }, root = {
            FleetScreen(selectedAgentId = null, onOpenAgent = { nav.push(Dest.Agent(it), Tab.FLEET) })
        }) { dest ->
            when (dest) {
                is Dest.Agent -> AgentScreen(dest.id, onBack = { nav.pop() }, onOpenDiff = { nav.push(Dest.Diff(dest.id), Tab.FLEET) })
                is Dest.Diff -> DiffScreen(dest.id, onBack = { nav.pop() })
                else -> Unit
            }
        }
    }
}

@Composable
private fun RunsTab(nav: Navigator, twoPane: Boolean, width: Dp) {
    val stack = nav.stack(Tab.RUNS)
    val open: (Dest) -> Unit = { if (twoPane) nav.show(Tab.RUNS, it) else nav.push(it, Tab.RUNS) }
    if (twoPane) {
        BackHandler(enabled = stack.isNotEmpty()) { nav.pop() }
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.width(listPaneWidth(width)).fillMaxHeight()) { RunsScreen(selected = stack.lastOrNull(), onOpen = open) }
            VerticalDivider(color = Kc.BorderSubtle)
            Box(Modifier.weight(1f).fillMaxHeight()) {
                PaneSwitch(target = stack.lastOrNull()) { dest ->
                    when (dest) {
                        is Dest.Run -> RunScreen(dest.id, onBack = { nav.pop() }, inPane = true)
                        is Dest.Environment -> EnvironmentScreen(dest.id, onBack = { nav.pop() }, inPane = true)
                        else -> PanePlaceholder("Select a run or environment", "Logs, tests and deployment health appear here.")
                    }
                }
            }
        }
    } else {
        BackStack(stack, onPop = { nav.pop() }, root = { RunsScreen(selected = null, onOpen = open) }) { dest ->
            when (dest) {
                is Dest.Run -> RunScreen(dest.id, onBack = { nav.pop() })
                is Dest.Environment -> EnvironmentScreen(dest.id, onBack = { nav.pop() })
                else -> Unit
            }
        }
    }
}

@Composable
private fun PaneSwitch(target: Dest?, content: @Composable (Dest?) -> Unit) {
    val reduced = LocalReducedMotion.current
    AnimatedContent(
        targetState = target,
        contentKey = { it?.let { d -> d::class.simpleName + d.hashCode() } },
        transitionSpec = {
            (fadeIn(KcMotion.spec(reduced, KcMotion.BASE)) + slideInHorizontally(KcMotion.spec(reduced, KcMotion.BASE)) { it / 12 }) togetherWith
                fadeOut(KcMotion.spec(reduced, KcMotion.FAST))
        },
        label = "pane",
    ) { content(it) }
}

/**
 * A back stack with the system predictive-back gesture: the top screen follows the gesture
 * (slight shift and scale) and pops on release; cancelling settles it back.
 */
@Composable
private fun BackStack(stack: List<Dest>, onPop: () -> Unit, root: @Composable () -> Unit, content: @Composable (Dest) -> Unit) {
    val reduced = LocalReducedMotion.current
    var progress by remember { mutableFloatStateOf(0f) }
    val scope = rememberCoroutineScope()
    PredictiveBackHandler(enabled = stack.isNotEmpty()) { events ->
        try {
            events.collect { progress = it.progress }
            onPop()
            progress = 0f
        } catch (e: CancellationException) {
            scope.launch { animate(progress, 0f, animationSpec = tween(KcMotion.FAST)) { v, _ -> progress = v } }
            throw e
        }
    }
    var lastDepth by remember { mutableIntStateOf(stack.size) }
    val depth = stack.size
    val shift = with(LocalDensity.current) { 56.dp.toPx() }
    AnimatedContent(
        targetState = stack.lastOrNull(),
        transitionSpec = {
            val forward = depth >= lastDepth
            lastDepth = depth
            if (reduced) {
                ContentTransform(fadeIn(tween(0)), fadeOut(tween(0)))
            } else if (forward) {
                (slideInHorizontally(tween(KcMotion.SLOW, easing = KcMotion.Emphasized)) { it / 5 } + fadeIn(tween(KcMotion.BASE))) togetherWith
                    fadeOut(tween(KcMotion.FAST))
            } else {
                fadeIn(tween(KcMotion.BASE)) togetherWith
                    (slideOutHorizontally(tween(KcMotion.BASE, easing = KcMotion.Emphasized)) { it / 4 } + fadeOut(tween(KcMotion.FAST)))
            }
        },
        label = "stack",
    ) { dest ->
        val isTop = dest == stack.lastOrNull() && dest != null
        Box(
            Modifier.fillMaxSize().graphicsLayer {
                if (isTop && progress > 0f && !reduced) {
                    translationX = progress * shift
                    val s = 1f - 0.06f * progress
                    scaleX = s
                    scaleY = s
                    shape = RoundedCornerShape((28 * progress).dp)
                    clip = true
                }
            },
        ) { if (dest == null) root() else content(dest) }
    }
}

@Composable
private fun PanePlaceholder(title: String, body: String) {
    Box(Modifier.fillMaxSize().background(Kc.Graphite), contentAlignment = Alignment.Center) {
        com.kalcode.remote.ui.components.EmptyState(Icons.Outlined.TouchApp, title, body)
    }
}

@Composable
private fun KcBottomBar(nav: Navigator) {
    val client = LocalClient.current
    val fleet by client.fleet.collectAsStateWithLifecycle()
    NavigationBar(
        containerColor = Kc.Surface1,
        tonalElevation = 0.dp,
        modifier = Modifier.border(width = 0.dp, color = Kc.Graphite).testTag("bottomBar"),
    ) {
        Tab.entries.forEach { tab ->
            NavigationBarItem(
                selected = nav.tab == tab,
                onClick = { nav.select(tab) },
                icon = { TabIcon(tab, fleet) },
                label = { Text(tab.title, style = MaterialTheme.typography.labelMedium) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = Kc.Starlight,
                    selectedTextColor = Kc.Starlight,
                    indicatorColor = Kc.AccentSoft,
                    unselectedIconColor = Kc.Nebula,
                    unselectedTextColor = Kc.Nebula,
                ),
            )
        }
    }
}

@Composable
private fun KcRail(nav: Navigator) {
    val client = LocalClient.current
    val fleet by client.fleet.collectAsStateWithLifecycle()
    NavigationRail(
        containerColor = Kc.Surface1,
        windowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Start + WindowInsetsSides.Vertical),
        header = {
            androidx.compose.foundation.Image(
                painter = androidx.compose.ui.res.painterResource(com.kalcode.remote.R.drawable.kalcode_mark),
                contentDescription = "KalCode",
                modifier = Modifier.padding(top = 12.dp, bottom = 8.dp).size(40.dp),
            )
        },
    ) {
        Spacer(Modifier.height(8.dp))
        Tab.entries.forEach { tab ->
            NavigationRailItem(
                selected = nav.tab == tab,
                onClick = { nav.select(tab) },
                icon = { TabIcon(tab, fleet) },
                label = { Text(tab.title, style = MaterialTheme.typography.labelMedium) },
                colors = NavigationRailItemDefaults.colors(
                    selectedIconColor = Kc.Starlight,
                    selectedTextColor = Kc.Starlight,
                    indicatorColor = Kc.AccentSoft,
                    unselectedIconColor = Kc.Nebula,
                    unselectedTextColor = Kc.Nebula,
                ),
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun TabIcon(tab: Tab, fleet: FleetState) {
    val needs = if (tab == Tab.FLEET) fleet.needsYou.size else 0
    androidx.compose.material3.BadgedBox(badge = {
        if (needs > 0) {
            androidx.compose.material3.Badge(containerColor = Kc.Waiting, contentColor = Kc.AccentFg) { Text("$needs") }
        }
    }) {
        Icon(tab.icon, contentDescription = if (needs > 0) "${tab.title}, $needs need you" else tab.title)
    }
}

/** Screen header used by detail screens: back button, title, and status-bar inset. */
@Composable
fun headerInsets(): Modifier = Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))

fun Modifier.headingSemantics(): Modifier = semantics { heading() }
