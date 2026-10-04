//! KalCode context packages and the Context Firewall (system codes CTX / FW, phase P0).
//!
//! Everything KalCode itself sends to an AI provider — context drops, handoff capsules, memory,
//! automation and delegation prompts, KalVoice reasoning — is built here as a typed
//! [`package::ContextPackage`] and passes the [`firewall::Firewall`] first. The user sees a
//! preview of exactly what will be sent (every item, its size, sensitivity, verdict and
//! redactions), may remove items or confirm overridable ones, and the send is pinned to the
//! previewed content hash.
//!
//! Library only: no IPC, UI or event emission lives here. The lead wires it into the core
//! (`docs/campaigns/CTX.md` lists the integration steps, contract types and events).
//!
//! Module map:
//!
//! * [`model`] — shared vocabulary (mirrors the proposed `contracts::context` types);
//! * [`paths`] — canonical workspace containment and look-alike folding;
//! * [`never_share`] — built-in sensitive names and user patterns;
//! * [`ignore_rules`] — `.gitignore` / `.ignore` / `.kalcodeignore` for single paths;
//! * [`secrets`] and [`redact`] — detection and structure-preserving redaction, designed to
//!   become the shared `kalcode_core::redact`;
//! * [`content`] — text/image/document/binary classification and trimming;
//! * [`diff`] — withholding never-share files inside diffs;
//! * [`firewall`] — the evaluation (deny wins);
//! * [`folder`] — budgeted folder analysis with a prunable preview;
//! * [`provider`] — provider capability descriptors (trait, defaults, test double);
//! * [`translate`] — provider-safe translation plans;
//! * [`package`] — building, previewing, overriding, rendering and hash-pinning packages;
//! * [`log`], [`events`], [`store`] — the append-only decision log, `context.*` event facts
//!   and schema v8.

pub mod content;
mod detectors;
pub mod diff;
pub mod egress;
pub mod error;
pub mod events;
pub mod firewall;
pub mod folder;
pub mod ignore_rules;
pub mod log;
pub mod memory;
pub mod model;
pub mod never_share;
pub mod package;
pub mod paths;
pub mod provider;
pub mod redact;
pub mod secrets;
pub mod store;
pub mod translate;

pub use egress::{
    PromptAdmission, PromptGate, PromptGateError, PromptReview, PromptTarget, PromptWarning,
};
pub use error::{ContextError, Result};
pub use firewall::{
    Candidate, Content, Firewall, FirewallDecision, FirewallPolicy, MissionScope, SecretAction,
    WorkspacePermission,
};
pub use folder::{DefaultRelevance, FolderBudget, FolderPreview, RelevanceScorer, analyze_folder};
pub use model::{
    ContextPurpose, FirewallReason, FirewallRule, FirewallVerdict, IgnoreSource, ItemKind,
    ItemOrigin, RuleEffect, Sensitivity,
};
pub use package::{
    ContextItem, ContextItemPreview, ContextPackage, ContextPreview, PackageOptions,
    RenderedPackage, SendCheck,
};
pub use paths::WorkspaceRoot;
pub use provider::{
    ContextLimitsDescriptor, DEFAULT_PACKAGE_CAP_BYTES, Modality, ProviderContextCapabilities,
    TextOnlyDefaults,
};
pub use store::MIGRATION_V8;
