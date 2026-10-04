# Native provider parity

KalCode hosts supported provider CLIs in real terminals. Provider-native authentication, permissions and policy remain authoritative. Cursor's verified integration is documented in [cursor.md](cursor.md).

| Capability | Claude Code | Codex | Gemini CLI | Cursor |
| --- | --- | --- | --- | --- |
| Native coding terminal, workspace, resize, input and interrupts | Shared PTY adapter | Shared PTY adapter | Shared PTY adapter | Shared PTY adapter |
| Native file, edit, search, shell and Git tools | Native CLI | Native CLI | Native CLI | Native CLI |
| Account persistence | Native managed profile | Native managed profile | Native managed profile | Native OS-user sign-in |
| Concurrent isolated accounts | Managed profiles | Managed profiles | Managed profiles | Not verified; one native account |
| Model choices | Provider model configuration | Runtime catalog | Native model configuration | Runtime `agent models`; no static list |
| Turn status | Authenticated hooks | Authenticated completion notifications | Process-only status | Authenticated plugin hooks, with limited fallback |
| Usage | Canonical provider-reported source | Canonical provider-reported source | Unavailable | Unavailable |
| User settings and integrations | Native configuration | Native configuration | Native configuration | Native configuration plus additive observer plugin |
| Unified Memory | Shared workspace service and native prompt context | Shared workspace service and task context | Shared workspace service and task context | Shared workspace service and native startup/prompt context |

This table describes integration mechanisms, not certification of every upstream extension or model. Provider policy can disable a native feature; KalCode must show the real limitation and must not fabricate status or availability.
