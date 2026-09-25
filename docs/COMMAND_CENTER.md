# Command Center
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **CC** · Phase **P5**

The deep operations view above the Dashboard: one new top-level surface with progressive
disclosure (summary → panel → entity → timeline).

## Panels

Agent graph, task graph, providers (health and capacity), workspaces (including remote state),
approvals, resources, recovery, hot-swaps, environment warnings, diff intelligence and benchmark
insights. Each panel is owned and shipped by its system and registered with the Command Center.
If a system is unavailable, its panel shows an honest unavailable state; the other panels are
unaffected.

## Relationship to the Dashboard

The Dashboard (rebuilt in Z7) stays the quick view. The Command Center reuses its data layer
and never re-implements fetching. Everything else nests inside it: KalCode adds only this one
top-level surface for these systems.

## Performance

Virtualized lists; first paint ≤ 300 ms with 200 threads and 1M events; graphs at 60 fps with
200 nodes.
