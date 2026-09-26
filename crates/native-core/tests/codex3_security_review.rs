//! Independent, synthetic-only probes of the immutable security repair candidate.
use kalcode_core::logging::{MAX_LOG_RECORD_BYTES, RedactingMakeWriter, redact};
use std::io::Write;
use std::sync::{Arc, Mutex};
use tracing_subscriber::fmt::MakeWriter;

#[test]
fn json_escaped_sensitive_key_is_not_a_detection_bypass() {
    for key in [r"pass\u0077ord", r"api_\u006bey", r"refresh_\u0074oken"] {
        let input = format!(r#"{{"{key}":"synthetic first ReviewSuffix987!","region":"us"}}"#);
        let output = redact(&input);
        assert!(
            !output.contains("ReviewSuffix987!"),
            "escaped sensitive JSON key bypassed detection: {key}"
        );
        let decoded: serde_json::Value = serde_json::from_str(&output).expect("JSON stays valid");
        assert_eq!(decoded["region"], "us");
    }
}

#[test]
fn encoded_keys_work_at_each_letter_and_inside_nested_envelopes() {
    for name in ["password", "api_key", "refresh_token"] {
        for (at, byte) in name.bytes().enumerate() {
            let key = format!("{}\\u{:04x}{}", &name[..at], byte, &name[at + 1..]);
            for depth in 0..=4 {
                let mut input =
                    format!(r#"{{"{key}":"synthetic 日本 ReviewSuffix987!","region":"us"}}"#);
                for _ in 0..depth {
                    input = serde_json::to_string(&input).expect("encode");
                }
                let output = redact(&input);
                assert!(
                    !output.contains("ReviewSuffix987!"),
                    "key {name}, letter {at}, depth {depth}"
                );
                let mut decoded = output.into_owned();
                for _ in 0..depth {
                    decoded = serde_json::from_str(&decoded).expect("valid wrapper");
                }
                let value: serde_json::Value =
                    serde_json::from_str(&decoded).expect("valid object");
                assert_eq!(value[name], "[REDACTED]");
                assert_eq!(value["region"], "us");
            }
        }
    }
}

#[test]
fn encoded_key_detection_preserves_placeholders_and_ordinary_fields() {
    for input in [
        r#"{"pass\u0077ord":"${PASSWORD}","region":"us"}"#,
        r#"{"pass\u0077ord":"[REDACTED]","region":"us"}"#,
        r#"{"reg\u0069on":"synthetic value with spaces"}"#,
        r#"["pass\u0077ord","ordinary adjacent array value"]"#,
        r#"{"pass\u0077ord":{"region":"ordinary nested value"}}"#,
    ] {
        assert_eq!(redact(input), input);
    }
}

#[test]
fn nested_unicode_values_remain_redacted_and_keep_neighboring_fields() {
    for secret in [
        "synthetic \"quote ReviewSuffix987!",
        "synthetic 日本 🔐 ReviewSuffix987!",
        "synthetic\r\nReviewSuffix987!",
    ] {
        for depth in 0..=6 {
            let mut input = serde_json::json!({"password": secret, "region": "us"}).to_string();
            for _ in 0..depth {
                input = serde_json::to_string(&input).expect("encode");
            }
            let output = redact(&input);
            assert!(
                !output.contains("ReviewSuffix987!"),
                "credential leaked at depth {depth}"
            );
            let mut decoded = output.into_owned();
            for _ in 0..depth {
                decoded = serde_json::from_str(&decoded).expect("wrapper stays valid");
            }
            let value: serde_json::Value =
                serde_json::from_str(&decoded).expect("object stays valid");
            assert_eq!(value["password"], "[REDACTED]");
            assert_eq!(value["region"], "us");
        }
    }
}

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);
impl Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("lock").extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn exact_record_limit_is_accepted_and_next_record_still_works() {
    let sink = Sink::default();
    let output = sink.clone();
    let make = RedactingMakeWriter::new(move || sink.clone());
    let mut record = b"password=\"synthetic ReviewSuffix987!\" ".to_vec();
    record.resize(MAX_LOG_RECORD_BYTES, b'.');
    {
        let mut writer = make.make_writer();
        for chunk in record.chunks(7) {
            writer.write_all(chunk).expect("bounded write");
        }
        writer.flush().expect("flush boundary record");
        writer.write_all(b"\nregion=us\n").expect("next record");
    }
    let bytes = output.0.lock().expect("lock");
    let text = std::str::from_utf8(&bytes).expect("UTF-8");
    assert!(!text.contains("ReviewSuffix987!"));
    assert!(text.ends_with("\nregion=us\n"));
    assert_eq!(text.matches("[REDACTED]").count(), 1);
}
