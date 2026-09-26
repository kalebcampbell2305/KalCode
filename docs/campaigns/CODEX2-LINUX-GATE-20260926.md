# Linux Rust gate inventory correction

Independent review of completed primary repair `91166fa` found that its Linux profile expected 15 ignored tests. There are 16 inventoried ignores with the production Whisper feature enabled, but two artifact probes compile only on Windows x64 or Mac arm64. Linux therefore expects 14. This corrects a false gate failure without adding an ignore or changing a Rust test.

- **Scope:** Linux profile's exact ignored-test count.
- **Branch:** `codex2/linux-rust-gate-count`.
- **Commit:** `2e4aa5b3301430a07aad7070e944395fd67c6ef2`.
- **Base/dependency:** primary `91166fa79e0deeb47147a27e43df5c0497599408`; apply after that commit.
- **Files:** `tooling/test-suites.json`, `tooling/test-suites.test.mjs`.
- **What changed:** Linux minimum/maximum ignored count and its registry assertion change from 15 to 14, with an explanatory target-guard comment.
- **Focused tests:** corrected expectation first failed `15 !== 14`; after configuration repair, one focused test passed. Parent independently reran it successfully.
- **Broader tests:** all 16 registry tests passed; scoped Biome and diff checks passed.
- **Security notes:** Windows/Mac counts remain 16, minimum executed remains 1258, maximum flaky remains zero, production Whisper remains enabled, and all intentional-ignore declarations/reasons are unchanged.
- **Dependencies:** `91166fa`; independent of both other deputy source fixes.
- **Conflict status:** clean committed worktree; parent `git apply --check` passed against the current primary recovery worktree without modifying it.
- **Recommended merge order:** after `91166fa`; either order relative to `770b66c` and `50c6007`.
- **Known risk:** source-inventory and Node registry verification only. No Linux compilation or native test pass is claimed. The earlier primary recovery document's Linux count of 15 is superseded by this correction.

Evidence is under `.worktrees/codex2-linux-rust-gate-count/target/linux-rust-gate/`: `red.log`, `green.log`, and `registry-linked.log`. The first full registry attempt lacked Vitest; `registry.log` preserves that prerequisite failure. An ignored junction to the existing protocol dependency directory allowed the unchanged registered suite to run; no dependency installation or lockfile change occurred.

Commands:

```text
node --test --test-name-pattern="registered Rust release gate" tooling/test-suites.test.mjs
node --test tooling/test-suites.test.mjs
```

Independent inventory: nine provider ignores, three performance ignores and four KalVoice ignores. The two Linux exclusions are `pinned_runtime_archive_round_trips_the_exact_extraction_policy` in `component_store_tests.rs` and `pinned_local_reasoning_candidate_smoke_benchmark` in `local_reasoning_real.rs`. The Whisper integration ignore remains included through the registered production feature.
