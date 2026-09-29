# KalVoice

KalVoice is the coding assistant and voice layer built into KalCode. It turns your voice into
coding prompts and KalCode commands: dictate directly into Claude Code, Codex, Gemini CLI and
your terminals, or ask KalVoice to run your workspace. Hold one key, speak, let go.

Status: shipped in 0.1.5 and **Available on every channel, Stable included**
(`crates/native-core/src/flags.rs`). Code: `crates/kalvoice`, the desktop shell's
`kalvoice_commands.rs`, `apps/desktop/src/kalvoice/`. The surface needs the on-device speech
engine (`kalvoice-whisper`). Outside development builds it is hidden only when the engine isn't
compiled in (`FeatureFlags::require_component`). Release builds always include the engine:
Stable Windows builds refuse to build without it (`tooling/release/build-windows.mjs`), and macOS
release builds always add it (`tooling/release/macos-contract.mjs`). See "Implementation" below
and `docs/campaigns/Z12.md`.

## Principles

1. **Zero company AI cost.** Dictation uses an on-device speech model. Commands that KalCode can
   understand deterministically run without any model. Requests that need interpretation use the
   explicitly configured on-device reasoning runtime. Missing local reasoning fails closed; there
   is no connected-provider or KalCode-paid fallback.
2. **Same systems, no duplicates.** KalVoice calls the same runtime APIs as the UI (workspaces,
   terminals, threads, approvals, navigation). It is never above the permission model and can
   never enable Bypass.
3. **Private by default.** Audio is captured into memory, transcribed on the device, and
   discarded. Recordings are not stored or uploaded. Events never contain transcripts or request
   text.
   **Network (disclosed default-on exception).** KalVoice's inference makes no network calls and
   costs $0. The one exception is a one-time download of its default components on first use,
   on by default: the English speech model (`tiny.en`, about 78 MB) and, while "Prepare local
   intelligence automatically" is on, local intelligence (about 850 MB). Both come only from
   KalCode's signed component catalog on kalcoded.com and are verified (signatures, size,
   SHA-256, rollback floor) before use. While they download, the widget and Settings say what is
   downloading, its size and its source ("Downloading the English speech model (78 MB) from
   KalCode's signed component catalog…", "Preparing local intelligence (852 MB) from KalCode's
   signed component catalog…"), and KalVoice Settings carries a standing note about these
   one-time, verified downloads. Removing the speech model, pausing, or turning the preference
   off stops them. Nothing else is downloaded without a click, and audio never leaves the device.
4. **Immediate.** The microphone starts on key-down, recognition streams while you speak, and
   a command runs the moment you let go.

## Push to talk

One key, held: **hold `F8`, speak, let go.** No chords. The key is configurable in Settings →
KalVoice ("Push-to-talk key", Change): F1–F24, Pause, Scroll Lock or Insert, on its own.

- **F5, F7 and F12 are refused**: KalCode's window uses them (reload, caret browsing, developer
  tools). A key another app has registered globally is refused when saving ("F9 is already used
  by another app. Choose a different key.") and the previous key stays.
- **Fn is not offered.** On Windows keyboards Fn is handled by the keyboard firmware and never
  reaches applications, so KalCode can't see it pressed or released. The capture field only
  accepts keys that actually arrive.
- **Caps Lock (and Num Lock) are not offered.** Registering them system-wide needs a low-level
  keyboard hook, and holding them toggles the lock state; KalCode doesn't install keyboard hooks.
- Modifiers alone and chords are refused ("Push to talk uses one key on its own, without Ctrl,
  Alt or Shift.").

The key is registered through the official Tauri global-shortcut plugin, from Rust only (the
WebView has no permission to call the plugin), and **only while a KalCode window has focus**, so
other apps keep the key. Real press and release events drive the microphone. Key repeat is
ignored (the OS registration uses no-repeat). If the release can't arrive (the window loses
focus while the key is held) the take finishes at that moment; a 120 s cap ends any take.
Escape cancels and discards. Hiding the widget does not turn push to talk off; a separate switch
(Settings → KalVoice → Push to talk) does.

## One utterance, three outcomes

When the key goes up, KalVoice decides what the words were for:

| # | Condition | Result | Counted |
| --- | --- | --- | --- |
| 1 | The words are a KalVoice command with **high confidence** ("open dashboard", "new terminal", "pause every thread") | the command runs; the widget shows the result and **Type it instead** | 1 KalVoice Request |
| 2 | Otherwise, a text box or terminal had focus when the key went down | the words are typed there at the caret (terminals: written to the PTY) | never |
| 3 | Otherwise | local interpretation into a validated KalCode action, or an explicit unavailable/uncertain response | 1 only when executed |

**Type it instead** undoes a command that was meant as text: it types the words into the box
that had focus and, when the command is reversible (navigation), goes back and un-counts it.
Low-confidence matches (a bare "status" or "approvals", or "switch to Codex", said while typing)
are dictated, not run.
The route taken is recorded in `kalvoice.*` events by id and intent name only.

Typed requests (the KalVoice page's "Type a request") take route 1 or 3.

## Latency

Latency is the product. The pipeline never transcribes from scratch after the key goes up:

```text
KEY DOWN ─▶ microphone open (cpal, in memory, 16 kHz mono)          stage 1: key down → mic
         ─▶ streaming recognition: the growing buffer is re-decoded
            about every 300 ms, partial words shown live             stage 2: speech → first partial
KEY UP   ─▶ tail check: if the last 300 ms are silent the latest
            partial is final (no pass); else one short final pass   stage 3: key up → final
         ─▶ compiled deterministic matcher (no model)                stage 4: final → recognized
         ─▶ execute through the runtime APIs ─▶ UI updated           stage 5: recognized → visible action
```

- **Warm:** the selected model is loaded at startup and kept (with its decoder state); changing
  the model reloads it in the background. The microphone opens on key-down and is not pre-opened:
  measured open time is already inside budget, and a pre-opened microphone would keep the OS
  "microphone in use" indicator on all the time.
- **Decode budget:** the audio context is sized to the audio (not whisper's fixed 30 s window)
  and tokens are capped by duration, which took one pass from about 4 s to 0.1–0.7 s on the
  reference machine.
- **Instrumentation:** every take records the five stages with monotonic clocks; the last 200
  are kept in memory (never on disk) and summarized as p50/p95/p99. Development builds show them
  on the KalVoice page ("Latency (developer build)").
- **Benchmark:** `crates/kalvoice/examples/latency_bench.rs` plays WAV fixtures in real time
  through the same controller and router, optionally under CPU load, and checks
  `crates/kalvoice/benches/budgets.json` (`--check`). Fixtures are generated locally with the
  operating system's own speech synthesis (`tooling/kalvoice/make-fixtures.ps1`, Windows
  System.Speech, 16 kHz mono); they are not committed.
- Measured numbers, the model choice and what is still over budget: `docs/campaigns/Z12.md`.

## Command pipeline

```text
request (push-to-talk transcript, or typed)
  ─▶ allowance check (KalVoice Requests)            one top-level request = 1
  ─▶ deterministic grammar ─▶ KalVoiceIntent          no model for structured commands
       └─ not understood ─▶ bounded on-device interpretation (or unavailable/uncertain)
  ─▶ validate the structured action against current workspace and runtime authority
  ─▶ atomic request claim and allowance check immediately before execution
  ─▶ execute through the existing runtime APIs
  ─▶ short report (text; optional OS speech synthesis)
```

Deterministic intents (`KalVoiceIntent`, `crates/contracts/src/kalvoice.rs`; 30 kinds with
`reasoning`):

- **Navigation and workspaces:** navigate (surfaces this build shows; others are refused
  `surface_unavailable`), open workspace, create terminal.
- **Threads:** create N threads with a provider (1–16), open thread, focus a thread or pane
  ("focus the login fix thread", "focus the Codex pane": a thread in a provider pane is shown
  in its pane on the Code canvas, others open in Threads), pause / resume / stop threads (all,
  workspace, one; never on a partial name). Asking for a permission mode ("switch the login fix
  thread to plan mode") opens the thread, and the person changes the mode in its permission menu;
  Bypass is refused outright, and the contract can't represent it.
- **Accounts:** `rebind_thread_account` resolves the thread and account and only opens
  KalCode's Rebind confirmation; `set_workspace_account` sets the workspace's default account.
- **Sessions (0.1.5):** "send that" / "clear that" (`submit_focused`, `clear_focused`, scoped to
  what KalVoice typed), "tell <session> to …" (`direct_prompt`, through the composer's own Send),
  `focus_by_state`, `focus_previous` and `which_sessions` ("what needs permission?"). Every
  spoken session name goes through the session resolver; several fits get a "Which one?" choice.
- **Approvals and status:** show approvals, status report ("what are my threads doing?"),
  filter the Dashboard (Z7-W3, `filter_dashboard`, UI-only).
- **Layout:** pane layout (Z7-W1, below), `control_pane` (move, maximize, restore, collapse,
  expand a named pane) and `control_browser` (open, navigate, back, forward, reload, stop).

Everything else is `Reasoning`.

Refused in 0.1.5, before anything is counted:

- **Provider panes** (`create_provider_panes`, and `create_threads` without an account) need
  the ProviderPanes feature, which is gated on Stable: refused `provider_panes_unavailable`.
  "Open a new Codex thread with my work account" is not refused: it opens KalCode's New thread
  form and starts nothing.
- **`search`** ("search for the login fix") reads back names and statuses from the Session
  Locator, a gated feature. Where the locator isn't shown (Stable), voice search is refused
  `not_in_this_build` and never reads locator results.
- **`switch_provider`** ("switch to Codex") is parsed at low confidence, so a focused text box
  keeps the words; as a command it is refused `not_in_this_build`.

**Pane layout intents** (Z7-W1). Deterministic, verb-led (high confidence), layout only: they
never start, stop or close a process and never ask for approval (they count like navigation).
The result is a UI directive the Code pane canvas carries out; when Code isn't on screen,
KalVoice opens it first.

| Say | Intent | UI directive | What happens |
| --- | --- | --- | --- |
| "split the pane", "split this pane side by side / horizontally / left and right" | `split { axis: horizontal }` | `split_pane` | The focused pane splits; the new pane (right) offers what can be opened there. |
| "split the pane vertically / down / stacked / top and bottom" | `split { axis: vertical }` | `split_pane` | The new pane opens below. |
| "split Claude and Codex side by side", "put Claude next to Codex", "arrange Gemini and Claude top and bottom" | `split` + the named providers (carried inside `crates/kalvoice` as `NamedTarget::Providers` → `ExecContext.providers`; the contract intent can't hold them) | `arrange_panes { axis, providerIds }` | The newest pane of each named provider in the workspace is put next to the first; a provider without a pane is reported honestly ("No pane yet for …"), nothing is started. |
| "make this pane bigger / larger / wider / taller / smaller / narrower / shorter", "grow / enlarge / expand / widen / shrink the pane" (+ "a bit" = 1 step, "much / a lot" = 4, default 2) | `resize { direction, steps }` (bigger → right, taller → down, smaller → left, shorter → up) | `resize_pane` | The focused pane grows (or shrinks) by 32 px per step; with no neighbour that way it grows toward the other side, so "bigger" always does something. |
| "close this pane", "close the Codex pane" | `close { query }` | `close_pane` | The pane leaves the layout; what it runs keeps running ("in background") and Ctrl Alt R reopens it. |

Axis convention (shared with `apps/desktop/src/shell/panes/model.ts`): `horizontal` = side by
side, `vertical` = stacked. "And" normally makes a request compound (→ `Reasoning`); the only
patterns tried on a request containing a conjunction are these pane arrangements.

Dashboard filters (`FilterDashboard { chip }` → `UiDirective::FilterDashboard`; no model, no
thread changes; the summary counts non-archived threads by `ThreadStatus::chip`):

| Chip | Example phrases |
| --- | --- |
| `working` | "Show only agents that are working", "show working agents", "which agents are working" |
| `waiting_for_you` | "Show everything waiting for me", "show the agents waiting for me", "show threads that need my attention" |
| `done` | "Show completed work", "show finished threads", "show threads that have finished" |
| `idle` | "Show idle agents", "show the threads that are idle" |
| `all` | "Show all agents", "clear the dashboard filter" |

"Show what's waiting for me" still opens the Approvals panel, and "show agents" still navigates.

**Workspace controls** use the same local actions as the interface. Creating, opening,
pausing and resuming workspace sessions do not add a separate KalCode approval.
Provider execution remains governed by the selected runtime's native permission mode.
KalVoice does not answer provider approvals or enable Bypass.

**KalVoice intelligence** is local-only: deterministic commands first, then the on-device
interpreter when configured and ready. Missing local reasoning returns
`local_reasoning_unavailable`, remains uncounted, and never falls back to a connected
provider. Legacy stored provider-intelligence preferences do not authorize provider inference.

## Speech models

whisper.cpp models (upstream: Hugging Face `ggerganov/whisper.cpp`, revision
`5359861c739e955e79d9a303bcbc70fb988958b1`), served as signed KalCode components from the signed
component catalog on kalcoded.com. Every download is checked against the catalog's Ed25519
signature, the component's own signature, its size and SHA-256, and the OS-held rollback floor;
downloads resume, and are installed into KalCode's signed component store atomically. Licence:
MIT (whisper.cpp and the converted OpenAI Whisper weights).

**Zero setup.** After the runtime starts, KalCode fetches the default model (`tiny.en`) on its
own through that same pipeline, with system-granted consent recorded as `automatic_default`
(the only model it may fetch without a click; every other model keeps its download dialog). The
consent kind is persisted in a sidecar (`consent.json`, bound to the receipt's SHA-256)
beside the component's signed-store receipt; the receipt itself keeps exactly the legacy shape,
so a lifecycle rollback to an older build still loads it. A revision without a valid sidecar
(legacy, or written by an older build) reads as `user` and is still detected, loaded and reused. An installed speech model is always reused and never fetched
again. If the owner removes (or
cancels) a speech model, KalCode stores an opt-out and never re-downloads one on its own;
Settings shows the manual Download again. Every component download waits (up to 10 minutes,
re-evaluated on each Resource Governor sample) instead of failing when the governor has no
room yet, and never fetches while push to talk is in use. The UI states are truthful:
Preparing speech (downloading x% / verifying), Waiting for system resources, Unavailable (with
the reason and the automatic retry), then Ready. The installer does not bundle a model.

| Model | Size | Use |
| --- | --- | --- |
| English (fastest), `tiny.en`, **default** | 78 MB | quickest response; commands and short dictation |
| English (balanced), `base.en` | 148 MB | more accurate dictation, slower |
| English (more accurate), `small.en` | 488 MB | accents and technical words; slow on older CPUs |
| Multilingual `base`, `small` | 148 / 488 MB | about 100 languages |

`tiny.en` is the default because it was the only model near the key-up budget on the reference
CPU; the vocabulary prompt and the alias and repetition clean-up keep command accuracy on the
fixtures. Quantized variants (q5_1, q8_0) measured slower on this CPU and aren't offered.
Streaming engines built for partials (sherpa-onnx with a streaming zipformer, Apache-2.0) are
the next candidate; see the campaign doc.

## KalVoice Requests

- One top-level request to the assistant counts once, however many internal steps it takes
  ("Pause every active thread" = 1; "Have Claude implement this, Codex review it, then run the
  tests" = 1).
- Allowances per monthly cycle: Free 75 · Pro 1,500 · MAX 5,000 · MAX 2X 10,000 · OWNER unlimited
  (`packages/protocol/src/plans.ts`). Dictation is never counted. Provider tokens are never counted.
- The server-side usage ledger is authoritative (docs/BILLING.md): idempotent per client request
  id, reset per the account's plan cycle. Before accounts exist, and briefly offline, the app keeps
  a provisional local count with the plan's allowance and reconciles with the ledger when it can.
  A finite plan displays, for example, "482 / 1,500 used · 1,018 remaining · renews October 1."
- User-facing unit: **KalVoice Requests** — never "tokens".

## Speech output

Optional spoken replies use the operating system's speech synthesis. No cloud text-to-speech.

## Events

`kalvoice.dictation_started|completed|failed`, `kalvoice.request_started|completed|failed`,
`kalvoice.command_recognized|executed`, `kalvoice.limit_reached`, `kalvoice.provider_selected`,
`kalvoice.voice_output_started|completed` — ids and facts only (see docs/EVENT_PROTOCOL.md).

## Local intelligence

**Provisioning (shipped in 0.1.5).** Once a speech model is ready, KalCode prepares local
intelligence (llama.cpp runtime plus the Qwen model, about 850 MB) automatically through the same
signed catalog and verified pipeline, under `automatic_default` consent, while the Settings
preference "Prepare local intelligence automatically" is on (default; turn it off on a metered
connection, then use Review download). Settings shows "Preparing local intelligence (850 MB)…"
with progress and a Pause/Resume control; a pause is stored and survives restarts. A failed
download or interpreter start is never final: KalCode retries after 1, 5, 15 and 60 minutes, then
hourly, and at once when KalCode comes back to the front (no Retry click needed; Retry local
startup still works). Permanent failures do not retry: an unsupported system ("KalVoice
components aren't available for this system"), a catalog or component that fails signature or
trust verification ("Couldn't verify KalVoice components. Try again later"), or missing consent
stop automatic attempts until the next launch; the manual download stays available. A download
deferred for push to talk is traced every 60 seconds while it waits. KalCode does not detect metered networks. Other components (non-default
speech models) still require the owner's consent in their download dialog.

## Implementation (Z12)

### Crate `crates/kalvoice`

| Module | What it does |
| --- | --- |
| `grammar` | Compiled deterministic text → `KalVoiceIntent` with a confidence (high / low). Whole-utterance patterns after politeness words; negations ("don't…") and compound requests ("… and then …") are never commands (→ `Reasoning`). Counts: digits or one–twenty, at most 16 threads (`thread_count_too_large`), 0 refused, anything else never guessed. Hears "codecs"/"code x" as Codex and "for"/"to" as counts where speech recognition does. |
| `ledger` | Provisional monthly count (table `kalvoice_requests`): one row per client request id (idempotent), atomic allowance check, period from the cycle anchor day (1st, UTC) to the same day next month, refund for "Type it instead" on reversible commands within two minutes. Rows hold ids, input kind and intent name only. |
| `schema` | Migration **v6** (`crates/native-core/migrations/0006_kalvoice.sql`), registered in `kalcode_core::db::MIGRATIONS` after the event platform's v5 (embedded, checksummed, backed up before it runs). Upgrades v4 → v6 and v5 → v6 are tested in `crates/kalvoice/tests/schema.rs` and end to end in `apps/desktop/tests/e2e/integrity.spec.ts`. |
| `plan` | Allowance per tier (Free 75, Pro 1,500, MAX 5,000, MAX 2X 10,000, OWNER unlimited); a test reads `packages/protocol/src/plans.ts` so the numbers can't drift. Before accounts exist every install is provisionally Free. |
| `orchestrator` | Allowance check ? deterministic grammar or local interpretation ? validated workspace/runtime action ? atomic request ledger ? execution. Duplicate request IDs never execute or count twice. Unavailable or invalid interpretations remain uncounted. Workspace controls use no extra approval; coding sessions keep provider-native permissions. Events publish only after committed state and contain no transcript. |
| `voice`, `streaming`, `audio`, `stt` | One take at a time. Engine and model are checked **before** the microphone opens; capture of the default input (cpal) into memory (mono, 120 s cap), windowed-sinc resampling to 16 kHz, streaming partials, tail reuse, whisper.cpp (`whisper` feature) with a persistent decoder state, then the audio is zeroed and dropped. Only a 0–1 input level leaves the capture. |
| `latency` | Five stage timings per take, rolling p50/p95/p99. |
| `models` | Catalog pinned to one Hugging Face revision with sizes and SHA-256; consented, resumable, verified, atomic downloads into `<data>/models/whisper/`; cancel keeps the partial file; delete removes both. |
| `prefs` | Push-to-talk key and switch, legacy intelligence preference, speech model, spoken replies (off), widget default position (top centre), visibility and a placement per window size class (table `kalvoice_preferences`). |
| `shortcuts` | The single-key rules: allowed keys, keys KalCode reserves, and why Fn, lock keys and modifiers are refused. |
| `speech_output` | Optional OS voice (`tts` crate; Windows speech / macOS) on its own thread. Off by default. |

A KalVoice Request counts when KalVoice executes a validated command. Refused requests
(missing runtime, unavailable workspace, invalid interpretation or exceeded allowance) do
not count. Duplicate IDs cannot execute or count twice. Local dictation never counts.

### Desktop

- Commands (registered in `lib.rs`, allow-listed in `command_registry.rs` and the capability):
  `kalvoice_subscribe` (a per-window signal channel: listening, level, partials, results with
  timings, stages, downloads), `kalvoice_status`, `kalvoice_request`, `kalvoice_talk`,
  `kalvoice_type_instead`, `kalvoice_latency`, `kalvoice_latency_record`,
  `kalvoice_preferences_update`, `kalvoice_listen_start|stop|cancel`,
  `kalvoice_model_download|cancel|delete`, `kalvoice_reasoning_prepare`,
  `kalvoice_reasoning_retry` and `kalvoice_open_microphone_settings` (opens the OS microphone
  privacy page). There is no KalVoice approval command and no approvals worker: KalVoice never
  answers approvals, and provider permission prompts stay native to each provider.
  Push to talk records its takes in `talk` mode (`KalVoiceMode::Talk`).
- `kalvoice_executor.rs` runs commands through the same runtimes as the UI: workspaces and
  terminals (Z1, `kalcode_core`), threads (Z3, `ThreadRuntime`: `create_idle_threads`,
  `pause_threads`, `resume_threads`, `stop_threads`, `find`, `status_summary`) and pending
  approvals (Z4, `PermissionService::list_approvals`, read-only). The UI side of a result
  (navigate, open a workspace or terminal, open a thread, open the Approvals panel, filter the
  Dashboard, and the pane directives through `dispatchPaneCommand`,
  apps/desktop/src/shell/panes/paneCommands.ts) runs in `KalVoiceProvider`.
- Interpretation uses the local reasoning interface. Missing runtime fails closed; connected
  coding providers are never an interpretation fallback.
- KalVoice's tables are schema v6, part of every build's migrations; the first start after
  the update backs up the database and adds them.
- The voice widget: one line, `[orb] KALVOICE ● Ready`, docked top centre by default (clear of
  composers and terminal controls). States Ready · Listening · Processing · Executing · Done ·
  Error, each as text beside a dot and announced in a polite live region; the orb's motion
  follows the state and stops under reduced motion. It opens up only for the live transcript, a
  brief result (with "Type it instead") or an error with its fix, then settles back. It never
  shows an approval prompt. There is no text box in the widget; the orb itself
  is a quiet press-and-hold alternative to the key. It drags anywhere inside the window, docks
  to edges and corners, collapses to the orb, hides (push to talk keeps working), remembers a
  placement per window size, and moves with the arrow keys. The push-to-talk key, Settings and
  the command palette bring it back.
- Dictation goes into the text box focused when the key went down (inserted at the caret).
  Terminals register a sink with `registerDictationSink` (`apps/desktop/src/kalvoice/dictation.ts`)
  so text goes to the PTY.

### Building

The whisper.cpp engine is behind the cargo feature `kalvoice-whisper` (desktop) / `whisper`
(crate) because its bindings are generated with bindgen, which needs **libclang**
(`docs/DEVELOPMENT.md`, "Building KalVoice's speech engine"). With LLVM installed
(`winget install LLVM.LLVM`) and `LIBCLANG_PATH` pointing at its `bin` folder:

```bash
pnpm --filter @kalcode/desktop tauri build --no-bundle --features kalvoice-whisper
```

Without the feature everything else works and push to talk says the speech engine isn't included
in this build; outside development builds the KalVoice surface is then hidden. Release builds
always include the feature (see "Status" above). CMake and the MSVC build tools are also
required (already needed by Tauri on Windows). Microphone capture and the OS voice are built on
Windows and macOS; on Linux they report unavailable until CI installs the ALSA and
speech-dispatcher development packages.
