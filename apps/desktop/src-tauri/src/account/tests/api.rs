#![allow(dead_code)]

use crate::account;

use std::time::Duration;

use account::api::{
    API_ORIGIN, BrowserDestination, PkcePair, RetryClass, retry_delay, validate_browser_destination,
};

#[test]
fn production_origin_and_generated_pkce_are_fixed_and_secret_safe() {
    assert_eq!(API_ORIGIN, "https://api.kalcoded.com");
    let pair = PkcePair::generate().expect("OS randomness");
    assert_eq!(pair.expose_verifier().len(), 43);
    assert_eq!(pair.challenge().len(), 43);
    assert_ne!(pair.expose_verifier(), pair.challenge());
    assert_eq!(format!("{pair:?}"), "PkcePair([REDACTED])");
}

#[test]
fn pkce_s256_matches_the_rfc7636_vector_without_padding() {
    let pair = PkcePair::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".to_owned())
        .expect("valid verifier");
    assert_eq!(
        pair.challenge(),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    assert_eq!(pair.expose_verifier().len(), 43);
    assert!(!pair.challenge().contains('='));
    assert_eq!(format!("{pair:?}"), "PkcePair([REDACTED])");
}

#[test]
fn browser_destinations_are_https_and_exact_host_bound() {
    assert_eq!(
        validate_browser_destination("https://checkout.stripe.com/c/pay/session"),
        Ok(BrowserDestination::Checkout)
    );
    assert_eq!(
        validate_browser_destination("https://billing.stripe.com/p/session"),
        Ok(BrowserDestination::Portal)
    );
    for unsafe_url in [
        "http://checkout.stripe.com/c/pay/session",
        "https://checkout.stripe.com.evil.test/c/pay/session",
        "https://user@checkout.stripe.com/c/pay/session",
        "https://checkout.stripe.com:444/c/pay/session",
        "javascript:alert(1)",
    ] {
        assert!(
            validate_browser_destination(unsafe_url).is_err(),
            "{unsafe_url} must be rejected"
        );
    }
}

#[test]
fn retry_waits_are_bounded_and_unsafe_requests_do_not_retry() {
    assert_eq!(
        retry_delay(RetryClass::Read, 0, Some(2)),
        Some(Duration::from_secs(2))
    );
    assert_eq!(
        retry_delay(RetryClass::Read, 1, Some(999)),
        Some(Duration::from_secs(15))
    );
    assert_eq!(retry_delay(RetryClass::CheckoutSameRequest, 2, None), None);
    assert_eq!(retry_delay(RetryClass::EmailSend, 0, Some(1)), None);
    assert_eq!(retry_delay(RetryClass::Read, 2, Some(1)), None);
}
