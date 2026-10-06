package com.kalcode.remote.ui

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.ui.graphics.vector.ImageVector
import com.kalcode.remote.client.RemoteClient
import com.kalcode.remote.protocol.WireJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The same four places as KalCode Remote on iOS. Settings and Launch live in Mission Control's top bar. */
enum class Tab(val title: String, val icon: ImageVector) {
    FLEET("Mission Control", Icons.Outlined.Dashboard),
    NEEDS_YOU("Needs You", Icons.Outlined.PanTool),
    RUNS("Runs", Icons.Outlined.Terminal),
    VOICE("KalVoice", Icons.Outlined.GraphicEq),
}

/** A screen pushed above a tab's root. */
sealed interface Dest {
    data class Agent(val id: String) : Dest
    data class Diff(val id: String) : Dest
    data class Run(val id: String) : Dest
    data class Environment(val id: String) : Dest
    data class Log(val id: String) : Dest
    data object Settings : Dest
}

/** Tab selection and one back stack per tab. Survives rotation (activity handles config changes). */
@Stable
class Navigator {
    var tab by mutableStateOf(Tab.FLEET)
        private set
    private var stacks by mutableStateOf(Tab.entries.associateWith { emptyList<Dest>() })

    fun stack(tab: Tab = this.tab): List<Dest> = stacks.getValue(tab)
    val top: Dest? get() = stack().lastOrNull()

    fun select(tab: Tab) {
        if (this.tab == tab) reset(tab) else this.tab = tab
    }

    fun push(dest: Dest, on: Tab = tab) {
        tab = on
        val current = stack(on)
        if (current.lastOrNull() == dest) return
        stacks = stacks + (on to current + dest)
    }

    /** Opens [dest] as the only screen above [on]'s root (deep links, list-detail selection). */
    fun show(on: Tab, vararg dest: Dest) {
        tab = on
        stacks = stacks + (on to dest.toList())
    }

    fun pop(): Boolean {
        val current = stack()
        if (current.isEmpty()) return false
        stacks = stacks + (tab to current.dropLast(1))
        return true
    }

    fun reset(tab: Tab) {
        stacks = stacks + (tab to emptyList())
    }

    fun resetAll() {
        tab = Tab.FLEET
        stacks = Tab.entries.associateWith { emptyList() }
    }
}

fun args(vararg pairs: Pair<String, String?>): JsonObject =
    JsonObject(pairs.filter { it.second != null }.associate { it.first to JsonPrimitive(it.second) })

/** Runs [op] and decodes its result. */
suspend fun <T> RemoteClient.call(op: String, args: JsonObject, serializer: KSerializer<T>): T =
    WireJson.decodeFromJsonElement(serializer, request(op, args))
