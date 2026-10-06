package com.kalcode.remote.protocol

import androidx.compose.runtime.Immutable

/**
 * The device's mirror of the desktop's canonical state.
 *
 * A snapshot replaces everything. A patch applies only when its `rev` is exactly the next one;
 * anything else is a gap and the caller must reconnect (the desktop then sends a fresh
 * snapshot). The reducer never guesses. Instances are immutable.
 */
@Immutable
data class FleetState(
    val rev: Long? = null,
    val workstation: Workstation? = null,
    val workspaces: List<Workspace> = emptyList(),
    val agents: List<Agent> = emptyList(),
    val needsYou: List<NeedsYouItem> = emptyList(),
    val runs: List<Run> = emptyList(),
    val services: List<Service> = emptyList(),
    val environments: List<Environment> = emptyList(),
) {
    val hasSnapshot: Boolean get() = rev != null

    sealed interface PatchOutcome {
        data class Applied(val state: FleetState) : PatchOutcome
        /** The patch didn't follow the last applied revision. */
        data class Gap(val expected: Long?, val received: Long) : PatchOutcome
    }

    fun applySnapshot(rev: Long, state: RemoteState): FleetState = FleetState(
        rev = rev,
        workstation = state.workstation,
        workspaces = state.workspaces,
        agents = state.agents,
        needsYou = state.needsYou,
        runs = state.runs,
        services = state.services,
        environments = state.environments,
    )

    fun applyPatch(patch: Patch): PatchOutcome {
        val current = rev
        if (current == null || patch.rev != current + 1) {
            return PatchOutcome.Gap(current?.plus(1), patch.rev)
        }
        val u = patch.upsert
        val r = patch.remove
        return PatchOutcome.Applied(
            copy(
                rev = patch.rev,
                workstation = patch.workstation ?: workstation,
                agents = merge(agents, r.agents, u.agents) { it.id },
                needsYou = merge(needsYou, r.needsYou, u.needsYou) { it.id },
                runs = merge(runs, r.runs, u.runs) { it.id },
                services = merge(services, r.services, u.services) { it.id },
                environments = merge(environments, r.environments, u.environments) { it.id },
                workspaces = merge(workspaces, r.workspaces, u.workspaces) { it.id },
            ),
        )
    }

    // ---- lookups ----

    fun agent(id: String): Agent? = agents.firstOrNull { it.id == id }
    fun needsYouItem(id: String): NeedsYouItem? = needsYou.firstOrNull { it.id == id }
    fun run(id: String): Run? = runs.firstOrNull { it.id == id }
    fun needsYouForAgent(id: String): List<NeedsYouItem> = needsYou.filter { it.agentId == id }
    val activeWorkspace: Workspace? get() = workstation?.activeWorkspaceId?.let { id -> workspaces.firstOrNull { it.id == id } }

    /** Stable display order: what needs the person first, then live work, then the rest. */
    fun sortedAgents(filter: FleetFilter = FleetFilter.ALL): List<Agent> =
        agents.filter(filter::matches).sortedWith(AGENT_ORDER)

    fun count(filter: FleetFilter): Int = agents.count(filter::matches)

    /** Oldest first: the person answers in the order things asked. */
    val sortedNeedsYou: List<NeedsYouItem>
        get() = needsYou.sortedWith(compareBy<NeedsYouItem> { it.createdAt ?: Long.MIN_VALUE }.thenBy { it.id })

    companion object {
        private fun <T> merge(items: List<T>, removed: List<String>, upserts: List<T>, key: (T) -> String): List<T> {
            if (removed.isEmpty() && upserts.isEmpty()) return items
            val gone = removed.toHashSet()
            val result = ArrayList<T>(items.size + upserts.size)
            val index = HashMap<String, Int>(items.size * 2)
            for (item in items) {
                val k = key(item)
                if (k in gone) continue
                index[k] = result.size
                result.add(item)
            }
            for (item in upserts) {
                val k = key(item)
                val at = index[k]
                if (at != null) {
                    result[at] = item
                } else {
                    index[k] = result.size
                    result.add(item)
                }
            }
            return result
        }

        fun sortRank(state: AgentState): Int = when (state) {
            AgentState.NEEDS_YOU -> 0
            AgentState.WAITING -> 1
            AgentState.FAILED -> 2
            AgentState.WORKING, AgentState.TESTING, AgentState.STARTING -> 3
            AgentState.READY, AgentState.IDLE, AgentState.UNKNOWN -> 4
            AgentState.DONE, AgentState.STOPPED -> 5
        }

        /** Within a group, newest first by creation time (which never changes, so cards don't jump). */
        val AGENT_ORDER: Comparator<Agent> = compareBy<Agent> { sortRank(it.state) }
            .thenByDescending { it.createdAt ?: Long.MIN_VALUE }
            .thenBy { it.id }
    }
}

enum class FleetFilter(val title: String) {
    ALL("All"), NEEDS_YOU("Needs You"), WORKING("Working"), FAILED("Failed"), DONE("Done");

    fun matches(agent: Agent): Boolean = when (this) {
        ALL -> true
        NEEDS_YOU -> agent.state.needsAttention || agent.pendingApprovals > 0
        WORKING -> agent.state.isActive
        FAILED -> agent.state == AgentState.FAILED
        DONE -> agent.state.isFinished
    }
}
