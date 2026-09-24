# ADR 0002 — Rust owns the protocol types

Status: accepted · 2026-09-24

## Context
IPC payloads and events cross the Rust/TypeScript boundary. Hand-maintained duplicate types drift.

## Decision
Protocol types (events, settings, diagnostics, errors, flags) are defined once in Rust with serde
and exported to `packages/protocol/src/generated/` with ts-rs on every `cargo test`. `i64` maps to
`number` (`TS_RS_LARGE_INT`). CI fails if the generated files differ from the committed ones.
Hand-written TypeScript in `packages/protocol` is limited to contracts that have no Rust side
yet (provider and permission contracts, plan catalog).

## Consequences
A Rust change that alters the wire format cannot merge without the TypeScript update. Adjacently
tagged enums give the frontend exhaustive, discriminated unions for event types.
