# Code mode: workspaces and terminals

Status: implemented in Z1 · Native: `crates/pty`, `crates/native-core/src/workspaces.rs` ·
Shell: `apps/desktop/src-tauri/src/code_commands.rs` · UI: `apps/desktop/src/surfaces/code/`

## 1. Workspaces

A workspace is a project folder the user chose through the **native** folder picker. The
WebView never supplies a path: `workspace_open_dialog` shows the picker from Rust
(`tauri-plugin-dialog`, used only from Rust — the WebView has no dialog permissions) and opens
whatever folder the user picks.

- **Canonical path.** The folder is canonicalized (`..`, symlinks and letter case resolved; the
  Windows `\\?\` prefix removed) and stored in `workspaces.root_path`, which is unique. Opening
  the same folder again, however it is reached, reuses the same workspace.
- **Validation.** A missing folder is refused with `filesystem/folder_not_found`; a file with
  `filesystem/not_a_folder`. Nothing is created in either case.
- **Active workspace.** Exactly one workspace is active (`app_meta.active_workspace_id`). It is
  restored on the next launch. Opening or switching updates `last_opened_at`, which orders the
  list (most recent first).
- **Unavailable folders.** A folder moved or deleted outside KalCode is reported as
  `available: false` ("Folder not found"). Terminals cannot start there; the workspace can be
  removed. Availability is re-read whenever the Code surface is shown and when the window
  regains focus.
- **Removing** a workspace only forgets it (and its tab records). The folder and its files are
  never touched. Removal is refused with `validation/terminals_running` while any of its
  terminals is running.
- Events: `workspace.created` (first open), `workspace.opened` (reopen or switch; not emitted
  when the workspace was already active), `workspace.removed`.

## 2. Shells

`detect_shells()` runs once when the core starts and is read-only: it looks for shells that are
already installed and never installs, downloads or changes anything.

| Platform | Shells (default first) |
| --- | --- |
| Windows | PowerShell 7 (`pwsh` on `PATH`), Windows PowerShell, Command Prompt (`%ComSpec%`), Git Bash (`Program Files\Git\bin\bash.exe`) |
| macOS / Linux | The login shell (`$SHELL`) first, then zsh, bash, fish, sh from standard locations |

The WebView sees only `{ id, name, isDefault }`. It starts a terminal by shell **id**; the
executable path and arguments never leave native code. Unknown ids are refused
(`terminal/shell_unavailable`); malformed ones (`validation/invalid_shell`).

## 3. Terminals

Each tab runs one shell in a native pseudo-terminal — ConPTY on Windows, openpty on macOS and
Linux (`portable-pty`) — started in the workspace folder with `TERM=xterm-256color`,
`COLORTERM=truecolor` and `TERM_PROGRAM=KalCode`. Every `KALCODE_*` variable and the WebView2
test overrides are removed from the shell's environment. Only a real `pwsh.exe` on `PATH` counts
as PowerShell 7 (a `pwsh.cmd` or `.bat` does not).

- **Streaming.** `terminal_attach` streams output over a per-view Tauri channel as raw bytes
  (`InvokeResponseBody::Raw`, an `ArrayBuffer` in JS). The first message is always the
  scrollback replay (possibly empty), then live output. Each attach returns its own attachment
  id, owned by the calling webview; a view detaches exactly that id, so overlapping
  attach/detach requests can never release another view's stream. A webview holds at most 4
  attachments per terminal (the oldest is released beyond that); a page reload drops all of the
  page's attachments.
- **Flow control.** A view acknowledges the bytes it has rendered (`terminal_ack`, every
  64 KB). A view that falls more than 4 MB behind stops receiving output; its next ack returns
  `false` and it re-attaches, resetting and replaying from the scrollback. Native memory held
  for a slow or unresponsive view is bounded.
- **Scrollback.** Each session keeps the last 512 KB of output in memory, trimmed at line starts.
  Output is never written to the database or the event log.
- **Views.** The UI renders with xterm.js 6 and its DOM renderer. Tabs of the active workspace
  stay mounted and attached, so switching tabs is instant; leaving the Code surface detaches, and
  coming back re-attaches and replays the scrollback.
- **Terminal reports.** ConPTY asks for the cursor position when a shell starts. If no view is
  attached, the session answers itself; if a view is attached, xterm.js answers. Requests are
  never kept in the scrollback, and reports xterm.js generates while replaying are not sent to
  the shell, so a replay never answers a question twice.
- **Input.** `terminal_write` takes UTF-8 text (at most 64 KB per call; the client splits larger
  pastes). Writes are queued to a per-session writer thread, so input never blocks the UI thread
  and keeps its order; a shell that stops reading for a long time gets
  `terminal/terminal_busy` (retryable). Input to an ended tab gets `terminal/terminal_not_running`.
- **Resize.** The view fits the terminal to its panel (ResizeObserver → fit addon) and sends the
  new size, debounced by 80 ms. Sizes must be 2–1000 columns and rows (`validation/invalid_size`).
- **Limits.** Up to 12 tabs per workspace (`validation/too_many_terminals`).
- **Exit.** When a shell exits on its own, its tab stays with its final output and a Restart
  action. Exit code 0 records `shell.completed`; anything else `shell.failed`.
- **Close.** Closing a tab ends the shell by closing its pseudo-terminal — on Windows every
  process attached to that console, including programs started from the shell, receives the
  close; on macOS and Linux the shell's process group gets SIGHUP and, if anything is still
  running after 3 s, SIGKILL — then forgets the tab. A running shell's end is recorded as
  `shell.completed` with `closedByUser: true`. If the exit is not reported within 5 s the tab is
  forgotten anyway, but its session stays tracked until it exits (and shutdown ends it).
  Closing a tab never asks for confirmation, like other terminal apps.
- **Sessions and restarts.** Every started shell gets a new generation number. An exit report
  from a session that Restart has replaced is ignored, so it can never end the new shell.
- **Locking.** A shell is started while the database connection lock is held, so the tab row,
  the process and `shell.started` appear together and an exit racing the start is recorded
  after it. Starting a process normally takes milliseconds; an unusually slow start (for
  example, antivirus scanning the shell) briefly delays other database commands.

## 4. Restart semantics

Processes cannot survive KalCode exiting.

- **Clean exit.** `Core::shutdown` stops every shell, marks their tabs `end_reason = 'app_closed'`,
  then records `app.stopped`.
- **Crash.** At the next start, tabs still marked running are marked `app_closed` before anything
  else happens.
- **Next launch.** The active workspace and its tabs come back, the previously active tab in
  front. Tabs whose shell was running show "This terminal ended when KalCode closed" with
  **Restart** and **Close tab**. There is no output to replay for them.
- **Restart** starts a fresh shell (same tab, same shell if still installed) in the workspace
  folder and records `shell.started`. A restarted tab begins with a clean screen; views of the
  previous session are released.

## 5. Keyboard

| Keys | Action |
| --- | --- |
| Ctrl+Shift+` | New terminal in the active workspace (from anywhere; asks for a folder if none) |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+Shift+W | Close the tab in front |
| Ctrl+Shift+E | Leave the terminal: focus moves to its tab |
| ←/→, Home, End (on tabs) | Move between tabs |
| Enter (on a tab) | Focus its terminal |
| Delete (on a tab) | Close it |
| Ctrl+C with a selection / Ctrl+Shift+C | Copy |
| Ctrl+V / Ctrl+Shift+V | Paste |

These shortcuts use Ctrl on every platform, like terminal apps; a terminal cannot distinguish
Ctrl+Shift+letter from Ctrl+letter, so shells never depend on them. All other keys go to the
shell while a terminal has focus — including Ctrl+K and Ctrl+B (readline's kill-line and
back-char), so the command palette and sidebar toggle work from outside the terminal. A new or
restarted tab takes focus.

## 6. Colours

Dark and light palettes are designed from the design tokens (`surfaces/code/terminalTheme.ts`).
Every ANSI foreground colour meets WCAG AA (4.5:1) on its theme's terminal background except dark
"black", which programs use as a background; xterm.js's `minimumContrastRatio: 4.5` lifts any
foreground/background pair a program chooses that would fall below AA. Font: `--font-mono`
(JetBrains Mono, self-hosted), 13 px.

## 7. IPC

See the table in `docs/ARCHITECTURE.md` §4. Every id is validated with
`kalcode_contracts::ids::is_valid_id`; no command accepts a path, executable, working directory
or shell string from the WebView.

## 8. Known limitations

- Terminal output is not exposed to screen readers: xterm.js's DOM renderer marks its rows
  `aria-hidden`, and its screen-reader mode (which mirrors output into a live region) is not
  enabled yet. The input field is labelled, and every control around the terminal is accessible.
  A setting to turn on screen-reader mode is planned.
- Legacy X10 mouse reports that contain bytes above 127 are dropped (input travels as UTF-8
  text). SGR mouse mode, which modern programs use, is unaffected.
- A shell that exits at the same moment its tab is closed may not get its own exit event; the
  close is still recorded.
- A cursor-position request split across two reads of the pseudo-terminal is not recognised.
  With a view attached, xterm.js still answers it; with no view attached (rare: ConPTY sends it
  once at startup, in one piece), the shell may wait until a view attaches.
- Unix process-group cleanup is implemented and type-checked but was not exercised on macOS or
  Linux in this campaign (development and E2E ran on Windows); CI runs the PTY tests there.
