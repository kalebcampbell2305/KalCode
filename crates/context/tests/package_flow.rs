//! Package lifecycle: typed items, provider-safe translation driven by capability descriptors,
//! budgets, hash pinning at send time, preview shape, decision-log and event facts.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use common::{Ws, token};
use kalcode_context::events::ContextEvent;
use kalcode_context::package::{
    ContextItem, ContextPackage, PackageOptions, RenderedPart, SendCheck,
};
use kalcode_context::provider::testing::FakeProviderCapabilities;
use kalcode_context::provider::{ContextLimitsDescriptor, Modality, TextOnlyDefaults};
use kalcode_context::translate::{RefusalReason, TranslationPlan};
use kalcode_context::{
    ContextError, ContextPurpose, Firewall, FirewallVerdict, ItemKind, ItemOrigin,
    ProviderContextCapabilities,
};

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 2, 0, 0, 0]);
    bytes.extend_from_slice(&[0u8; 64]);
    bytes
}

fn options() -> PackageOptions {
    PackageOptions::new(ContextPurpose::Drop)
}

#[test]
fn defaults_never_assume_images_or_attachments() {
    let defaults = TextOnlyDefaults::new("any");
    for modality in [
        Modality::Image,
        Modality::Document,
        Modality::FileReference,
        Modality::UrlFetch,
    ] {
        assert!(!defaults.accepts(modality), "{modality:?}");
    }
    assert!(defaults.accepts(Modality::Text));
    assert_eq!(defaults.max_attachment_bytes(), 0);
    let limits = ContextLimitsDescriptor {
        provider_id: "p".into(),
        max_input_bytes: 1_000_000,
        accepts_images: false,
    };
    assert!(!limits.accepts(Modality::Image));
}

#[test]
fn images_translate_by_capability() {
    let ws = Ws::new();
    let firewall = Firewall::for_root(ws.path());
    let image = || ContextItem::image(png(1280, 720), "screenshot.png");

    // Text-only provider: a confirmed screenshot becomes a description, never an attachment.
    let mut package = ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new("text-only"),
        options(),
        vec![image()],
    );
    let item = &package.items[0];
    assert_eq!(
        item.decision.verdict,
        FirewallVerdict::Block { overridable: true }
    );
    assert_eq!(
        item.plan,
        TranslationPlan::Refused {
            reason: RefusalReason::NeedsConfirmation
        }
    );
    package.confirm_override(0).expect("confirm");
    assert!(matches!(
        package.items[0].plan,
        TranslationPlan::Summary { .. }
    ));
    let note = package.items[0].note.clone().unwrap_or_default();
    assert!(note.contains("doesn't declare image input"), "{note}");
    let rendered = package.render().expect("render");
    assert!(
        rendered
            .parts()
            .iter()
            .all(|p| matches!(p, RenderedPart::Text(_)))
    );
    assert!(rendered.text().contains("1280×720"));

    // A provider that declares images gets the attachment.
    let caps = FakeProviderCapabilities::everything();
    let mut package = ContextPackage::build(&firewall, &caps, options(), vec![image()]);
    package.confirm_override(0).expect("confirm");
    assert!(matches!(
        package.items[0].plan,
        TranslationPlan::Attachment { ref mime, .. } if mime == "image/png"
    ));
    let rendered = package.render().expect("render");
    assert!(
        rendered
            .parts()
            .iter()
            .any(|p| matches!(p, RenderedPart::Attachment { mime, .. } if mime == "image/png"))
    );

    // Declared images but not this format / too large: description.
    let mut caps = FakeProviderCapabilities::everything();
    caps.max_attachment_bytes = 10;
    let mut package = ContextPackage::build(&firewall, &caps, options(), vec![image()]);
    package.confirm_override(0).expect("confirm");
    assert!(matches!(
        package.items[0].plan,
        TranslationPlan::Summary { .. }
    ));
}

#[test]
fn budgets_trim_output_and_refuse_oversize_files() {
    let ws = Ws::new();
    let line = "fn f() { let value = compute(1, 2, 3); }\n";
    ws.write("src/big.rs", line.repeat(300));
    let firewall = Firewall::for_root(ws.path());
    let log: String = (0..400).map(|i| format!("[{i:04}] step ok\n")).collect();
    let caps = FakeProviderCapabilities::text_only().with_max_input_bytes(6 * 1024);
    let package = ContextPackage::build(
        &firewall,
        &caps,
        options(),
        vec![
            ContextItem::text(ItemKind::LogOutput, "build log", ItemOrigin::System, log),
            ContextItem::file("src/big.rs"),
        ],
    );
    assert_eq!(package.budget_bytes, 6 * 1024);
    assert!(matches!(
        package.items[0].plan,
        TranslationPlan::Trimmed { .. }
    ));
    assert_eq!(
        package.items[1].plan,
        TranslationPlan::Refused {
            reason: RefusalReason::OverBudget
        }
    );
    let rendered = package.render().expect("render");
    let text = rendered.text();
    assert!(text.contains("[0000] step ok"));
    assert!(text.contains("[0399] step ok"));
    assert!(text.contains("bytes omitted by KalCode"));
    assert!(rendered.bytes_sent() <= 6 * 1024);
    let preview = package.preview();
    assert_eq!(preview.max_bytes, 6 * 1024);
    assert!(
        preview
            .translation_notes
            .iter()
            .any(|n| n.contains("doesn't fit"))
    );
    assert!(
        preview
            .translation_notes
            .iter()
            .any(|n| n.contains("trimmed"))
    );

    // The package cap applies even when the provider takes more.
    let mut opts = options();
    opts.package_cap_bytes = 1024;
    let package = ContextPackage::build(
        &firewall,
        &FakeProviderCapabilities::everything(),
        opts,
        vec![ContextItem::file("src/big.rs")],
    );
    assert_eq!(package.budget_bytes, 1024);
}

/// Opening a FIFO for reading blocks until a writer appears; building a package must never wait
/// on one.
#[cfg(unix)]
#[test]
fn a_named_pipe_never_blocks_package_building() {
    let ws = Ws::new();
    let fifo = ws.path().join("pipe");
    let made = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("run mkfifo");
    assert!(made.success(), "mkfifo failed");
    let root = ws.path().to_path_buf();
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let firewall = Firewall::for_root(&root);
        let package = ContextPackage::build(
            &firewall,
            &FakeProviderCapabilities::everything(),
            options(),
            vec![ContextItem::file("pipe")],
        );
        let _ = done.send(package.items.len());
    });
    let items = finished
        .recv_timeout(std::time::Duration::from_secs(20))
        .expect("package building returned instead of waiting on the pipe");
    assert_eq!(items, 1);
    // Unblock the reader thread if the build is still stuck on the pipe.
    drop(std::fs::OpenOptions::new().write(true).open(&fifo));
}

#[test]
fn hash_is_pinned_until_send() {
    let ws = Ws::new();
    ws.write("src/a.rs", "fn a() {}\n");
    ws.write("src/b.rs", "fn b() {}\n");
    let firewall = Firewall::for_root(ws.path());
    let caps = TextOnlyDefaults::new("provider-x");
    let items = vec![ContextItem::file("src/a.rs"), ContextItem::file("src/b.rs")];
    let mut package = ContextPackage::build(&firewall, &caps, options(), items);
    let previewed = package.preview().content_sha256;
    assert_eq!(previewed.len(), 64);

    // Deterministic: removing and restoring an item returns to the same hash.
    package.set_included(1, false).expect("exclude");
    assert_ne!(package.content_sha256(), previewed);
    assert_eq!(package.items[1].plan, TranslationPlan::Omitted);
    package.set_included(1, true).expect("include");
    assert_eq!(package.content_sha256(), previewed);
    assert!(matches!(
        package.set_included(9, false),
        Err(ContextError::PositionOutOfRange { position: 9 })
    ));

    // Unchanged content: ready, and the rendered hash is the previewed one.
    match package
        .check_before_send(&previewed, &firewall)
        .expect("check")
    {
        SendCheck::Ready(rendered) => {
            assert_eq!(rendered.content_sha256(), previewed);
            assert!(rendered.text().contains("fn a() {}"));
        }
        SendCheck::Stale(_) => panic!("unchanged content reported stale"),
    }

    // The file changes after the preview: nothing is sent, a new preview is required.
    let secret = token("ghp_", 3, 36);
    ws.write("src/b.rs", format!("fn b() {{ let t = \"{secret}\"; }}\n"));
    match package
        .check_before_send(&previewed, &firewall)
        .expect("check")
    {
        SendCheck::Ready(_) => panic!("changed content sent without a new preview"),
        SendCheck::Stale(refreshed) => {
            let preview = refreshed.preview();
            assert_ne!(preview.content_sha256, previewed);
            assert!(matches!(
                preview.items[1].verdict,
                FirewallVerdict::AllowRedacted { .. }
            ));
            assert!(!preview.items[1].excerpt.contains(&secret));
        }
    }
}

#[test]
fn overrides_survive_refresh_only_for_unchanged_content() {
    let ws = Ws::new();
    ws.write(".gitignore", "*.log\n");
    ws.write("run.log", "ok\n");
    let firewall = Firewall::for_root(ws.path());
    let caps = TextOnlyDefaults::new("p");
    let mut package = ContextPackage::build(
        &firewall,
        &caps,
        options(),
        vec![ContextItem::file("run.log")],
    );
    package.confirm_override(0).expect("confirm");
    let refreshed = package.refresh(&firewall);
    assert!(refreshed.items[0].override_confirmed);
    assert_eq!(refreshed.content_sha256(), package.content_sha256());
    ws.write("run.log", "changed\n");
    let refreshed = package.refresh(&firewall);
    assert!(
        !refreshed.items[0].override_confirmed,
        "a changed file needs a new confirmation"
    );
}

#[test]
fn every_item_kind_is_supported() {
    let ws = Ws::new();
    ws.write("src/lib.rs", "line1\nline2\nline3\nline4\n");
    ws.write("docs/notes.md", "# Notes\n");
    let firewall = Firewall::for_root(ws.path());
    let text =
        |kind, label: &str, body: &str| ContextItem::text(kind, label, ItemOrigin::System, body);
    let items = vec![
        ContextItem::file("src/lib.rs"),
        ContextItem::file_range("src/lib.rs", 2, 3),
        text(ItemKind::Diff, "working tree", "diff --git a/x b/x\n+y\n"),
        text(ItemKind::LogOutput, "terminal", "error: failed\n"),
        ContextItem::document(b"# Design\n".to_vec(), "design.md"),
        ContextItem::document(b"%PDF-1.7\n...".to_vec(), "spec.pdf"),
        ContextItem::url("https://example.com/docs?page=2"),
        text(ItemKind::TestReport, "tests", "12 passed, 1 failed\n"),
        text(ItemKind::GitCommit, "HEAD", "commit abc\n\n    Fix\n"),
        text(ItemKind::MissionArtifact, "plan", "step 1\n").with_mission("m-1"),
        ContextItem::text(
            ItemKind::Selection,
            "selection",
            ItemOrigin::User,
            "let x = 1;",
        ),
        ContextItem::text(ItemKind::Text, "note", ItemOrigin::User, "Please review."),
        text(
            ItemKind::MemoryRecord,
            "memory",
            "The API uses cursor pagination.\n",
        ),
        ContextItem::text(
            ItemKind::ThreadExcerpt,
            "reply",
            ItemOrigin::Provider,
            "Done.\n",
        ),
        text(ItemKind::EventRange, "events 10-20", "thread.started\n"),
        ContextItem::image(png(8, 8), "shot.png"),
    ];
    let package = ContextPackage::build(&firewall, &TextOnlyDefaults::new("p"), options(), items);
    let rendered = package.render().expect("render").text();
    assert!(
        rendered.contains("[item 2 · file excerpt · src/lib.rs:2-3]\nline2\nline3\n"),
        "{rendered}"
    );
    assert!(
        rendered.contains(
            "Link (address only; KalCode did not open it): https://example.com/docs?page=2"
        )
    );
    assert!(rendered.contains("# Design"));
    assert!(rendered.contains("UNTRUSTED provider output"));
    // PDF and image need confirmation; everything else is sent.
    let refused: Vec<u32> = package
        .items
        .iter()
        .filter(|i| !i.plan.is_sent())
        .map(|i| i.position)
        .collect();
    assert_eq!(refused, vec![5, 15]);
}

#[test]
fn links_are_checked_and_credentials_redacted() {
    let ws = Ws::new();
    let firewall = Firewall::for_root(ws.path());
    let password = common::body(9, 18);
    let package = ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new("p"),
        options(),
        vec![
            ContextItem::url(format!("https://admin:{password}@internal.example/x")),
            ContextItem::url("file:///etc/passwd"),
            ContextItem::url("javascript:alert(1)"),
        ],
    );
    assert!(matches!(
        package.items[0].decision.verdict,
        FirewallVerdict::AllowRedacted { .. }
    ));
    assert_eq!(
        package.items[1].decision.verdict,
        FirewallVerdict::Block { overridable: false }
    );
    assert_eq!(
        package.items[2].decision.verdict,
        FirewallVerdict::Block { overridable: false }
    );
    let text = package.render().expect("render").text();
    assert!(!text.contains(&password));
    assert!(!text.contains("/etc/passwd"));
}

#[test]
fn references_only_for_fully_allowed_files() {
    let ws = Ws::new();
    ws.write("src/clean.rs", "fn clean() {}\n");
    ws.write(
        "src/dirty.rs",
        format!("const K: &str = \"{}\";\n", token("ghp_", 5, 36)),
    );
    let firewall = Firewall::for_root(ws.path());
    let mut opts = options();
    opts.prefer_references = true;
    let package = ContextPackage::build(
        &firewall,
        &FakeProviderCapabilities::everything(),
        opts.clone(),
        vec![
            ContextItem::file("src/clean.rs"),
            ContextItem::file("src/dirty.rs"),
        ],
    );
    assert_eq!(
        package.items[0].plan,
        TranslationPlan::Reference {
            path: "src/clean.rs".into()
        }
    );
    assert!(
        matches!(package.items[1].plan, TranslationPlan::Inline { .. }),
        "redacted items are inlined, never referenced"
    );
    // Without the capability, everything is inline.
    let package = ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new("p"),
        opts,
        vec![ContextItem::file("src/clean.rs")],
    );
    assert!(matches!(
        package.items[0].plan,
        TranslationPlan::Inline { .. }
    ));
}

#[test]
fn preview_log_and_events_hold_no_secrets() {
    let ws = Ws::new();
    let secret = token("ghp_", 11, 36);
    ws.write(
        "src/config.rs",
        format!("pub const TOKEN: &str = \"{secret}\";\n"),
    );
    ws.write(".env", format!("TOKEN={secret}\n"));
    let firewall = Firewall::for_root(ws.path());
    let package = ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new("provider-x"),
        options(),
        vec![
            ContextItem::file("src/config.rs"),
            ContextItem::file(".env"),
            ContextItem::text(
                ItemKind::Text,
                "note",
                ItemOrigin::User,
                format!("use {secret}"),
            ),
        ],
    );
    let preview = package.preview();
    let preview_json = serde_json::to_value(&preview).expect("json");
    // Wire shape: camelCase fields, tagged verdicts.
    assert!(preview_json.get("contentSha256").is_some());
    assert!(preview_json.get("packageId").is_some());
    assert_eq!(preview_json["items"][1]["verdict"]["kind"], "block");
    assert_eq!(
        preview_json["items"][0]["verdict"]["kind"],
        "allow_redacted"
    );
    let log = package.log_entries();
    let events = package.created_events();
    let blobs = [
        serde_json::to_string(&preview).expect("json"),
        serde_json::to_string(&log).expect("json"),
        serde_json::to_string(&events).expect("json"),
    ];
    for blob in &blobs {
        assert!(!blob.contains(&secret), "secret leaked into {blob}");
    }
    assert!(
        log.iter()
            .any(|e| e.action.as_str() == "blocked" && e.rule == "ignored_path.builtin_sensitive")
    );
    assert!(
        log.iter()
            .any(|e| e.action.as_str() == "redacted" && e.rule == "secret_detected")
    );
    assert!(matches!(
        events[0],
        ContextEvent::PackageCreated { items: 3, .. }
    ));
    assert!(events.iter().any(|e| matches!(e, ContextEvent::Blocked { rule, items: 1, .. } if rule == "ignored_path.builtin_sensitive")));
    assert!(events.iter().any(|e| matches!(
        e,
        ContextEvent::Redacted {
            items: 2,
            spans: 2,
            ..
        }
    )));
    let rendered = package.render().expect("render");
    let shared = package.shared_event(&rendered);
    assert_eq!(shared.event_type(), "context.shared");
    let json = serde_json::to_value(&shared).expect("json");
    assert_eq!(json["type"], "context.shared");
    assert_eq!(json["redactions"], 2);
}

#[test]
fn empty_packages_refuse_to_render() {
    let ws = Ws::new();
    let firewall = Firewall::for_root(ws.path());
    let package = ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new("p"),
        options(),
        vec![ContextItem::file(".env")],
    );
    assert!(matches!(package.render(), Err(ContextError::NothingToSend)));
    let missing = ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new("p"),
        options(),
        vec![ContextItem::file("src/missing.rs")],
    );
    assert!(missing.items[0].unavailable.is_some());
    assert!(matches!(missing.render(), Err(ContextError::NothingToSend)));
}
