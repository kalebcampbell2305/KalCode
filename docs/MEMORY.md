# Evidence-Backed Memory
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **MEM** · Phase **P4**

Scoped, inspectable memory where every record carries provenance, confidence and staleness. This
is KalCode's memory foundation.

## Records

Scope (global / workspace / agent / mission), kind (fact, decision, convention, preference,
warning), subject, statement, origin, and at least one evidence item: an event, a file range with
content hash, a commit, a verification run, a thread message, or an explicit user statement.
Confidence is a bounded score with a visible basis and is never shown as certainty.

## Lifecycle

- **Stale** when evidence changes or disappears (checked in the background, with the reason).
- **Contradicted** when records with the same scope and subject disagree (deterministic;
  provider-assisted detection is opt-in and previewed).
- The user can inspect, correct (a new revision), verify, pin, ignore and delete. Delete removes
  the content; only an id-level `memory.deleted` event remains.

## Boundaries

Memory reaches a provider only inside a context package, through the Context Firewall and a
preview (`CONTEXT.md`). Agents write memory only through the Trust Kernel (`memory.write`), and
their records start at low confidence.
