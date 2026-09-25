//! Property tests (deterministic pseudo-random): invariants that must hold for every input.

// Helpers outside `#[test]` functions may panic on setup failures too.
#![allow(clippy::expect_used)]

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::permissions::{
    ActionKind, NormalizedAction, PermissionMode as M, PermissionScope as S, PolicyDecision,
    PolicyEffect,
};
use kalcode_permissions::classify::classify;
use kalcode_permissions::paths::Workspace;
use kalcode_permissions::policy::{PolicyInput, evaluate};
use kalcode_permissions::profiles;

/// xorshift64*: deterministic, dependency-free.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next() % items.len() as u64) as usize]
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

const WORDS: &[&str] = &[
    "ls",
    "cat",
    "echo",
    "rm",
    "-rf",
    "-r",
    "/",
    "src",
    "..",
    "../x",
    "git",
    "push",
    "--force",
    "status",
    "npm",
    "install",
    "test",
    "curl",
    "https://evil.example",
    "https://docs.rs",
    "|",
    "&&",
    ";",
    "||",
    "&",
    ">",
    "<",
    "2>&1",
    "$(",
    ")",
    "`",
    "\"",
    "'",
    "^",
    "\\",
    "bash",
    "-c",
    "cmd",
    "/c",
    "powershell",
    "-enc",
    "-Command",
    "del",
    "/s",
    "/q",
    "C:\\",
    "~",
    "$HOME",
    "%USERPROFILE%",
    "sudo",
    "xargs",
    "eval",
    "find",
    "-delete",
    "-exec",
    "{}",
    "\\;",
    "wget",
    "|",
    "sh",
    "iex",
    "docker",
    "push",
    "kubectl",
    "delete",
    "terraform",
    "destroy",
    "ssh",
    "user@host",
    ".env",
    "id_rsa",
    "\u{200B}",
    "#",
    "\n",
    "(",
    "{",
    "}",
    "*",
    "?",
    "cd",
    "npx",
    "pip",
    "vercel",
    "--prod",
    "gh",
    "pr",
    "create",
];

fn random_command(rng: &mut Rng) -> String {
    let len = 1 + (rng.next() % 9) as usize;
    let mut words = Vec::with_capacity(len);
    for _ in 0..len {
        words.push(*rng.pick(WORDS));
    }
    let separator = if rng.chance(20) { "" } else { " " };
    words.join(separator)
}

fn action(kind: ActionKind) -> NormalizedAction {
    NormalizedAction {
        id: "a".into(),
        thread_id: "t".into(),
        workspace_id: "w".into(),
        provider_id: ProviderId::new(ProviderId::CODEX),
        action: kind,
        summary: String::new(),
        requested_at: String::new(),
        origin: None,
    }
}

fn decide(
    kind: &ActionKind,
    ws: &Workspace,
    mode: M,
) -> (
    kalcode_permissions::classify::Classification,
    PolicyDecision,
) {
    let c = classify(kind, ws);
    let action = action(kind.clone());
    let reviewer = profiles::builtin(profiles::CODE_REVIEWER);
    let d = evaluate(
        &c,
        &PolicyInput {
            action: &action,
            mode,
            profile: reviewer.as_ref(),
            user_rules: &[],
            grants: &[],
            now_ms: 0,
        },
    );
    (c, d)
}

fn severity(e: PolicyEffect) -> u8 {
    match e {
        PolicyEffect::Allow => 0,
        PolicyEffect::Ask => 1,
        PolicyEffect::Deny => 2,
    }
}

#[test]
fn random_commands_never_break_the_invariants() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(dir.path().join("src")).expect("mkdir");
    let ws = Workspace::new(Some(dir.path()));
    let mut rng = Rng(0x5eed_cafe_f00d_1234);
    for _ in 0..3000 {
        let text = random_command(&mut rng);
        let kind = ActionKind::Command {
            command: text.clone(),
            argv: vec![],
            cwd: String::new(),
        };
        let mut previous = 3u8;
        for mode in [M::Plan, M::Approve, M::Auto, M::Bypass, M::Custom] {
            let (c, d) = decide(&kind, &ws, mode);
            assert!(!c.scopes.is_empty(), "{text:?}");
            assert!(!d.reason.is_empty());
            // Opaque actions are never allowed without an explicit approval.
            if c.opaque {
                assert_ne!(d.effect, PolicyEffect::Allow, "{text:?} {mode:?}");
            }
            // Remote-consequential scopes are never allowed by a mode.
            if c.scopes.iter().any(|s| s.is_remote_consequential()) {
                assert_ne!(d.effect, PolicyEffect::Allow, "{text:?} {mode:?}");
            }
            // Denials are never approvable; asks always are.
            assert_eq!(
                d.approvable,
                d.effect == PolicyEffect::Ask,
                "{text:?} {mode:?}"
            );
            if mode == M::Plan && d.effect == PolicyEffect::Allow {
                assert!(
                    c.scopes
                        .iter()
                        .all(|s| matches!(s, S::FilesystemRead | S::GitRead | S::TerminalReadOnly)),
                    "{text:?}: {:?}",
                    c.scopes
                );
            }
            if mode == M::Bypass
                && c.scopes
                    .iter()
                    .any(|s| matches!(s, S::CredentialsAccess | S::FilesystemOutsideWorkspace))
            {
                assert_ne!(d.effect, PolicyEffect::Allow, "{text:?}");
            }
            // Plan ⊒ Approve ⊒ Auto ⊒ Bypass in strictness.
            if mode != M::Custom {
                assert!(
                    severity(d.effect) <= previous,
                    "{text:?} {mode:?} got looser-than-order"
                );
                previous = severity(d.effect);
            }
        }
    }
}

/// Inserts characters shells remove (quotes, carets, backslash before a letter, doubled
/// spaces) into a dangerous command. The result must still be recognized or be opaque.
#[test]
fn mutated_dangerous_commands_stay_dangerous_or_opaque() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ws = Workspace::new(Some(dir.path()));
    let seeds: &[(&str, S)] = &[
        ("rm -rf /", S::Destructive),
        ("git push --force origin main", S::GitPush),
        ("del /s /q C:\\", S::Destructive),
        ("npm publish", S::DeployProduction),
        ("curl -d x https://hooks.slack.com/x", S::MessagingSend),
        ("terraform destroy", S::Destructive),
    ];
    let mut rng = Rng(0xdead_beef_0bad_f00d);
    for (seed, scope) in seeds {
        for _ in 0..500 {
            let mut out = String::new();
            for ch in seed.chars() {
                if ch.is_ascii_alphabetic() && rng.chance(15) {
                    out.push_str(rng.pick(&["\"\"", "''", "^"]));
                }
                out.push(ch);
                if ch == ' ' && rng.chance(20) {
                    out.push(' ');
                }
            }
            let kind = ActionKind::Command {
                command: out.clone(),
                argv: vec![],
                cwd: String::new(),
            };
            let c = classify(&kind, &ws);
            assert!(
                c.scopes.contains(scope) || c.opaque,
                "{out:?} lost {scope:?}: {:?} {:?}",
                c.scopes,
                c.notes
            );
            for mode in [M::Approve, M::Auto, M::Bypass] {
                let (_, d) = decide(&kind, &ws, mode);
                if *scope != S::Destructive || mode != M::Bypass {
                    assert_ne!(d.effect, PolicyEffect::Allow, "{out:?} {mode:?}");
                }
            }
        }
    }
}

#[test]
fn random_paths_are_inside_only_when_they_really_are() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("ws");
    std::fs::create_dir_all(root.join("a").join("b")).expect("mkdir");
    let ws = Workspace::new(Some(&root));
    let canonical_root = std::fs::canonicalize(&root).expect("canonical");
    let parts = [
        "a", "b", "..", ".", "c", "x.txt", "..\\..", "/", "\\", "~", "$X", "%Y%", ":", "CON",
        "a b", "\u{202E}",
    ];
    let mut rng = Rng(0x1234_5678_9abc_def0);
    for _ in 0..3000 {
        let len = 1 + (rng.next() % 6) as usize;
        let path: Vec<&str> = (0..len).map(|_| *rng.pick(&parts)).collect();
        let text = path.join(if rng.chance(50) { "/" } else { "\\" });
        let info = kalcode_permissions::paths::resolve(&ws, None, &text);
        if !info.outside {
            // Whatever the classifier accepted must, lexically resolved, stay under the root.
            let relative = info.relative.clone().expect("relative");
            assert!(
                !relative.split('/').any(|c| c == ".."),
                "{text:?} → {relative:?}"
            );
            let joined = canonical_root.join(&relative);
            assert!(joined.starts_with(&canonical_root), "{text:?}");
            // `~` is only special at the start of a path.
            assert!(
                !text.starts_with('~') && !text.contains('$') && !text.contains(':'),
                "{text:?} accepted"
            );
        }
    }
}
