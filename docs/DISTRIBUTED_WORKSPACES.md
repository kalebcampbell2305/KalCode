# Distributed Workspaces
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **RW** · Phase **P3 (SSH phase 1) · P6 (remote providers, phase 2)**

Workspaces that live on another machine over SSH, with the same rail, Code surface and terminal
experience as local ones.

## Connection states

OFFLINE · CONNECTING · AWAITING HOST-KEY CONFIRMATION · CONNECTED · RECONNECTING (attempt, next
retry) · AUTH FAILED · HOST KEY CHANGED. AWAITING HOST-KEY CONFIRMATION is an explicit extra state,
needed so an unknown host is never accepted silently.

## Security

- Unknown host: the SHA-256 fingerprint is compared by the user in a native dialog; a match in the
  user's `known_hosts` is shown as such and still confirmed on first use.
- Changed host key: the connection is refused and no credentials are sent; replacing the key needs
  a native confirmation that shows both fingerprints.
- Passwords and passphrases are stored only on opt-in, only in the OS secure store; private keys
  are never copied; SSH agent supported; agent forwarding, X11 and port forwarding are off by
  default.
- Remote paths are contained under the remote root (remote `realpath`); agent-initiated remote
  actions pass the Trust Kernel.

## Model

A remote workspace is a row in Z1's `workspaces` with `location = ssh` (a lead-approved column
addition), not a second workspace system. The transport sits behind a `RemoteTransport` trait:
an embedded SSH library first (validated in a spike), the system `ssh` binary as a fallback.

## Phase 2

Provider sessions on the remote host under the user's own remote sign-in; remote worktrees;
reconnect in Process Continuity.
