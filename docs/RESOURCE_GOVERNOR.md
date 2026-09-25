# Workspace Resource Governor
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **RG** · Phase **P0 (sampler) · P2 (settings UI) · P4 (scheduler holds)**

Low-overhead monitoring of CPU, RAM, GPU/VRAM (where the platform exposes it), disk IO and free
space, network, process count, and provider and terminal process trees.

## Behaviour

Adaptive sampling: 0.2 Hz when idle, 1 Hz while tasks run or a resource view is open;
≤ 1 % of one core at 1 Hz. Modes: Conservative / Balanced / Performance / Custom set pressure
thresholds and the maximum number of concurrent provider sessions. The mode is a setting, not a
permission.

## Boundaries

Until the Scheduler exists it is advisory (a warning when creating threads) and never blocks.
After that it supplies typed hold reasons. It **never** terminates or suspends user processes;
suggestions go through the Utility Dock's process control (explain, ask, Trust Kernel).

## Events

`resource.pressure_changed` and `resource.mode_changed` on transitions only; samples stream on a
channel and are never events. Placement: Settings → Resources, plus a Command Center panel.
