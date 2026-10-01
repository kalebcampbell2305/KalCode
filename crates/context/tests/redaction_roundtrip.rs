//! Redaction round-trips: idempotence, structure preservation, no residue, parity with the log
//! redactor, and property tests over arbitrary input.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::borrow::Cow;

use kalcode_context::redact::{PlaceholderStyle, apply, redact_log_line, redact_text};
use kalcode_context::secrets::{ScanContext, scan, scan_with};
use proptest::prelude::*;

fn ctx() -> ScanContext<'static> {
    ScanContext::default()
}

#[test]
fn round_trip_is_idempotent_structure_preserving_and_clean() {
    let placeholder = regex::Regex::new(r"\[REDACTED:[a-z_]+\]").expect("re");
    for (text, secret) in common::samples() {
        let once = redact_text(&text, ctx(), PlaceholderStyle::Labelled);
        let twice = redact_text(&once.text, ctx(), PlaceholderStyle::Labelled);
        assert_eq!(once.text, twice.text, "not idempotent for {text:?}");
        assert!(
            twice.spans.is_empty(),
            "placeholder re-detected: {:?}",
            twice.spans
        );
        assert!(!once.text.contains(&secret), "residue in {:?}", once.text);
        assert_eq!(
            once.text.matches('\n').count(),
            text.matches('\n').count(),
            "line structure changed: {text:?} -> {:?}",
            once.text
        );
        assert!(
            scan(&once.text).is_empty(),
            "residual findings in {:?}",
            once.text
        );
        // Everything outside the redacted spans is unchanged, in order.
        let mut cursor = 0;
        let mut outside = String::new();
        for span in &once.spans {
            outside.push_str(&text[cursor..span.start]);
            cursor = span.end;
        }
        outside.push_str(&text[cursor..]);
        let strip =
            |s: &str| -> String { s.chars().filter(|c| *c != '\n' && *c != '\r').collect() };
        assert_eq!(
            strip(&placeholder.replace_all(&once.text, "")),
            strip(&outside),
            "non-secret text changed"
        );
    }
}

#[test]
fn adjacent_assignment_cannot_expose_a_second_pass_entropy_secret() {
    let text = [
        "https://u:",
        "ib0c+Ae-1__",
        "password=",
        "____A=",
        "\"api_key\": \"",
    ]
    .concat();

    let once = redact_text(&text, ctx(), PlaceholderStyle::Labelled);
    let twice = redact_text(&once.text, ctx(), PlaceholderStyle::Labelled);

    assert_eq!(once.text, twice.text);
    assert!(!once.text.contains("ib0c+Ae-1__"));
    assert!(!once.text.contains("____A="));
    assert!(
        scan(&once.text).is_empty(),
        "residual finding in {:?}",
        once.text
    );
    assert_eq!(once.text.matches('\n').count(), text.matches('\n').count());
}

#[test]
fn plain_style_matches_the_log_format() {
    let (text, secret) = &common::samples()[1];
    let out = redact_text(text, ctx(), PlaceholderStyle::Plain);
    assert!(out.text.contains("[REDACTED]"));
    assert!(!out.text.contains(secret));
}

/// Every vector from `native-core`'s `logging.rs` tests: this redactor can replace it.
#[test]
fn covers_every_log_redaction_vector() {
    let cases: &[(&str, &str)] = &[
        (
            "key sk-ant-api03-abcdefghijklmnopqrstuvwx used",
            "sk-ant-api03",
        ),
        (
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
            "eyJhbGci",
        ),
        (
            "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "ghp_abcdef",
        ),
        ("aws AKIAABCDEFGHIJKLMNOP", "AKIAABCD"),
        (
            "google AIzaSyA1234567890abcdefghijklmnopqrstuv",
            "AIzaSyA12",
        ),
        ("https://user:hunter22@example.com/repo.git", "hunter22"),
        (r#"{"api_key":"abc123def456"}"#, "abc123def456"),
        ("password=correcthorse", "correcthorse"),
        (
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
            "MIIEow",
        ),
        (
            "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY",
            "wJalrXUtnFEMI",
        ),
        ("secret_key: abcdef123456", "abcdef123456"),
        ("private_key = 'mysecretkeydata'", "mysecretkeydata"),
        (
            "Authorization: Basic dXNlcjpwYXNzd29yZA==",
            "dXNlcjpwYXNzd29yZA",
        ),
        ("stripe sk_live_51HxAbCdEfGhIjKlMn", "sk_live_51Hx"),
        (
            "git https://glpat-abcdefghijklmnopqrstu@gitlab.com/x.git",
            "glpat-abcdef",
        ),
        (
            "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w",
            "eyJzdWIi",
        ),
        (
            "key AIzaSyA1234567890abcdefghijklmnopqrstu- next",
            "AIzaSyA12345",
        ),
        ("slack xapp-1-A0123456789-abcdef", "xapp-1-A0123"),
        ("hub hf_abcdefghijklmnopqrstuvwxyz0123456", "hf_abcdefghij"),
        (
            "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----",
            "lQOYBF",
        ),
        (
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEtruncated",
            "MIIEtruncated",
        ),
        (
            r#"{\"api_key\":\"abc123def456ghi\",\"error\":\"bad\"}"#,
            "abc123def456ghi",
        ),
        (
            r#"connecting with token=\"secretvalue123\""#,
            "secretvalue123",
        ),
        (
            "header Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
            "abcdefghijklmnop",
        ),
        ("leaked sk-proj-ABCDEFGHIJKLMNOPQRSTUV here", "sk-proj-ABCD"),
    ];
    for (input, secret) in cases {
        let out = redact_log_line(input);
        assert!(!out.contains(secret), "{input:?} -> {out:?}");
        assert!(out.contains("[REDACTED]"), "{input:?} -> {out:?}");
    }
    let clean = r#"{"level":"INFO","fields":{"event":"app.started","version":"0.1.0","seq":42}}"#;
    assert!(matches!(redact_log_line(clean), Cow::Borrowed(_)));
    assert_eq!(
        redact_log_line("leaked sk-proj-ABCDEFGHIJKLMNOPQRSTUV here\n"),
        "leaked [REDACTED] here\n"
    );
}

fn secret_strategy() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("ghp_[A-Za-z0-9]{36}"),
        Just("sk-ant-api03-[A-Za-z0-9]{40}"),
        Just("AKIA[A-Z0-9]{16}"),
        Just("xoxb-[A-Za-z0-9]{24}"),
        Just("hf_[A-Za-z0-9]{34}"),
        Just("glpat-[A-Za-z0-9]{24}"),
    ]
    .prop_flat_map(|re| proptest::string::string_regex(re).expect("regex strategy"))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Arbitrary Unicode never panics; findings are sorted, disjoint and on char boundaries;
    /// redaction keeps the line count and is idempotent.
    #[test]
    fn arbitrary_text_is_safe(text in "\\PC{0,400}") {
        let findings = scan_with(&text, ScanContext::default());
        let mut last_end = 0;
        for f in &findings {
            prop_assert!(f.start >= last_end);
            prop_assert!(f.start < f.end && f.end <= text.len());
            prop_assert!(text.is_char_boundary(f.start) && text.is_char_boundary(f.end));
            last_end = f.end;
        }
        let once = apply(&text, &findings, PlaceholderStyle::Labelled);
        prop_assert_eq!(once.text.matches('\n').count(), text.matches('\n').count());
        let twice = redact_text(&once.text, ScanContext::default(), PlaceholderStyle::Labelled);
        prop_assert_eq!(&twice.text, &once.text);
    }

    /// Secret-shaped text built from assignment fragments: idempotent and clean afterwards.
    #[test]
    fn assignment_soup_is_idempotent(
        parts in proptest::collection::vec(
            prop_oneof![
                Just("password=".to_owned()),
                Just("token: ".to_owned()),
                Just("\"api_key\": \"".to_owned()),
                Just("Bearer ".to_owned()),
                Just("https://u:".to_owned()),
                Just("@h/".to_owned()),
                Just("\n".to_owned()),
                "[A-Za-z0-9+/=_-]{1,40}",
            ],
            0..24,
        )
    ) {
        let text: String = parts.concat();
        let once = redact_text(&text, ScanContext::default(), PlaceholderStyle::Labelled);
        let twice = redact_text(&once.text, ScanContext::default(), PlaceholderStyle::Labelled);
        prop_assert_eq!(&twice.text, &once.text);
        prop_assert_eq!(once.text.matches('\n').count(), text.matches('\n').count());
    }

    /// A secret embedded anywhere in ordinary text never survives redaction.
    #[test]
    fn embedded_secrets_never_survive(
        prefix in "[a-z ,.;:=\n]{0,60}",
        suffix in "[a-z ,.;:=\n]{0,60}",
        secret in secret_strategy(),
    ) {
        let text = format!("{prefix} {secret} {suffix}");
        let out = redact_text(&text, ScanContext::default(), PlaceholderStyle::Labelled);
        prop_assert!(!out.text.contains(&secret), "{:?}", out.text);
        let log = redact_log_line(&text);
        prop_assert!(!log.contains(&secret));
    }
}
