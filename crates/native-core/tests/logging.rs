//! Synthetic quoted credentials must be removed in full before logs are written.
#![allow(clippy::expect_used)]

use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use kalcode_core::logging::{MAX_LOG_RECORD_BYTES, RedactingMakeWriter, redact};
use tracing_subscriber::fmt::MakeWriter;

#[test]
fn nested_json_keeps_structure_at_every_encoding_depth() {
    for password in [
        "short SuffixValue987!",
        "short\nNamespace::Tail987!",
        "短い\tSuffix(987)!",
        "short escaped\"quote Tail987!",
    ] {
        let mut input = serde_json::json!({ "password": password, "region": "us" }).to_string();
        for depth in 0..9 {
            let output = redact(&input).into_owned();
            assert_eq!(redact(&output), output, "depth {depth}");
            let mut decoded = output;
            for _ in 0..depth {
                decoded = serde_json::from_str::<String>(&decoded).expect("intact JSON wrapper");
            }
            let value: serde_json::Value =
                serde_json::from_str(&decoded).expect("intact JSON object");
            assert_eq!(value["password"], "[REDACTED]", "depth {depth}");
            assert_eq!(value["region"], "us");
            input = serde_json::to_string(&input).expect("encode wrapper");
        }
    }
}

#[test]
fn quoted_multiline_and_doubled_delimiters_redact_complete_values() {
    for (input, expected) in [
        (
            "password=\"short\nSuffixValue987!\" region=us",
            "password=\"[REDACTED]\n\" region=us",
        ),
        (
            "password='short\r\nSuffixValue987!' region=us",
            "password='[REDACTED]\r\n' region=us",
        ),
        (
            "password=`short SuffixValue987!` region=us",
            "password=`[REDACTED]` region=us",
        ),
        (
            "password='short ''SuffixValue987!'' tail' region=us",
            "password='[REDACTED]' region=us",
        ),
        (
            "password=\"short \"\"SuffixValue987!\"\" tail\" region=us",
            "password=\"[REDACTED]\" region=us",
        ),
    ] {
        assert_eq!(redact(input), expected);
        assert_eq!(redact(expected), expected);
        // JSON wrapper layers must retain the same delimiters and adjacent field.
        let mut input = input.to_owned();
        let mut expected = expected.to_owned();
        // Raw multiline redaction preserves physical line breaks; JSON stores them as
        // escapes inside the value, so the encoded placeholder has no physical breaks.
        expected = expected.replace(['\r', '\n'], "");
        for _ in 0..4 {
            input = serde_json::to_string(&input).expect("encode input");
            expected = serde_json::to_string(&expected).expect("encode expected");
            assert_eq!(redact(&input), expected);
        }
    }
}

#[test]
fn escaped_single_quotes_and_backticks_keep_the_entire_credential_covered() {
    for input in [
        "password='short escaped\\'quote TailValue987!' region=us",
        "password=`short escaped\\`quote TailValue987!` region=us",
    ] {
        let quote = if input.contains('`') { '`' } else { '\'' };
        let mut expected = format!("password={quote}[REDACTED]{quote} region=us");
        let mut input = input.to_owned();
        for _ in 0..5 {
            assert_eq!(redact(&input), expected);
            input = serde_json::to_string(&input).expect("encode input");
            expected = serde_json::to_string(&expected).expect("encode expected");
        }
    }
}

#[test]
fn json_envelopes_survive_truncated_or_ambiguous_inner_quotes() {
    for message in [
        "password='short ending\\' region=us",
        "password=`short ending\\` region=us",
        "password='short SuffixValue987!",
        "password=`short SuffixValue987!",
        "password='short\nNamespace::Tail987!' region=us",
        "password=`short\nNamespace::Tail987!` region=us",
        "password='short contains \"double\" SuffixValue987!' region=us",
    ] {
        let mut input = serde_json::json!({ "message": message, "region": "jp" }).to_string();
        for depth in 0..5 {
            let output = redact(&input).into_owned();
            assert_eq!(redact(&output), output);
            assert!(!output.contains("SuffixValue987!"));
            assert!(!output.contains("Namespace::Tail987!"));
            let mut decoded = output;
            for _ in 0..depth {
                decoded = serde_json::from_str(&decoded).expect("intact wrapper");
            }
            let value: serde_json::Value =
                serde_json::from_str(&decoded).expect("intact outer JSON");
            assert_eq!(value["region"], "jp");
            assert!(
                value["message"]
                    .as_str()
                    .expect("message")
                    .contains("[REDACTED]")
            );
            input = serde_json::to_string(&input).expect("encode layer");
        }
    }
}

#[test]
fn json_mapping_preserves_unicode_escapes_and_merges_overlapping_detectors() {
    use kalcode_core::redact::secrets::{ScanContext, scan_with};
    for payload in [
        r"short \uD83D\uDD10 SuffixValue987!",
        r"\u77ed\u3044\tNamespace::Tail987!",
        r"short ghp_abcdefghijklmnopqrstuvwxyz0123456789 suffix",
        "短い 合成パスワード🔐",
    ] {
        let input =
            format!(r#"{{"message":"\uD83D\uDD10 password='{payload}'","region":"\u65e5\u672c"}}"#);
        let expected =
            r#"{"message":"\uD83D\uDD10 password='[REDACTED]'","region":"\u65e5\u672c"}"#;
        assert_eq!(redact(&input), expected);
        assert_eq!(redact(expected), expected);
        let findings = scan_with(
            &input,
            ScanContext {
                no_entropy: true,
                file_name: None,
            },
        );
        assert_eq!(
            findings.len(),
            1,
            "overlapping assignments and format findings merge"
        );
        assert_eq!(&input[findings[0].start..findings[0].end], payload);
        let parsed: serde_json::Value = serde_json::from_str(expected).expect("intact JSON");
        assert_eq!(parsed["region"], "日本");
    }
}

#[test]
fn malformed_json_uses_the_raw_scanner_without_panicking() {
    for input in [
        r#"{"password":"short SuffixValue987!""#,
        r#"{"message":"password=\"short SuffixValue987!"#,
        r#"{"password":"short SuffixValue987!","other":"\ud800"}"#,
        r#"{"password":"short SuffixValue987!","other":"\q"}"#,
    ] {
        let output = redact(input);
        assert!(!output.contains("SuffixValue987!"));
        assert!(output.contains("[REDACTED]"));
    }
}

#[test]
fn tracing_json_sink_keeps_envelopes_around_ambiguous_fragments() {
    let output = Buffer::default();
    let sink = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_writer(RedactingMakeWriter::new(move || sink.clone()))
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        for message in [
            "password='short ending\\' region=us",
            "password=`short escaped\\`quote TailValue987!` region=us",
            "password='short escaped\\'quote TailValue987!' region=us",
        ] {
            let mut body = message.to_owned();
            for _ in 0..4 {
                tracing::info!(body = %body, region = "us");
                body = serde_json::to_string(&body).expect("encode body");
            }
        }
    });
    let bytes = output.0.lock().expect("buffer").clone();
    let output = String::from_utf8(bytes).expect("UTF-8");
    assert_eq!(output.lines().count(), 12);
    assert!(!output.contains("TailValue987!"));
    assert!(!output.contains("ending"));
    for (index, line) in output.lines().enumerate() {
        let parsed: serde_json::Value = serde_json::from_str(line).expect("intact log JSON");
        assert_eq!(parsed["fields"]["region"], "us");
        let mut body = parsed["fields"]["body"].as_str().expect("body").to_owned();
        for _ in 0..index % 4 {
            body = serde_json::from_str(&body).expect("intact body wrapper");
        }
        assert!(body.contains("[REDACTED]"));
    }
}

#[test]
fn malformed_quote_runs_never_create_invalid_secret_spans() {
    use kalcode_core::redact::secrets::{ScanContext, scan_with};
    for opening_slashes in 0..16 {
        for closing_slashes in 0..16 {
            for quote in ['\'', '"', '`'] {
                for value in ["x", "短い synthetic suffix", "\n", "[REDACTED]"] {
                    let input = format!(
                        "password={}{quote}{value}{}{quote} region=us",
                        "\\".repeat(opening_slashes),
                        "\\".repeat(closing_slashes)
                    );
                    for finding in scan_with(
                        &input,
                        ScanContext {
                            no_entropy: true,
                            file_name: None,
                        },
                    ) {
                        assert!(finding.start <= finding.end);
                        assert!(input.get(finding.start..finding.end).is_some());
                    }
                    let _ = redact(&input);
                }
            }
        }
    }
}

#[test]
fn writer_redacts_a_complete_record_across_every_byte_boundary() {
    let input = "password=\"short\nSuffixValue987!\" region=日本\n";
    for split in 0..=input.len() {
        let output = Buffer::default();
        let sink = output.clone();
        let make = RedactingMakeWriter::new(move || sink.clone());
        {
            let mut writer = make.make_writer();
            writer
                .write_all(&input.as_bytes()[..split])
                .expect("write prefix");
            writer
                .write_all(&input.as_bytes()[split..])
                .expect("write suffix");
        }
        let bytes = output.0.lock().expect("buffer lock").clone();
        assert_eq!(
            String::from_utf8(bytes).expect("intact UTF-8"),
            redact(input),
            "split {split}"
        );
    }
}

#[test]
fn writer_flush_ends_records_without_repeating_them_on_drop() {
    let output = Buffer::default();
    let sink = output.clone();
    let make = RedactingMakeWriter::new(move || sink.clone());
    {
        let mut writer = make.make_writer();
        for chunk in b"password=\"short SuffixValue987!\" region=us\n".chunks(1) {
            writer.write_all(chunk).expect("write byte");
        }
        assert!(
            output.0.lock().expect("buffer").is_empty(),
            "no raw prefix leaves writer"
        );
        writer.flush().expect("flush first record");
        writer.flush().expect("empty flush");
        writer
            .write_all(b"password=\"second OtherSuffix987!\" region=jp\n")
            .expect("second record");
    }
    let bytes = output.0.lock().expect("buffer").clone();
    assert_eq!(
        String::from_utf8(bytes).expect("UTF-8"),
        "password=\"[REDACTED]\" region=us\npassword=\"[REDACTED]\" region=jp\n"
    );
}

#[test]
fn oversized_record_fails_closed_without_poisoning_later_records() {
    let output = Buffer::default();
    let sink = output.clone();
    let make = RedactingMakeWriter::new(move || sink.clone());
    {
        let mut writer = make.make_writer();
        writer
            .write_all(b"password=\"short SuffixValue987!")
            .expect("buffer prefix");
        let error = writer
            .write_all(&vec![b'a'; MAX_LOG_RECORD_BYTES])
            .expect_err("reject oversized record");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(writer.flush().is_err());
        assert!(writer.write_all(b"\"\n").is_err());
    }
    assert!(
        output.0.lock().expect("buffer").is_empty(),
        "oversized record never reaches sink"
    );
    {
        let mut writer = make.make_writer();
        writer
            .write_all(b"region=us\n")
            .expect("new record remains usable");
    }
    assert_eq!(*output.0.lock().expect("buffer"), b"region=us\n");
}

#[test]
fn writer_does_not_retry_a_partially_failed_sink_on_drop() {
    struct FailsAfterPrefix(Buffer);
    impl Write for FailsAfterPrefix {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let mut buffer = self.0.0.lock().expect("buffer");
            if !buffer.is_empty() {
                return Err(io::Error::other("synthetic sink failure"));
            }
            let len = bytes.len().min(6);
            buffer.extend_from_slice(&bytes[..len]);
            Ok(len)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let output = Buffer::default();
    let sink = output.clone();
    let make = RedactingMakeWriter::new(move || FailsAfterPrefix(sink.clone()));
    {
        let mut writer = make.make_writer();
        writer
            .write_all(b"password=\"short SuffixValue987!\"\n")
            .expect("buffer record");
        assert!(writer.flush().is_err());
        assert!(writer.write_all(b"ignored").is_err());
    }
    assert_eq!(*output.0.lock().expect("buffer"), b"passwo");
}

#[test]
fn tracing_json_sink_redacts_nested_json_strings() {
    let output = Buffer::default();
    let sink = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_writer(RedactingMakeWriter::new(move || sink.clone()))
        .finish();
    let mut body =
        serde_json::json!({ "password": "short\nNamespace::Tail987!", "region": "us" }).to_string();
    tracing::subscriber::with_default(subscriber, || {
        for _ in 0..8 {
            tracing::info!(body = %body, region = "us");
            body = serde_json::to_string(&body).expect("encode body");
        }
    });
    let bytes = output.0.lock().expect("buffer lock").clone();
    let output = String::from_utf8(bytes).expect("UTF-8 output");
    assert_eq!(output.lines().count(), 8);
    for (depth, line) in output.lines().enumerate() {
        let value: serde_json::Value = serde_json::from_str(line).expect("valid log JSON");
        assert_eq!(value["fields"]["region"], "us");
        let mut body = value["fields"]["body"]
            .as_str()
            .expect("body string")
            .to_owned();
        for _ in 0..depth {
            body = serde_json::from_str(&body).expect("intact wrapper");
        }
        let body: serde_json::Value = serde_json::from_str(&body).expect("intact body");
        assert_eq!(body["password"], "[REDACTED]");
        assert_eq!(body["region"], "us");
    }
}

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
