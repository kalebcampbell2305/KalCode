//! SEC-LATENT regression (ported from the review PoC `secrev_panics`): targeted no-panic fuzz
//! over tricky multi-byte inputs for every path, diff, trim and firewall entry point, now also
//! covering combined-diff headers, file ranges and the new detectors.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use kalcode_context::content::trim_head_tail;
use kalcode_context::diff::split_sections;
use kalcode_context::never_share::validate_pattern;
use kalcode_context::package::{ContextItem, ContextPackage, PackageOptions};
use kalcode_context::paths::{check_relative_text, normalize_for_match};
use kalcode_context::provider::TextOnlyDefaults;
use kalcode_context::redact::{PlaceholderStyle, redact_text};
use kalcode_context::secrets::ScanContext;
use kalcode_context::{Candidate, ContextPurpose, Firewall, ItemKind, ItemOrigin};

const ATOMS: &[&str] = &[
    "/",
    "\\",
    ".",
    "..",
    "~",
    "~1",
    ":",
    "$",
    "%",
    "a",
    "é",
    "日本",
    "😀",
    "\u{FF0E}",
    "\u{2024}",
    "¹",
    "com",
    "lpt",
    "\n",
    "\r\n",
    " ",
    "\"",
    "diff --git a/",
    " b/",
    "--- ",
    "+++ ",
    "@@",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----END",
    "password=",
    "\u{0130}",
    "\u{212A}",
    "data:a/b;base64,",
    "ghp_",
    "Aa1",
    "=",
    "'",
    "`",
    "\\\"",
    "*",
    "[",
    "]",
    "{",
    "**",
    "!",
    "diff --cc ",
    "diff --combined ",
    "rename from ",
    "---- BEGIN SSH2 PRIVATE KEY ----",
    "AGE-SECRET-KEY-1",
    "LS0tLS1CRUdJTi",
    "<password>",
    "</password>",
    "name: ",
    "value: ",
    "-p",
    "--password ",
    "ENV ",
    "Authorization: Token ",
    "|",
    "  ",
    "define('DB_PASSWORD', '",
    "hooks.slack.com/services/",
    "://:",
    "@",
    "AKIA",
    ",",
];

#[test]
fn no_panics_on_tricky_inputs() {
    let ws = common::Ws::new();
    ws.write("src/a.txt", "x");
    let fw = Firewall::for_root(ws.path());
    let mut rng = common::Rng::new(99);
    let rounds = if cfg!(debug_assertions) {
        15_000
    } else {
        40_000
    };
    for _ in 0..rounds {
        let n = (rng.next() % 24) as usize;
        let s: String = (0..n)
            .map(|_| ATOMS[(rng.next() % ATOMS.len() as u64) as usize])
            .collect();
        let _ = check_relative_text(&s);
        let _ = normalize_for_match(&s);
        let _ = validate_pattern(&s);
        let _ = fw.check_path(&s, false);
        let _ = split_sections(&s);
        for max in [0usize, 1, 3, 63, 64, 65, 70, 100] {
            let _ = trim_head_tail(&s, max);
        }
        let _ = fw.evaluate(&Candidate::text(ItemKind::Diff, ItemOrigin::Workspace, &s));
        let red = redact_text(
            &s,
            ScanContext {
                file_name: Some("x.yml"),
                no_entropy: false,
            },
            PlaceholderStyle::Labelled,
        );
        assert_eq!(
            red.text.matches('\n').count(),
            s.matches('\n').count(),
            "{s:?}"
        );
    }
}

#[test]
fn file_ranges_never_panic() {
    let ws = common::Ws::new();
    let mut rng = common::Rng::new(7);
    let fw = Firewall::for_root(ws.path());
    for i in 0..300 {
        let n = (rng.next() % 40) as usize;
        let s: String = (0..n)
            .map(|_| ATOMS[(rng.next() % ATOMS.len() as u64) as usize])
            .collect();
        ws.write("f.txt", &s);
        let start = (rng.next() % 6) as u32;
        let end = (rng.next() % 8) as u32;
        let _ = ContextPackage::build(
            &fw,
            &TextOnlyDefaults::new("p"),
            PackageOptions::new(ContextPurpose::Drop),
            vec![ContextItem::file_range("f.txt", start, end)],
        );
        let _ = i;
    }
}
