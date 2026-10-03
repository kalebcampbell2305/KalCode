# Images in Code terminals

Code is KalCode's primary coding workspace. Its project header puts **New agent** and **New terminal** first, with workspace switching and layout controls kept secondary. Existing terminal sessions stay mounted across navigation and styling changes.

Every running shell and coding-agent pane has an **Attach image** button. Select a PNG, JPEG or WebP, or paste an image from the clipboard with the terminal focused. Text-only paste keeps the terminal's existing behavior. Attachment inserts at the current cursor; it never presses Enter or starts a provider request. Generic shells receive a quoted local file path. Supported coding CLIs recognize the pasted path as image input through their own terminal composer.

## Ownership and storage

- `terminalImages.ts` owns bounded image preparation and registration of mounted terminals. At most two images prepare concurrently. Source files are limited to 32 MiB and 16 million pixels; large supported images are scaled to at most 4096 pixels per side and 8 MiB of PNG.
- `terminal_image_commands.rs` validates and fully decodes PNG input again, strips metadata by re-encoding pixels, and creates generated files inside KalCode's data directory. Source filenames and pixels are not written to settings, browser storage or telemetry.
- Agent images live with the resumable session under `sessions/<thread>/images`. Generic-shell images live under `terminal-images/terminals/<terminal>`. Each target is limited to 64 files and 128 MiB. Images for successfully delivered agent prompts remain available across stop/resume; reaching the limit requires starting another terminal. There is no automatic age-based deletion of resumable agent references.
- A failed or cancelled delivery discards its exact generated image ID. Permanently closing a generic terminal cleans up its generated images. Cleanup rejects links and unrelated filenames. An interrupted process or failed cleanup can leave a bounded managed file; cleanup does not erase referenced images speculatively.
- Native import rechecks the runtime and target after disk work. The final shell write checks the original terminal generation; provider writes check the exact running instance through the existing guarded input lane. A restarted terminal cannot receive an attachment intended for its predecessor.

## Compatibility and verification

The shared frontend and native paths support Windows and macOS. No database migration, account changes, provider authentication changes, or public version change is required. Provider image interpretation still depends on the selected CLI/model supporting images. KalCode prepares a local attachment; it does not claim a provider has analyzed it before the user submits.

Coverage lives in the terminal image unit/integration tests, ordered-input tests, native image tests, `workspaces_and_terminals.rs`, UI `terminal-images.spec.ts`, and the isolated native image test in E2E `code.spec.ts`. The JPEG browser test exercises the fallback decoder under the shipping image CSP. Existing Code and pane tests protect keyboard input, focus, layouts, accessibility and mounted-session behavior.

Real CLI probes with generated images confirmed attachment parsing without prompt submission in Windows Claude Code 2.1.288, Codex 0.160.0 and Gemini CLI 0.61.0, and macOS Claude Code 2.1.288 and Gemini CLI 0.61.0. Codex was unavailable on the Mac test host; its matching source-level POSIX path parser was reviewed. These probes establish composer attachment, not remote model vision output. They never modified the owner's clipboard or closed the owner's KalCode.

Rollback uses a normal revert of the feature commit on main, followed by the standard signed internal-build release. Reverting leaves managed image files intact and does not alter user sessions or require a schema downgrade. The owner's active KalCode must never be closed by verification or release automation.
