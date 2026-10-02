# KalCode — Product Definition

> **One intelligence that operates your entire AI workspace.**

Status: living document · Owner: KalCode engineering · Last reviewed: 2026-09-24

## 1. What KalCode is

KalCode is a commercial, local-first desktop application (plus the public website at
**https://kalcoded.com**) that gives developers one professional environment in which to:

- connect the AI coding providers they already use (Claude Code, Codex, Gemini CLI, and future providers),
- run those providers as persistent **Threads** inside real workspaces and terminals,
- stay in control of what every agent is allowed to do through **permission modes**,
- see everything that is happening on a live **Dashboard**,
- and use **KalVoice** — the coding assistant and voice layer built into KalCode — to dictate
  prompts into any input and to operate KalCode by voice or text.

KalCode solves the problem of juggling many independent coding-agent terminals. KalVoice makes
that environment conversational.

```text
Open KalCode → connect Claude / Codex / Gemini → open a project → run several coding agents
→ watch everything on the Dashboard → dictate prompts or ask KalVoice to run KalCode
→ permissions stay under your control → KalCode coordinates everything
```

## 2. Brand architecture

| Name | What it is |
| --- | --- |
| **KalCode** | The product: desktop app, website, subscription, orchestration environment. |
| **KalVoice** | The coding assistant and voice interface inside KalCode: hold one key to command KalCode, dictate, or ask. |

KalVoice line: **"Speak your prompts. Control your workspace. Coordinate your coding agents."**
KalCode tagline (brand board): **"One intelligence. A brighter tomorrow."**

KalCode is independent of any of the owner's private projects. No private code, data or branding
enters this repository (enforced by `tooling/check-branding.mjs`).

## 3. Business model: bring your own provider (absolute rule)

KalCode must operate without paying variable AI costs for its users.

- **Model inference runs on the user's own provider account** — their Claude Code sign-in or API
  key, their Codex account, their Gemini CLI account — through each provider's documented
  integration. Provider usage is paid for and governed by the user's relationship with that
  provider.
- KalCode never holds company-owned provider credentials for customer use, never falls back to a
  KalCode-paid API, and never resells or meters provider tokens.
- Speech: KalVoice dictation runs a **local** speech-recognition model on the user's computer;
  spoken replies use the operating system's speech synthesis. No paid cloud STT/TTS.
- Deferred until explicitly approved with sustainable revenue: KalCode-hosted inference, funded
  credits, cloud speech, hosted agent compute.
- `tooling/check-zero-cost.mjs` fails CI if product code calls hosted AI or speech APIs directly.

KalCode's own infrastructure is the app, account system, website, billing and a lightweight
backend.

## 4. Product surfaces

| Surface | Purpose | Campaign |
| --- | --- | --- |
| Dashboard | Runtime truth: what is running, who is doing it, what needs approval. | Z0 shell → Z5 |
| KalVoice | One push-to-talk key: commands that operate KalCode, dictation into any input, requests for your provider. | Z12 (in progress) |
| Code | Pane-based project workspace (threads, terminal, files, Git, diff, browser). | Z1 → Z6 |
| Threads | Persistent units of AI work. | Z3 |
| Agents | Persistent AI teammates with roles, providers and permissions. | Z8 |
| Missions | Outcome-oriented multi-task execution with verification. | Z9–Z10 |
| Automations | Scheduled and event-triggered runs. | Z11 |
| Skills / Plugins | Reusable procedures; capability-scoped integrations. | Z11 |
| Memory | Scoped, inspectable memory. | Z11+ |
| Providers | Detection, connection, capabilities, accounts. | Z2 |
| Settings | Appearance, diagnostics, defaults, the KalVoice push-to-talk key. | Z0 → |
| Account / Billing | KalCode account, plan, entitlement, KalVoice usage. | Z13 |

Surfaces that have not shipped are gated by feature flags and, in development builds, render an
honest "not available in this build" page — never a fake UI.

## 5. KalVoice

See `docs/KALVOICE.md`. One push-to-talk key (F8 by default, configurable): **hold it, speak,
let go.** What happens next depends on what was said and where:

- **A command** KalVoice recognizes with confidence ("Open four Codex threads", "Pause every
  active thread", "Show me anything waiting for permission") runs at once, with a "Type it
  instead" undo. Commands are understood deterministically without any model. Each executed
  command counts as **one KalVoice Request**. Provider sessions retain their native permission
  experience; KalVoice does not add a second app-control approval layer.
- **Dictation**: otherwise, if a text box or terminal is focused, the words are typed there
  (thread composers for Claude/Codex/Gemini, terminal input, prompts, search). Local speech
  recognition. **Unlimited on every plan; never counted.**
- **A request**: anything else goes through the bounded **on-device interpreter**. Missing,
  uncertain or invalid local interpretation fails closed and is not counted. Connected coding
  providers are action targets; they are never KalVoice's fallback brain.

KalVoice uses the same runtime as the rest of KalCode and is never above the permission model.

## 6. Plans

Defined once in `packages/protocol/src/plans.ts`.

| | Free (TRY) | Pro (BUILD) | MAX (ORCHESTRATE, most popular) | MAX 2X (AUTOMATE) | OWNER (private) |
| --- | --- | --- | --- | --- | --- |
| Price | $0 | $10 / month or $100 / year | $25 / month or $250 / year | $50 / month or $500 / year | $0, non-billable |
| KalVoice Requests / month | 25 | 150 | 500 | 1,000 | Unlimited |
| Open terminals | 4 | 12 | 18 | Unlimited | Unlimited |
| Parallel coding agents | 1 | 4 | 10 | Unlimited | Unlimited |
| Workspaces | 2 | 10 | Unlimited | Unlimited | Unlimited |
| Connected provider accounts | 2 | 6 | 8 | Unlimited | Unlimited |
| Local KalVoice dictation | Unlimited | Unlimited | Unlimited | Unlimited | Unlimited |
| Permission modes (Plan, Approve, Auto, Bypass, Custom) | All | All | All | All | All |
| Plan roadmap | `PLAN_FEATURE_GROUPS` in `plans.ts`: each feature's lowest plan and Available / Coming soon state | | | | Everything, current and future |

"Unlimited" means KalCode sets no limit of its own; hardware, OS, provider, account, API and upstream
limits may still apply.

Rules:

- Every provider is available on every plan; plans limit how many provider accounts are connected. Provider tokens are never counted as KalVoice usage.
- Permission modes are safety controls and are never paywalled.
- "KalVoice Requests" is the user-facing unit. Never call them tokens.
- Paid access and usage are authorized by trusted backend state (server-side entitlements and a
  usage ledger). OWNER is a private server-side entitlement: non-billable, non-expiring, not
  purchasable, unrestricted, and never granted by frontend checks or email comparisons.

## 7. Principles

- **Everything visible works.** No dead buttons, fake statuses, placeholder data presented as real.
- **Runtime truth over prose.** Status comes from structured events, not model-written text.
- **User authority.** KalVoice and every agent operate inside the user's permission model.
- **Provider independence.** No provider is an architectural dependency.
- **Zero company AI cost.** Users' own providers and local compute; nothing KalCode must subsidize.
- **Local-first and private.** Projects, threads, events, memory and settings stay on the device;
  dictation audio stays local and is not retained.
- **Evidence over claims.** "Done" requires verification evidence.
- **Honest marketing.** The website never promises functionality that does not exist.
