//! The check catalog (DOC-01). Every check is a function of the run's [`RunContext`] that
//! returns a [`CheckOutput`]; the runner gives each one its own thread and a 15 s budget.

pub mod kalcode;
pub mod project;
pub mod providers;
pub mod system;
pub mod tools;

use std::path::Path;
use std::sync::Arc;

use kalcode_core::logging::redact;

use crate::context::RunContext;
use crate::types::{
    DetailFact, DoctorArea, DoctorFinding, FindingSeverity, FixOption, Reversibility,
};

/// How a check ended (findings make a `Passed` check a `Finding`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    Checked,
    CouldNotCheck(String),
    Skipped(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckOutput {
    pub ended: Ended,
    pub summary: String,
    pub findings: Vec<DoctorFinding>,
}

impl CheckOutput {
    pub fn passed(summary: impl Into<String>) -> Self {
        Self {
            ended: Ended::Checked,
            summary: summary.into(),
            findings: Vec::new(),
        }
    }

    pub fn with(summary: impl Into<String>, findings: Vec<DoctorFinding>) -> Self {
        Self {
            ended: Ended::Checked,
            summary: summary.into(),
            findings,
        }
    }

    pub fn could_not_check(reason: impl Into<String>) -> Self {
        let reason = reason.into();
        Self {
            ended: Ended::CouldNotCheck(reason.clone()),
            summary: "Couldn't check".into(),
            findings: Vec::new(),
        }
    }

    pub fn skipped(reason: impl Into<String>) -> Self {
        Self {
            ended: Ended::Skipped(reason.into()),
            summary: "Skipped".into(),
            findings: Vec::new(),
        }
    }
}

pub type CheckFn = Arc<dyn Fn(&RunContext) -> CheckOutput + Send + Sync>;

/// One entry of a run's plan.
#[derive(Clone)]
pub struct CheckDef {
    pub id: String,
    pub area: DoctorArea,
    pub title: String,
    pub run: CheckFn,
}

impl std::fmt::Debug for CheckDef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CheckDef").field("id", &self.id).finish()
    }
}

pub fn def(
    id: impl Into<String>,
    area: DoctorArea,
    title: impl Into<String>,
    run: impl Fn(&RunContext) -> CheckOutput + Send + Sync + 'static,
) -> CheckDef {
    CheckDef {
        id: id.into(),
        area,
        title: title.into(),
        run: Arc::new(run),
    }
}

/// The checks of `areas`, in display order. Provider checks come from the provider source's
/// current list (one per provider), read once here.
pub fn plan(ctx: &RunContext, areas: &[DoctorArea]) -> Vec<CheckDef> {
    let mut out = Vec::new();
    for area in DoctorArea::ALL {
        if !areas.is_empty() && !areas.contains(&area) {
            continue;
        }
        match area {
            DoctorArea::KalCode => out.extend(kalcode::checks()),
            DoctorArea::Providers => out.extend(providers::checks(ctx)),
            DoctorArea::DevTools => out.extend(tools::checks()),
            DoctorArea::System => out.extend(system::checks()),
            DoctorArea::Project => out.extend(project::checks()),
        }
    }
    out
}

/// Starts a finding (the runner fills `check_id`, `area` and `ignored`).
pub fn finding(
    code: impl Into<String>,
    severity: FindingSeverity,
    title: impl Into<String>,
    explanation: impl Into<String>,
) -> DoctorFinding {
    DoctorFinding {
        code: code.into(),
        version: String::new(),
        check_id: String::new(),
        area: DoctorArea::KalCode,
        severity,
        title: title.into(),
        explanation: explanation.into(),
        details: Vec::new(),
        subjects: Vec::new(),
        fixes: Vec::new(),
        ignored: None,
        workspace_id: None,
    }
}

/// Most subjects kept on one finding.
pub const MAX_SUBJECTS: usize = 50;

pub trait FindingExt {
    fn detail(self, label: &str, value: impl AsRef<str>) -> Self;
    fn subjects(self, subjects: impl IntoIterator<Item = String>) -> Self;
    fn fix(self, fix: FixOption) -> Self;
    fn in_workspace(self, workspace_id: &str) -> Self;
}

impl FindingExt for DoctorFinding {
    fn detail(mut self, label: &str, value: impl AsRef<str>) -> Self {
        self.details.push(DetailFact {
            label: label.to_owned(),
            value: clean_detail(value.as_ref()),
        });
        self
    }

    fn subjects(mut self, subjects: impl IntoIterator<Item = String>) -> Self {
        self.subjects = subjects
            .into_iter()
            .take(MAX_SUBJECTS)
            .map(|s| clean_subject(&s))
            .collect();
        self
    }

    fn fix(mut self, fix: FixOption) -> Self {
        self.fixes.push(fix);
        self
    }

    fn in_workspace(mut self, workspace_id: &str) -> Self {
        self.workspace_id = Some(workspace_id.to_owned());
        self
    }
}

/// Control characters removed, length bounded, secrets redacted (the shared redactor).
pub fn clean(text: &str, max: usize) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max)
        .collect();
    redact(&cleaned).into_owned()
}

fn absolute_like(text: &str) -> bool {
    let trimmed = text.trim();
    Path::new(trimmed).is_absolute()
        || trimmed.starts_with("\\\\")
        || (trimmed.as_bytes().get(1) == Some(&b':')
            && matches!(trimmed.as_bytes().get(2), Some(b'\\' | b'/')))
}

/// Absolute host paths never cross IPC. Workspace-relative paths and plain labels remain useful.
fn clean_detail(text: &str) -> String {
    if absolute_like(text) {
        "Local path hidden".into()
    } else {
        clean(text, 400)
    }
}

fn clean_subject(text: &str) -> String {
    if absolute_like(text) {
        "Local path hidden".into()
    } else {
        clean(text, 400)
    }
}

/// A fix that only shows a command (DOC-04): nothing runs.
pub fn show_command(
    fix_code: &str,
    label: &str,
    description: &str,
    command: String,
    shell: &str,
) -> FixOption {
    FixOption {
        fix_code: fix_code.to_owned(),
        label: label.to_owned(),
        description: description.to_owned(),
        scopes: Vec::new(),
        reversible: Reversibility::NothingChanges,
        show_command_only: true,
        command: Some(command),
        command_shell: Some(shell.to_owned()),
    }
}

/// "1 file" / "3 files".
pub fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Bytes for people: "512 MB", "1.4 GB".
pub fn bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    let n_f = n as f64;
    if n_f >= KB * KB * KB {
        format!("{:.1} GB", n_f / (KB * KB * KB))
    } else if n_f >= KB * KB {
        format!("{:.0} MB", n_f / (KB * KB))
    } else if n_f >= KB {
        format!("{:.0} KB", n_f / KB)
    } else {
        format!("{n} bytes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_sizes_read_naturally() {
        assert_eq!(bytes(12), "12 bytes");
        assert_eq!(bytes(2048), "2 KB");
        assert_eq!(bytes(60 * 1024 * 1024), "60 MB");
        assert_eq!(bytes(3 * 1024 * 1024 * 1024 / 2), "1.5 GB");
    }

    #[test]
    fn details_are_cleaned_and_redacted() {
        let f = finding("x.y", FindingSeverity::Info, "t", "e")
            .detail("PATH", "C:\\bin\n\u{7}ok")
            .subjects(vec!["a".to_owned(); 80]);
        assert_eq!(f.details[0].value, "Local path hidden");
        assert_eq!(f.subjects.len(), MAX_SUBJECTS);
        let secret = clean("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", 200);
        assert!(
            !secret.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
            "{secret}"
        );
    }
}
