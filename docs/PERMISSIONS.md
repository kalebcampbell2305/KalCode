# KalCode Permission Architecture

Status: architecture defined in Z0 · Implementation: campaign Z4 · Contract types:
`packages/protocol/src/permissions.ts`

Permissions are security infrastructure. They govern every provider, agent, KalVoice action,
automation and plugin. **KalVoice is not above the permission model.** Every permission mode —
Plan, Approve, Auto, Bypass and Custom — is available on every plan, including Free.

## 1. Model

```text
Action request ─▶ classify (scope + attributes) ─▶ evaluate policy ─▶ decision
                                                     │                 ├─ allow  → execute, audit if consequential
                                                     │                 ├─ ask    → approval.requested → user decides
                                                     │                 └─ deny   → provider receives denial
                                                     └─ inputs: profile, standing grants, workspace, thread, provider capabilities
```

### Scopes

`filesystem.read`, `filesystem.write`, `filesystem.outside_workspace`, `terminal.read_only`,
`terminal.execute`, `package.install`, `git.read`, `git.commit`, `git.push`, `network.docs`,
`network.other`, `browser.navigate`, `browser.interact`, `plugin.<id>.<capability>`,
`credentials.access`, `messaging.send`, `deploy.production`, `cloud.modify`,
`billing.spend`, `destructive`.

### Decisions available to the user

Deny · Approve once · Approve for thread · Approve for workspace · Allow via rule.

## 2. Profiles

| Profile | Intent | Default behaviour |
| --- | --- | --- |
| **Plan** | Read and plan; no modification. | Reads allowed; any write/execute/network-mutation denied or asked. |
| **Approve** (default) | Safe work proceeds; authority-requiring work pauses. | Workspace reads allowed; writes/commands ask unless covered by a rule. |
| **Auto** | Automatically approve what the active policy covers. | Policy-covered actions allowed; everything else still asks. `always_ask` scopes always ask. |
| **Bypass** | Broad **local** execution authority. | Local workspace actions allowed. Remote-consequential scopes (`git.push`, `deploy.production`, `cloud.modify`, `billing.spend`, `messaging.send`) still follow their own rules. Requires explicit user selection, warning, persistent indicator. Never enabled by an agent or KalVoice. |
| **Custom** | Named rule sets (e.g. "Code Reviewer", "Local Builder"). | Per-scope allow / ask / deny / never. |

## 3. Provider mapping

KalCode presents one permission UX, but providers expose different mechanisms. Each adapter
declares a `PermissionMapping` describing, per KalCode profile, the provider-native
configuration it uses and whether the mapping is **exact**, **approximate (stricter)** or
**unsupported**. Rules:

- Never silently grant more authority than the KalCode profile implies.
- If a provider cannot express a profile, choose the closest **stricter** mapping and show
  the difference in the UI.
- Where a provider supports routing approvals to a host, KalCode is the approver; otherwise the
  adapter runs the provider in its most restrictive mode and KalCode enforces at the tool level
  it can observe.

Mappings are documented per provider in `docs/PROVIDERS.md` once researched against current
official provider documentation (Z2).

## 4. Audit

Consequential decisions (approvals, denials, profile changes, Bypass enablement) are written as
events (`approval.*`, `permission.profile_changed`) and are immutable in the event log.

## 5. Stale approvals

An approval request expires when its thread stops, the provider process exits, or the request
is superseded. Expired requests render as expired and cannot be approved.
