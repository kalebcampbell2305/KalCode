# Agent Organization Graph
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **ORG** · Phase **P3 (core, with Z8 Agents) · P5 (live graph)**

Relationships between KalCode agents and the delegation contracts that govern how one agent
may hand work to another, shown as a live graph.

## What it builds on

- **Z8 Agents** (agent definitions: role, default provider, profile, default mode ≤ Auto).
- **Z3 threads** — a delegation always runs as a thread (`ThreadOrigin::Delegation`).
- **Trust Kernel** (`TRUST_KERNEL.md`) — delegation ceilings are enforced by the one permission
  evaluator. There is no separate authority.

## Rules

- A delegation contract lists *may* rules and *may-not* rules (scopes, path globs, providers), a max
  depth (1–5, global hard cap 5), whether re-delegation is allowed, and an optional duration.
  Contracts are immutable; edits create a superseding contract.
- The delegate's authority = the delegator's authority ∩ the contract. It is never broader
  (property-tested). *May-not* rules act as `never`.
- Loops (an agent appearing twice in a chain) and depth overflows are refused and recorded
  (`agent.delegation_refused`).
- Standing grants never transfer. Delegates cannot enable Bypass or change any policy.

## Surfaces

Agents surface (relationships, contracts); the live graph lives in the Command Center
(clustering beyond 500 nodes).

## Events

`agent.created` / `.updated` / `.retired`, `agent.delegated`, `agent.delegation_refused`,
`agent.delegation_completed`, `trust.ceiling_applied`.
