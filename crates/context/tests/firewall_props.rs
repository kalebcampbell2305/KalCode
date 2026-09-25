//! Property tests for the firewall: monotonicity (adding a restriction never loosens a
//! verdict), deny wins, never-share paths are always final blocks, secrets never reach the
//! output of a non-blocked item, and arbitrary paths and bytes never panic.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::sync::OnceLock;

use common::Ws;
use kalcode_context::model::{FirewallVerdict, RuleEffect};
use kalcode_context::never_share::GlobList;
use kalcode_context::{
    Candidate, Content, Firewall, FirewallPolicy, ItemKind, ItemOrigin, MissionScope, SecretAction,
    WorkspacePermission, WorkspaceRoot,
};
use proptest::prelude::*;

const PATHS: &[&str] = &[
    "src/app.rs",
    "src/lib/util.ts",
    "docs/guide.md",
    "build/out.log",
    "exports/users_dump.sql",
    "README.md",
    ".env",
    "keys/id_ed25519",
    "certs/a.pem",
    "../escape.txt",
    "src/a.rs:stream",
    "notes/today.txt",
];

const SECRET_PATHS: &[&str] = &[".env", "keys/id_ed25519", "certs/a.pem"];

fn ws() -> &'static Ws {
    static WS: OnceLock<Ws> = OnceLock::new();
    WS.get_or_init(|| {
        let ws = Ws::new();
        ws.write(".gitignore", "build/\n");
        for path in PATHS
            .iter()
            .filter(|p| !p.contains("..") && !p.contains(':'))
        {
            ws.write(path, "placeholder\n");
        }
        ws
    })
}

#[derive(Debug, Clone, Copy)]
struct Toggles {
    deny: bool,
    exclude_docs: bool,
    scope_src: bool,
    block_secrets: bool,
    ignore_files: bool,
}

fn toggles() -> impl Strategy<Value = Toggles> {
    (
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
    )
        .prop_map(
            |(deny, exclude_docs, scope_src, block_secrets, ignore_files)| Toggles {
                deny,
                exclude_docs,
                scope_src,
                block_secrets,
                ignore_files,
            },
        )
}

fn firewall(t: Toggles) -> Firewall {
    let policy = FirewallPolicy {
        permission: if t.deny {
            WorkspacePermission::Denied {
                reason: "test".into(),
            }
        } else {
            WorkspacePermission::Granted
        },
        exclusions: if t.exclude_docs {
            GlobList::new(&["docs/"]).expect("globs")
        } else {
            GlobList::default()
        },
        mission_scope: t
            .scope_src
            .then(|| MissionScope::new("m", &["src/**"]).expect("scope")),
        on_secret: if t.block_secrets {
            SecretAction::Block
        } else {
            SecretAction::Redact
        },
        respect_ignore_files: t.ignore_files,
        ..FirewallPolicy::default()
    };
    Firewall::new(WorkspaceRoot::new(ws().path()), policy)
}

/// Each toggle turned on is a restriction (turning ignore files *on* restricts).
fn restrictions(t: Toggles) -> Vec<Toggles> {
    let mut out = Vec::new();
    if !t.deny {
        out.push(Toggles { deny: true, ..t });
    }
    if !t.exclude_docs {
        out.push(Toggles {
            exclude_docs: true,
            ..t
        });
    }
    if !t.scope_src {
        out.push(Toggles {
            scope_src: true,
            ..t
        });
    }
    if !t.block_secrets {
        out.push(Toggles {
            block_secrets: true,
            ..t
        });
    }
    if !t.ignore_files {
        out.push(Toggles {
            ignore_files: true,
            ..t
        });
    }
    out
}

fn content_strategy() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(String::new()),
        Just("fn main() {}\n".to_owned()),
        "[a-z ]{0,80}",
        "ghp_[A-Za-z0-9]{36}".prop_map(|s| format!("token = \"{s}\"\n")),
        "[A-Za-z0-9]{24}".prop_map(|s| format!("password={s}9Qx\n")),
        "[A-Za-z0-9]{30}".prop_map(|s| format!("value: \"{s}7Kp\"\n")),
    ]
}

fn evaluate(fw: &Firewall, path: Option<&str>, text: &str) -> kalcode_context::FirewallDecision {
    fw.evaluate(&Candidate {
        kind: ItemKind::File,
        origin: ItemOrigin::Workspace,
        path,
        mission_id: None,
        file_name: None,
        content: Content::Text(text),
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Adding any restriction never makes a verdict less restrictive.
    #[test]
    fn restrictions_are_monotonic(
        t in toggles(),
        path_index in 0..PATHS.len(),
        with_path in any::<bool>(),
        text in content_strategy(),
    ) {
        let path = with_path.then(|| PATHS[path_index]);
        let base = evaluate(&firewall(t), path, &text).verdict;
        for stricter in restrictions(t) {
            let tightened = evaluate(&firewall(stricter), path, &text).verdict;
            prop_assert!(
                tightened.rank() >= base.rank(),
                "{path:?} {t:?} -> {stricter:?}: {base:?} became {tightened:?}"
            );
        }
    }

    /// Deny wins: the verdict is exactly the strongest effect of the fired rules, and an
    /// overridable block has no final-block reason behind it.
    #[test]
    fn verdict_is_the_strongest_effect(
        t in toggles(),
        path_index in 0..PATHS.len(),
        text in content_strategy(),
    ) {
        let decision = evaluate(&firewall(t), Some(PATHS[path_index]), &text);
        let strongest = decision.reasons.iter().map(|r| r.effect).max().unwrap_or(RuleEffect::Label);
        match decision.verdict {
            FirewallVerdict::Allow => prop_assert!(strongest == RuleEffect::Label),
            FirewallVerdict::AllowRedacted { spans } => {
                prop_assert_eq!(strongest, RuleEffect::Redact);
                prop_assert!(spans > 0);
            }
            FirewallVerdict::Block { overridable: true } => {
                prop_assert_eq!(strongest, RuleEffect::BlockOverridable);
                prop_assert!(decision.reasons.iter().all(|r| r.effect != RuleEffect::Block));
            }
            FirewallVerdict::Block { overridable: false } => {
                prop_assert_eq!(strongest, RuleEffect::Block);
                prop_assert!(decision.text.is_none(), "final blocks keep no content");
            }
        }
    }

    /// Built-in secret paths are final blocks under every policy and every content.
    #[test]
    fn secret_paths_always_block(
        t in toggles(),
        path_index in 0..SECRET_PATHS.len(),
        upper in any::<bool>(),
        text in content_strategy(),
    ) {
        let path = if upper {
            SECRET_PATHS[path_index].to_uppercase()
        } else {
            SECRET_PATHS[path_index].to_owned()
        };
        let decision = evaluate(&firewall(t), Some(&path), &text);
        prop_assert_eq!(decision.verdict, FirewallVerdict::Block { overridable: false });
    }

    /// A generated token never appears in the text of an item that is not finally blocked.
    #[test]
    fn secrets_never_reach_output(
        t in toggles(),
        secret in "ghp_[A-Za-z0-9]{36}",
        prefix in "[a-z =:\"\n]{0,40}",
    ) {
        let text = format!("{prefix}{secret}\n");
        let decision = evaluate(&firewall(t), None, &text);
        if let Some(redacted) = decision.text {
            prop_assert!(!redacted.text.contains(&secret));
        }
    }

    /// Arbitrary path strings and arbitrary bytes never panic, and unsafe input is never
    /// allowed through as a path inside the workspace.
    #[test]
    fn arbitrary_input_never_panics(
        path in "\\PC{0,64}",
        bytes in proptest::collection::vec(any::<u8>(), 0..512),
    ) {
        let fw = firewall(Toggles { deny: false, exclude_docs: false, scope_src: false, block_secrets: false, ignore_files: true });
        let decision = fw.evaluate(&Candidate {
            kind: ItemKind::File,
            origin: ItemOrigin::Workspace,
            path: Some(&path),
            mission_id: None,
            file_name: None,
            content: Content::Bytes(&bytes),
        });
        if path.contains("..") && decision.relative_path.is_none() {
            prop_assert!(decision.verdict.is_block());
        }
        if path.chars().any(|c| c == ':' ) && !path.starts_with(|c: char| c.is_ascii_alphabetic()) {
            prop_assert!(decision.verdict.is_block());
        }
    }
}
