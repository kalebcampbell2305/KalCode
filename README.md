# KalCode

**One intelligence that operates your entire AI workspace.**

KalCode is a desktop application that connects the AI coding providers you already use
(Claude Code, Codex, Gemini CLI), runs them in real workspaces, keeps you in control of what
every agent may do, and lets JARVIS — the intelligence inside KalCode — coordinate the work.
Website: https://kalcoded.com

> Status: private development. Campaign **Z0 — Foundation**. See `docs/campaigns/Z0.md`.

## Repository

| Path | What |
| --- | --- |
| `apps/desktop` | Desktop app: React UI (`src/`) + Tauri shell (`src-tauri/`) |
| `apps/website` | kalcoded.com: Astro + Cloudflare Worker + D1 |
| `crates/native-core` | Native runtime: SQLite + migrations, event protocol, settings, logging, errors |
| `crates/secure-store` | OS credential store behind `SecretStore` |
| `packages/protocol` | Rust-generated IPC types, plan catalog, provider and permission contracts |
| `packages/ui` | Design tokens, brand masters, React primitives |
| `docs` | Product, architecture, protocol, security, testing, brand, campaigns, ADRs |
| `tooling` | Brand asset pipeline, protocol index, branding check, window capture |

## Requirements

Node 24+, pnpm 10, Rust stable (1.88+), and the Tauri 2 platform prerequisites
(WebView2 on Windows; Xcode CLT on macOS; webkit2gtk-4.1 on Linux). Python 3 with Pillow and
NumPy for the brand pipeline.

## Common commands

```bash
pnpm install
pnpm dev:desktop        # KalCode desktop app with hot reload
pnpm dev:website        # website dev server
pnpm check              # format, lint, typecheck, unit tests, branding check
pnpm --filter @kalcode/desktop test:ui    # desktop UI tests (Playwright + axe)
pnpm --filter @kalcode/desktop test:e2e   # real-app E2E (Windows; build first)
pnpm --filter @kalcode/website test:e2e   # website E2E
pnpm gen:protocol       # regenerate TypeScript protocol types from Rust
python tooling/generate-brand-assets.py   # regenerate brand assets from the masters
```

© 2026 KalCode. All rights reserved.
