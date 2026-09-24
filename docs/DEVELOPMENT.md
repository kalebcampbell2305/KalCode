# Parallel development

KalCode is developed in coordinated threads, each on its own branch in its own git worktree.
`main` is the integrated, reviewed state; the owner's live previews always run from `main`.

## Threads

| Thread | Branch | Worktree | Owns |
| --- | --- | --- | --- |
| 1 — Workspace + Terminal (Z1) | `z1/workspace-terminal` | `.worktrees/z1` | `crates/pty`, workspaces/terminals in native-core, Code surface, migration `0002` |
| 2 — Provider runtime (Z2) | `z2/provider-runtime` | `.worktrees/z2` | `crates/providers`, provider contracts, Providers surface, migration `0003` if needed |
| 3a — Threads (Z3) | `z3/threads` | `.worktrees/z3` | thread runtime, Threads surface, migration `0004` |
| 4 — Permission engine (Z4) | `z4/permissions` | `.worktrees/z4` | `crates/permissions`, approvals UI, migration `0005` |
| 5 — Dashboard (Z5) | `z5/dashboard` | `.worktrees/z5` | Dashboard surface (fixtures until Z3/Z4 land) |
| 6 — Test & integration infrastructure | `infra/testing` | `.worktrees/infra` | CI, performance harness, `packages/testing` |
| Entitlements (OWNER) | `z13/owner-entitlement` | `.worktrees/owner` | `apps/api`, `crates/entitlements`, entitlement contracts |
| 3 — Integration / QA (lead) | `main` | repository root | review, runtime/visual/security QA, merges, acceptance docs |

`.worktrees/` is git-ignored. Create one with `git worktree add .worktrees/<name> <branch>`.

## Isolation rules

1. **Never touch the owner's data.** Feature branches must not run against the default data
   folder. Run the desktop app in a worktree only with an isolated folder, e.g.
   `KALCODE_DATA_DIR=<abs path>/.kalcode-dev` (honoured by debug builds). Migrations on a branch
   would otherwise upgrade the owner's database.
2. **Distinct ports per worktree.**

   | Worktree | `KALCODE_UI_TEST_PORT` | `KALCODE_E2E_CDP_PORT` | Vite dev (`tauri dev`) |
   | --- | --- | --- | --- |
   | main | 1421 | 9333 | 1420 (owner's live preview) |
   | z1 | 1431 | 9431 | do not run `tauri dev`; use tests and `build:e2e` |
   | z2 | 1432 | 9432 | same |
   | owner | 1433 | 9433 | same |
   | z3 | 1434 | 9434 | same |
   | z4 | 1435 | 9435 | same |
   | z5 | 1436 | 9436 | same |
   | infra | 1437 | 9437 | same |

   UI tests never reuse an existing server, so a port collision fails loudly instead of testing
   another worktree's code.
3. **Migration numbers are reserved per thread** (see `docs/CONTRACTS.md`). Schema changes are
   append-only.
4. **Shared contracts** (`crates/contracts`) are owned by the lead. Consume them; request changes
   in your hand-off instead of editing them on a campaign branch.
5. **Shared files** (`crates/native-core/src/{events/mod.rs,runtime.rs,flags.rs}`,
   `apps/desktop/src-tauri/{build.rs,src/lib.rs,src/commands.rs,capabilities/main.json}`,
   `apps/desktop/src/{shell/*,ipc/*}`, `packages/protocol/src/index.ts`) get additive, minimal
   edits only, listed in the thread's hand-off so the lead can integrate them.
6. Never deploy, create cloud resources, push, or merge from a thread. Commit to the thread's
   branch only.

## Merge policy

A branch merges into `main` only after its campaign's acceptance criteria pass, `pnpm check`
passes, relevant UI/E2E suites pass, and the lead has reviewed the diff and run the result.
Merges are `--no-ff` so each campaign stays visible in history.
