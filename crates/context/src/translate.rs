//! Provider-safe translation: how each item becomes provider input (CTX-03).
//!
//! The package budget is `min(provider max input, package cap)`. Items are planned in the
//! user's order. Every non-inline outcome carries a note the preview shows verbatim.

pub use kalcode_contracts::context::{RefusalReason, TranslationPlan};

use crate::content::{ContentClass, trim_head_tail};
use crate::model::{FirewallVerdict, ItemKind};
use crate::provider::{Modality, ProviderContextCapabilities};

/// Bytes reserved per rendered item for its header and footer lines.
pub const FRAME_OVERHEAD_BYTES: u64 = 192;
/// Smallest useful remainder for a trimmed item.
pub const MIN_TRIMMED_BYTES: u64 = 1024;

/// What the planner needs to know about one item.
#[derive(Debug, Clone, Copy)]
pub struct PlanInput<'a> {
    pub kind: ItemKind,
    pub label: &'a str,
    pub included: bool,
    pub unavailable: bool,
    pub verdict: FirewallVerdict,
    pub override_confirmed: bool,
    pub content_class: Option<ContentClass>,
    /// Redacted text payload length, if the item is text.
    pub text_bytes: Option<u64>,
    /// Raw attachment length, if the item is an image or document.
    pub attachment_bytes: Option<u64>,
    /// Summary text length (images and documents the provider can't take, folders).
    pub summary_bytes: u64,
    /// Workspace path, for references.
    pub reference_path: Option<&'a str>,
}

/// Planner output for one item: the plan, a note, and the text to send when it was trimmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub plan: TranslationPlan,
    pub note: Option<String>,
}

/// Plans a whole package. `prefer_references` lets fully-allowed files go as references when
/// the provider declares [`Modality::FileReference`].
pub fn plan_package(
    inputs: &[PlanInput<'_>],
    caps: &dyn ProviderContextCapabilities,
    package_cap: u64,
    prefer_references: bool,
) -> (u64, Vec<Planned>) {
    let budget = caps.max_input_bytes().min(package_cap);
    let mut remaining = budget;
    let mut out = Vec::with_capacity(inputs.len());
    for input in inputs {
        let planned = plan_item(input, caps, &mut remaining, prefer_references);
        out.push(planned);
    }
    (budget, out)
}

fn refused(reason: RefusalReason, note: impl Into<String>) -> Planned {
    Planned {
        plan: TranslationPlan::Refused { reason },
        note: Some(note.into()),
    }
}

fn plan_item(
    input: &PlanInput<'_>,
    caps: &dyn ProviderContextCapabilities,
    remaining: &mut u64,
    prefer_references: bool,
) -> Planned {
    let label = input.label;
    if !input.included {
        return Planned {
            plan: TranslationPlan::Omitted,
            note: None,
        };
    }
    if input.unavailable {
        return refused(
            RefusalReason::Unavailable,
            format!("{label}: couldn't be read, so it isn't sent."),
        );
    }
    match input.verdict {
        FirewallVerdict::Block { overridable: false } => {
            return refused(
                RefusalReason::Blocked,
                format!("{label}: blocked by the Context Firewall."),
            );
        }
        FirewallVerdict::Block { overridable: true } if !input.override_confirmed => {
            return refused(
                RefusalReason::NeedsConfirmation,
                format!("{label}: needs your confirmation before it can be sent."),
            );
        }
        _ => {}
    }

    // Folders become their listing.
    if input.kind == ItemKind::Folder {
        return take_summary(input, remaining, "the folder is sent as a file listing");
    }

    // Images and documents: attachment only with a declared capability, else a description.
    if let Some(class @ (ContentClass::Image { .. } | ContentClass::Document { .. })) =
        input.content_class
    {
        let (modality, format_ok, mime) = match class {
            ContentClass::Image { format } => (
                Modality::Image,
                caps.accepts_image_format(format),
                format.mime(),
            ),
            ContentClass::Document { format } => (Modality::Document, true, format.mime()),
            _ => (Modality::Text, false, ""),
        };
        let bytes = input.attachment_bytes.unwrap_or(0);
        if caps.accepts(modality)
            && format_ok
            && bytes <= caps.max_attachment_bytes()
            && bytes + FRAME_OVERHEAD_BYTES <= *remaining
        {
            *remaining -= bytes + FRAME_OVERHEAD_BYTES;
            return Planned {
                plan: TranslationPlan::Attachment {
                    mime: mime.to_owned(),
                    bytes,
                },
                note: None,
            };
        }
        let why = if !caps.accepts(modality) {
            format!(
                "{} doesn't declare {} input, so only a description is sent",
                caps.provider_id(),
                if modality == Modality::Image {
                    "image"
                } else {
                    "document"
                }
            )
        } else if !format_ok {
            format!(
                "{} doesn't accept this image format, so only a description is sent",
                caps.provider_id()
            )
        } else {
            "the attachment is larger than the provider accepts, so only a description is sent"
                .to_owned()
        };
        return take_summary(input, remaining, &why);
    }

    let Some(text_bytes) = input.text_bytes else {
        return refused(
            RefusalReason::UnsupportedByProvider,
            format!("{label}: this content can't be sent as text."),
        );
    };

    if prefer_references
        && input.verdict == FirewallVerdict::Allow
        && matches!(input.kind, ItemKind::File)
        && caps.accepts(Modality::FileReference)
        && let Some(path) = input.reference_path
    {
        let cost = path.len() as u64 + FRAME_OVERHEAD_BYTES;
        if cost <= *remaining {
            *remaining -= cost;
            return Planned {
                plan: TranslationPlan::Reference {
                    path: path.to_owned(),
                },
                note: Some(format!(
                    "{label}: sent as a path; the provider reads it with its own tools under your permission rules."
                )),
            };
        }
    }

    let needed = text_bytes + FRAME_OVERHEAD_BYTES;
    if needed <= *remaining {
        *remaining -= needed;
        return Planned {
            plan: TranslationPlan::Inline { bytes: text_bytes },
            note: None,
        };
    }
    if input.kind.is_trimmable() && *remaining >= MIN_TRIMMED_BYTES + FRAME_OVERHEAD_BYTES {
        let keep = *remaining - FRAME_OVERHEAD_BYTES;
        *remaining = 0;
        return Planned {
            plan: TranslationPlan::Trimmed {
                bytes: keep,
                omitted_bytes: text_bytes.saturating_sub(keep),
            },
            note: Some(format!(
                "{label}: trimmed to its first and last parts to fit the {} budget.",
                human_bytes(caps.max_input_bytes())
            )),
        };
    }
    refused(
        RefusalReason::OverBudget,
        format!(
            "{label}: {} doesn't fit the remaining {} of the package budget; remove other items or send it separately.",
            human_bytes(text_bytes),
            human_bytes(*remaining)
        ),
    )
}

fn take_summary(input: &PlanInput<'_>, remaining: &mut u64, why: &str) -> Planned {
    let cost = input.summary_bytes + FRAME_OVERHEAD_BYTES;
    if cost > *remaining {
        return refused(
            RefusalReason::OverBudget,
            format!("{}: doesn't fit the remaining package budget.", input.label),
        );
    }
    *remaining -= cost;
    Planned {
        plan: TranslationPlan::Summary {
            bytes: input.summary_bytes,
        },
        note: Some(format!("{}: {why}.", input.label)),
    }
}

/// Applies a `Trimmed` plan to the payload text.
pub fn apply_trim(text: &str, plan: &TranslationPlan) -> String {
    match plan {
        TranslationPlan::Trimmed { bytes, .. } => trim_head_tail(text, *bytes as usize).0,
        _ => text.to_owned(),
    }
}

pub fn human_bytes(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * 1024;
    if bytes >= MIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.1} KiB", bytes as f64 / KIB as f64)
    } else {
        format!("{bytes} bytes")
    }
}
