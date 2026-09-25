//! Context packages and the Context Firewall (CTX/FW). Adopted in CA-1 from
//! `docs/CONTRACTS_ADVANCED.md` §5.2 as amended by `docs/campaigns/CTX.md`. Moved from
//! `kalcode_context` with identical JSON; that crate re-exports these types.
//!
//! Wire conventions: `snake_case` enums, internally tagged data-carrying enums (`kind`),
//! `camelCase` fields. Nothing here carries secret content: excerpts are redacted and bounded.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;

/// Why a package is being built. Stored in `context_packages.purpose`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum IgnoreSource {
    /// `.gitignore`, `.ignore`, `.kalcodeignore`, `.git/info/exclude` or the user's global
    /// Git excludes file.
    GitIgnore,
    /// A "never share" pattern the user set for this workspace or for all workspaces.
    WorkspaceNeverShare,
    /// KalCode's built-in sensitive names (`.env*`, keys, credential files, …).
    BuiltinSensitive,
}

/// A rule that fired for an item.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum FirewallRule {
    /// Sharing from this workspace is not permitted (Trust Kernel / workspace setting).
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
    /// control characters, …).
    UnsafePath,
    /// The user excluded this path for this package or workspace.
    UserExclusion {
        pattern: String,
    },
    SizeLimit {
        max_bytes: u64,
    },
    BinaryContent,
    /// Content KalCode cannot inspect for secrets (images, PDFs, office documents). Needs a
    /// per-item confirmation.
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

/// What a single firewall rule does to an item. Ordered by restrictiveness: the strongest effect
/// of all fired rules decides the verdict (deny wins). Exported to TypeScript as
/// `FirewallRuleEffect` (the permission `RuleEffect` keeps its name).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "FirewallRuleEffect")]
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

/// The firewall's decision for one item: ALLOW / ALLOW_REDACTED / BLOCK. `AllowRedacted` is the
/// proposal's `Redact { spans }` (wire `allow_redacted`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum FirewallVerdict {
    Allow,
    AllowRedacted { spans: u32 },
    Block { overridable: bool },
}

impl FirewallVerdict {
    /// The decision-log value (matches the v8 `verdict` CHECK: `allow | redact | block`).
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

    /// Restrictiveness rank: Allow < AllowRedacted < Block(overridable) < Block(final).
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FirewallReason {
    pub rule: FirewallRule,
    pub effect: RuleEffect,
    pub message: String,
}

/// 1-based, inclusive line range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

/// A kind of input a provider may accept besides plain text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Modality {
    /// Plain text in the prompt. Every provider accepts text.
    Text,
    /// Image attachments.
    Image,
    /// Document attachments (PDF and similar).
    Document,
    /// A workspace path the provider opens with its own tools. The file then reaches the
    /// provider under the Trust Kernel's read rules, not through the firewall, so references
    /// are only used for items the firewall fully allows.
    FileReference,
    /// A link the provider can fetch itself.
    UrlFetch,
}

/// Why an item is not sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RefusalReason {
    /// The firewall blocked the item.
    Blocked,
    /// Overridable block, not yet confirmed by the user.
    NeedsConfirmation,
    /// The item could not be read.
    Unavailable,
    /// It does not fit the remaining budget.
    OverBudget,
    /// The provider does not accept this kind of input.
    UnsupportedByProvider,
}

/// How an item becomes provider input (CTX-03).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum TranslationPlan {
    /// Sent as text, complete (after redaction).
    Inline { bytes: u64 },
    /// Sent as text with the middle omitted to fit the budget (output-like items only).
    Trimmed { bytes: u64, omitted_bytes: u64 },
    /// Sent as a workspace path the provider opens with its own tools (opt-in; fully allowed
    /// items only).
    Reference { path: String },
    /// Sent as an attachment the provider declared it accepts.
    Attachment { mime: String, bytes: u64 },
    /// Sent as a short description instead of the content.
    Summary { bytes: u64 },
    /// Not sent.
    Refused { reason: RefusalReason },
    /// Removed by the user.
    Omitted,
}

impl TranslationPlan {
    pub fn is_sent(&self) -> bool {
        !matches!(self, Self::Refused { .. } | Self::Omitted)
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Inline { .. } => "inline",
            Self::Trimmed { .. } => "trimmed",
            Self::Reference { .. } => "reference",
            Self::Attachment { .. } => "attachment",
            Self::Summary { .. } => "summary",
            Self::Refused { .. } => "refused",
            Self::Omitted => "omitted",
        }
    }
}

/// What the UI shows for one item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContextItemPreview {
    pub position: u32,
    pub label: String,
    pub kind: ItemKind,
    pub source_kind: String,
    pub bytes: u64,
    pub sensitivity: Sensitivity,
    pub verdict: FirewallVerdict,
    pub rules: Vec<FirewallReason>,
    /// Redacted and bounded (≤ 4 KiB). Empty for finally blocked items.
    pub excerpt: String,
    pub included: bool,
    pub overridable: bool,
    pub override_confirmed: bool,
    pub translation: TranslationPlan,
    pub note: Option<String>,
    pub unavailable: Option<String>,
}

/// The whole preview. Nothing is sent without confirming it, and the send is pinned to
/// `content_sha256` (CTX-04).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContextPreview {
    pub package_id: String,
    pub purpose: ContextPurpose,
    pub target_provider_id: ProviderId,
    pub target_thread_id: Option<String>,
    pub items: Vec<ContextItemPreview>,
    /// Bytes that would be sent.
    pub total_bytes: u64,
    /// The budget: min(provider max input, package cap).
    pub max_bytes: u64,
    pub translation_notes: Vec<String>,
    /// Must match at send time (CTX-04).
    pub content_sha256: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdicts_keep_the_crate_wire_names() {
        assert_eq!(
            serde_json::to_value(FirewallVerdict::AllowRedacted { spans: 2 }).expect("json"),
            serde_json::json!({"kind": "allow_redacted", "spans": 2})
        );
        assert_eq!(
            FirewallVerdict::AllowRedacted { spans: 2 }.as_str(),
            "redact"
        );
        assert!(
            FirewallVerdict::Block { overridable: false }.rank()
                > FirewallVerdict::Block { overridable: true }.rank()
        );
    }

    #[test]
    fn rules_are_tagged_and_coded() {
        let rule = FirewallRule::IgnoredPath {
            source: IgnoreSource::WorkspaceNeverShare,
            rule: ".env".into(),
        };
        assert_eq!(
            serde_json::to_value(&rule).expect("json"),
            serde_json::json!({"kind": "ignored_path", "source": "workspace_never_share", "rule": ".env"})
        );
        assert_eq!(rule.code(), "ignored_path.never_share");
        assert!(Sensitivity::Secret > Sensitivity::Confidential);
        assert!(RuleEffect::Block > RuleEffect::Redact);
    }

    #[test]
    fn preview_provider_id_is_a_plain_string() {
        let preview = ContextPreview {
            package_id: "p".into(),
            purpose: ContextPurpose::Drop,
            target_provider_id: ProviderId::new("claude-code"),
            target_thread_id: None,
            items: vec![],
            total_bytes: 0,
            max_bytes: 1,
            translation_notes: vec![],
            content_sha256: String::new(),
        };
        let json = serde_json::to_value(&preview).expect("json");
        assert_eq!(json["targetProviderId"], "claude-code");
        assert_eq!(
            serde_json::to_value(TranslationPlan::Trimmed {
                bytes: 1,
                omitted_bytes: 2
            })
            .expect("json"),
            serde_json::json!({"kind": "trimmed", "bytes": 1, "omittedBytes": 2})
        );
    }
}
