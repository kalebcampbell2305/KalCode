//! SEC-LATENT regressions for the Context Firewall (ported from the 2026-09-24 review PoCs
//! `secrev_paths_package`, `secrev_detection_gaps::never_share_name_gaps` and `secrev_dos`):
//!
//! * M4 — a file range that excludes a PEM header still has the key body redacted;
//! * M7 — dropped/pasted content named like a never-share file is blocked like the file;
//! * hard links — a workspace name hard-linked to another file is not shared silently;
//! * combined diffs — `diff --cc` / `--combined` sections and plain sections after Git ones are
//!   withheld, and diffs are withheld in every text item kind;
//! * never-share names — backup copies, kube configs, Maven/Terraform/Firebase/keytab/keyring
//!   files and other credential stores are blocked;
//! * entropy pass — linear: a crafted 8 MiB file scans quickly.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::time::{Duration, Instant};

use common::{Ws, body};
use kalcode_context::package::{ContextItem, ContextPackage, PackageOptions, SendCheck};
use kalcode_context::provider::TextOnlyDefaults;
use kalcode_context::secrets::{ScanContext, scan_with};
use kalcode_context::{
    Candidate, Content, ContextPurpose, Firewall, FirewallVerdict, ItemKind, ItemOrigin, RuleEffect,
};

fn build(firewall: &Firewall, items: Vec<ContextItem>) -> ContextPackage {
    ContextPackage::build(
        firewall,
        &TextOnlyDefaults::new("p"),
        PackageOptions::new(ContextPurpose::Drop),
        items,
    )
}

fn rendered_text(pkg: &ContextPackage) -> String {
    pkg.render().map(|r| r.text()).unwrap_or_default()
}

// ---- M4: file ranges ---------------------------------------------------------------------

fn pem_config() -> (String, Vec<String>) {
    let lines: Vec<String> = (0..8).map(|i| body(500 + i, 64)).collect();
    let mut text =
        String::from("service:\n  name: api\n  tls_key: |\n    -----BEGIN RSA PRIVATE KEY-----\n");
    for l in &lines {
        text.push_str(&format!("    {l}\n"));
    }
    text.push_str("    -----END RSA PRIVATE KEY-----\n  port: 8443\n");
    (text, lines)
}

#[test]
fn m4_range_without_pem_header_does_not_leak_key_body() {
    let ws = Ws::new();
    let (text, lines) = pem_config();
    ws.write("deploy/config.yaml", &text);
    let firewall = Firewall::for_root(ws.path());

    let whole = build(&firewall, vec![ContextItem::file("deploy/config.yaml")]);
    let whole_out = rendered_text(&whole);
    assert!(lines.iter().all(|l| !whole_out.contains(l.as_str())));

    // Lines 5..12 are the key body only (the BEGIN line 4 is outside the range).
    for (start, end) in [(5, 12), (6, 7), (12, 12), (1, 5), (11, 14)] {
        let range = build(
            &firewall,
            vec![ContextItem::file_range("deploy/config.yaml", start, end)],
        );
        let out = rendered_text(&range);
        let leaked = lines.iter().filter(|l| out.contains(l.as_str())).count();
        assert_eq!(leaked, 0, "range {start}-{end} leaked key body:\n{out}");
        assert!(
            matches!(
                range.items[0].decision.verdict,
                FirewallVerdict::AllowRedacted { .. }
            ),
            "range {start}-{end}: {:?}",
            range.items[0].decision.verdict
        );
    }
    // A range outside the key is untouched.
    let clean = build(
        &firewall,
        vec![ContextItem::file_range("deploy/config.yaml", 1, 2)],
    );
    assert_eq!(clean.items[0].decision.verdict, FirewallVerdict::Allow);
    assert!(rendered_text(&clean).contains("name: api"));
}

#[test]
fn m4_range_of_assignment_value_on_later_line_is_redacted() {
    let ws = Ws::new();
    let pw = body(61, 18);
    ws.write(
        "config/app.yml",
        format!("db:\n  password: |\n    {pw}\n  host: db\n"),
    );
    let firewall = Firewall::for_root(ws.path());
    let range = build(
        &firewall,
        vec![ContextItem::file_range("config/app.yml", 3, 3)],
    );
    assert!(!rendered_text(&range).contains(&pw));
}

// ---- M7: dropped content is checked by name ----------------------------------------------

#[test]
fn m7_dropped_documents_apply_never_share_names() {
    let ws = Ws::new();
    let firewall = Firewall::for_root(ws.path());
    let pw = body(42, 14);
    let content = format!("DB_HOST=db\nDB_USER=app\nDB_PASS={pw}\n");
    for name in [
        ".env",
        "C:\\Users\\me\\project\\.env.production",
        "/home/me/.aws/credentials",
        "id_ed25519",
        "server.pem",
    ] {
        let pkg = build(
            &firewall,
            vec![ContextItem::document(content.clone().into_bytes(), name)],
        );
        assert_eq!(
            pkg.items[0].decision.verdict,
            FirewallVerdict::Block { overridable: false },
            "{name}"
        );
        assert!(!rendered_text(&pkg).contains(&pw), "{name}");
    }

    let d = firewall.evaluate(&Candidate {
        kind: ItemKind::Document,
        origin: ItemOrigin::User,
        path: None,
        mission_id: None,
        file_name: Some("id_rsa"),
        content: Content::Bytes(
            b"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
        ),
    });
    assert_eq!(d.verdict, FirewallVerdict::Block { overridable: false });
    assert!(d.text.is_none());

    // Images named like a key file are blocked too.
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0".to_vec();
    let pkg = build(&firewall, vec![ContextItem::image(png.clone(), "id_rsa")]);
    assert_eq!(
        pkg.items[0].decision.verdict,
        FirewallVerdict::Block { overridable: false }
    );
    // An ordinary dropped name is unaffected.
    let pkg = build(&firewall, vec![ContextItem::image(png, "screenshot.png")]);
    assert_eq!(
        pkg.items[0].decision.verdict,
        FirewallVerdict::Block { overridable: true }
    );
}

// ---- hard links ----------------------------------------------------------------------------

#[test]
fn hard_links_are_not_shared_silently() {
    let ws = Ws::new();
    let outside = ws.outside();
    let pw = body(43, 14);
    std::fs::create_dir_all(outside.join(".ssh")).unwrap();
    std::fs::write(outside.join(".env"), format!("DB_PASS={pw}\n")).unwrap();
    std::fs::write(
        outside.join(".ssh").join("id_ed25519"),
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
    )
    .unwrap();
    std::fs::create_dir_all(ws.path().join("notes")).unwrap();
    std::fs::hard_link(outside.join(".env"), ws.path().join("notes").join("db.txt")).unwrap();
    std::fs::hard_link(
        outside.join(".ssh").join("id_ed25519"),
        ws.path().join("notes").join("key.txt"),
    )
    .unwrap();
    ws.write(".env", format!("DB_PASS={pw}\n"));
    std::fs::hard_link(ws.path().join(".env"), ws.path().join("env-copy.txt")).unwrap();
    ws.write("notes/plain.txt", "just notes\n");

    let firewall = Firewall::for_root(ws.path());
    let pkg = build(
        &firewall,
        vec![
            ContextItem::file("notes/db.txt"),
            ContextItem::file("notes/key.txt"),
            ContextItem::file(".env"),
            ContextItem::file("env-copy.txt"),
            ContextItem::file("notes/plain.txt"),
        ],
    );
    for item in &pkg.items[..4] {
        assert!(
            item.decision.verdict.is_block(),
            "{} was not blocked: {:?}",
            item.item.label,
            item.decision.verdict
        );
    }
    assert_eq!(pkg.items[4].decision.verdict, FirewallVerdict::Allow);
    let out = rendered_text(&pkg);
    assert!(!out.contains(&pw));
    assert!(!out.contains("b3BlbnNzaC1rZXktdjEAAAAA"));
    assert!(out.contains("just notes"));
}

// ---- combined diffs ------------------------------------------------------------------------

#[test]
fn combined_and_mixed_diffs_withhold_never_share_sections() {
    let ws = Ws::new();
    let firewall = Firewall::for_root(ws.path());
    let pw = body(44, 14);
    let combined = format!(
        "commit 1\n\ndiff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-x\n+y\n\
         commit 2 (merge)\n\ndiff --cc .env\nindex 1,2..3\n--- a/.env\n+++ b/.env\n@@@ -1,1 -1,1 +1,1 @@@\n++DB_SESSION={pw}\n"
    );
    let combined_long = combined.replace("diff --cc .env", "diff --combined .env");
    let mixed = format!(
        "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-x\n+y\n\
         --- a/config/.env.local\n+++ b/config/.env.local\n@@ -1 +1 @@\n+DB_SESSION={pw}\n"
    );
    let renamed = format!(
        "diff --git a/notes.txt b/notes.txt\nsimilarity index 90%\nrename from keys/id_rsa\nrename to notes.txt\n@@ -1 +1 @@\n+DB_SESSION={pw}\n"
    );
    for (label, diff) in [
        ("combined --cc", &combined),
        ("combined --combined", &combined_long),
        ("plain after git", &mixed),
        ("rename from key", &renamed),
    ] {
        for kind in [
            ItemKind::Diff,
            ItemKind::GitCommit,
            ItemKind::LogOutput,
            ItemKind::Text,
            ItemKind::Selection,
        ] {
            let d = firewall.evaluate(&Candidate::text(kind, ItemOrigin::Workspace, diff));
            let t = d.text.map(|t| t.text).unwrap_or_default();
            assert!(!t.contains(&pw), "{label} as {kind:?}: value present:\n{t}");
            assert!(
                !t.contains("DB_SESSION"),
                "{label} as {kind:?}: section not withheld:\n{t}"
            );
        }
    }
    // The ordinary section stays.
    let d = firewall.evaluate(&Candidate::text(
        ItemKind::Diff,
        ItemOrigin::Workspace,
        &combined,
    ));
    assert!(d.text.unwrap().text.contains("+y"));
}

// ---- never-share name gaps -------------------------------------------------------------------

#[test]
fn never_share_name_gaps_are_closed() {
    let ws = Ws::new();
    let fw = Firewall::for_root(ws.path());
    let blocked = |name: &str| {
        let (_, reasons) = fw.check_path(name, false);
        reasons
            .iter()
            .any(|r| r.effect >= RuleEffect::BlockOverridable)
    };
    for name in [
        ".env",
        ".env~",
        ".env - Copy",
        ".env copy",
        "#.env#",
        ".#.env",
        "env.production",
        ".flaskenv",
        "id_rsa.bak",
        "id_ed25519.old",
        "server.key.bak",
        "server.pem.orig",
        ".my.cnf",
        ".mylogin.cnf",
        "auth.json",
        "kubeconfig",
        "admin.kubeconfig",
        "kubeconfig.yaml",
        ".config/hub",
        ".m2/settings.xml",
        ".m2/settings-security.xml",
        ".terraform.d/credentials.tfrc.json",
        "proj-firebase-adminsdk-ab12c-0123456789.json",
        "krb5.keytab",
        "secring.gpg",
        "private.asc",
        ".dockerconfigjson",
        "me_accessKeys.csv",
        "credentials.csv",
        ".gnupg/x",
        ".ssh/id_rsa",
        "credentials",
        ".docker/config.json",
        ".config/gcloud/credentials.db",
        ".azure/msal_token_cache.json",
        "azureProfile.json",
        "accessTokens.json",
        ".git-credentials",
        ".netrc",
        "_netrc",
        ".pgpass",
        ".cargo/credentials",
        ".config/rclone/rclone.conf",
        ".databrickscfg",
        ".config/sops/age/keys.txt",
        "Login Data",
        "logins.json",
        "key4.db",
        "cookies.sqlite",
        "login.keychain-db",
        "passwords.csv",
        "bitwarden_export_20260101.json",
        "vault.1pux",
        "export.1pif",
        "lastpass_export.csv",
        ".yarnrc",
        ".gradle/gradle.properties",
    ] {
        assert!(blocked(name), "{name} is not blocked");
    }
    for name in [
        "README.md",
        "src/env.rs",
        "src/auth/login.rs",
        "config/settings.xml",
        "gradle.properties",
        "public.asc",
        "docs/kube.md",
        ".env.example",
        "src/keys.rs",
        "src/id_generator.rs",
    ] {
        assert!(!blocked(name), "{name} is blocked");
    }
}

// ---- entropy pass is linear ------------------------------------------------------------------

fn crafted(half: usize) -> String {
    let mut s = String::with_capacity(half * 2 + 64);
    while s.len() < half {
        s.push_str("data:a/b;base64,A ");
    }
    let mark = s.len();
    while s.len() - mark < half {
        s.push_str(" aaaaaaaaaaaaaaaaaaaaaa");
    }
    s
}

#[test]
fn entropy_pass_is_linear_on_crafted_input() {
    // 8 MiB total: half data URIs, half entropy candidates (the review's quadratic case).
    let text = crafted(4 * 1024 * 1024);
    let started = Instant::now();
    let _ = scan_with(&text, ScanContext::default());
    let elapsed = started.elapsed();
    let budget = if cfg!(debug_assertions) {
        Duration::from_secs(20)
    } else {
        Duration::from_millis(1000)
    };
    println!("crafted 8 MiB scan: {} ms", elapsed.as_millis());
    assert!(elapsed < budget, "crafted 8 MiB scan took {elapsed:?}");
    // Doubling the input roughly doubles the time (linear, not quadratic).
    let small = crafted(512 * 1024);
    let t = Instant::now();
    let _ = scan_with(&small, ScanContext::default());
    let small_elapsed = t.elapsed().max(Duration::from_millis(1));
    assert!(
        elapsed < small_elapsed * 40,
        "8x input took {elapsed:?} vs {small_elapsed:?}"
    );
}

// ---- sanity carried over from the review ----------------------------------------------------

#[test]
fn junctions_resolve_and_hash_pinning_holds() {
    let ws = Ws::new();
    let outside = ws.outside();
    std::fs::create_dir_all(outside.join(".ssh")).unwrap();
    std::fs::write(outside.join(".ssh").join("config"), "Host x\n").unwrap();
    std::fs::create_dir_all(ws.path().join(".aws")).unwrap();
    ws.write(".aws/notes.txt", "x\n");
    let firewall = Firewall::for_root(ws.path());
    if common::link_dir(&ws.path().join("docs"), &outside.join(".ssh"))
        && common::link_dir(&ws.path().join("docs2"), &ws.path().join(".aws"))
    {
        let (check, _) = firewall.check_path("docs/config", false);
        assert!(check.relative().is_none());
        for p in ["docs2/notes.txt", "docs2/../.aws/notes.txt"] {
            let (_, reasons) = firewall.check_path(p, false);
            assert!(reasons.iter().any(|r| r.effect == RuleEffect::Block), "{p}");
        }
    }
    ws.write("src/a.txt", "hello\n");
    let pkg = build(&firewall, vec![ContextItem::file("src/a.txt")]);
    let h = pkg.preview().content_sha256;
    assert!(matches!(
        pkg.check_before_send(&h, &firewall).unwrap(),
        SendCheck::Ready(_)
    ));
    ws.write("src/a.txt", "hello2\n");
    assert!(matches!(
        pkg.check_before_send(&h, &firewall).unwrap(),
        SendCheck::Stale(_)
    ));
}
