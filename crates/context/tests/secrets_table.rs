//! Table-driven secret detection: true positives across common credential formats, and
//! false-positive fixtures (UUIDs, digests, lockfile hashes, embedded images, identifiers,
//! code references, placeholders, prose).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use common::{BASE62, Rng, UPPER_DIGITS, body, hex, token};
use kalcode_context::redact::{PlaceholderStyle, redact_text};
use kalcode_context::secrets::{Confidence, ScanContext, scan_with};

struct Positive {
    label: &'static str,
    text: String,
    secret: String,
    detector: &'static str,
    file: Option<&'static str>,
}

fn positives() -> Vec<Positive> {
    let mut rng = Rng::new(99);
    let mut cases = Vec::new();
    let mut push = |label: &'static str,
                    text: String,
                    secret: String,
                    detector: &'static str,
                    file: Option<&'static str>| {
        cases.push(Positive {
            label,
            text,
            secret,
            detector,
            file,
        })
    };

    let s = token("sk-ant-api03-", 1, 40);
    push(
        "ai key (sk-ant)",
        format!("key {s} used"),
        s,
        "ai_provider_key",
        None,
    );
    let s = token("sk-proj-", 2, 48);
    push(
        "ai key (sk-proj)",
        format!("export KEY_X={s}"),
        s,
        "ai_provider_key",
        None,
    );
    let s = token("ghp_", 3, 36);
    push(
        "git host token (ghp_)",
        format!("token: {s}"),
        s,
        "git_host_token",
        None,
    );
    let s = token("github_pat_", 4, 60);
    push(
        "git host fine-grained token",
        format!("x {s} y"),
        s,
        "git_host_token",
        None,
    );
    let s = token("glpat-", 5, 22);
    push(
        "git host token (glpat-)",
        format!("url https://oauth2:{s}@gitlab.example/x.git"),
        s,
        "git_host_token",
        None,
    );
    let s = token("sk_live_", 6, 24);
    push(
        "payment secret key",
        format!("STRIPE={s}"),
        s,
        "payment_key",
        None,
    );
    let s = token("whsec_", 7, 32);
    push(
        "webhook signing secret",
        format!("secret {s}"),
        s,
        "payment_key",
        None,
    );
    let s = token("hf_", 8, 34);
    push(
        "model hub token",
        format!("hub {s}"),
        s,
        "model_hub_token",
        None,
    );
    let s = token("npm_", 9, 36);
    push(
        "package registry token",
        format!("//registry.npmjs.org/:_authToken={s}"),
        s,
        "package_registry_token",
        Some(".npmrc"),
    );
    let s = token("pypi-AgEIcHlwaS5vcmc", 10, 60);
    push(
        "python package token",
        format!("password = {s}"),
        s,
        "package_registry_token",
        Some(".pypirc"),
    );
    let s = format!("AKIA{}", rng.string(UPPER_DIGITS, 16));
    push(
        "cloud access key id",
        format!("aws_access_key_id = {s}"),
        s,
        "cloud_access_key_id",
        None,
    );
    let s = format!("AIza{}", rng.string(BASE62, 35));
    push(
        "cloud api key",
        format!("const k = '{s}';"),
        s,
        "cloud_api_key",
        Some("main.js"),
    );
    let s = format!("dop_v1_{}", hex(11, 64));
    push("cloud token", format!("DO={s}"), s, "cloud_token", None);
    let s = token("xoxb-", 12, 40);
    push(
        "chat bot token",
        format!("SLACK={s}"),
        s,
        "chat_token",
        None,
    );
    let s = format!("123456789:AA{}", rng.string(BASE62, 33));
    push(
        "chat bot token (numeric)",
        format!("bot {s} ok"),
        s,
        "chat_token",
        None,
    );
    let s = format!("SG.{}.{}", rng.string(BASE62, 22), rng.string(BASE62, 43));
    push(
        "email delivery key",
        format!("mail {s}"),
        s,
        "messaging_api_key",
        None,
    );
    let s = format!("shpat_{}", hex(13, 32));
    push(
        "commerce token",
        format!("x {s}"),
        s,
        "commerce_token",
        None,
    );
    let s = format!("eyJhbGciOiJIUzI1NiJ9.eyJ{}.{}", body(14, 30), body(15, 43));
    push("jwt", format!("Authorization: Bearer {s}"), s, "jwt", None);
    let s = body(16, 40);
    push(
        "bearer token",
        format!("curl -H 'Authorization: Bearer {s}'"),
        s,
        "bearer_token",
        None,
    );
    push(
        "basic auth",
        "Authorization: Basic dXNlcjpzM2NyM3RQYXNz".to_owned(),
        "dXNlcjpzM2NyM3RQYXNz".to_owned(),
        "basic_auth",
        None,
    );
    let s = body(17, 18);
    push(
        "url credentials (user:pass)",
        format!("DATABASE_URL=postgres://admin:{s}@db.internal:5432/app"),
        s,
        "url_credentials",
        None,
    );
    let s = body(18, 24);
    push(
        "url credentials (token@)",
        format!("git clone https://{s}@git.example.com/r.git"),
        s,
        "url_credentials",
        None,
    );
    let s = format!("{}==", body(19, 86));
    push(
        "connection string key",
        format!(
            "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey={s};EndpointSuffix=example"
        ),
        s,
        "connection_string_key",
        None,
    );
    let s = body(20, 40);
    push(
        "sensitive assignment (.env)",
        format!("AWS_SECRET_ACCESS_KEY={s}"),
        s,
        "sensitive_assignment",
        Some(".env"),
    );
    let s = body(21, 30);
    push(
        "sensitive assignment (json)",
        format!("{{\"client_secret\": \"{s}\"}}"),
        s,
        "sensitive_assignment",
        Some("config.json"),
    );
    let s = "correcthorse".to_owned();
    push(
        "sensitive assignment (plain word)",
        "password=correcthorse".to_owned(),
        s,
        "sensitive_assignment",
        None,
    );
    let s = body(22, 28);
    push(
        "sensitive assignment (yaml)",
        format!("db:\n  password: {s}\n"),
        s,
        "sensitive_assignment",
        Some("app.yaml"),
    );
    let s = body(23, 32);
    push(
        "sensitive assignment (quoted, code)",
        format!("const apiKey = \"{s}\";"),
        s,
        "sensitive_assignment",
        Some("client.ts"),
    );
    let s = body(24, 32);
    push(
        "high entropy literal",
        format!("const x = \"{s}\";"),
        s,
        "high_entropy_string",
        Some("x.js"),
    );
    let s = body(25, 40);
    push(
        "high entropy value",
        format!("value: {s}"),
        s,
        "high_entropy_string",
        Some("x.yaml"),
    );

    let key_body = format!("{}\n{}\n{}\n", body(26, 64), body(27, 64), body(28, 20));
    for header in [
        "RSA PRIVATE KEY",
        "PRIVATE KEY",
        "EC PRIVATE KEY",
        "OPENSSH PRIVATE KEY",
        "ENCRYPTED PRIVATE KEY",
    ] {
        push(
            "private key block",
            format!("-----BEGIN {header}-----\n{key_body}-----END {header}-----\n"),
            body(26, 64),
            "private_key",
            Some("key.txt"),
        );
    }
    push(
        "pgp private key block",
        format!(
            "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n{key_body}-----END PGP PRIVATE KEY BLOCK-----\n"
        ),
        body(27, 64),
        "private_key",
        None,
    );
    push(
        "truncated private key",
        format!("-----BEGIN RSA PRIVATE KEY-----\n{}", body(29, 50)),
        body(29, 50),
        "private_key",
        None,
    );
    push(
        "private key in json (service account)",
        format!(
            "{{\"type\": \"service_account\", \"private_key\": \"-----BEGIN PRIVATE KEY-----\\n{}\\n-----END PRIVATE KEY-----\\n\"}}",
            body(30, 64)
        ),
        body(30, 64),
        "private_key",
        Some("sa.json"),
    );
    push(
        "putty private key",
        format!(
            "PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none\nComment: k\nPublic-Lines: 1\n{}\nPrivate-Lines: 1\n{}\nPrivate-MAC: {}\n",
            body(31, 40),
            body(32, 40),
            hex(33, 64)
        ),
        body(32, 40),
        "private_key",
        None,
    );
    cases
}

#[test]
fn detects_common_credential_formats() {
    for case in positives() {
        let context = ScanContext {
            file_name: case.file,
            no_entropy: false,
        };
        let findings = scan_with(&case.text, context);
        let hit = findings.iter().find(|f| {
            case.text[f.start..f.end].contains(&case.secret)
                || case.secret.contains(&case.text[f.start..f.end])
        });
        let Some(hit) = hit else {
            panic!(
                "{}: no finding covers the secret in {:?}: {findings:?}",
                case.label, case.text
            );
        };
        assert_eq!(hit.detector, case.detector, "{}: {findings:?}", case.label);
        let redacted = redact_text(&case.text, context, PlaceholderStyle::Labelled);
        assert!(
            !redacted.text.contains(&case.secret),
            "{}: secret survived redaction: {}",
            case.label,
            redacted.text
        );
        assert!(redacted.text.contains("[REDACTED:"), "{}", case.label);
    }
}

#[test]
fn format_detectors_are_high_confidence() {
    for case in positives() {
        if case.detector == "high_entropy_string" {
            continue;
        }
        let findings = scan_with(
            &case.text,
            ScanContext {
                file_name: case.file,
                no_entropy: false,
            },
        );
        assert!(
            findings.iter().any(|f| f.confidence == Confidence::High),
            "{}: {findings:?}",
            case.label
        );
    }
}

struct Negative {
    label: &'static str,
    text: String,
    file: Option<&'static str>,
}

fn negatives() -> Vec<Negative> {
    let mut rng = Rng::new(7);
    let b64 = |rng: &mut Rng, n: usize| {
        rng.string(
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
            n,
        )
    };
    let mut v = Vec::new();
    let mut push = |label: &'static str, text: String, file: Option<&'static str>| {
        v.push(Negative { label, text, file })
    };
    push(
        "uuid literal",
        "id: \"550e8400-e29b-41d4-a716-446655440000\"".into(),
        None,
    );
    push(
        "uuid in json",
        "{\"requestId\": \"0190f5a2-7c1d-7b3e-9f00-1a2b3c4d5e6f\"}".into(),
        Some("r.json"),
    );
    push("commit id", format!("commit = \"{}\"", hex(1, 40)), None);
    push(
        "image digest",
        format!("image: app@sha256:{}", hex(2, 64)),
        Some("compose.yaml"),
    );
    push(
        "cargo lock checksum",
        format!("[[package]]\nname = \"x\"\nchecksum = \"{}\"\n", hex(3, 64)),
        Some("Cargo.lock"),
    );
    push(
        "cargo lock checksum (no file name)",
        format!("checksum = \"{}\"", hex(4, 64)),
        None,
    );
    let integrity = format!("sha512-{}==", b64(&mut rng, 86));
    push(
        "npm lock integrity",
        format!("\"integrity\": \"{integrity}\","),
        Some("package-lock.json"),
    );
    push(
        "npm lock integrity (no file name)",
        format!("\"integrity\": \"{integrity}\","),
        None,
    );
    push(
        "pnpm lock integrity",
        format!("resolution: {{integrity: {integrity}}}"),
        Some("pnpm-lock.yaml"),
    );
    push(
        "go.sum hash",
        format!("example.com/x v1.2.3 h1:{}=", b64(&mut rng, 43)),
        Some("go.sum"),
    );
    push(
        "yarn lock",
        format!(
            "  resolved \"https://registry.yarnpkg.com/x/-/x-1.0.0.tgz#{}\"\n  integrity {integrity}\n",
            hex(5, 40)
        ),
        Some("yarn.lock"),
    );
    push(
        "png data uri",
        format!("<img src=\"data:image/png;base64,{}\">", b64(&mut rng, 600)),
        Some("index.html"),
    );
    push(
        "svg data uri in css",
        format!(
            ".icon {{ background: url(data:image/svg+xml;base64,{}); }}",
            b64(&mut rng, 120)
        ),
        Some("a.css"),
    );
    push(
        "short data uri",
        format!("src=\"data:image/gif;base64,{}\"", b64(&mut rng, 60)),
        None,
    );
    push(
        "camelCase identifier literal",
        "fn(\"getUserAccountSettingsById123\")".into(),
        Some("a.ts"),
    );
    push(
        "PascalCase literal",
        "const name = \"ThisIsAVeryLongComponentName\";".into(),
        Some("a.tsx"),
    );
    push(
        "constant name",
        "const KEY = \"MAX_RETRY_ATTEMPTS_PER_REQUEST_2\";".into(),
        Some("a.rs"),
    );
    push(
        "css class",
        "class=\"btn-primary-large-rounded-2\"".into(),
        Some("a.html"),
    );
    push(
        "call expression",
        "password = get_password()".into(),
        Some("a.py"),
    );
    push("type annotation", "token: string;".into(), Some("a.ts"));
    push(
        "env reference",
        "apiKey: process.env.API_KEY,".into(),
        Some("a.ts"),
    );
    push(
        "template reference",
        "password: \"${DB_PASSWORD}\"".into(),
        Some("compose.yaml"),
    );
    push(
        "placeholder",
        "api_key = \"your_api_key\"".into(),
        Some("README.md"),
    );
    push("masked", "secret: xxxxxxxxxx".into(), Some("a.yaml"));
    push("member path", "token = self.token".into(), Some("a.py"));
    push(
        "shorthand in code",
        "const client = new Client({ apiKey: apiKey });".into(),
        Some("a.ts"),
    );
    push(
        "prose",
        "The bearer authentication scheme uses opaque tokens.".into(),
        Some("README.md"),
    );
    push(
        "unix path",
        "path = \"/usr/local/lib/node_modules/typescript/bin/tsc\"".into(),
        None,
    );
    push(
        "long lowercase word",
        "label: \"internationalization-configuration\"".into(),
        None,
    );
    push(
        "already redacted",
        "password=[REDACTED:sensitive_assignment]".into(),
        None,
    );
    push(
        "already redacted url",
        "postgres://admin:[REDACTED:url_credentials]@db/app".into(),
        None,
    );
    push(
        "semver and hashes in text",
        "Released v1.2.3 (build 2026.09.24) at 0a1b2c3d".into(),
        None,
    );
    push(
        "base64 of long text blob",
        format!("blob = \"{}\"", b64(&mut rng, 400)),
        None,
    );
    v
}

#[test]
fn false_positive_fixtures_stay_clean() {
    for case in negatives() {
        let findings = scan_with(
            &case.text,
            ScanContext {
                file_name: case.file,
                no_entropy: false,
            },
        );
        let spans: Vec<&str> = findings
            .iter()
            .map(|f| &case.text[f.start..f.end])
            .collect();
        assert!(
            findings.is_empty(),
            "{}: unexpected findings {findings:?} {spans:?} in {:?}",
            case.label,
            case.text
        );
    }
}

#[test]
fn hash_manifests_disable_only_the_entropy_heuristic() {
    // A real key inside a lockfile is still caught by its format detector.
    let key = token("ghp_", 40, 36);
    let text = format!("\"resolved\": \"https://{key}@example.com/x.tgz\"");
    let findings = scan_with(
        &text,
        ScanContext {
            file_name: Some("package-lock.json"),
            no_entropy: false,
        },
    );
    assert!(!findings.is_empty());
}
