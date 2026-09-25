# Event-Driven Engineering (Automations)
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **AUT** · Phase **P4 (core) · P6 (mission and verification actions)**

Automations react to events or schedules, check conditions, act, optionally verify, and notify —
always inside the permission model. This is KalCode's automations foundation.

## Shape

Trigger (event types and filters, schedule, manual) · conditions · actions (notify, create a
thread, send to a thread, run an argv command, create a checkpoint, pause threads; later: start a
task, run verification) · permission mode · optional verification · notification policy · limits.

## Safety

- Every action runs with origin `automation` through the Trust Kernel. Bypass needs an explicit,
  confirmed user choice; remote-consequential scopes still ask, and the run waits in the approval
  queue.
- Loop prevention through event causation chains; max chain depth (default 3, hard cap 5); rate
  limits, cooldowns and concurrency caps; skipped runs are recorded with the reason.
- A global kill switch stops all runs immediately. KalVoice may engage it; disengaging it needs a
  native confirmation.
- Templates interpolate only typed ids and enumerations; provider-originated text is passed as
  quoted, firewalled, untrusted context.

## Events

`automation.created` / `.updated` / `.enabled` / `.disabled` / `.deleted`, `automation.triggered`,
`automation.run_completed`, `automation.loop_prevented`, `automation.rate_limited`,
`automation.kill_switch_changed`. Notifications use the shared notification center (Z7).
