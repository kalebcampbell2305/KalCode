# Provider Profiles
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **PP** · Phase **P2**

Named, versioned sets of provider settings, applied by default at global, workspace, agent,
mission or thread level.

## Rules

- Settings come only from what each provider adapter declares (setting descriptors). Each shows how
  it applies: *provider-native* (with the flag), *KalCode-enforced* (for example concurrency or a
  turn timeout), or *approximate* (with an explanation). Unsupported settings are never shown
  without that explanation.
- Precedence: thread > mission > agent > workspace > global; the UI shows where each value came
  from.
- Profiles carry **no permission authority** (no mode, no rules). Applying any profile cannot
  change a permission decision.
- Editing creates a new version; running threads keep the version they started with.
- The Hot-Swap failover policy (default off) is stored with profile bindings.

## Events

`provider_profile.created` / `.updated` / `.archived`, `provider_profile.binding_changed`,
`provider_profile.applied` (per session start, including settings not applied and why).
