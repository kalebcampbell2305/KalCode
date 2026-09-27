use crate::account;

use account::api::ApiError;
use account::social::{
    SocialCallback, SocialProvider, parse_social_callback, validate_social_authorize_url,
};

const STATE: &str = "sssssssssssssssssssssssssssssssssssssssssss";
const NONCE: &str = "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn";
const CHALLENGE: &str = "ccccccccccccccccccccccccccccccccccccccccccc";

#[test]
fn callback_parser_accepts_only_exact_provider_bound_shapes_and_redacts_payloads() {
    let success = parse_social_callback(&format!(
        "kalcode://auth/google?code=one-use-code&state={STATE}"
    ))
    .expect("valid success");
    assert!(matches!(
        success,
        SocialCallback::Success {
            provider: SocialProvider::Google,
            ..
        }
    ));
    let rendered = format!("{success:?}");
    assert!(!rendered.contains("one-use-code"));
    assert!(!rendered.contains(STATE));

    assert!(matches!(
        parse_social_callback(&format!(
            "kalcode://auth/microsoft?error=sign_in_canceled&state={STATE}"
        )),
        Ok(SocialCallback::Canceled {
            provider: SocialProvider::Microsoft,
            ..
        })
    ));
    assert!(matches!(
        parse_social_callback(&format!(
            "kalcode://auth/google?error=sign_in_failed&state={STATE}"
        )),
        Ok(SocialCallback::Failed { .. })
    ));
}

#[test]
fn callback_parser_rejects_unknown_duplicate_credential_and_ambiguous_payloads() {
    for raw in [
        format!("https://auth/google?code=code&state={STATE}"),
        format!("kalcode://evil/google?code=code&state={STATE}"),
        format!("kalcode://user@auth/google?code=code&state={STATE}"),
        format!("kalcode://auth/github?code=code&state={STATE}"),
        format!("kalcode://auth/google/extra?code=code&state={STATE}"),
        format!("kalcode://auth/google?code=code&state={STATE}&extra=x"),
        format!("kalcode://auth/google?code=one&code=two&state={STATE}"),
        format!("kalcode://auth/google?code=code&state={STATE}&error=sign_in_failed"),
        format!("kalcode://auth/google?error=access_denied&state={STATE}"),
        format!("kalcode://auth/google?token=bearer&state={STATE}"),
        "kalcode://auth/google?code=code&state=short".into(),
    ] {
        assert!(
            parse_social_callback(&raw).is_err(),
            "must reject callback shape"
        );
    }
}

fn authorize_url(provider: SocialProvider) -> String {
    let (base, response_mode) = match provider {
        SocialProvider::Google => ("https://accounts.google.com/o/oauth2/v2/auth", ""),
        SocialProvider::Microsoft => (
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            "&response_mode=query",
        ),
    };
    format!(
        "{base}?client_id=client&redirect_uri={}&response_type=code&scope=openid%20email&state={STATE}&nonce={NONCE}&code_challenge={CHALLENGE}&code_challenge_method=S256&prompt=select_account{response_mode}",
        url::form_urlencoded::byte_serialize(provider.callback_url().as_bytes())
            .collect::<String>()
    )
}

#[test]
fn authorize_url_is_exact_provider_pkce_nonce_and_callback_bound() {
    for provider in [SocialProvider::Google, SocialProvider::Microsoft] {
        assert_eq!(
            validate_social_authorize_url(&authorize_url(provider), provider, CHALLENGE, NONCE),
            Ok(STATE.into())
        );
    }
}

#[test]
fn authorize_url_rejects_open_redirects_tampering_and_extra_parameters() {
    let valid = authorize_url(SocialProvider::Google);
    for unsafe_url in [
        valid.replacen("accounts.google.com", "attacker.example", 1),
        valid.replacen(CHALLENGE, STATE, 1),
        valid.replacen(NONCE, STATE, 1),
        valid.replace("&prompt=select_account", ""),
        valid.replace("prompt=select_account", "prompt=consent"),
        format!("{valid}&prompt=select_account"),
        format!("{valid}&access_type=offline"),
        valid.replacen(
            "https%3A%2F%2Fapi.kalcoded.com",
            "https%3A%2F%2Fattacker.example",
            1,
        ),
    ] {
        assert_eq!(
            validate_social_authorize_url(&unsafe_url, SocialProvider::Google, CHALLENGE, NONCE),
            Err(ApiError::InvalidResponse)
        );
    }
}
