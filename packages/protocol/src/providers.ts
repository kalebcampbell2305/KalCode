/**
 * Provider helpers. The provider contract (ProviderId, AgentEvent, SessionConfig, capabilities,
 * and the AgentProvider/AgentSession traits) is defined in Rust (`crates/contracts/src/agent.rs`)
 * and generated into `./generated`; do not redefine it here.
 */
import type { ProviderId } from "./generated/index.ts";

/** Providers KalCode targets first. Mirrors the constants on the Rust `ProviderId`. */
export const KNOWN_PROVIDERS = {
  claudeCode: "claude-code",
  codex: "codex",
  cursor: "cursor",
  geminiCli: "gemini-cli",
} as const satisfies Record<string, ProviderId>;
