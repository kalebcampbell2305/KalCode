# ADR 0001 — Monorepo and toolchain

Status: accepted · 2026-09-24

## Context
KalCode spans a Rust native runtime, a React desktop UI, a public website, shared protocol
types and a design system. These change together (an IPC change touches Rust, generated types
and UI in one commit).

## Decision
One repository with a pnpm workspace (`apps/*`, `packages/*`, `tooling`) and a Cargo workspace
(`crates/*`, `apps/desktop/src-tauri`). Tauri 2 + React 19 + Vite for the desktop app; Astro for
the website. Biome for TypeScript/CSS formatting and linting, rustfmt + Clippy (`-D warnings`)
for Rust. No task-runner layer (e.g. Turborepo) until build times justify it.

## Consequences
Atomic cross-layer changes and one CI pipeline. Directories are created when the campaign that
needs them starts, so the tree never contains empty placeholder packages.
