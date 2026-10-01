# KalCode tao patch

This directory vendors `tao` 0.35.3 exactly as published on crates.io (`.crate` SHA-256
`d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9`, the checksum `Cargo.lock`
recorded for the registry package). Upstream repository: `https://github.com/tauri-apps/tao`,
source commit `5a14e624c81b7a799728129417e9218be25f17d9` (per `.cargo_vcs_info.json`). The upstream
Apache-2.0 license files (`LICENSE`, `LICENSE.spdx`) are preserved verbatim. It is wired in
through `[patch.crates-io]` in the root `Cargo.toml`, so `tauri-runtime-wry` 2.11.x (which requires
`tao ^0.35`) builds against this copy on every platform.

The only change is a backport of upstream commit
`c704261c519c58cfdd0bc2d58ba24e06a0b71c92` ("fix(windows): avoid reentrant input lock deadlocks",
tauri-apps/tao#1215, released in tao 0.36.0; tauri-apps/tauri#12531), applied unmodified to:

- `src/platform_impl/windows/event_loop.rs`
- `src/platform_impl/windows/keyboard.rs`
- `src/platform_impl/windows/keyboard_layout.rs`
- `src/platform_impl/windows/minimal_ime.rs`

(The commit's `.changes/windows-input-deadlock.md` Covector changefile is not vendored.)

Why: tao 0.35.3 held the global `KEY_EVENT_BUILDERS` mutex (and `LAYOUT_CACHE`) while calling
`PeekMessageW` in its keyboard handler. A message sent from another thread, such as
`WM_KILLFOCUS`, is delivered inside that `PeekMessageW`, re-enters the handler and blocks forever
on the same non-reentrant `parking_lot` mutex, hanging KalCode's UI thread (observed in a dump of a
hung 0.1.7 process). The backport peeks before taking those locks.

Regression test: `apps/desktop/src-tauri/tests/windows_tao_reentrant_focus.rs` (Windows only)
fails within about 2 s against registry tao 0.35.3 and passes against this copy.

Remove this directory and its `[patch.crates-io]` entry once Tauri accepts a tao release that
contains c704261c (tao >= 0.36.0).
