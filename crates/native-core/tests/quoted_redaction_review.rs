use kalcode_core::logging::redact;
#[test]
fn nested_json_credential_suffix_is_redacted() {
    let mut input = serde_json::json!({"password": "synthetic alpha omega sentinel"}).to_string();
    for _ in 0..3 {
        input = serde_json::to_string(&input).expect("encode synthetic fixture");
    }
    assert!(
        !redact(&input).contains("omega sentinel"),
        "nested encoded credential suffix leaked"
    );
}
#[test]
fn multiline_credential_suffix_is_redacted() {
    let input = "password=\"synthetic alpha\nomega sentinel\" region=us";
    assert!(
        !redact(input).contains("omega sentinel"),
        "multiline credential suffix leaked"
    );
}
