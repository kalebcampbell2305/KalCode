# Developer Utility Dock
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **UD** · Phase **P2**

Small developer tools that dock into Code Mode as widgets: API inspector, JSON, regex, process
monitor, port inspector, environment viewer, SQLite viewer, scratch terminal, scratchpad, diff,
encoding/hash.

## Reuse

Process and port data come from the Resource Governor's sampler. The diff tool is the shared
`DiffView`. The scratch terminal is a Z1 PTY. Widgets register with the Z7 widget framework.

## Safety

- JSON, regex, diff and hashing run in Web Workers; regexes have a timeout.
- Terminating a process: KalCode-started processes need a confirmation; other processes of the
  current user need a native confirmation; system processes, other users' processes and KalCode
  itself are refused.
- Environment values are redacted by default; revealing one needs a native confirmation and is
  never logged.
- The SQLite viewer opens only files chosen in the native picker, read-only, with writes, ATTACH,
  PRAGMA writes and extension loading denied, and a 5 s query limit.
- The API inspector sends no automatic credentials; link-local and metadata addresses are blocked
  unless confirmed; the first request to each new host needs a native confirmation; events record
  only method and host.
