# KalCode Remote protocol (v1)

KalCode Remote turns an iPhone, iPad or Android device into a command center for the user's
**live desktop workstation**. The desktop stays the host: it runs the provider agents,
terminals, builds, Browser, Git/worktrees and deployments. Remote mirrors the desktop's
canonical state and sends actions back through the same services the desktop UI and KalVoice
use. There is no second product universe on the phone.

This document is the contract between the desktop host (`crates/remote` +
`apps/desktop/src-tauri/src/remote/`) and the mobile apps (`apps/mobile/ios`,
`apps/mobile/android`). Change both sides together.

## 1. Security model

| Requirement | How v1 meets it |
|---|---|
| Authenticated workstation identity | The desktop has a long-term X25519 static key (`remote:host-key` in the OS secret store via `crates/secure-store`). Its public key travels in the pairing QR code; the phone pins it and the Noise IK handshake proves the desktop holds the private key on every connection. |
| Secure device pairing | Desktop shows a QR code (and a copyable pairing link) with a single-use 32-byte pairing code that expires after 5 minutes. A device presents it inside the encrypted first handshake message; the desktop registers the device's static public key and burns the code. One pairing window at a time. |
| Encrypted transport | `Noise_IK_25519_ChaChaPoly_SHA256`, prologue `kalcode-remote/1`. Every byte after the handshake is AEAD-encrypted with per-direction keys. |
| Device revocation | The desktop's device registry removes the device key; any live connection from it is closed immediately with `revoked`. Later handshakes get an encrypted `revoked` rejection, so the phone can show the truth and clear its pairing. |
| Session-scoped credentials | No bearer tokens. Each connection derives fresh transport keys from ephemeral DH; the device's static private key never leaves its Keychain/Keystore. |
| Replay protection | The handshake mixes fresh ephemerals from both sides, so a replayed first message cannot complete a session. Pairing codes are single use. Transport messages use Noise's strictly increasing nonces; a gap or repeat kills the connection. Every request carries a unique `id`; the host remembers the last 512 results per device and returns the stored result for a repeated id instead of acting twice (a repeat while the first is still running is answered `conflict`). |
| Least privilege | Only the operations in §5 exist. There is no shell, file write, credential, permission-mode or settings operation. Approvals can be answered **Approve once** or **Deny** only. Every action is audited with `ActionOrigin::Remote { host_id: <device id> }`. |
| No credentials on the phone | Provider credentials, API keys, signing keys and account sessions never cross the wire. Mobile receives labels (account label, provider name), never secrets. |
| Unpaired devices | Get nothing: the handshake is rejected before any application data, so they cannot read source, provider sessions, credentials or project state. |
| Entitlement | Remote is a MAX feature (`FeatureId::Remote`). The listener runs only while the signed-in plan includes it and the user turned Remote on. |

### Key storage

* Desktop: static private key in the OS secret store (`remote:host-key`, base64). Device registry
  (`remote-devices.json`, public keys + metadata only) in the KalCode data directory.
* iOS: device static private key and the pinned workstation record in the Keychain
  (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). Android: Android Keystore-wrapped key.

## 2. Pairing payload

The desktop renders `kalcode-remote://pair?d=<base64url(JSON)>` as a QR code:

```json
{
  "v": 1,
  "wid": "ws_01J...",             // workstation id (stable, random)
  "name": "Kaleb's Workstation",  // desktop machine name
  "pk": "<base64 X25519 public>", // workstation static public key (32 bytes)
  "code": "<base64 32 bytes>",    // single-use pairing code
  "addrs": ["192.168.1.20:47820", "100.101.102.103:47820"],
  "exp": 1791234567              // unix seconds; the desktop also enforces it
}
```

`addrs` lists the desktop's reachable IPv4 addresses (LAN and Tailscale `100.64.0.0/10`)
with the listening port (default `47820`, next free up to `47829`). The phone tries every address
in parallel and keeps the first that completes a handshake.

## 3. Transport

TCP. Each wire frame is a 2-byte big-endian length followed by that many bytes of Noise message
(max 65535). After the handshake, the decrypted plaintext of consecutive frames forms one byte
stream of **application messages**: each is a 4-byte big-endian length followed by UTF-8 JSON
(max 8 MiB desktop → device, **max 256 KiB device → desktop**; a larger declared length closes
the connection). A sender splits an application message across as many frames as needed
(≤ 65519 plaintext bytes per frame).

### Limits (normative)

| Limit | Value | Over the limit |
|---|---|---|
| Handshake frame (either direction) | 4 KiB | connection closed |
| Handshakes in progress | 32 total, 4 per source IP | the TCP socket is closed before any Noise work |
| Handshake fields `device`, `platform`, `model`, `app` | ≤ 64 characters, no control characters | `invalid` |
| Device → desktop application message | 256 KiB | connection closed |
| Requests running per connection | 16 | `res` with `unavailable` |
| Request rate per device | `agent.launch` 5/min; `agent.prompt`, `agent.stop`, `agent.retry`, `needs.decide`, `voice.command`, `tidy.closeIdle` 30/min; reads (`agent.detail`, `agent.diff`, `agent.log`, `launch.options`, `run.detail`) 10/s, burst 20 | `res` with `refused`, message `rate limited` (the id is not remembered; a later retry runs) |
| Live sessions per device | 2 | the oldest gets `bye replaced` |
| Desktop write without progress | 10 s | connection closed; a closing connection gets 10 s to take its `bye` |

### Handshake (Noise IK)

1. Device → desktop: `e, es, s, ss` with payload JSON
   `{"v":1,"device":"Kaleb's iPhone","platform":"ios","model":"iPhone17,1","app":"1.0 (1)","pair":"<code or omitted>","ts":<unix secs>}`.
2. Desktop → device: `e, ee, se` with payload JSON. Success:
   `{"ok":true,"wid":"ws_...","name":"...","deviceId":"dev_...","host":{"platform":"windows","version":"0.1.9","build":2007}}`.
   Failure: `{"ok":false,"error":"unpaired"|"revoked"|"pairing_expired"|"not_entitled"|"busy"|"version"|"invalid"}`
   and the desktop closes the socket. `invalid`: a `device`, `platform`, `model` or `app`
   field is longer than 64 characters or contains control characters.

A device with a known static key is accepted without a code. An unknown key needs a valid
unexpired code; a used/expired code returns `pairing_expired`. A key that was revoked returns
`revoked`. Handshake timeout: 10 s. The code is checked at message 1 but spent (and the device
registered) only when the device's encrypted `hello` arrives; if two handshakes race with the
same code, exactly one is registered and the other connection is closed after its `hello`.

## 4. Application messages

All messages are JSON objects with a `t` (type) field. Field names are camelCase.
Timestamps are RFC 3339 strings.

### Device → desktop

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `{}` | Sent once after the handshake. The desktop answers `snapshot`. Later `hello`s are ignored. |
| `req` | `id` (unique string, UUID), `op`, `args` | Run an operation (§5). Answered by exactly one `res`. |
| `ping` | `n` | Keepalive; answered by `pong` with the same `n`. |

### Desktop → device

| `t` | Fields | Meaning |
|---|---|---|
| `snapshot` | `rev`, `state` (§4.1) | Full canonical state. Replaces everything the device has. |
| `patch` | `rev`, `upsert` {collection → [items]}, `remove` {collection → [ids]}, `workstation`? | Incremental change. Collections: `agents`, `needsYou`, `runs`, `services`, `environments`, `workspaces`. |
| `res` | `id`, `ok`, `result`? / `error`? {`code`, `message`} | Result of a `req`. |
| `notify` | `id`, `kind`, `title`, `body`, `link` | A notification-worthy event (§6). |
| `pong` | `n` | Keepalive reply. |
| `bye` | `reason` (`revoked`, `disabled`, `shutdown`, `not_entitled`, `replaced`) | Desktop is closing the connection on purpose. `replaced`: the same device opened a newer session; the device keeps the newer one and changes no state. |

`rev` increases by one for every snapshot/patch on that connection. A device that sees a gap
reconnects (it never guesses). On every (re)connect the desktop sends a full snapshot, so a
device always reconciles to canonical state without replaying anything.

Keepalive: device pings every 15 s; the desktop pings nothing. Either side treats 35 s of
silence as a dead connection.

### 4.1 State

```jsonc
{
  "workstation": {
    "id": "ws_...", "name": "Kaleb's Workstation", "platform": "windows",
    "version": "0.1.9", "build": 2007,
    "activeWorkspaceId": "wsp_..." // most recently active workspace, or null
  },
  "workspaces": [{ "id": "...", "name": "KalCode", "path": "C:/...", "lastActiveAt": "..." }],
  "agents": [{
    "id": "thr_...",                 // ThreadId
    "name": "Fix login redirect",
    "workspaceId": "...", "workspaceName": "KalCode",
    "providerId": "claude-code", "providerName": "Claude Code",
    "accountLabel": "Work", "model": "claude-opus-5-5", "effort": "high", // null when unknown
    "state": "working",              // AgentState: starting|ready|working|testing|waiting|needs_you|idle|done|failed|stopped
    "status": "running_command",     // raw ThreadStatus (snake_case), for detail views
    "activity": "Running npm test",  // current action, or null
    "branch": "kal/fix-login", "worktree": true,
    "filesChanged": 4, "pendingApprovals": 0,
    "error": null,
    "createdAt": "...", "lastActivityAt": "...",
    "runtime": "pane"                // pane | headless
  }],
  "needsYou": [{
    "id": "approval:apr_..." ,       // stable: "<kind>:<source id>"
    "kind": "approval",              // approval | question | failed | auth | stalled | review
    "title": "Run `cargo test`?", "detail": "Claude Code wants to run a command in KalCode",
    "agentId": "thr_..." ,           // or null
    "approvalId": "apr_...",         // only for kind=approval
    "createdAt": "...",
    "actions": ["approve_once", "deny", "open"] // what the device may offer
  }],
  "runs": [{
    "id": "op_...", "title": "Nightly tests", "kind": "test", "status": "running",
    "agentId": null, "branch": "main", "currentAction": "cargo test -p git",
    "outcome": null, "updatedAt": "..."
  }],
  "services": [{ "id": "...", "name": "web", "status": "running", "url": "http://localhost:5173" }],
  "environments": [{ "id": "...", "name": "Production", "kind": "production",
                     "deploymentStatus": "deployed", "health": "healthy",
                     "url": "https://...", "lastDeployAt": "..." }]
}
```

Elapsed time is derived on the device from `createdAt`/`lastActivityAt`, exactly as the desktop
deck does, so the desktop never sends per-second churn.

## 5. Operations

Every action goes through the same desktop services the desktop UI uses. Agent actions are
`KalVoiceIntent`s executed by the KalVoice orchestrator's executor, so Remote and desktop
KalVoice share one action bus and one set of safety rules (destructive actions never act on an
ambiguous target, prompts never go to an agent with an open approval, …).

| `op` | `args` | `result` | Desktop path |
|---|---|---|---|
| `agent.detail` | `agentId` | `{agent, messages:[{role,text,at}], tools:[{name,summary,status,at}], worktree}` | thread store, `thread_messages`, `thread_tool_calls`, worktree state |
| `agent.diff` | `agentId`, `maxBytes`? | `{files:[{path,status,additions,deletions,hunks:[{header,lines:[[kind,text]]}]}], truncated}` | `crates/git` diff of the agent's worktree/workspace |
| `agent.log` | `agentId`, `beforeId`? | `{entries:[...], more}` | deep log/transcript page, loaded on demand only |
| `agent.prompt` | `agentId`, `text` | `{summary}` | KalVoice `DirectPrompt` |
| `agent.stop` | `agentId` | `{summary}` | KalVoice `StopThreads` |
| `agent.retry` | `agentId` | `{summary}` | KalVoice `ResumeThreads` |
| `agent.launch` | `workspaceId`, `providerId`, `accountId`?, `model`?, `effort`?, `prompt`? | `{agentId?, summary}` | KalVoice `CreateThreads` |
| `launch.options` | — | `{workspaces, providers:[{id,name,accounts:[{id,label}],models:[{id,name,efforts}]}]}` | provider/account/model catalog (labels only) |
| `needs.decide` | `approvalId`, `decision` (`approve_once`\|`deny`) | `{status}` | permission service, `Actor::User`, origin Remote |
| `voice.command` | `text`, `agentId`? | `{summary, outcome}` | KalVoice orchestrator with the device's transcript (on-device speech recognition) |
| `run.detail` | `runId` | `{run, logs, tests}` | operations store |
| `tidy.closeIdle` | — | `{summary}` | KalVoice `CloseIdleAgents` (KalTidy) |

Error codes: `not_found` (the target ended or no longer exists — never act on a substitute),
`conflict` (state changed; refresh), `refused` (a safety rule declined; `message` says why),
`not_entitled`, `unavailable`, `invalid`, `internal`.

When a device is revoked or the desktop closes every connection (`bye`), operations still running
for that connection are cancelled and their ids remembered as `unavailable`; nothing starts after
a revocation. Operations of a connection that merely drops (or is `replaced`) run to completion
and their results answer the retry.

### Offline queue (device)

While **Reconnecting** (not Offline), the device may hold `agent.prompt` and `voice.command` for
up to 60 s, shown as "Queued — sends when connected". Every other action needs a live
connection. Queued requests keep their original `id`, so a request that actually reached the
desktop before the drop is never executed twice.

## 6. Notifications and deep links

The desktop emits `notify` only for decisions and outcomes: an agent needs you (approval or
question), an agent failed, an agent finished, a run failed, a deployment changed. Routine
progress never notifies. Coalescing: at most one notification per agent per 10 s.

Links: `kalcode-remote://agent/<agentId>`, `kalcode-remote://needs/<needsYouId>`,
`kalcode-remote://run/<runId>`, `kalcode-remote://diff/<agentId>`, `kalcode-remote://fleet`.
A device opening a link whose target no longer exists shows what happened ("This agent has
finished" / "Already answered") and lands on the Fleet; it never acts on a different target.

v1 delivers notifications while the app is connected (foreground or recently backgrounded) as
local notifications. Remote push (APNs/FCM through a blind relay) is the next transport step;
the payload format is `{"kc":{"link":"kalcode-remote://...","wid":"ws_..."}}`.

## 7. Connection states (device)

`Online` (handshake done, snapshot received) · `Reconnecting` (a paired workstation dropped;
retrying with 0.5 s → 10 s backoff, UI keeps the last state and dims it) · `Offline` (no
address reachable for 30 s, or the workstation said `shutdown`) · `Removed` (`revoked`). The
device never shows stale state as live.

## 8. Value sets and sub-shapes (normative)

| Field | Values / shape |
|---|---|
| `notify.kind` | `needs_you` \| `agent_failed` \| `agent_done` \| `run_failed` \| `deployment` |
| `agent.diff` line `kind` (first element of each `lines` pair) | `add` \| `del` \| `ctx` |
| `agent.log` entry | `{id, kind, text, at}`; `more: bool` means an older page exists (pass the last `id` as `beforeId`) |
| `agent.detail` `worktree` | `{path, branch, baseBranch}` or `null` |
| `run.detail` | `logs: [string]`, `tests: [{name, status, durationMs}]` |
| `needs.decide` result `status` | `approved` \| `denied` \| `already_answered` |
| `voice.command` result `outcome` | `done` \| `partial` \| `refused` \| `clarify` |

Handshake check order on the desktop: version → `invalid` → revoked → unpaired → `not_entitled`
→ pairing code. A revoked key stays revoked even with a valid code (re-pairing needs the device to forget
the workstation and generate a new key). A session counts as accepted only after the device's
encrypted `hello`, so a replayed first message never updates `lastSeenAt` and never spends a
pairing code. A device keeps the name it paired with; reconnects refresh `platform`, `model`
and `app` only.
