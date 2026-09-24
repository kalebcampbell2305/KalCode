# KalVoice

KalVoice is the coding assistant and voice layer built into KalCode. It turns your voice into
coding prompts and KalCode commands: dictate directly into Claude Code, Codex, Gemini CLI and
your terminals, or ask KalVoice to run your workspace.

Status: architecture defined (contracts in `crates/contracts/src/kalvoice.rs`); implementation is
campaign Z12, running in parallel.

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
