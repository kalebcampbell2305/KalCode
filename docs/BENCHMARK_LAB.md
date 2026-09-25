# Benchmark Lab
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **BL (+ FA)** · Phase **P5**

A local-only evaluation of how the user's own providers perform on the user's own tasks, by task
class.

## Metrics

Verification pass rate, first-pass tests, retries, time, tool failures, regressions and
handoffs, per provider × model × profile × task class. Cost appears only when the provider
reports it *and* the user enables its display.

## Honesty

Minimum sample size per cell (default 10) and intervals for rates; below the minimum a cell reads
"not enough data". Advisory only: it never changes providers, profiles or schedules. Nothing — no
code, prompts or results — leaves the device.

## Dependencies

Missions (task outcomes) and Verification (results). Outcomes are rebuildable from events and
those tables. It shares its outcome store with the Failure Autopsy (`TIME_MACHINE.md`).
Placement: an Intelligence section of the Command Center.
