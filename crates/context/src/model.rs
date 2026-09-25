//! Shared vocabulary for context packages and the firewall.
//!
//! These types mirror the PROPOSED `crates/contracts::context` module
//! (`docs/CONTRACTS_ADVANCED.md` §5.2). They live in this crate until the lead lands the CA-0
//! contract PR; at that point they become re-exports and the wire names stay the same
//! (`snake_case` enums, internally tagged data-carrying enums, `camelCase` fields).

use serde::{Deserialize, Serialize};

/// Why a package is being built. Stored in `context_packages.purpose`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextPurpose {
    Drop,
    Handoff,
    Memory,
    Automation,
    Delegation,
    Reasoning,
}

impl ContextPurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Drop => "drop",
            Self::Handoff => "handoff",
            Self::Memory => "memory",
            Self::Automation => "automation",
            Self::Delegation => "delegation",
            Self::Reasoning => "reasoning",
        }
    }
}

/// What an item is. The union of the plan's CTX-01 list and the P0 library brief.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    File,
    FileRange,
    Folder,
    /// An image; screenshots are images whose origin is the user.
    Image,
    Diff,
    /// Terminal excerpts, build/log output and error output.
    LogOutput,
    Document,
    UrlReference,
    TestReport,
    GitCommit,
    MissionArtifact,
    Selection,
    Text,
    MemoryRecord,
    ThreadExcerpt,
    EventRange,
}

impl ItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::FileRange => "file_range",
            Self::Folder => "folder",
            Self::Image => "image",
            Self::Diff => "diff",
            Self::LogOutput => "log_output",
            Self::Document => "document",
            Self::UrlReference => "url_reference",
            Self::TestReport => "test_report",
            Self::GitCommit => "git_commit",
            Self::MissionArtifact => "mission_artifact",
            Self::Selection => "selection",
            Self::Text => "text",
            Self::MemoryRecord => "memory_record",
            Self::ThreadExcerpt => "thread_excerpt",
            Self::EventRange => "event_range",
        }
    }

    /// Output-like items whose middle can be dropped (head and tail kept) to fit a budget.
    pub fn is_trimmable(self) -> bool {
        matches!(
            self,
            Self::LogOutput | Self::TestReport | Self::ThreadExcerpt | Self::EventRange
        )
    }
}

/// Who produced the item's content. Provider-produced text is untrusted and is labelled as such
/// when it is passed on (prompt-injection containment), never interpolated as instructions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemOrigin {
    /// Typed or selected by the user.
    User,
    /// Read from the workspace by native code.
    Workspace,
    /// Produced by a provider (model output, tool output relayed by a provider).
    Provider,
    /// Produced by KalCode itself (event summaries, test reports it ran).
    System,
}

/// How sensitive an item is. Ordered: `Public < Internal < Confidential < Secret`.
///
/// *Secret* is never overridable; *Confidential* needs a per-item confirmation (FW-02).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sensitivity {
    Public,
    Internal,
    Confidential,
    Secret,
}

impl Sensitivity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Internal => "internal",
            Self::Confidential => "confidential",
            Self::Secret => "secret",
        }
    }
}

/// Where an "ignored" decision came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IgnoreSource {
    /// `.gitignore`, `.ignore`, `.kalcodeignore`, `.git/info/exclude` or the user's global
    /// Git excludes file.
    GitIgnore,
    /// A "never share" pattern the user set for this workspace or for all workspaces.
    WorkspaceNeverShare,
    /// KalCode's built-in sensitive names (`.env*`, keys, credential files, …).
    BuiltinSensitive,
}

/// A rule that fired for an item. Wire names follow the proposed contract; variants beyond the
/// proposal are marked and listed as contract requests in `docs/campaigns/CTX.md`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FirewallRule {
    /// Sharing from this workspace is not permitted (Trust Kernel / workspace setting).
    /// *Addition to the proposal.*
    WorkspacePermissionDenied,
    SecretDetected {
        detector: String,
        count: u32,
    },
    IgnoredPath {
        source: IgnoreSource,
        /// The built-in rule id, or the user pattern, or the ignore file that matched.
        rule: String,
    },
    SensitivityLabel {
        level: Sensitivity,
    },
    OutsideMissionScope {
        mission_id: String,
    },
    OutsideWorkspace,
    /// The path cannot be interpreted safely (alternate data stream, device name, trailing dot,
    /// control characters, …). *Addition to the proposal.*
    UnsafePath,
    /// The user excluded this path for this package or workspace. *Addition to the proposal.*
    UserExclusion {
        pattern: String,
    },
    SizeLimit {
        max_bytes: u64,
    },
    BinaryContent,
    /// Content KalCode cannot inspect for secrets (images, PDFs, office documents). Needs a
    /// per-item confirmation. *Addition to the proposal.*
    UnscannableContent,
    /// Labelled, never blocked.
    UntrustedProviderText,
}

impl FirewallRule {
    /// Stable short code used in the decision log and in `context.blocked` events.
    pub fn code(&self) -> &'static str {
        match self {
            Self::WorkspacePermissionDenied => "workspace_permission_denied",
            Self::SecretDetected { .. } => "secret_detected",
            Self::IgnoredPath {
                source: IgnoreSource::GitIgnore,
                ..
            } => "ignored_path.gitignore",
            Self::IgnoredPath {
                source: IgnoreSource::WorkspaceNeverShare,
                ..
            } => "ignored_path.never_share",
            Self::IgnoredPath {
                source: IgnoreSource::BuiltinSensitive,
                ..
            } => "ignored_path.builtin_sensitive",
            Self::SensitivityLabel { .. } => "sensitivity_label",
            Self::OutsideMissionScope { .. } => "outside_mission_scope",
            Self::OutsideWorkspace => "outside_workspace",
            Self::UnsafePath => "unsafe_path",
            Self::UserExclusion { .. } => "user_exclusion",
            Self::SizeLimit { .. } => "size_limit",
            Self::BinaryContent => "binary_content",
            Self::UnscannableContent => "unscannable_content",
            Self::UntrustedProviderText => "untrusted_provider_text",
        }
    }
}

/// What a single rule does to an item. Ordered by restrictiveness: the strongest effect of all
/// fired rules decides the verdict (deny wins).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleEffect {
    /// Informational label (e.g. untrusted provider text). Never restricts.
    Label,
    /// Content is sent with the matched spans replaced.
    Redact,
    /// Blocked unless the user confirms this item (confidential).
    BlockOverridable,
    /// Blocked; no per-item override exists.
    Block,
}

/// The firewall's decision for one item: ALLOW / ALLOW_REDACTED / BLOCK.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FirewallVerdict {
    Allow,
    /// The proposal's `Redact { spans }`.
    AllowRedacted {
        spans: u32,
    },
    Block {
        overridable: bool,
    },
}

impl FirewallVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::AllowRedacted { .. } => "redact",
            Self::Block { .. } => "block",
        }
    }

    pub fn is_block(self) -> bool {
        matches!(self, Self::Block { .. })
    }

    /// Restrictiveness rank used by monotonicity tests: Allow < AllowRedacted < Block(overridable)
    /// < Block(final).
    pub fn rank(self) -> u8 {
        match self {
            Self::Allow => 0,
            Self::AllowRedacted { .. } => 1,
            Self::Block { overridable: true } => 2,
            Self::Block { overridable: false } => 3,
        }
    }
}

/// One fired rule with its effect and a user-facing explanation (no secret content).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallReason {
    pub rule: FirewallRule,
    pub effect: RuleEffect,
    pub message: String,
}
