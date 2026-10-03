//! Property tests (deterministic pseudo-random): invariants that must hold for every input.

// Helpers outside `#[test]` functions may panic on setup failures too.
#![allow(clippy::expect_used)]

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::permissions::{
    ActionKind, NormalizedAction, PermissionMode as M, PermissionProfile, PermissionRule,
    PermissionScope as S, PolicyDecision, PolicyEffect, RuleEffect,
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
    // Dialect-specific syntax (SEC-LATENT): every shell's quoting, escaping and separators.
    "@",
    "%X%",
    "!X!",
    "$'",
    "\\x72",
    "${X:-",
    "\u{2018}",
    "\u{2019}",
    "\u{201C}",
    "\u{201D}",
    "\u{2013}Recurse",
    "\u{2014}r",
    "-Recurse:$true",
    "Remove-Item",
    "ri",
    "rd",
    "/s/q",
    "<#",
    "#>",
    "--%",
    "{rm,-rf,src}",
    "@{e={",
    "ForEach-Object{",
    "$env:API_KEY",
    "--rec",
    "--forc",
    "-O",
    "--upload-pack=x",
    "--ext-diff",
    ".en*",
    "*.pem",
    ",",
    "\r\n",
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
    for _ in 0..6000 {
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
            // Bypass runs without approvals (owner directive 2026-10-03) except for
            // credentials; every other mode keeps opaque and remote actions asking.
            let credentials = c.scopes.contains(&S::CredentialsAccess);
            if mode == M::Bypass {
                assert_eq!(
                    d.effect == PolicyEffect::Allow,
                    !credentials,
                    "{text:?} {:?}",
                    c.scopes
                );
            }
            // Opaque actions are never allowed without an explicit approval.
            if c.opaque && mode != M::Bypass {
                assert_ne!(d.effect, PolicyEffect::Allow, "{text:?} {mode:?}");
            }
            // Remote-consequential scopes are never allowed by a mode other than Bypass.
            if c.scopes.iter().any(|s| s.is_remote_consequential()) && mode != M::Bypass {
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
            // Bypass runs without approvals (owner directive 2026-10-03); the classification
            // above is what this property protects.
            for mode in [M::Approve, M::Auto] {
                let (_, d) = decide(&kind, &ws, mode);
                assert_ne!(d.effect, PolicyEffect::Allow, "{out:?} {mode:?}");
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

/// A Custom profile that denies destructive actions.
fn deny_destructive() -> PermissionProfile {
    PermissionProfile {
        id: "deny-destructive".into(),
        name: "No destructive actions".into(),
        mode: M::Custom,
        rules: vec![PermissionRule {
            scope: S::Destructive,
            effect: RuleEffect::Deny,
            matcher: None,
        }],
        builtin: false,
    }
}

/// Deny wins: a destructive command joined to anything by a separator that **any** shell honours
/// (bash, cmd.exe or PowerShell), and dressed in any dialect's quoting or escaping, is denied by a
/// deny rule — never allowed or merely asked about — because the most authority-requiring reading
/// of the text is the one judged.
#[test]
fn deny_wins_for_destructive_commands_in_any_dialect() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(dir.path().join("src")).expect("mkdir");
    let ws = Workspace::new(Some(dir.path()));
    let profile = deny_destructive();
    // Prefixes every shell parses as one complete command; each shell adds its own below.
    let prefixes: &[&str] = &["echo hi", "git status", "ls -la", "cat src/a.txt", ""];
    // Per shell: (separator, suffix that closes whatever the separator opened) and commands that
    // shell really runs destructively. Git works in every shell.
    let git: &[&str] = &[
        "git push --forc origin main",
        "git reset --har",
        "git clean --forc -d",
    ];
    let posix: (&[(&str, &str)], &[&str]) = (
        &[
            (" ; ", ""),
            (" && ", ""),
            (" || ", ""),
            (" | ", ""),
            (" & ", ""),
            ("\n", ""),
            (" ^& ", ""),
            (" ^; ", ""),
            (" ^&^& ", ""),
            (" $'\\'' ; ", " #'"),
            (" #'\n", "\necho '"),
        ],
        &[
            "rm -rf src",
            "rm --rec src",
            "rsync -a --del src/ dst/",
            "find . -delete",
            "{rm,-rf,src}",
        ],
    );
    let cmd: (&[(&str, &str)], &[&str]) = (
        &[
            (" & ", ""),
            (" && ", ""),
            (" || ", ""),
            (" | ", ""),
            ("\n", ""),
            (" 'x & ", " & echo '"),
            (" 'x | ", " | echo '"),
        ],
        &[
            "rd /s /q src",
            "@rd /s /q src",
            "rd/s/q src",
            "rmdir /s /q src",
            "del /s /q src",
            "rd,/s,/q,src",
        ],
    );
    let powershell: (&[(&str, &str)], &[&str]) = (
        &[
            (" ; ", ""),
            (" | ", ""),
            ("\n", ""),
            (" && ", ""),
            (" <# x #> ; ", ""),
            (" | ForEach-Object{", "}"),
            (" @{e={", "}}"),
            (" \u{201C}it's\u{201D} ; ", ""),
        ],
        &[
            "Remove-Item -Recurse src",
            "Remove-Item \u{2013}Recurse src",
            "Remove-Item \u{2014}Recurse src",
            "Remove-Item -Recurse:$true src",
            "ri -r src",
            "& \u{2018}Remove-Item\u{2019} -Recurse src",
        ],
    );
    // Text that only the named shell parses as a complete command (a lone `'` is data to
    // cmd.exe but opens a quote in bash and PowerShell).
    let own_prefixes: [&[&str]; 3] = [
        &["type src/a.txt"],
        &["echo 'x", "type src\\a.txt"],
        &["echo \u{201C}it's\u{201D}", "Get-ChildItem src"],
    ];
    let shells = [posix, cmd, powershell];
    let mut rng = Rng(0x0dd_ba11_c0ff_ee00);
    for _ in 0..4000 {
        let shell = (rng.next() % 3) as usize;
        let (separators, destructive) = shells[shell];
        let prefix = if rng.chance(30) {
            rng.pick(own_prefixes[shell])
        } else {
            rng.pick(prefixes)
        };
        let (separator, suffix) = rng.pick(separators);
        let danger = if rng.chance(20) {
            rng.pick(git)
        } else {
            rng.pick(destructive)
        };
        let text = if prefix.is_empty() {
            (*danger).to_owned()
        } else {
            format!("{prefix}{separator}{danger}{suffix}")
        };
        let kind = ActionKind::Command {
            command: text.clone(),
            argv: vec![],
            cwd: String::new(),
        };
        let c = classify(&kind, &ws);
        assert!(
            c.scopes.contains(&S::Destructive) || c.opaque,
            "{text:?} lost Destructive: {:?} {:?}",
            c.scopes,
            c.notes
        );
        let a = action(kind);
        let d = evaluate(
            &c,
            &PolicyInput {
                action: &a,
                mode: M::Custom,
                profile: Some(&profile),
                user_rules: &[],
                grants: &[],
                now_ms: 0,
            },
        );
        assert_eq!(d.effect, PolicyEffect::Deny, "{text:?}: {}", d.reason);
    }
}

/// Random text built from every dialect's metacharacters never panics, is classified the same
/// way every time, and stays fast with five readings per command.
#[test]
fn random_dialect_soup_never_panics_and_is_deterministic() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ws = Workspace::new(Some(dir.path()));
    let alphabet: Vec<char> =
        "abcdrmsqxyz -/\\\"'`^&|;()<>{}[]*?$%!@#,=~\n\t\r:.\u{2018}\u{2019}\u{201C}\u{201D}\u{2013}\u{2014}\u{2012}\u{200B}"
            .chars()
            .collect();
    let mut rng = Rng(0xfeed_face_dead_beef);
    let started = std::time::Instant::now();
    for _ in 0..5000 {
        let len = 1 + (rng.next() % 40) as usize;
        let text: String = (0..len).map(|_| *rng.pick(&alphabet)).collect();
        let first = kalcode_permissions::command::classify_command(&text, &[], "", &ws);
        let second = kalcode_permissions::command::classify_command(&text, &[], "", &ws);
        assert_eq!(first, second, "{text:?} is not deterministic");
        assert!(!first.scopes.is_empty(), "{text:?}");
    }
    assert!(
        started.elapsed() < std::time::Duration::from_secs(60),
        "{:?}",
        started.elapsed()
    );
}
