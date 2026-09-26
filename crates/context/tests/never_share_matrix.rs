//! Never-share path matrix: built-in sensitive names under case changes, Unicode look-alikes,
//! trailing dots and spaces, alternate data streams, device names, environment expansion,
//! traversal, junction and symlink escapes, and 8.3 short names.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use common::Ws;
use kalcode_context::model::{FirewallRule, FirewallVerdict};
use kalcode_context::package::{ContextItem, ContextPackage, PackageOptions};
use kalcode_context::provider::TextOnlyDefaults;
use kalcode_context::{Candidate, Content, ContextPurpose, Firewall, ItemKind, ItemOrigin};

const FINAL: FirewallVerdict = FirewallVerdict::Block { overridable: false };
const CONFIRM: FirewallVerdict = FirewallVerdict::Block { overridable: true };
const ALLOW: FirewallVerdict = FirewallVerdict::Allow;

fn workspace() -> Ws {
    let ws = Ws::new();
    let secret = common::token("ghp_", 1, 36);
    for (path, content) in [
        (".env", format!("GIT_TOKEN={secret}\n")),
        (
            "config/.env.production",
            "DB_PASSWORD=x9Kq2LmZ7vPp\n".to_owned(),
        ),
        (".env.example", "DB_PASSWORD=\n".to_owned()),
        (
            "keys/id_rsa",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n".to_owned(),
        ),
        (
            "keys/id_rsa.pub",
            "ssh-ed25519 AAAAC3Nza user@host\n".to_owned(),
        ),
        ("certs/server.pem", "cert\n".to_owned()),
        ("certs/client.p12", "p12\n".to_owned()),
        ("tls/site.key", "key\n".to_owned()),
        (".aws/credentials", "[default]\n".to_owned()),
        (".npmrc", "//registry/:_authToken=x\n".to_owned()),
        ("gcp/service-account.json", "{}\n".to_owned()),
        ("exports/customers_export.csv", "id,email\n".to_owned()),
        ("src/main.rs", "fn main() {}\n".to_owned()),
        ("src/id_generator.rs", "pub fn id() {}\n".to_owned()),
        ("notes/plan.md", "# plan\n".to_owned()),
    ] {
        ws.write(path, content);
    }
    ws
}

fn verdict(firewall: &Firewall, path: &str) -> FirewallVerdict {
    firewall
        .evaluate(&Candidate {
            kind: ItemKind::File,
            origin: ItemOrigin::Workspace,
            path: Some(path),
            mission_id: None,
            file_name: None,
            content: Content::None,
        })
        .verdict
}

#[test]
fn builtin_names_under_every_spelling() {
    let ws = workspace();
    let firewall = Firewall::for_root(ws.path());
    let cases: &[(&str, FirewallVerdict)] = &[
        (".env", FINAL),
        (".ENV", FINAL),
        (".Env.Local", FINAL),
        ("config/.env.production", FINAL),
        ("config\\.ENV.PRODUCTION", FINAL),
        ("./config/../.env", FINAL),
        ("src/../.env", FINAL),
        ("prod.env", FINAL),
        (".envrc", FINAL),
        (".env.example", ALLOW),
        ("keys/id_rsa", FINAL),
        ("keys/ID_RSA", FINAL),
        ("keys/id_ed25519", FINAL),
        ("keys/id_rsa.pub", ALLOW),
        ("certs/server.pem", FINAL),
        ("certs/SERVER.PEM", FINAL),
        ("certs/client.p12", FINAL),
        ("certs/client.PFX", FINAL),
        ("tls/site.key", FINAL),
        (".aws/credentials", FINAL),
        (".AWS/Credentials", FINAL),
        (".ssh/config", FINAL),
        (".npmrc", FINAL),
        (".NPMRC", FINAL),
        ("gcp/service-account.json", FINAL),
        ("gcp/prod-credentials.json", FINAL),
        ("infra/terraform.tfstate", FINAL),
        (".git/config", CONFIRM),
        ("exports/customers_export.csv", CONFIRM),
        ("src/main.rs", ALLOW),
        ("src/id_generator.rs", ALLOW),
        ("notes/plan.md", ALLOW),
    ];
    for (path, expected) in cases {
        assert_eq!(verdict(&firewall, path), *expected, "{path}");
    }
}

#[test]
fn unicode_lookalikes_and_invisible_characters() {
    let ws = workspace();
    let firewall = Firewall::for_root(ws.path());
    for path in [
        "\u{FF0E}env",                      // full-width full stop
        "\u{FF0E}\u{FF25}\u{FF2E}\u{FF36}", // full-width ．ＥＮＶ
        "\u{2024}env",                      // one dot leader
        "keys/\u{FF49}\u{FF44}_rsa",        // full-width ｉｄ
        "keys/id\u{FE4D}rsa",               // dashed low line
        "certs/server\u{FF0E}pem",
    ] {
        assert_eq!(verdict(&firewall, path), FINAL, "{path:?}");
    }
    // Invisible and bidi characters make a path uninterpretable: blocked as unsafe.
    for path in [
        ".e\u{200B}nv",
        "src/\u{202E}sr.niam",
        "src/main\u{FEFF}.rs",
        ".env\u{00AD}",
    ] {
        let decision = firewall.evaluate(&Candidate {
            kind: ItemKind::File,
            origin: ItemOrigin::Workspace,
            path: Some(path),
            mission_id: None,
            file_name: None,
            content: Content::None,
        });
        assert_eq!(decision.verdict, FINAL, "{path:?}");
        assert!(
            decision
                .reasons
                .iter()
                .any(|r| r.rule == FirewallRule::UnsafePath),
            "{path:?}: {:?}",
            decision.reasons
        );
    }
}

#[test]
fn trailing_dots_spaces_streams_and_devices() {
    let ws = workspace();
    let firewall = Firewall::for_root(ws.path());
    for path in [
        ".env.",
        ".env..",
        ".env ",
        " .env",
        ".env. .",
        "keys/id_rsa.",
        ".env::$DATA",
        ".env:$DATA",
        ".env:hidden",
        "src/main.rs:stream",
        "src/main.rs::$DATA",
        "src/NUL",
        "src/con.txt",
        "src/COM1",
        "src/lpt9.log",
        "CONIN$",
    ] {
        assert_eq!(verdict(&firewall, path), FINAL, "{path:?}");
    }
}

#[test]
fn escapes_outside_the_workspace() {
    let ws = workspace();
    let outside = ws.outside();
    std::fs::write(outside.join("x.txt"), "outside").expect("write");
    let firewall = Firewall::for_root(ws.path());
    let absolute_outside = outside.join("x.txt").to_string_lossy().into_owned();
    let sibling = format!("{}2/x.txt", ws.path().to_string_lossy());
    for path in [
        "../outside/x.txt",
        "src/../../outside/x.txt",
        "../../../../../../../../etc/passwd",
        absolute_outside.as_str(),
        sibling.as_str(),
        "\\\\server\\share\\.env",
        "//server/share/x",
        "\\\\?\\UNC\\server\\share\\x",
        "\\\\.\\PhysicalDrive0",
        "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x",
        "\\??\\C:\\x",
        "C:relative.txt",
        "~/.ssh/id_rsa",
        "$HOME/.env",
        "${HOME}/x",
        "%USERPROFILE%\\.env",
        "`pwd`/x",
    ] {
        assert_eq!(verdict(&firewall, path), FINAL, "{path:?}");
    }
}

#[test]
fn link_and_junction_escapes() {
    let ws = workspace();
    let outside = ws.outside();
    std::fs::write(outside.join("notes.txt"), "outside notes").expect("write");
    let firewall = Firewall::for_root(ws.path());

    // A junction (Windows) / symlink (Unix) inside the workspace pointing outside it.
    // Junctions need no privilege, so on Windows this case must run.
    let created = common::link_dir(&ws.path().join("out"), &outside);
    assert!(created || !cfg!(windows), "could not create a junction");
    if created {
        assert_eq!(verdict(&firewall, "out/notes.txt"), FINAL);
        assert_eq!(verdict(&firewall, "out"), FINAL);
    }
    // An innocent-looking link to a credential directory is judged by its target.
    if common::link_dir(&ws.path().join("docs_keys"), &ws.path().join("keys")) {
        assert_eq!(verdict(&firewall, "docs_keys/id_rsa"), FINAL);
        assert_eq!(verdict(&firewall, "docs_keys/id_rsa.pub"), ALLOW);
    }
    if common::link_dir(&ws.path().join("cloud"), &ws.path().join(".aws")) {
        assert_eq!(verdict(&firewall, "cloud/credentials"), FINAL);
    }
    // A file symlink named like ordinary text that points at `.env` (needs developer mode on
    // Windows; skipped when the OS refuses).
    if common::link_file(&ws.path().join("readme-copy.txt"), &ws.path().join(".env")) {
        assert_eq!(verdict(&firewall, "readme-copy.txt"), FINAL);
    } else {
        eprintln!("file symlinks are not permitted here; that case was skipped");
    }
    // A dangling link cannot be verified: blocked.
    if common::link_dir(&ws.path().join("gone"), &ws.path().join("does-not-exist")) {
        assert_eq!(verdict(&firewall, "gone/x.txt"), FINAL);
    }
}

#[cfg(windows)]
#[test]
fn short_names_resolve_to_their_long_names() {
    use std::os::windows::process::CommandExt as _;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let ws = workspace();
    let firewall = Firewall::for_root(ws.path());
    // `for %I in (.env) do @echo %~snxI` prints the 8.3 name when the volume creates them.
    let output = std::process::Command::new("cmd")
        .args(["/C", "for %I in (.env) do @echo %~snxI"])
        .current_dir(ws.path())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .expect("cmd");
    let short = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if short.is_empty() || short.eq_ignore_ascii_case(".env") {
        eprintln!("8.3 names are disabled on this volume; skipping");
        return;
    }
    assert_eq!(verdict(&firewall, &short), FINAL, "short name {short}");
    // A short name that does not exist cannot be expanded: blocked, not guessed.
    assert_eq!(verdict(&firewall, "src/NEWFIL~1.RS"), FINAL);
}

#[test]
fn blocked_files_are_never_read_and_never_leak() {
    let ws = workspace();
    let secret = common::token("ghp_", 1, 36);
    let firewall = Firewall::for_root(ws.path());
    let package = ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new("provider-x"),
        PackageOptions::new(ContextPurpose::Drop),
        vec![ContextItem::file(".env"), ContextItem::file("src/main.rs")],
    );
    let env = &package.items[0];
    assert_eq!(env.decision.verdict, FINAL);
    assert!(env.decision.text.is_none());
    assert_eq!(env.bytes, 0, "a finally blocked file is not read");
    let preview = serde_json::to_string(&package.preview()).expect("json");
    let rendered = package.render().expect("render").text();
    let log = serde_json::to_string(&package.log_entries()).expect("json");
    for blob in [&preview, &rendered, &log] {
        assert!(!blob.contains(&secret));
    }
    assert!(rendered.contains("fn main() {}"));
}

#[test]
fn user_patterns_and_exclusions() {
    use kalcode_context::never_share::{
        GlobList, NeverSharePattern, NeverShareRules, PatternScope,
    };
    use kalcode_context::{FirewallPolicy, Sensitivity, WorkspaceRoot};
    let ws = workspace();
    let policy = FirewallPolicy {
        never_share: NeverShareRules::new(&[
            NeverSharePattern {
                scope: PatternScope::Global,
                pattern: "notes/".into(),
                sensitivity: Sensitivity::Confidential,
            },
            NeverSharePattern {
                scope: PatternScope::Workspace {
                    workspace_id: "w".into(),
                },
                pattern: "*.rs".into(),
                sensitivity: Sensitivity::Secret,
            },
        ])
        .expect("rules"),
        exclusions: GlobList::new(&["src/id_*"]).expect("globs"),
        ..FirewallPolicy::default()
    };
    let firewall = Firewall::new(WorkspaceRoot::new(ws.path()), policy);
    assert_eq!(verdict(&firewall, "notes/plan.md"), CONFIRM);
    assert_eq!(verdict(&firewall, "NOTES/Plan.md"), CONFIRM);
    assert_eq!(verdict(&firewall, "src/main.rs"), FINAL);
    assert_eq!(verdict(&firewall, "src/ID_GENERATOR.rs"), FINAL);
    assert_eq!(verdict(&firewall, ".env.example"), ALLOW);
}
