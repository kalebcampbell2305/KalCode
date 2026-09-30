# Dev and Stable application identity

`pnpm dev:desktop` (or `pnpm --filter @kalcode/desktop tauri dev`) selects the Dev overlay.
`pnpm --filter @kalcode/desktop tauri build --debug` also uses it.

| Lane | Application identifier / credential service | Product | URL scheme |
| --- | --- | --- | --- |
| Debug | `com.kalcode.desktop.dev` | KalCode Dev | `kalcode-dev://` |
| Release | `com.kalcode.desktop` | KalCode | `kalcode://` |

Tauri derives application-data paths and single-instance identity from the identifier. Browser
profile IDs and OS credential services use the matching compiled identity. Stable config and
Stable credential names are unchanged. Internal `kalcode://browser-focus` events are process-local
Tauri event names, not OS protocol handlers, and remain compatible.

Direct debug Cargo commands must set `TAURI_CONFIG` to the contents of
`apps/desktop/src-tauri/tauri.dev.conf.json`. The build rejects mismatched identity/profile pairs
instead of silently producing a debug app with Stable's identity. Clear that variable for release
commands. Custom profiles must retain consistent debug assertions across application crates.
The normal `pnpm lint`, `pnpm test`, and `pnpm check` commands select the Dev overlay automatically.

Dev cannot install/restore Stable updates. Production social sign-in currently returns Stable
links, so Dev refuses that flow before opening a browser; enabling Dev social sign-in requires
separate API support for the Dev callback scheme. Email sign-in is unaffected.

On macOS, the release lead must verify side-by-side bundles, distinct app data/keychain entries,
and that each URL scheme opens only its intended app. No installed application or credentials
are exercised by the config/unit checks.
