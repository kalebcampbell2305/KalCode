//! IPC types of the Environment Doctor (exported to TypeScript with ts-rs). They follow
//! `docs/CONTRACTS_ADVANCED.md` §6.4 (`DoctorArea`, `FindingSeverity`, `DoctorFinding`,
//! `FixOption`, `Reversibility`, `DoctorRun`) and add what the UI needs around them: per-check
//! results with progress, ignore scopes, fix previews and the fix log.

use kalcode_contracts::permissions::PermissionScope;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The five check groups (DOC-01).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum DoctorArea {
    #[serde(rename = "kalcode")]
    KalCode,
    #[serde(rename = "providers")]
    Providers,
    #[serde(rename = "dev_tools")]
    DevTools,
    #[serde(rename = "system")]
    System,
    #[serde(rename = "project")]
    Project,
}

impl DoctorArea {
    pub const ALL: [DoctorArea; 5] = [
        DoctorArea::KalCode,
        DoctorArea::Providers,
        DoctorArea::DevTools,
        DoctorArea::System,
        DoctorArea::Project,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::KalCode => "kalcode",
            Self::Providers => "providers",
            Self::DevTools => "dev_tools",
            Self::System => "system",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FindingSeverity {
    Info,
    Warning,
    Critical,
}

/// Where one check is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CheckStatus {
    /// Still running (only while the run is running).
    Running,
    /// Checked; nothing to report.
    Passed,
    /// Checked; at least one finding.
    Finding,
    /// The check itself failed, timed out or had no data (DOC-05: never fails the run).
    CouldNotCheck,
    /// Not applicable here (no project open, a Windows-only check elsewhere).
    Skipped,
    /// The run was cancelled before this check finished.
    Cancelled,
}

/// One check's result in a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CheckResult {
    /// Stable id, e.g. `kalcode.database`, `tools.node`, `providers.claude-code`.
    pub id: String,
    pub area: DoctorArea,
    pub title: String,
    pub status: CheckStatus,
    /// One line: what was found ("Git 2.45.1", "OK", "3 entries to look at").
    pub summary: String,
    /// Why it couldn't be checked or was skipped.
    pub reason: Option<String>,
    pub duration_ms: Option<u64>,
    /// Codes of this check's findings.
    pub finding_codes: Vec<String>,
}

/// How a fix can be undone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Reversibility {
    /// KalCode records the inverse operation and Undo applies it.
    Reversible {
        how: String,
    },
    NotReversible {
        why: String,
    },
    /// Nothing changes (the fix only shows a command to run yourself).
    NothingChanges,
}

/// One entry of the fixed fix catalog offered for a finding. Never a free-form command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FixOption {
    /// Catalog code: `file.*` fixes edit a file after approval; `show.*` only show a command.
    pub fix_code: String,
    /// Button label ("Add to .gitignore", "Show the command").
    pub label: String,
    /// What it changes, in plain words.
    pub description: String,
    /// Permission scopes the change needs (empty for show-only fixes).
    pub scopes: Vec<PermissionScope>,
    pub reversible: Reversibility,
    /// DOC-04: nothing runs; KalCode shows the command for you to run yourself.
    pub show_command_only: bool,
    /// The command to run yourself (show-only fixes).
    pub command: Option<String>,
    /// Where the command runs ("PowerShell", "An administrator PowerShell", "Your terminal").
    pub command_shell: Option<String>,
}

/// Where an ignore applies.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum IgnoreScope {
    Global,
    Workspace { workspace_id: String },
}

impl IgnoreScope {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Workspace { .. } => "workspace",
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Global => "",
            Self::Workspace { workspace_id } => workspace_id,
        }
    }
}

/// A label + value pair shown under Details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DetailFact {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DoctorFinding {
    /// Stable, ignorable code, e.g. `project.env.not_ignored`, `tools.node.missing`.
    pub code: String,
    /// Opaque version of this exact observation. A fix must echo it so a later run or changed
    /// finding cannot be substituted under an old approval.
    pub version: String,
    pub check_id: String,
    pub area: DoctorArea,
    pub severity: FindingSeverity,
    pub title: String,
    /// Plain-language explanation: what it means and why it matters.
    pub explanation: String,
    /// Details: facts behind the finding (paths, versions, counts). Redacted.
    pub details: Vec<DetailFact>,
    /// Items the finding is about (workspace-relative paths, PATH entries), at most 50.
    pub subjects: Vec<String>,
    pub fixes: Vec<FixOption>,
    /// Set when the person ignored this finding (and where).
    pub ignored: Option<IgnoreScope>,
    /// The workspace a project finding belongs to.
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RunStatus {
    Running,
    Completed,
    Cancelled,
}

/// Counts over a run's findings (ignored findings are counted only under `ignored`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FindingCounts {
    pub critical: u32,
    pub warning: u32,
    pub info: u32,
    pub ignored: u32,
    pub passed: u32,
    pub could_not_check: u32,
    pub skipped: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DoctorRun {
    pub id: String,
    pub status: RunStatus,
    pub started_at: String,
    pub finished_at: Option<String>,
    /// Areas this run covers.
    pub areas: Vec<DoctorArea>,
    /// The project the "current project" checks looked at.
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    /// Per-check timeout in milliseconds (15 s).
    pub timeout_ms: u64,
    pub checks: Vec<CheckResult>,
    pub findings: Vec<DoctorFinding>,
    pub counts: FindingCounts,
    /// False when ignores and the fix log last only for this session (schema v16 not installed).
    pub persistent: bool,
}

/// `doctor_run` input.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RunRequest {
    /// Areas to check; empty = all.
    #[serde(default)]
    pub areas: Vec<DoctorArea>,
    /// Only these check ids (KalVoice "why is Node not found?" runs `tools.node`); empty = all
    /// checks of the areas.
    #[serde(default)]
    pub checks: Vec<String>,
    /// The active workspace id. Native code resolves it through the canonical workspace store;
    /// the WebView never supplies a path.
    #[serde(default)]
    pub workspace_id: Option<String>,
}

/// What Fix will do, shown before anything runs (DOC-03).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FixPreview {
    pub run_id: String,
    pub finding_code: String,
    pub fix: FixOption,
    /// Every change, one line each ("Adds the line /.env to .gitignore").
    pub changes: Vec<String>,
    /// The file or setting that changes, for display.
    pub target: Option<String>,
    /// How to undo it, in plain words.
    pub undo: String,
    /// The permission engine asks you before it runs (always, for Doctor fixes).
    pub needs_approval: bool,
}

/// Exact preconditions for previewing or applying a catalog fix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FixRequest {
    pub run_id: String,
    pub finding_code: String,
    pub finding_version: String,
    pub fix_code: String,
    /// Present only when resuming the exact request after the owner approved it.
    #[serde(default)]
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RevertRequest {
    pub fix_log_id: String,
    #[serde(default)]
    pub approval_id: Option<String>,
}

/// The result of asking for a fix (or its undo).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum FixOutcome {
    /// Applied (or undone) right away; `fix_log_id` names the record.
    Done { fix_log_id: String, message: String },
    /// Waiting for your answer to this approval request.
    AwaitingApproval { approval_id: String },
    /// The permission engine refused it.
    Denied { reason: String },
    /// A show-only fix: nothing ran.
    ShowCommand { command: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FixStatus {
    /// Waiting for approval (in memory only; approvals expire when KalCode restarts).
    AwaitingApproval,
    Applying,
    Applied,
    /// Undo is waiting for approval.
    UndoAwaitingApproval,
    Reverting,
    Failed,
    Reverted,
}

/// One entry of the fix log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FixLogEntry {
    /// The fix log id (`None` while the fix waits for approval).
    pub id: Option<String>,
    pub finding_code: String,
    pub fix_code: String,
    pub workspace_id: Option<String>,
    pub summary: String,
    pub status: FixStatus,
    pub approval_id: Option<String>,
    pub applied_at: Option<String>,
    pub reverted_at: Option<String>,
    /// Undo is possible now.
    pub can_undo: bool,
    /// Why it failed (stable code) when `status` is `failed`.
    pub error: Option<String>,
}

/// One remembered ignore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IgnoredFinding {
    pub finding_code: String,
    pub scope: IgnoreScope,
    pub workspace_name: Option<String>,
    pub title: String,
    pub ignored_at: String,
}

/// `doctor_ignored` output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IgnoredList {
    pub items: Vec<IgnoredFinding>,
    pub persistent: bool,
}

/// `doctor_ignore` input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IgnoreRequest {
    pub finding_code: String,
    pub scope: IgnoreScope,
    /// `false` = un-ignore.
    pub ignored: bool,
}
