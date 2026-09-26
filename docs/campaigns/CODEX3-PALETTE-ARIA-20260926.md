# Command palette selection and ARIA

Branch `codex3/command-palette-aria`, base `2f61f64`. No dependency on the separate
macOS component packet and no native/release artifact changes.

The existing dark and light rail-home accessibility tests both reproduced a critical
`aria-valid-attr-value` failure: the combobox and listbox referenced a removed command after
asynchronous locator results arrived. A new behavioral test separately reproduced arrow
navigation being reset to the preferred first result on the next animation frame.

The cmdk 1.1.1 patch synchronizes its internal active descendant with the option actually
committed to the list, including controlled changes, force-mounted items, same-value remounts
and removal. See `patches/README.md` for the readable change and removal/upgrade criteria.
Both published ESM and CommonJS distributions receive the same change. pnpm pins the patch
digest; package versions remain unchanged. A frozen install is required when integrating.

CommandPalette keeps its named-command and first-locator preference, but applies it only when
the query/results change. Deliberate keyboard or pointer navigation takes precedence. All
selection lookup is scoped to the current dialog. The immediate Enter fallback still handles
named commands, but respects deliberate navigation. No synthetic pointer or click workaround
was added for ARIA, and no command executes merely because the preferred selection changes.

Verification:

- Original dark/light axe tests: RED before, GREEN after.
- New async active-descendant and arrow stability browser tests: RED before, GREEN after.
- Eleven focused headless browser tests pass: new ARIA transitions/no-results/reopen,
  keyboard/focus/Enter, existing locator search/filter/KalVoice paths, both axe themes and
  the existing shell palette command test.
- Real ESM and CommonJS menus pass controlled replacement/same-value remount/removal tests.
- Full desktop unit suite: 102 files, 880 tests pass. Existing jsdom canvas diagnostic remains.
- TypeScript, scoped Biome, diff check, frozen offline install and production Vite build pass.
  Vite retains the existing chunk-size and mixed dynamic/static Tauri import warnings.

One verification command shim was rewritten by the offline install while its Windows batch
wrapper was still open. The first full unit run completed successfully, and that wrapper
started a redundant second full run, also 880/880 passing with final command exit 0. This is
a verification orchestration issue, not a test or
source failure; the exact log is retained at `target/palette-desktop-tests.log` in this worktree.
Do not mutate package installs while a package-manager batch wrapper is running.

Risk/dependency: this is a pinned third-party patch, so a future cmdk upgrade must rerun the
documented cases and remove or port it. The observer is confined to the list, ignores the
ARIA attributes it publishes, emits only on ID changes and disconnects on unmount. Production
native screen-reader QA remains useful; these proofs cover real headless Chromium semantics
and both package formats, not signed desktop release/install verification.
