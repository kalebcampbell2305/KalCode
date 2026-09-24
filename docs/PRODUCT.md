# KalCode — Product Definition

> **One intelligence that operates your entire AI workspace.**

Status: living document · Owner: KalCode engineering · Last reviewed: 2026-09-24 (campaign Z0)

## 1. What KalCode is

KalCode is a commercial, local-first desktop application (plus the public website at
**https://kalcoded.com**) that gives developers one professional environment in which to:

- connect the AI coding providers they already use (Claude Code, Codex, Gemini CLI, and future providers),
- run those providers as persistent **Threads** inside real workspaces and terminals,
- stay in control of what every agent is allowed to do through **permission profiles**,
- see everything that is happening on a live **Dashboard**,
- and, when they want to, hand an objective to **JARVIS**, the intelligence inside KalCode that
  coordinates providers, threads, missions and tools on the user's behalf.

The product promise, in four lines:

1. **Choose the intelligence.**
2. **Give it the objective.**
3. **Watch the work happen.**
4. **Stay in control.**

## 2. Brand architecture

| Name | What it is | What it is not |
| --- | --- | --- |
| **KalCode** | The commercial product: desktop app, website, subscription, orchestration environment. | — |
| **JARVIS** | An intelligence capability *inside* KalCode (conversation, orchestration, delegation, command interface). | Not the product name. Not the owner's private JARVIS system. |

JARVIS inside KalCode is implemented **independently** within this repository. The owner's
private, local JARVIS system is a separate, closed, owner-only system. No code, prompts,
memories, models, data or architecture from it may enter this repository or its installers
(see `docs/SECURITY.md` §Private-system boundary). KalCode must never require it.

Tagline system (from the brand references):

- KalCode wordmark tagline: **"Code a brighter tomorrow."**
- Product headline: **"One intelligence that operates your entire AI workspace."**
- JARVIS lockup line (in-app JARVIS surface): **"Global thinking. Personal impact."**

## 3. Product surfaces

| Surface | Purpose | First campaign |
| --- | --- | --- |
| Dashboard | Runtime truth: what is running, who is doing it, what needs approval. | Z0 shell → Z5 |
| JARVIS | Conversational command interface over the same runtime. | Z7 |
| Code | Pane-based project workspace (threads, terminal, files, Git, diff, browser). | Z1 → Z6 |
| Threads | Persistent units of AI work. | Z3 |
| Agents | Persistent AI teammates with roles, providers and permissions. | Z8 |
| Missions | Outcome-oriented multi-task execution with verification. | Z9–Z10 |
| Automations | Scheduled and event-triggered runs. | Z11 |
| Skills | Reusable, versioned procedures. | Z11 |
| Plugins | Capability-scoped integrations. | Z11 |
| Memory | Scoped, inspectable memory. | Z11+ |
| Providers | Detection, connection, capabilities, accounts. | Z2 |
| Settings | Appearance, diagnostics, defaults, notifications. | Z0 |
| Account / Billing | KalCode account, plan, entitlement. | Z13 |

A surface is only shown to normal users once it functions. Surfaces that have not reached
their campaign are **gated by feature flags** (see `docs/ARCHITECTURE.md` §Feature flags) and,
in development builds, render an explicit "not available in this build" state — never a fake UI.

## 4. Plans (centralized in `packages/protocol/src/plans.ts`)

| Plan | Price | Philosophy |
| --- | --- | --- |
| **Free** | $0 | Useful enough to understand why KalCode matters. |
| **Pro** | $10 / month | Serious individual use: concurrency, agents, pair/team workflows, automations, skills, plugins. |
| **MAX** | $25 / month | Highest individual concurrency, advanced missions and JARVIS, event automations, hosted features where available. |

Rules:

- Connecting an AI provider is **never** paywalled. KalCode monetizes KalCode functionality.
- Prices and entitlements come from one configuration module. No component hardcodes a price.
- Paid access is authorized only by trusted backend entitlement state (Z13). The client may cache
  entitlements for bounded offline grace.

## 5. Principles

- **Everything visible works.** No dead buttons, fake statuses, placeholder data presented as real.
- **Runtime truth over prose.** Status comes from structured events, not model-written text.
- **User authority.** JARVIS and every agent operate inside the user's permission model.
- **Provider independence.** No provider is an architectural dependency.
- **Local-first.** Projects, threads, events, memory, settings stay on the device by default.
- **Evidence over claims.** "Done" requires verification evidence.
- **Honest marketing.** The website never promises functionality that does not exist.

## 6. Current state (campaign Z0)

KalCode is in private development. Z0 delivers the foundation: monorepo, desktop shell, native
runtime, SQLite persistence with migrations, the event protocol, typed IPC, logging, error
architecture, secret-storage abstraction, design system, tests, CI, and the public website with
early-access registration. See `docs/campaigns/Z0.md` for the acceptance matrix and report.
