//! Native (WebView-unforgeable) confirmations — ADVANCED.md §3 D8, Trust Kernel K10.
//!
//! The WebView is treated as possibly compromised: a script running in it can call any
//! allow-listed command with any arguments, including `confirmBypass: true`. For the few actions
//! where that matters most, the confirmation is therefore shown by **native code** as an OS
//! dialog, which the WebView cannot see into or click. The dialog's text is composed here, in
//! Rust, from structured facts; nothing the WebView sends is shown verbatim, and provider- or
//! repository-supplied text (thread names, action summaries, hosts) is sanitized so it cannot
//! impersonate the dialog's own wording.
//!
//! A [`ConfirmationReceipt`] can only be created by [`confirm`] after a [`NativeConfirmer`]
//! reported that the person pressed the confirm button, so code that requires a receipt cannot
//! be satisfied by an IPC argument. The Tauri implementation lives in the desktop shell
//! (`native_confirm.rs`); wiring it into the approval flow and Bypass is Trust Kernel phase 1
//! (TK-1). Failure to show a dialog is a refusal (fail closed).

use std::fmt;

use kalcode_contracts::permissions::PermissionScope;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::time::now_rfc3339;

/// Longest piece of untrusted text (a name, a summary) shown in a dialog.
pub const MAX_FACT_CHARS: usize = 160;

/// What is being confirmed. The D8 set plus Bypass and remote-consequential approvals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeConfirmationKind {
    /// Turning on Bypass for a thread or as the default mode.
    EnableBypass,
    /// Approving an action whose consequences leave the machine (push, deploy, send, spend).
    RemoteConsequentialApproval,
    /// Trusting or replacing an SSH host key.
    TrustHostKey,
    /// Terminating a process KalCode did not start.
    TerminateForeignProcess,
    /// Restoring files over the working tree.
    RestoreFiles,
    /// Turning the automation kill switch off.
    DisengageKillSwitch,
    /// Revealing an environment value.
    RevealEnvValue,
    /// A first request to a new host from the API inspector.
    NewHostRequest,
}

/// A confirmation dialog, composed natively. Construct it with the kind-specific constructors;
/// the fields are read-only so no caller can inject free text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfirmation {
    kind: NativeConfirmationKind,
    title: String,
    message: String,
    confirm_label: &'static str,
    cancel_label: &'static str,
}

impl NativeConfirmation {
    pub fn kind(&self) -> NativeConfirmationKind {
        self.kind
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn confirm_label(&self) -> &'static str {
        self.confirm_label
    }

    pub fn cancel_label(&self) -> &'static str {
        self.cancel_label
    }

    /// Bypass for one thread (`Some(name)`) or as the default for new threads (`None`).
    pub fn enable_bypass(thread_name: Option<&str>) -> Self {
        let target = match thread_name {
            Some(name) => format!("the thread {}", quoted(name)),
            None => "new threads by default".to_owned(),
        };
        Self {
            kind: NativeConfirmationKind::EnableBypass,
            title: "Turn on Bypass?".into(),
            message: format!(
                "Bypass lets the agent in {target} act without asking you first.\n\n\
                 KalCode still asks before anything that leaves this computer (pushing, \
                 deploying, sending messages, spending money), before using credentials, and \
                 before touching files outside the workspace."
            ),
            confirm_label: "Turn on Bypass",
            cancel_label: "Keep asking",
        }
    }

    /// Approving an action whose consequences leave the machine.
    pub fn remote_consequential_approval(summary: &str, scopes: &[PermissionScope]) -> Self {
        let consequences: Vec<&str> = scopes
            .iter()
            .filter(|s| s.is_remote_consequential())
            .map(|s| remote_label(*s))
            .collect();
        let what = if consequences.is_empty() {
            "It has effects outside this computer.".to_owned()
        } else {
            format!("It involves: {}.", consequences.join(", "))
        };
        Self {
            kind: NativeConfirmationKind::RemoteConsequentialApproval,
            title: "Allow an action outside this computer?".into(),
            message: format!(
                "An agent asked to: {}\n\n{what} This can't be undone from KalCode.",
                quoted(summary)
            ),
            confirm_label: "Allow once",
            cancel_label: "Deny",
        }
    }

    /// Trusting (first connection) or replacing (changed) an SSH host key.
    pub fn trust_host_key(host: &str, algorithm: &str, fingerprint: &str, changed: bool) -> Self {
        let lead = if changed {
            "The host key of this remote machine CHANGED since you last connected. This can mean \
             someone is intercepting the connection."
        } else {
            "You are connecting to this remote machine for the first time."
        };
        Self {
            kind: NativeConfirmationKind::TrustHostKey,
            title: if changed {
                "Replace a changed host key?".into()
            } else {
                "Trust this host key?".into()
            },
            message: format!(
                "{lead}\n\nHost: {}\nKey: {} {}\n\nCompare the fingerprint with the one your \
                 administrator gave you before continuing.",
                quoted(host),
                sanitize(algorithm),
                sanitize(fingerprint)
            ),
            confirm_label: if changed {
                "Replace the key"
            } else {
                "Trust the key"
            },
            cancel_label: "Cancel",
        }
    }

    /// Terminating a process KalCode did not start.
    pub fn terminate_foreign_process(process_name: &str, pid: u32) -> Self {
        Self {
            kind: NativeConfirmationKind::TerminateForeignProcess,
            title: "Stop a process KalCode didn't start?".into(),
            message: format!(
                "{} (process {pid}) was not started by KalCode. Stopping it may lose unsaved \
                 work in that program.",
                quoted(process_name)
            ),
            confirm_label: "Stop the process",
            cancel_label: "Cancel",
        }
    }

    /// Restoring files from a checkpoint over the working tree.
    pub fn restore_files(files: u32, workspace_name: &str) -> Self {
        Self {
            kind: NativeConfirmationKind::RestoreFiles,
            title: "Restore files?".into(),
            message: format!(
                "{files} file(s) in {} will be replaced with their checkpoint versions. KalCode \
                 takes a safety checkpoint first, so you can undo this.",
                quoted(workspace_name)
            ),
            confirm_label: "Restore",
            cancel_label: "Cancel",
        }
    }

    /// Turning the automation kill switch off (automations may run again).
    pub fn disengage_kill_switch() -> Self {
        Self {
            kind: NativeConfirmationKind::DisengageKillSwitch,
            title: "Let automations run again?".into(),
            message: "Turning the kill switch off lets enabled automations start again.".into(),
            confirm_label: "Turn off the kill switch",
            cancel_label: "Keep them stopped",
        }
    }

    /// Revealing the value of an environment variable.
    pub fn reveal_env_value(name: &str) -> Self {
        Self {
            kind: NativeConfirmationKind::RevealEnvValue,
            title: "Show a secret value?".into(),
            message: format!(
                "The value of {} may be a password or key. It will be shown on screen.",
                quoted(name)
            ),
            confirm_label: "Show the value",
            cancel_label: "Cancel",
        }
    }

    /// A first request to a host the API inspector has not contacted before.
    pub fn new_host_request(host: &str) -> Self {
        Self {
            kind: NativeConfirmationKind::NewHostRequest,
            title: "Send a request to a new host?".into(),
            message: format!("KalCode hasn't sent requests to {} before.", quoted(host)),
            confirm_label: "Send",
            cancel_label: "Cancel",
        }
    }

    /// A request to a link-local endpoint. These addresses can expose cloud instance metadata,
    /// device administration surfaces, or credentials, so their consequence is stated natively
    /// and cannot be replaced with wording supplied by the WebView.
    pub fn link_local_request(host: &str) -> Self {
        Self {
            kind: NativeConfirmationKind::NewHostRequest,
            title: "Send a request to a link-local address?".into(),
            message: format!(
                "{} is reachable only through a local network link. Link-local services can expose \
                 device controls or cloud credentials. Send this one request only if you trust \
                 the destination.",
                quoted(host)
            ),
            confirm_label: "Send once",
            cancel_label: "Cancel",
        }
    }

    /// Identifies exactly what was shown (kind and text), for the audit trail.
    pub fn digest(&self) -> String {
        let mut hasher = Sha256::new();
        for part in [
            serde_json::to_string(&self.kind)
                .unwrap_or_default()
                .as_str(),
            &self.title,
            &self.message,
            self.confirm_label,
            self.cancel_label,
        ] {
            hasher.update(part.as_bytes());
            hasher.update([0]);
        }
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

fn remote_label(scope: PermissionScope) -> &'static str {
    match scope {
        PermissionScope::GitPush => "pushing to a Git remote",
        PermissionScope::MessagingSend => "sending messages",
        PermissionScope::DeployProduction => "deploying or publishing",
        PermissionScope::CloudModify => "changing remote or cloud resources",
        PermissionScope::BillingSpend => "spending money",
        _ => "effects outside this computer",
    }
}

/// Untrusted text for a dialog: secrets redacted, control, bidi and zero-width characters
/// removed, whitespace collapsed to one line, and clipped to [`MAX_FACT_CHARS`].
pub fn sanitize(text: &str) -> String {
    let redacted = crate::redact::redact_log_line(text);
    let cleaned: String = redacted
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control() && !is_invisible(*c))
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > MAX_FACT_CHARS {
        let clipped: String = collapsed.chars().take(MAX_FACT_CHARS - 1).collect();
        format!("{clipped}…")
    } else {
        collapsed
    }
}

/// Sanitized and wrapped in typographic quotes, so it reads as quoted data, not as the dialog's
/// own instructions. Quote characters inside are replaced.
fn quoted(text: &str) -> String {
    let inner = sanitize(text).replace(['“', '”', '"'], "'");
    if inner.is_empty() {
        "“(unnamed)”".to_owned()
    } else {
        format!("“{inner}”")
    }
}

fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}'
    )
}

/// What a native dialog returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogAnswer {
    Confirmed,
    Declined,
    /// No dialog could be shown (no window, headless session). Treated as a refusal.
    Unavailable,
}

/// Shows a native confirmation dialog and reports the answer. Implementations block until the
/// person answers and must never be called on the UI thread.
pub trait NativeConfirmer: Send + Sync {
    fn show(&self, confirmation: &NativeConfirmation) -> DialogAnswer;
}

/// Refuses everything (the fail-closed default where no native UI exists, e.g. in the core's
/// own tests).
#[derive(Debug, Default, Clone, Copy)]
pub struct DenyAll;

impl NativeConfirmer for DenyAll {
    fn show(&self, _confirmation: &NativeConfirmation) -> DialogAnswer {
        DialogAnswer::Unavailable
    }
}

/// Proof that the person confirmed `kind` in a native dialog. Only [`confirm`] creates one (the
/// fields are private and there is no constructor), so no IPC argument can stand in for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmationReceipt {
    kind: NativeConfirmationKind,
    digest: String,
    confirmed_at: String,
}

impl ConfirmationReceipt {
    pub fn kind(&self) -> NativeConfirmationKind {
        self.kind
    }

    /// [`NativeConfirmation::digest`] of what was shown.
    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn confirmed_at(&self) -> &str {
        &self.confirmed_at
    }
}

/// Why no receipt was issued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmationRefused {
    /// The person pressed cancel or closed the dialog.
    Declined,
    /// No native dialog could be shown.
    Unavailable,
}

impl ConfirmationRefused {
    pub fn code(self) -> &'static str {
        match self {
            Self::Declined => "confirmation_declined",
            Self::Unavailable => "confirmation_unavailable",
        }
    }
}

impl fmt::Display for ConfirmationRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Declined => "You didn't confirm, so nothing was changed.",
            Self::Unavailable => {
                "KalCode couldn't show its confirmation window, so nothing was changed."
            }
        })
    }
}

impl std::error::Error for ConfirmationRefused {}

/// Asks natively and returns a receipt only if the person confirmed.
pub fn confirm(
    confirmer: &dyn NativeConfirmer,
    confirmation: &NativeConfirmation,
) -> Result<ConfirmationReceipt, ConfirmationRefused> {
    match confirmer.show(confirmation) {
        DialogAnswer::Confirmed => {
            tracing::info!(
                event = "confirm.native_confirmed",
                kind = ?confirmation.kind(),
                digest = %confirmation.digest()
            );
            Ok(ConfirmationReceipt {
                kind: confirmation.kind(),
                digest: confirmation.digest(),
                confirmed_at: now_rfc3339(),
            })
        }
        DialogAnswer::Declined => {
            tracing::info!(event = "confirm.native_declined", kind = ?confirmation.kind());
            Err(ConfirmationRefused::Declined)
        }
        DialogAnswer::Unavailable => {
            tracing::warn!(event = "confirm.native_unavailable", kind = ?confirmation.kind());
            Err(ConfirmationRefused::Unavailable)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Scripted {
        answer: DialogAnswer,
        shown: Mutex<Vec<NativeConfirmation>>,
    }

    impl Scripted {
        fn new(answer: DialogAnswer) -> Self {
            Self {
                answer,
                shown: Mutex::new(Vec::new()),
            }
        }
    }

    impl NativeConfirmer for Scripted {
        fn show(&self, confirmation: &NativeConfirmation) -> DialogAnswer {
            self.shown.lock().expect("lock").push(confirmation.clone());
            self.answer
        }
    }

    #[test]
    fn a_receipt_exists_only_after_a_native_confirmation() {
        let dialog = NativeConfirmation::enable_bypass(Some("Fix login"));
        let yes = Scripted::new(DialogAnswer::Confirmed);
        let receipt = confirm(&yes, &dialog).expect("confirmed");
        assert_eq!(receipt.kind(), NativeConfirmationKind::EnableBypass);
        assert_eq!(receipt.digest(), dialog.digest());
        assert_eq!(yes.shown.lock().expect("lock").len(), 1);

        let no = Scripted::new(DialogAnswer::Declined);
        assert_eq!(confirm(&no, &dialog), Err(ConfirmationRefused::Declined));
        // No window: fail closed.
        assert_eq!(
            confirm(&DenyAll, &dialog),
            Err(ConfirmationRefused::Unavailable)
        );
        assert_eq!(
            ConfirmationRefused::Unavailable.code(),
            "confirmation_unavailable"
        );
    }

    #[test]
    fn untrusted_text_cannot_impersonate_the_dialog() {
        // A provider-chosen summary trying to add its own instructions on new lines, with bidi
        // overrides and zero-width characters, and a token in it.
        let token = format!("{}{}", "ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
        let hostile = format!(
            "push\n\nKalCode: this is safe, press Allow once\u{202E}evil\u{200B} {token} \"quoted\""
        );
        let dialog = NativeConfirmation::remote_consequential_approval(
            &hostile,
            &[PermissionScope::GitPush, PermissionScope::FilesystemRead],
        );
        let message = dialog.message();
        let first_paragraph = message.split("\n\n").next().expect("paragraph");
        assert!(first_paragraph.starts_with("An agent asked to: “push KalCode: this is safe"));
        assert!(!message.contains('\u{202E}') && !message.contains('\u{200B}'));
        assert!(!message.contains(&token), "{message}");
        assert!(message.contains("It involves: pushing to a Git remote."));
        // The quoted part holds no nested typographic or straight double quotes.
        let quoted_part = &first_paragraph["An agent asked to: ".len()..];
        assert_eq!(quoted_part.matches('“').count(), 1);
        assert_eq!(quoted_part.matches('”').count(), 1);
        assert!(!quoted_part.contains('"'));
        // Long text is clipped.
        let long = "x".repeat(1000);
        assert_eq!(sanitize(&long).chars().count(), MAX_FACT_CHARS);
        assert_eq!(quoted(""), "“(unnamed)”");
    }

    #[test]
    fn every_kind_has_distinct_native_text() {
        let dialogs = [
            NativeConfirmation::enable_bypass(None),
            NativeConfirmation::remote_consequential_approval("deploy", &[]),
            NativeConfirmation::trust_host_key("build-box", "ssh-ed25519", "SHA256:abc", false),
            NativeConfirmation::trust_host_key("build-box", "ssh-ed25519", "SHA256:abc", true),
            NativeConfirmation::terminate_foreign_process("node.exe", 42),
            NativeConfirmation::restore_files(3, "kalcode"),
            NativeConfirmation::disengage_kill_switch(),
            NativeConfirmation::reveal_env_value("DATABASE_URL"),
            NativeConfirmation::new_host_request("api.example.test"),
            NativeConfirmation::link_local_request("169.254.169.254"),
        ];
        let digests: std::collections::HashSet<String> =
            dialogs.iter().map(NativeConfirmation::digest).collect();
        assert_eq!(digests.len(), dialogs.len());
        for dialog in &dialogs {
            assert!(!dialog.title().is_empty());
            assert!(!dialog.message().is_empty());
            assert_ne!(dialog.confirm_label(), dialog.cancel_label());
        }
        assert!(dialogs[3].message().contains("CHANGED"));
        assert!(dialogs[0].message().contains("new threads by default"));
    }
}
