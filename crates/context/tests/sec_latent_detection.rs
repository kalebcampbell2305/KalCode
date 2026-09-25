//! SEC-LATENT M5/M6 regression (ported from the 2026-09-24 review PoC `secrev_detection_gaps`):
//! every common secret format in the review matrix is redacted completely (no fragment of the
//! secret survives), and name/value pairs are recognised. Fixture values are documentation
//! examples or deterministic fake bodies assembled at run time.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use common::{body, hex, token};
use kalcode_context::redact::{PlaceholderStyle, redact_text};
use kalcode_context::secrets::ScanContext;

fn b64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn fake_pem() -> String {
    let mut s = String::from("-----BEGIN RSA PRIVATE KEY-----\n");
    for i in 0..10 {
        s.push_str(&body(900 + i, 64));
        s.push('\n');
    }
    s.push_str("-----END RSA PRIVATE KEY-----\n");
    s
}

struct Case {
    label: &'static str,
    file: &'static str,
    text: String,
    /// Fragments that must not survive.
    secrets: Vec<String>,
}

#[test]
fn every_review_format_is_fully_redacted() {
    let aws_id = "AKIAIOSFODNN7EXAMPLE".to_owned();
    let aws_secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_owned();
    let ghp = token("ghp_", 1, 36);
    let ghpat = token("github_pat_", 2, 82);
    let xoxb = format!("xoxb-{}-{}-{}", hex(3, 12), hex(4, 13), body(5, 24));
    let slack_hook = format!(
        "https://hooks.slack.com/services/T{}/B{}/{}",
        "0EXAMPLE0",
        "0EXAMPLE1",
        body(6, 24)
    );
    let sk_live = token("sk_live_", 7, 24);
    let rk_live = token("rk_live_", 8, 24);
    let aiza = token("AIza", 9, 35);
    let jwt = format!("eyJhbGciOiJIUzI1NiJ9.eyJ{}.{}", body(10, 30), body(11, 43));
    let pw_plain = body(12, 14);
    let long_hex = hex(13, 128);
    let pem = fake_pem();
    let pem_line = pem.lines().nth(3).unwrap().to_owned();
    let pem_b64 = b64(pem.as_bytes());
    let age = format!(
        "AGE-SECRET-KEY-1{}",
        common::Rng::new(14)
            .string(b"QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L", 58)
            .to_uppercase()
    );
    let ssh2_line = body(15, 64);

    let cases = vec![
        Case {
            label: "aws id + secret (credentials ini)",
            file: "notes/aws.ini",
            text: format!(
                "[default]\naws_access_key_id = {aws_id}\naws_secret_access_key = {aws_secret}\n"
            ),
            secrets: vec![aws_id.clone(), aws_secret.clone()],
        },
        Case {
            label: "aws console accessKeys.csv",
            file: "downloads/me_accessKeys.csv",
            text: format!("Access key ID,Secret access key\n{aws_id},{aws_secret}\n"),
            secrets: vec![aws_id.clone(), aws_secret.clone()],
        },
        Case {
            label: "ghp_ token",
            file: "a.txt",
            text: format!("token {ghp}\n"),
            secrets: vec![ghp.clone()],
        },
        Case {
            label: "github_pat_",
            file: "a.txt",
            text: format!("x={ghpat}\n"),
            secrets: vec![ghpat.clone()],
        },
        Case {
            label: "slack xoxb",
            file: "a.txt",
            text: format!("slack: {xoxb}\n"),
            secrets: vec![xoxb.clone()],
        },
        Case {
            label: "slack webhook url",
            file: "a.yml",
            text: format!("webhook_url: {slack_hook}\n"),
            secrets: vec![slack_hook.rsplit('/').next().unwrap().to_owned()],
        },
        Case {
            label: "stripe sk_live/rk_live",
            file: "a.txt",
            text: format!("{sk_live}\n{rk_live}\n"),
            secrets: vec![sk_live.clone(), rk_live.clone()],
        },
        Case {
            label: "google AIza",
            file: "a.js",
            text: format!("const k = \"{aiza}\";\n"),
            secrets: vec![aiza.clone()],
        },
        Case {
            label: "jwt",
            file: "a.txt",
            text: format!("{jwt}\n"),
            secrets: vec![jwt.clone()],
        },
        Case {
            label: "pem rsa",
            file: "a.txt",
            text: pem.clone(),
            secrets: vec![pem_line.clone()],
        },
        Case {
            label: "ssh2/rfc4716 private key",
            file: "a.txt",
            text: format!(
                "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nComment: \"k\"\n{ssh2_line}\n{}\n---- END SSH2 ENCRYPTED PRIVATE KEY ----\n",
                body(16, 64)
            ),
            secrets: vec![ssh2_line.clone()],
        },
        Case {
            label: "age secret key",
            file: "keys.txt",
            text: format!("# created\n{age}\n"),
            secrets: vec![age.clone()],
        },
        Case {
            label: ".env export+quotes",
            file: "cfg.env.txt",
            text: format!("export API_KEY=\"{pw_plain}\"\r\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: ".env spaces around =",
            file: "settings.cfg",
            text: format!("API_TOKEN = {pw_plain}\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "DB_PASS (short name)",
            file: "settings.cfg",
            text: format!("DB_PASS={pw_plain}\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "SMTP_PW",
            file: "settings.cfg",
            text: format!("SMTP_PW={pw_plain}\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "password with spaces (quoted)",
            file: "settings.cfg",
            text: "DB_PASSWORD=\"correct horse battery staple\"\n".to_owned(),
            secrets: vec!["horse battery staple".to_owned()],
        },
        Case {
            label: "password containing &",
            file: "settings.cfg",
            text: "DB_PASSWORD=Tr0ub4dor&3xyzQ\n".to_owned(),
            secrets: vec!["3xyzQ".to_owned()],
        },
        Case {
            label: "password starting with $",
            file: "settings.cfg",
            text: "DB_PASSWORD='$uperS3cretQ9'\n".to_owned(),
            secrets: vec!["uperS3cretQ9".to_owned()],
        },
        Case {
            label: "password containing (",
            file: "settings.cfg",
            text: "DB_PASSWORD=Pa(ss)w0rdQ9z\n".to_owned(),
            secrets: vec!["w0rdQ9z".to_owned()],
        },
        Case {
            label: "password that looks like member path",
            file: "settings.cfg",
            text: "DB_PASSWORD=correct.horse.battery\n".to_owned(),
            secrets: vec!["correct.horse.battery".to_owned()],
        },
        Case {
            label: "SECRET_KEY_BASE hex",
            file: "settings.cfg",
            text: format!("SECRET_KEY_BASE={long_hex}\n"),
            secrets: vec![long_hex.clone()],
        },
        Case {
            label: "ado.net Password=",
            file: "app.config",
            text: format!("Server=db;User Id=sa;Password={pw_plain};\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "redis url empty user",
            file: "settings.cfg",
            text: format!("REDIS_URL=redis://:{pw_plain}@cache:6379/0\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "postgres url pw with /",
            file: "settings.cfg",
            text: format!("DATABASE_URL=postgres://app:ab/{pw_plain}@db/x\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "kubeconfig client-key-data (base64 PEM)",
            file: "deploy/kubeconfig.yaml",
            text: format!("users:\n- name: admin\n  user:\n    client-key-data: {pem_b64}\n"),
            secrets: vec![pem_b64[40..120].to_owned()],
        },
        Case {
            label: "k8s secret id_rsa: base64",
            file: "deploy/secret.yaml",
            text: format!("data:\n  id_rsa: {pem_b64}\n"),
            secrets: vec![pem_b64[40..120].to_owned()],
        },
        Case {
            label: "xml <password>",
            file: "settings.xml",
            text: format!("<server><password>{pw_plain}</password></server>\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "xml appSettings key/value",
            file: "web.config",
            text: format!("<add key=\"ApiKey\" value=\"{pw_plain}\" />\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "php define",
            file: "wp-config.php",
            text: format!("define( 'DB_PASSWORD', '{pw_plain}' );\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "curl -u user:pass",
            file: "run.sh",
            text: format!("curl -u admin:{pw_plain} https://api.example.com/\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "mysql -p",
            file: "run.sh",
            text: format!("mysql -u root -p{pw_plain} db\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "--password <space> value",
            file: "run.log",
            text: format!("tool --password {pw_plain}\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "Dockerfile ENV space syntax",
            file: "Dockerfile",
            text: format!("ENV DB_PASSWORD {pw_plain}\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "Authorization: Token",
            file: "req.http",
            text: format!("Authorization: Token {pw_plain}\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "yaml block scalar password",
            file: "a.yml",
            text: format!("password: |\n  {pw_plain}\n"),
            secrets: vec![pw_plain.clone()],
        },
        Case {
            label: "secret split across lines (py concat)",
            file: "a.py",
            text: format!(
                "API_KEY = (\"{}\"\n           \"{}\")\n",
                &ghp[..12],
                &ghp[12..]
            ),
            secrets: vec![ghp[12..].to_owned()],
        },
    ];

    let mut leaked_cases = Vec::new();
    for case in &cases {
        let red = redact_text(
            &case.text,
            ScanContext {
                file_name: Some(case.file),
                no_entropy: false,
            },
            PlaceholderStyle::Labelled,
        );
        for secret in &case.secrets {
            if red.text.contains(secret.as_str()) {
                leaked_cases.push(format!("{}: {}", case.label, red.text));
            }
        }
        assert_eq!(
            red.text.lines().count(),
            case.text.lines().count(),
            "{}: line structure changed",
            case.label
        );
    }
    assert_eq!(cases.len(), 37);
    assert!(
        leaked_cases.is_empty(),
        "{} of {} formats leaked:
{}",
        leaked_cases.len(),
        cases.len(),
        leaked_cases.join(
            "
"
        )
    );
}

#[test]
fn name_value_pairs_are_redacted() {
    let pw = body(77, 14);
    for (label, file, text) in [
        (
            "k8s env name/value",
            "deploy.yaml",
            format!(
                "env:
  - name: DB_PASSWORD
    value: {pw}
"
            ),
        ),
        (
            "json name/value",
            "vars.json",
            format!(
                "[{{\"name\": \"API_KEY\", \"value\": \"{pw}\"}}]
"
            ),
        ),
        (
            "compose list",
            "docker-compose.yml",
            format!(
                "environment:
  - DB_PASSWORD={pw}
"
            ),
        ),
    ] {
        let red = redact_text(
            &text,
            ScanContext {
                file_name: Some(file),
                no_entropy: false,
            },
            PlaceholderStyle::Labelled,
        );
        assert!(!red.text.contains(&pw), "{label} leaked: {}", red.text);
    }
}

#[test]
fn new_detectors_keep_common_text_clean() {
    // A (public) certificate as kubeconfig stores it: long base64 of a PEM certificate.
    let cert = b64(format!(
        "-----BEGIN CERTIFICATE-----
{}
-----END CERTIFICATE-----
",
        body(88, 300)
    )
    .as_bytes());
    for (label, file, text) in [
        (
            "docker uid:gid",
            "run.sh",
            "docker run -u 1000:1000 image\n".to_owned(),
        ),
        (
            "length setting",
            ".env.example",
            "PASSWORD_MIN_LENGTH=12\n".to_owned(),
        ),
        (
            "secret name",
            "deploy.yaml",
            "SECRET_NAME=my-app-secret\n".to_owned(),
        ),
        (
            "key path",
            "settings.cfg",
            "KEY_PATH=/etc/ssl/private/server-key.pem\n".to_owned(),
        ),
        (
            "list of field names",
            "a.py",
            "fields = [\"password\", \"confirm_password\"]\n".to_owned(),
        ),
        (
            "request lookup in code",
            "a.py",
            "password = request.form[\"password\"]\n".to_owned(),
        ),
        (
            "call argument in code",
            "a.ts",
            "const token = await getToken(user, scope);\n".to_owned(),
        ),
        (
            "xml numeric setting",
            "web.config",
            "<add key=\"Timeout\" value=\"30000\" />\n".to_owned(),
        ),
        (
            "k8s non-secret env",
            "deploy.yaml",
            "env:\n  - name: LOG_LEVEL\n    value: debug-verbose\n".to_owned(),
        ),
        (
            "dockerfile env",
            "Dockerfile",
            "ENV NODE_ENV production\n".to_owned(),
        ),
        (
            "curl with variables",
            "run.sh",
            "curl -u $CI_USER:$CI_TOKEN https://api.example.com/\n".to_owned(),
        ),
        (
            "mysql prompt",
            "run.sh",
            "mysql -u root -p app_db\n".to_owned(),
        ),
        (
            "url with port and path",
            "README.md",
            "see https://example.com:8443/users/me@example.com\n".to_owned(),
        ),
        (
            "kube certificate data",
            "kubeconfig.yaml",
            format!("    client-certificate-data: {cert}\n"),
        ),
        (
            "yaml block without secret name",
            "a.yml",
            "description: |\n  A long description of the service.\n".to_owned(),
        ),
        (
            "password flag with variable",
            "run.sh",
            "tool --password \"$DB_PASSWORD\" --host db\n".to_owned(),
        ),
    ] {
        let red = redact_text(
            &text,
            ScanContext {
                file_name: Some(file),
                no_entropy: false,
            },
            PlaceholderStyle::Labelled,
        );
        assert!(red.spans.is_empty(), "{label}: {}", red.text);
    }
}
