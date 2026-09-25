# Provider-Agnostic Diff Intelligence
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **DI (+ BR)** · Phase **P4**

Who changed what, and what kind of change it is — across providers, agents, missions and
people — with a confidence on every heuristic label.

## Capabilities

- **Attribution** per file (and per hunk where observable): provider, agent, mission/task, human
  or unknown. *Exact* when a recorded write matches the content hash, *likely* from time windows,
  *unknown* otherwise.
- **Overlap and conflict detection** across threads, worktrees and tasks, with confidence; feeds
  the Scheduler.
- **Change classes**: architecture, behaviour, API contract, dependency, database,
  security-sensitive, config, tests, docs, generated — each with a likelihood and the rule that
  produced it.

## Blast Radius (cross-cutting)

Estimates impact beyond the changed files from import references, test coverage links,
co-change history, and config/migration/CI/public-API categories. Each impacted item has reasons
and a LOW/MEDIUM/HIGH likelihood; the UI says "may affect" and never claims certainty.

## Integration

Verification (which tests cover a change), the Time Machine (attribution on timeline nodes), the
Command Center, and the Git diff view (`DiffView` annotations). Placement: Git → Diff Intelligence.
