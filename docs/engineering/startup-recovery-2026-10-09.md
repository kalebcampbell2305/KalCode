# Startup and online recovery hotfix

Base: `26e08030e446c93a65ab233449336c241e10f686`.
Reproduced on Windows with installed `0.1.10+2310`.

## Causes

- The shell eagerly reads an Operations snapshot. Historical tool identity was resolved
  before SQL pagination, doing correlated event lookups across the entire tool archive.
  A read-only reproduction with 86,569 tool calls exceeded a three-second interrupt budget;
  the installed process remained inside SQLite for minutes. Other commands waited on the
  shared core database connection. Repeated refreshes accumulated 27 runtime leases and
  prevented clean shutdown.
- A temporary account transport failure selected valid signed offline grace. Background
  renewal considered only entitlement expiry, so an entitlement with days remaining did
  not promptly retry online verification after connectivity recovered.
- KalVoice's local engine health check actually succeeded. Its unavailable status followed
  the blocked application shutdown/runtime admission, rather than a missing voice model.

## Correction

Materialize the filtered, ordered tool-history page before projecting event identity.
Keep the exact workspace, thread, cursor and provider identity boundaries. Coalesce deck
polling so ticks, focus and events cannot stack unresolved reads. Automatically retry
verified offline account recovery with bounded backoff through the existing authenticated
refresh path; normal online renewal retains its existing cadence.
Run historical tool and turn projections on the existing read-only WAL connection so
optional history refreshes do not monopolize the core writer.

No schema migration, data reset, credential replacement or entitlement bypass is involved.
The shared Rust and frontend paths apply to Windows and macOS.

## Evidence

- A synthetic 4,000-tool regression exceeds a deterministic four-million SQLite VM
  instruction budget with the original query and passes with the correction.
- The corrected query returned 101 rows from the affected store in 0.325 seconds using
  a read-only connection. Only timing, query plans and aggregate counts were inspected.
- Focused tests cover history ordering, pagination, workspace isolation, exact observed
  identity, overlapping refreshes, failure recovery and stale client responses.
- A concurrent integration regression proves historical reads complete while the core
  writer is held, rather than serializing essential app state behind background history.
- Account tests cover long-lived offline grace returning to Ready and legitimate session
  revocation still clearing authority. No authentication or licensing policy is weakened.
- Local validation: 144 thread tests, 48 account-runtime tests, 4 account-link tests and
  3 deck-polling tests passed; desktop TypeScript and Biome checks passed.

Publication and installed-app restart verification are recorded in the release pipeline's
commit-bound receipts; implementation evidence alone is not a claim of shipment.

## Rollback

Revert this hotfix commit through the shared merge train and publish a newer internal build
if a regression requires rollback. No database downgrade or history deletion is required.
Do not revert by resetting main or installing an older update over a newer live build.
