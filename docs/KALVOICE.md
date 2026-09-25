# KalVoice

KalVoice is the coding assistant and voice layer built into KalCode. It turns your voice into
coding prompts and KalCode commands: dictate directly into Claude Code, Codex, Gemini CLI and
your terminals, or ask KalVoice to run your workspace.

Status: implemented in campaign Z12 (`crates/kalvoice`, the desktop shell's
`kalvoice_commands.rs`, `apps/desktop/src/kalvoice/`); **Preview** in development and beta
builds. See "Implementation" below and `docs/campaigns/Z12.md`.

## Principles

1. **Zero company AI cost.** Dictation uses an on-device speech model. Commands that KalCode can
   understand deterministically run without any model. Requests that need reasoning use the
   user's own connected provider. There is no KalCode-paid fallback, ever.
2. **Same systems, no duplicates.** KalVoice calls the same runtime APIs as the UI (workspaces,
   terminals, threads, approvals, navigation). It is never above the permission model and can
   never enable Bypass.
3. **Private by default.** Audio is captured into memory, transcribed on the device, and
   discarded. Recordings are not stored or uploaded. Events never contain transcripts or request
   text.
4. **Immediate.** The microphone starts on key-down, before anything else.

## Modes and shortcuts

Two independently configurable shortcuts (Settings → KalVoice):

| Mode | Default gesture | Result | Metering |
| --- | --- | --- | --- |
| Dictation | hold `Ctrl+Shift+Space` (⌘⇧Space on macOS) | transcript inserted into the focused input | never counted, unlimited on every plan |
| Command | press `Ctrl+Shift+K` (⌘⇧K), then speak or type | a KalCode action and a short report | 1 KalVoice Request per top-level request |

Defaults are chosen to avoid common OS and editor shortcuts and are checked for conflicts with
KalCode's own bindings.

## Dictation pipeline

```text
shortcut down ─▶ microphone live (native capture, 16 kHz mono, in memory)
shortcut up   ─▶ on-device speech recognition ─▶ transcript
              ─▶ insert into the focused KalCode input ─▶ audio buffer dropped
```

- **Speech engine:** whisper.cpp through Rust bindings, running on the user's CPU (GPU where
  available). Model files are downloaded only after the user agrees, from the model's official
  distribution, verified by SHA-256, and stored in KalCode's data folder. A compact English model
  is the default; larger or multilingual models are optional. Nothing is downloaded automatically.
- **Targets:** thread composers (Claude Code, Codex, Gemini CLI), terminal input (written to the
  PTY), the command palette, search boxes, prompts and other text inputs that opt in. The focused
  target is resolved when the shortcut is pressed, so switching focus mid-dictation cannot send
  text to the wrong place.
- **States:** listening, transcribing, inserted, cancelled (Escape), nothing heard, model not
  installed (with a download action), microphone unavailable or denied.

## Command pipeline

```text
request (voice → local transcript, or typed)
  ─▶ allowance check (KalVoice Requests)            one top-level request = 1
  ─▶ deterministic grammar ─▶ KalVoiceIntent          no model for structured commands
       └─ not understood ─▶ Reasoning via the user's selected provider (or "connect a provider")
  ─▶ permission evaluation for consequential actions
  ─▶ execute through the existing runtime APIs
  ─▶ short report (text; optional OS speech synthesis)
```

Deterministic intents (`KalVoiceIntent`): navigate, open workspace, create terminal, create N
threads with a provider, open thread, pause / resume / stop threads (all, workspace, one), show
approvals, status report ("what are my threads doing?"). Everything else is `Reasoning`.

**KalVoice intelligence** (which provider powers reasoning) is chosen by the user: a global
default and optional per-workspace defaults, from the providers they have connected. If the
chosen provider is unavailable: "Claude is currently unavailable. Choose another connected
provider or retry." If none is connected: "Connect a supported AI provider to use KalVoice
reasoning for this request."

## KalVoice Requests

- One top-level request to the assistant counts once, however many internal steps it takes
  ("Open four Codex threads" = 1; "Have Claude implement this, Codex review it, then run the
  tests" = 1).
- Allowances per monthly cycle: Free 250 · Pro 2,500 · MAX 10,000 · OWNER unlimited
  (`packages/protocol/src/plans.ts`). Dictation is never counted. Provider tokens are never counted.
- The server-side usage ledger is authoritative (docs/BILLING.md): idempotent per client request
  id, reset per the account's plan cycle. The app shows "Used 412 of 2,500, resets …". Before
  accounts exist, and briefly offline, the app keeps a provisional local count with the plan's
  allowance and reconciles with the ledger when it can.
- User-facing unit: **KalVoice Requests** — never "tokens".

## Speech output

Optional spoken replies use the operating system's speech synthesis. No cloud text-to-speech.

## Events

`kalvoice.dictation_started|completed|failed`, `kalvoice.request_started|completed|failed`,
`kalvoice.command_recognized|executed`, `kalvoice.limit_reached`, `kalvoice.provider_selected`,
`kalvoice.voice_output_started|completed` — ids and facts only (see docs/EVENT_PROTOCOL.md).

## Future

On-device reasoning models (`KalVoiceIntelligence::Local`), never downloaded without consent and
not a launch requirement.

## Implementation (Z12)

### Crate `crates/kalvoice`

| Module | What it does |
| --- | --- |
| `grammar` | Deterministic text → `KalVoiceIntent`. Whole-utterance patterns after politeness words; negations ("don't…") and compound requests ("… and then …") are never commands (→ `Reasoning`). Counts: digits or one–twenty; more than 20 is refused (`thread_count_too_large`), 0 is refused, anything else is never guessed. Named workspaces/threads stay placeholders until the runtime resolves them. Accepts "codecs"/"code x" for Codex (how speech recognition hears it). |
| `ledger` | Provisional monthly count (table `kalvoice_requests`, migration 0006): one row per client request id (idempotent), atomic allowance check, period from the cycle anchor day (1st, UTC) to the same day next month. Rows hold ids, input kind and intent name only. |
| `plan` | Allowance per tier (Free 250, Pro 2,500, MAX 10,000, OWNER unlimited); a test reads `packages/protocol/src/plans.ts` so the numbers can't drift. Before accounts exist every install is provisionally Free. |
| `orchestrator` | allowance check → grammar → name resolution → runtime check → `PermissionGate` (consequential intents only: create/pause/resume/stop threads; always evaluated in Approve mode, KalVoice never changes modes) → count → execute (via the `Executor` trait) or reason (via `AgentProvider`, read-only Plan mode, provider approvals denied, 120 s timeout, session terminated). Stages (`thinking`, `executing`) are reported for the UI. Events commit with state and are published after commit. |
| `voice`, `audio`, `stt` | One listening session at a time. Checks engine and model **before** the microphone opens; captures the default input (cpal) into memory (mono, 120 s cap), resamples to 16 kHz (windowed-sinc low-pass), transcribes with whisper.cpp (`whisper` feature), zeroes and drops the audio. Reports a live 0–1 input level for the waveform — only that number leaves the capture. |
| `models` | Catalog pinned to Hugging Face `ggerganov/whisper.cpp` revision `5359861c739e955e79d9a303bcbc70fb988958b1` with the published sizes and SHA-256 (base.en default; small.en, base, small optional). Download needs an explicit consent flag, writes `<file>.partial`, resumes with HTTP ranges, verifies the whole file, renames atomically; cancel keeps the partial file; delete removes both. Stored in `<data>/models/whisper/`. |
| `prefs` | Shortcuts, reasoning provider (automatic / a connected provider / on-device placeholder), speech model, spoken replies (off), assistant default position, visibility and a placement per window size class (table `kalvoice_preferences`). |
| `shortcuts` | Canonical accelerators (`CommandOrControl+Shift+Space`), modifier requirement, conflicts with KalCode's bindings, common system/editor shortcuts, and the other KalVoice shortcut. |
| `speech_output` | Optional OS voice (`tts` crate; Windows speech / macOS) on its own thread. |

What counts as a KalVoice Request: a request KalVoice acts on — it runs a command, opens an
approval request, or sends it to your provider. Refused-up-front requests are not counted:
limit reached, no provider connected, a workspace/thread that doesn't exist, a command this build
can't run, or a count that is out of range. Dictation is never counted.

### Desktop

- Commands (allow-listed in `build.rs` and the capability): `kalvoice_subscribe` (a per-window
  signal channel: listening, level, transcripts, stages, downloads), `kalvoice_status`,
  `kalvoice_request`, `kalvoice_preferences_update`, `kalvoice_listen_start|stop|cancel`,
  `kalvoice_model_download|cancel|delete`.
- Global shortcuts use the official Tauri global-shortcut plugin, registered from Rust only (the
  WebView has no permission to call the plugin). Dictation starts only while KalCode is focused.
  A command-shortcut tap opens the assistant ready to type; holding it speaks a command. A
  shortcut the OS refuses (another app owns it) is not saved and the previous one is restored.
- Reasoning uses the provider runtime (Z2): Claude Code, when installed and signed in, runs
  read-only in `<data>/kalvoice/reasoning`. Other providers join as their adapters land.
- Seams that answer honestly until their campaigns merge: workspaces and terminals (Z1),
  threads and status (Z3), approvals (Z4, `AskUnlessReadGate` meanwhile). Navigation works now.
- The floating assistant (orb above a small panel: KALVOICE, state line, waveform; expanded view
  adds the request box, result and usage) is draggable, clamped to the window, docks to edges and
  corners, collapses to the orb, minimizes, expands and closes (the command shortcut reopens it).
  States: idle, listening, transcribing, thinking, executing, waiting for permission, done,
  error — each announced in a live region. Decorative motion stops under reduced motion.
- Dictation goes into the text box focused when the shortcut went down (inserted at the caret).
  Terminals register a sink with `registerDictationSink` (`apps/desktop/src/kalvoice/dictation.ts`)
  so text goes to the PTY; Code mode wires it to `terminal_write`.

### Building

The whisper.cpp engine is behind the cargo feature `kalvoice-whisper` (desktop) / `whisper`
(crate) because its bindings are generated with bindgen, which needs **libclang**. With LLVM
installed (`winget install LLVM.LLVM`) and `LIBCLANG_PATH` pointing at its `bin` folder:

```bash
pnpm --filter @kalcode/desktop tauri build --no-bundle --features kalvoice-whisper
```

Without the feature everything else works and dictation says the speech engine isn't included in
this build. CMake and the MSVC build tools are also required (already needed by Tauri on Windows).
Microphone capture and the OS voice are built on Windows and macOS; on Linux they report
unavailable until CI installs the ALSA and speech-dispatcher development packages.
