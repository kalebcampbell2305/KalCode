//! Synthetic quoted credentials must be removed in full before logs are written.
#![allow(clippy::expect_used)]

use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use kalcode_core::logging::{RedactingMakeWriter, redact};

const SENSITIVE_NAMES: &[&str] = &[
    "secret",
    "password",
    "passwd",
    "pwd",
    "passphrase",
    "credential",
    "credentials",
    "private_key",
    "privatekey",
    "api_key",
    "apikey",
    "api-key",
    "access_key",
    "accesskey",
    "auth_token",
    "authtoken",
    "access_token",
    "refresh_token",
];

#[test]
fn quoted_assignments_redact_the_entire_value() {
    for (input, expected) in [
        (
            "password=\"correct horse battery staple\" region=us",
            "password=\"[REDACTED]\" region=us",
        ),
        (
            "password='short SuffixValue987!' region=us",
            "password='[REDACTED]' region=us",
        ),
        (
            "password=\"短い 合成パスワード🔐\" region=us",
            "password=\"[REDACTED]\" region=us",
        ),
        (
            r#"password="short escaped\"quote TailValue987!" region=us"#,
            r#"password="[REDACTED]" region=us"#,
        ),
        (
            r#"password=\"short escaped\\\"quote TailValue987!\" region=us"#,
            r#"password=\"[REDACTED]\" region=us"#,
        ),
    ] {
        let result = redact(input);
        assert_eq!(result, expected);
        assert_eq!(redact(&result), result, "redaction stays idempotent");
    }
}

#[test]
fn json_password_values_preserve_neighboring_fields() {
    for password in [
        "correct horse battery staple",
        "short SuffixValue987!",
        "short escaped\"quote TailValue987!",
        "short ending\\",
        "短い 合成パスワード🔐",
    ] {
        for name in SENSITIVE_NAMES {
            let input = serde_json::json!({ (*name): password, "region": "us", "attempt": 2 });
            let output = redact(&input.to_string()).into_owned();
            let value: serde_json::Value =
                serde_json::from_str(&output).expect("valid redacted JSON");
            assert_eq!(value[*name], "[REDACTED]");
            assert_eq!(value["region"], "us");
            assert_eq!(value["attempt"], 2);
        }
    }
}

#[test]
fn quoted_placeholder_and_ordinary_fields_remain_unchanged() {
    for input in [
        r#"password="${DB_PASSWORD}" region=us"#,
        r#"password="${ DB_PASSWORD }" region=us"#,
        r#"password="{{ DB_PASSWORD }}" region=us"#,
        r#"token="MAX_RETRY_ATTEMPTS" region=us"#,
        r#"password="[REDACTED]" region=us"#,
        r#"message="ordinary quoted words" region=us"#,
        r#"password="short" region=us"#,
        r#"password="env::PASSWORD" region=us"#,
        r#"password="get_password()" region=us"#,
        r#"password="short\\nNamespace::Tail987!" region=us"#,
        r#"password="short\\u0020Namespace::Tail987!" region=us"#,
    ] {
        assert_eq!(redact(input), input);
    }
}

#[test]
fn punctuation_inside_a_quoted_passphrase_is_not_a_code_reference() {
    for password in [
        "short Suffix(987)! tail",
        "short Namespace::Tail987! words",
        "${DB_PASSWORD} SuffixValue987! words",
        "$reference SuffixValue987! words",
    ] {
        let input = serde_json::json!({ "password": password, "region": "us" }).to_string();
        let value: serde_json::Value = serde_json::from_str(&redact(&input)).expect("valid JSON");
        assert_eq!(value["password"], "[REDACTED]");
        assert_eq!(value["region"], "us");
    }
}

#[test]
fn json_encoded_whitespace_does_not_hide_quoted_credentials() {
    for password in [
        "short\nSuffix(987)!",
        "short\tNamespace::Tail987!",
        "short\rSuffix(987)!",
        "short\u{000c}Suffix(987)!",
        "short\u{000b}Namespace::Tail987!",
        "短い\nSuffix(987)!",
    ] {
        let input = serde_json::json!({ "password": password, "region": "us" }).to_string();
        let output = redact(&input).into_owned();
        let value: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");
        assert_eq!(value["password"], "[REDACTED]", "input: {input}");
        assert_eq!(value["region"], "us");
        assert_eq!(redact(&output), output);
    }
    // JSON serializers can also encode non-ASCII whitespace explicitly.
    for escape in [r"\u0020", r"\u00a0", r"\u2003", r"\u2028", r"\u2029"] {
        let input = format!(r#"{{"password":"short{escape}Suffix(987)!","region":"us"}}"#);
        let output = redact(&input).into_owned();
        let value: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");
        assert_eq!(value["password"], "[REDACTED]", "input: {input}");
        assert_eq!(value["region"], "us");
    }
}

#[test]
fn tracing_json_sink_redacts_encoded_whitespace_credentials() {
    let output = Buffer::default();
    let sink = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_writer(RedactingMakeWriter::new(move || sink.clone()))
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        for password in [
            "short\nSuffix(987)!",
            "short\tNamespace::Tail987!",
            "short\u{000b}Namespace::Tail987!",
            "short\0\nSuffix(987)!",
            "short\u{001b}\tNamespace::Tail987!",
        ] {
            tracing::info!(password = %password, region = "us");
            tracing::info!(password = ?password, region = "us");
            let body = serde_json::json!({ "password": password, "region": "us" });
            tracing::info!(body = %body, region = "us");
        }
    });
    let bytes = output.0.lock().expect("buffer lock").clone();
    let output = String::from_utf8(bytes).expect("UTF-8 log output");
    assert!(!output.contains("Suffix(987)!"), "{output}");
    assert!(!output.contains("Namespace::Tail987!"), "{output}");
    assert!(!output.contains("short"), "{output}");
    assert_eq!(output.lines().count(), 15);
    for line in output.lines() {
        let value: serde_json::Value = serde_json::from_str(line).expect("valid JSON log");
        assert!(line.contains("[REDACTED]"));
        assert_eq!(value["fields"]["region"], "us");
        if let Some(body) = value["fields"]["body"].as_str() {
            let nested: serde_json::Value = serde_json::from_str(body).expect("valid nested JSON");
            assert_eq!(nested["password"], "[REDACTED]");
            assert_eq!(nested["region"], "us");
        }
    }
}

#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("buffer lock").extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn tracing_json_sink_never_writes_quoted_secret_suffixes() {
    let output = Buffer::default();
    let sink = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_writer(RedactingMakeWriter::new(move || sink.clone()))
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(password = %"short SuffixValue987!", region = "us");
        tracing::info!(password = ?"short escaped\"quote TailValue987!", region = "us");
        tracing::info!(r#"connecting password="short SuffixValue987!" region=us"#);
        for name in SENSITIVE_NAMES {
            let body = serde_json::json!({ (*name): "short SuffixValue987!\\", "region": "us" });
            tracing::info!(body = %body, region = "us");
        }
    });
    let bytes = output.0.lock().expect("buffer lock").clone();
    let output = String::from_utf8(bytes).expect("UTF-8 log output");
    assert!(!output.contains("SuffixValue987!"));
    assert!(!output.contains("TailValue987!"));
    assert!(!output.contains("short"));
    assert_eq!(output.lines().count(), 3 + SENSITIVE_NAMES.len());
    for line in output.lines() {
        let value: serde_json::Value = serde_json::from_str(line).expect("valid JSON log");
        assert!(line.contains("[REDACTED]"));
        assert!(value["fields"].to_string().contains("us"));
        if let Some(body) = value["fields"]["body"].as_str() {
            let nested: serde_json::Value = serde_json::from_str(body).expect("valid nested JSON");
            assert_eq!(nested["region"], "us");
        }
    }
}
