//! The policy: modes, rules, grants → one decision. Pure and deterministic: the same
//! classification, mode, rules and grants always produce the same decision.
//!
//! Precedence, per scope (most restrictive wins across scopes):
//!
//! 1. `never` rules of the active Custom profile → Deny, not approvable.
//! 2. `deny` rules of the active Custom profile → Deny.
//! 3. Plan mode's read-only boundary → Deny for anything that modifies.
//! 4. Auto: `always_ask` scopes ask. Every mode: remote-consequential scopes ask unless a rule
//!    **with a matcher** allows them (never implied by a mode, including Bypass).
//! 5. `allow` rules (Custom profile rules and the user's "Allow via rule" rules) → Allow.
//! 6. `ask` rules of the Custom profile → Ask.
//! 7. The mode baseline ([`baseline`]).
//! 8. A matching standing grant (thread / workspace approval) turns Ask into Allow.
//!
//! Finally, an **opaque** action (one KalCode could not fully see) is never allowed without an
//! explicit approval: any Allow becomes Ask.
//!
//! Bypass is the exception to all of the above (owner directive 2026-10-03, "take away all
//! approvals"): every action runs without a prompt except one that touches credentials or
//! secrets, which still asks.

use kalcode_contracts::permissions::{
    NormalizedAction, PermissionMode, PermissionProfile, PermissionRule, PermissionScope as S,
    PolicyDecision, PolicyEffect, RuleEffect,
};

use crate::classify::Classification;
use crate::grants::Grant;
use crate::network;
use crate::scopes::{self, is_always_ask};

/// Scopes Plan mode allows without asking.
const PLAN_ALLOW: &[S] = &[S::FilesystemRead, S::GitRead, S::TerminalReadOnly];
/// Read-type scopes Plan mode asks about (everything else is denied).
const PLAN_ASK: &[S] = &[
    S::FilesystemOutsideWorkspace,
    S::NetworkDocs,
    S::NetworkOther,
    S::BrowserNavigate,
    S::CredentialsAccess,
];
/// Scopes Approve mode allows without asking.
const APPROVE_ALLOW: &[S] = &[S::FilesystemRead, S::GitRead, S::TerminalReadOnly];
/// Scopes the Auto policy covers.
const AUTO_ALLOW: &[S] = &[
    S::FilesystemRead,
    S::FilesystemWrite,
    S::TerminalReadOnly,
    S::TerminalExecute,
    S::GitRead,
    S::GitCommit,
    S::NetworkDocs,
    S::BrowserNavigate,
];

/// The built-in behaviour of a mode for one scope. This single function is both what the
/// engine enforces and what the built-in profiles display.
pub fn baseline(mode: PermissionMode, scope: S) -> RuleEffect {
    match mode {
        PermissionMode::Plan => {
            if PLAN_ALLOW.contains(&scope) {
                RuleEffect::Allow
            } else if PLAN_ASK.contains(&scope) {
                RuleEffect::Ask
            } else {
                RuleEffect::Deny
            }
        }
        PermissionMode::Approve | PermissionMode::Custom => {
            if APPROVE_ALLOW.contains(&scope) {
                RuleEffect::Allow
            } else {
                RuleEffect::Ask
            }
        }
        PermissionMode::Auto => {
            if !is_always_ask(scope) && AUTO_ALLOW.contains(&scope) {
                RuleEffect::Allow
            } else {
                RuleEffect::Ask
            }
        }
        PermissionMode::Bypass => {
            if scope == S::CredentialsAccess {
                RuleEffect::Ask
            } else {
                RuleEffect::Allow
            }
        }
    }
}

pub fn mode_name(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Plan => "Plan",
        PermissionMode::Approve => "Approve",
        PermissionMode::Auto => "Auto",
        PermissionMode::Bypass => "Bypass",
        PermissionMode::Custom => "Custom",
    }
}

/// Everything the policy needs besides the classification.
pub struct PolicyInput<'a> {
    pub action: &'a NormalizedAction,
    pub mode: PermissionMode,
    /// The Custom profile in force (only consulted in Custom mode).
    pub profile: Option<&'a PermissionProfile>,
    /// The user's standing "Allow via rule" rules (allow effects only).
    pub user_rules: &'a [PermissionRule],
    /// Standing grants that may apply to this thread and workspace.
    pub grants: &'a [Grant],
    /// Current time, for grant expiry.
    pub now_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Verdict {
    Allow,
    Ask,
    Deny,
    Never,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Source {
    Baseline,
    ProfileRule(String),
    UserRule,
    Grant,
    PlanBoundary,
    AlwaysAsk,
    RemoteConsequential,
    Opaque,
    MissingProfile,
    /// A deny/never rule applied to an opaque action that can't be ruled out.
    OpaqueRule(String),
}

#[derive(Debug, Clone)]
struct ScopeVerdict {
    scope: S,
    verdict: Verdict,
    source: Source,
}

/// Evaluates one action. Never panics; anything unexpected resolves to Ask or Deny.
pub fn evaluate(c: &Classification, input: &PolicyInput<'_>) -> PolicyDecision {
    let mode = input.mode;
    if mode == PermissionMode::Bypass && !c.scopes.contains(&S::CredentialsAccess) {
        let mut scopes: Vec<S> = c.scopes.clone();
        scopes::normalize(&mut scopes);
        return PolicyDecision {
            effect: PolicyEffect::Allow,
            reason: "Bypass: runs without approvals.".to_owned(),
            scopes,
            approvable: false,
        };
    }
    let profile = match mode {
        PermissionMode::Custom => input.profile,
        _ => None,
    };
    let mut verdicts: Vec<ScopeVerdict> = c
        .scopes
        .iter()
        .map(|&scope| {
            if mode == PermissionMode::Custom && profile.is_none() {
                return ScopeVerdict {
                    scope,
                    verdict: Verdict::Deny,
                    source: Source::MissingProfile,
                };
            }
            scope_verdict(scope, c, input, profile)
        })
        .collect();

    if c.opaque {
        for v in &mut verdicts {
            if v.verdict == Verdict::Allow {
                v.verdict = Verdict::Ask;
                v.source = Source::Opaque;
            }
        }
        // An opaque action could be anything, so it can't be shown not to violate a deny or
        // never rule of the profile: every such rule applies.
        if let Some(profile) = profile {
            for rule in &profile.rules {
                let verdict = match rule.effect {
                    RuleEffect::Never => Verdict::Never,
                    RuleEffect::Deny => Verdict::Deny,
                    _ => continue,
                };
                verdicts.push(ScopeVerdict {
                    scope: rule.scope,
                    verdict,
                    source: Source::OpaqueRule(profile.name.clone()),
                });
            }
        }
    }

    let worst = verdicts
        .iter()
        .map(|v| v.verdict)
        .max()
        .unwrap_or(Verdict::Ask);
    let effect = match worst {
        Verdict::Allow => PolicyEffect::Allow,
        Verdict::Ask => PolicyEffect::Ask,
        Verdict::Deny | Verdict::Never => PolicyEffect::Deny,
    };
    let mut scopes: Vec<S> = c.scopes.clone();
    scopes::normalize(&mut scopes);
    PolicyDecision {
        effect,
        reason: reason(&verdicts, worst, mode, c),
        scopes,
        approvable: effect == PolicyEffect::Ask,
    }
}

fn scope_verdict(
    scope: S,
    c: &Classification,
    input: &PolicyInput<'_>,
    profile: Option<&PermissionProfile>,
) -> ScopeVerdict {
    let v = |verdict, source| ScopeVerdict {
        scope,
        verdict,
        source,
    };
    let profile_name = || profile.map(|p| p.name.clone()).unwrap_or_default();
    let profile_rules: &[PermissionRule] = profile.map_or(&[], |p| p.rules.as_slice());

    // 1–2: never / deny rules match conservatively (an unknown subject counts as a match).
    if profile_rules
        .iter()
        .any(|r| r.effect == RuleEffect::Never && rule_matches(r, scope, c) != Match::No)
    {
        return v(Verdict::Never, Source::ProfileRule(profile_name()));
    }
    if profile_rules
        .iter()
        .any(|r| r.effect == RuleEffect::Deny && rule_matches(r, scope, c) != Match::No)
    {
        return v(Verdict::Deny, Source::ProfileRule(profile_name()));
    }

    // 3: Plan is read-only.
    if input.mode == PermissionMode::Plan {
        return match baseline(PermissionMode::Plan, scope) {
            RuleEffect::Allow => v(Verdict::Allow, Source::Baseline),
            RuleEffect::Ask => {
                if grant_covers(scope, c, input) {
                    v(Verdict::Allow, Source::Grant)
                } else {
                    v(Verdict::Ask, Source::Baseline)
                }
            }
            _ => v(Verdict::Deny, Source::PlanBoundary),
        };
    }

    // 4: scopes no mode or blanket rule can pre-approve.
    let remote = scope.is_remote_consequential();
    let auto_always_ask = input.mode == PermissionMode::Auto && is_always_ask(scope);

    // 5: allow rules (exact matches only; opaque actions never match an allow rule).
    let allow_rule = |rules: &[PermissionRule]| {
        !c.opaque
            && rules.iter().any(|r| {
                r.effect == RuleEffect::Allow
                    && (!remote || r.matcher.as_deref().is_some_and(|m| !m.trim().is_empty()))
                    && rule_matches(r, scope, c) == Match::Yes
            })
    };
    if !auto_always_ask {
        if allow_rule(profile_rules) {
            return v(Verdict::Allow, Source::ProfileRule(profile_name()));
        }
        if allow_rule(input.user_rules) && !is_always_ask(scope) {
            return v(Verdict::Allow, Source::UserRule);
        }
    }

    // 6: ask rules of the profile.
    let asked_by_profile = profile_rules
        .iter()
        .any(|r| r.effect == RuleEffect::Ask && rule_matches(r, scope, c) != Match::No);

    // 7: baseline.
    let mut verdict = if asked_by_profile {
        v(Verdict::Ask, Source::ProfileRule(profile_name()))
    } else if remote {
        v(Verdict::Ask, Source::RemoteConsequential)
    } else if auto_always_ask {
        v(Verdict::Ask, Source::AlwaysAsk)
    } else {
        match baseline(input.mode, scope) {
            RuleEffect::Allow => v(Verdict::Allow, Source::Baseline),
            RuleEffect::Ask => v(Verdict::Ask, Source::Baseline),
            RuleEffect::Deny => v(Verdict::Deny, Source::Baseline),
            RuleEffect::Never => v(Verdict::Never, Source::Baseline),
        }
    };

    // 8: standing grants relax Ask only.
    if verdict.verdict == Verdict::Ask && grant_covers(scope, c, input) {
        verdict = v(Verdict::Allow, Source::Grant);
    }
    verdict
}

fn grant_covers(scope: S, c: &Classification, input: &PolicyInput<'_>) -> bool {
    !c.opaque
        && !c.sensitive
        && !is_always_ask(scope)
        && input
            .grants
            .iter()
            .any(|g| g.covers(input.action, c, scope, input.now_ms))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Match {
    Yes,
    No,
    /// The rule has a matcher but the action's subject is unknown (e.g. an opaque command).
    Unknown,
}

/// Does `rule` apply to `scope` of this action? Matchers are interpreted per scope family:
/// command-like scopes use a word-boundary command prefix, network/browser scopes a domain
/// (subdomains included), filesystem scopes a workspace-relative glob (`*`, `**`, `?`).
pub(crate) fn rule_matches(rule: &PermissionRule, scope: S, c: &Classification) -> Match {
    if rule.scope != scope {
        return Match::No;
    }
    let Some(matcher) = rule
        .matcher
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    else {
        return Match::Yes;
    };
    match scope {
        S::NetworkDocs | S::NetworkOther | S::BrowserNavigate | S::BrowserInteract => {
            if c.hosts.is_empty() {
                Match::Unknown
            } else if c.hosts.iter().all(|h| network::host_matches(h, matcher)) {
                Match::Yes
            } else {
                Match::No
            }
        }
        S::FilesystemRead | S::FilesystemWrite | S::FilesystemOutsideWorkspace => {
            if c.paths.is_empty() {
                Match::Unknown
            } else if c.paths.iter().all(|p| {
                let subject = p.relative.as_deref().unwrap_or(p.display.as_str());
                glob_match(matcher, &subject.replace('\\', "/"))
            }) {
                Match::Yes
            } else {
                Match::No
            }
        }
        _ => match &c.subject {
            None => Match::Unknown,
            Some(subject) if command_prefix_matches(subject, matcher) => Match::Yes,
            Some(_) => Match::No,
        },
    }
}

/// `npm test` matches `npm test` and `npm test -- --watch`, not `npm testx`.
pub fn command_prefix_matches(subject: &str, prefix: &str) -> bool {
    let subject: Vec<&str> = subject.split_whitespace().collect();
    let prefix: Vec<&str> = prefix.split_whitespace().collect();
    !prefix.is_empty()
        && subject.len() >= prefix.len()
        && subject
            .iter()
            .zip(&prefix)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

/// Minimal glob over `/`-separated paths: `*` and `?` stay within one component, `**` spans
/// any number of components. Comparison ignores ASCII case on Windows.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let normalize = |s: &str| {
        let s = s.trim_start_matches("./").trim_matches('/');
        if cfg!(windows) {
            s.to_ascii_lowercase()
        } else {
            s.to_owned()
        }
    };
    let pattern = normalize(pattern);
    let path = normalize(path);
    let p: Vec<&str> = pattern.split('/').collect();
    let s: Vec<&str> = if path.is_empty() {
        vec![]
    } else {
        path.split('/').collect()
    };
    glob_components(&p, &s)
}

fn glob_components(p: &[&str], s: &[&str]) -> bool {
    match p.split_first() {
        None => s.is_empty(),
        Some((&"**", rest)) => (0..=s.len()).any(|i| glob_components(rest, &s[i..])),
        Some((first, rest)) => match s.split_first() {
            Some((head, tail)) => glob_component(first, head) && glob_components(rest, tail),
            None => false,
        },
    }
}

fn glob_component(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn reason(
    verdicts: &[ScopeVerdict],
    worst: Verdict,
    mode: PermissionMode,
    c: &Classification,
) -> String {
    let mode_label = mode_name(mode);
    let mut relevant: Vec<&ScopeVerdict> = verdicts.iter().filter(|v| v.verdict == worst).collect();
    // Explain with the action's own scopes first; rules applied only because it was opaque last.
    relevant.sort_by_key(|v| matches!(v.source, Source::OpaqueRule(_)));
    if relevant
        .iter()
        .any(|v| !matches!(v.source, Source::OpaqueRule(_)))
    {
        relevant.retain(|v| !matches!(v.source, Source::OpaqueRule(_)));
    }
    let mut labels: Vec<&str> = relevant.iter().map(|v| scopes::label(v.scope)).collect();
    labels.dedup();
    let list = join_labels(&labels);
    let first = relevant.first();
    let mut text = match (worst, first.map(|v| &v.source)) {
        (Verdict::Never | Verdict::Deny, Some(Source::OpaqueRule(name))) => format!(
            "Blocked by the “{name}” profile: KalCode couldn't fully check this action, so it can't rule out {}, which the profile doesn't allow.",
            lower_first(&list)
        ),
        (Verdict::Never, Some(Source::ProfileRule(name))) => format!(
            "Blocked by the “{name}” profile: {} is set to Never and can't be approved.",
            lower_first(&list)
        ),
        (Verdict::Never, _) => format!("{list} is never allowed."),
        (Verdict::Deny, Some(Source::MissingProfile)) => {
            "This thread uses a Custom profile KalCode couldn't load, so the request is denied."
                .into()
        }
        (Verdict::Deny, Some(Source::PlanBoundary)) => format!(
            "Plan mode is read-only: {} isn't allowed. Switch the thread to Approve to make changes.",
            lower_first(&list)
        ),
        (Verdict::Deny, Some(Source::ProfileRule(name))) => {
            format!("Denied by the “{name}” profile: {}.", lower_first(&list))
        }
        (Verdict::Deny, _) => format!("{list} isn't allowed in {mode_label} mode."),
        (Verdict::Ask, _) => {
            let why = relevant
                .iter()
                .map(|v| &v.source)
                .find(|s| {
                    matches!(
                        s,
                        Source::Opaque | Source::RemoteConsequential | Source::AlwaysAsk
                    )
                })
                .or(first.map(|v| &v.source));
            match why {
                Some(Source::Opaque) => format!(
                    "KalCode couldn't fully check this action, so it needs your approval even in {mode_label} mode."
                ),
                Some(Source::RemoteConsequential) => format!(
                    "{list} affects things outside this computer, so it always needs your approval."
                ),
                Some(Source::AlwaysAsk) => {
                    format!("{list} always needs your approval, even in Auto mode.")
                }
                Some(Source::ProfileRule(name)) => {
                    format!("The “{name}” profile asks before {}.", lower_first(&list))
                }
                _ => format!("{list} needs your approval in {mode_label} mode."),
            }
        }
        (Verdict::Allow, _) => {
            let sources: Vec<&Source> = verdicts.iter().map(|v| &v.source).collect();
            if sources.contains(&&Source::Grant) {
                "Allowed by an approval you gave earlier.".into()
            } else if sources.contains(&&Source::UserRule) {
                "Allowed by one of your rules.".into()
            } else if let Some(Source::ProfileRule(name)) =
                sources.iter().find(|s| matches!(s, Source::ProfileRule(_)))
            {
                format!("Allowed by the “{name}” profile.")
            } else {
                format!("Allowed in {mode_label} mode.")
            }
        }
    };
    for note in c.notes.iter().take(2) {
        text.push(' ');
        text.push_str(note);
    }
    text.chars().take(600).collect()
}

fn join_labels(labels: &[&str]) -> String {
    match labels {
        [] => "This action".into(),
        [one] => (*one).into(),
        [first, second] => format!("{first} and {}", lower_first(second)),
        [rest @ .., last] => format!(
            "{} and {}",
            rest.iter()
                .enumerate()
                .map(|(i, l)| if i == 0 {
                    (*l).to_owned()
                } else {
                    lower_first(l)
                })
                .collect::<Vec<_>>()
                .join(", "),
            lower_first(last)
        ),
    }
}

fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs() {
        assert!(glob_match("src/**", "src/a/b.rs"));
        assert!(glob_match("src/*.rs", "src/a.rs"));
        assert!(!glob_match("src/*.rs", "src/a/b.rs"));
        assert!(glob_match("**/*.md", "docs/x/y.md"));
        assert!(glob_match("**/*.md", "y.md"));
        assert!(!glob_match("src/**", "srcx/a"));
        assert!(glob_match("a?c", "abc"));
    }

    #[test]
    fn command_prefixes_use_word_boundaries() {
        assert!(command_prefix_matches("npm test", "npm test"));
        assert!(command_prefix_matches("npm test -- -x", "npm test"));
        assert!(!command_prefix_matches("npm testx", "npm test"));
        assert!(!command_prefix_matches("npm", "npm test"));
        assert!(!command_prefix_matches("npm test", ""));
    }

    #[test]
    fn bypass_allows_everything_but_credentials_while_auto_asks_for_remote_scopes() {
        for scope in scopes::ALL_SCOPES {
            let expected = if scope == S::CredentialsAccess {
                RuleEffect::Ask
            } else {
                RuleEffect::Allow
            };
            assert_eq!(
                baseline(PermissionMode::Bypass, scope),
                expected,
                "{scope:?}"
            );
            if scope.is_remote_consequential() {
                assert_eq!(
                    baseline(PermissionMode::Auto, scope),
                    RuleEffect::Ask,
                    "{scope:?}"
                );
            }
        }
    }

    #[test]
    fn plan_denies_every_modifying_scope() {
        for scope in scopes::ALL_SCOPES {
            let effect = baseline(PermissionMode::Plan, scope);
            let reads = PLAN_ALLOW.contains(&scope) || PLAN_ASK.contains(&scope);
            assert_eq!(effect == RuleEffect::Deny, !reads, "{scope:?}");
        }
    }

    #[test]
    fn modes_are_ordered_by_authority() {
        // No scope is allowed by a stricter mode but not by a broader one.
        let order = [
            PermissionMode::Plan,
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Bypass,
        ];
        let rank = |e: RuleEffect| match e {
            RuleEffect::Allow => 0,
            RuleEffect::Ask => 1,
            RuleEffect::Deny | RuleEffect::Never => 2,
        };
        for scope in scopes::ALL_SCOPES {
            for pair in order.windows(2) {
                assert!(
                    rank(baseline(pair[1], scope)) <= rank(baseline(pair[0], scope)),
                    "{scope:?} {pair:?}"
                );
            }
        }
    }
}
