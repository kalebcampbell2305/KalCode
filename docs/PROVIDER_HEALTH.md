# Provider Health + Capacity
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **PH** · Phase **P2**

Live per-provider health: connection, process, authentication, account label, models, session
count, observed latency, recent failures, rate-limit state (only when observed), version, trend
and recoverability.

## Sources

Z2 detection and capabilities, the thread runtime's observer hook (first-output latency,
failures, session counts), structured backoff events, and hook signals from provider panes
(`PROVIDER_PANES.md`). **No invented quota data**: unknown is shown as unknown.

## Consumers

The Scheduler (concurrency and backoff), Hot-Swap (failover signals), missions and the Command
Center, through one API. It is separate from the Environment Doctor, which reads its snapshot
rather than probing again.

## Storage and events

Current state is in memory; hourly rollups keep 30 days of trend. `provider.health_changed` and
`provider.capacity_changed` are emitted on transitions only. A health failure reads as "unknown"
and never blocks a thread.
