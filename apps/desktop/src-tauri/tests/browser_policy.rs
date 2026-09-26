#[allow(dead_code)]
#[path = "../src/browser_policy.rs"]
mod browser_policy;

use browser_policy::{BrowserBounds, normalize_browser_url, validate_bounds, validate_browser_id};

#[test]
fn normalizes_development_and_public_addresses() {
    for (input, expected) in [
        ("localhost:3000", "http://localhost:3000/"),
        ("127.0.0.1:5173/docs", "http://127.0.0.1:5173/docs"),
        ("[::1]:8000", "http://[::1]:8000/"),
        ("kalcoded.com/docs", "https://kalcoded.com/docs"),
        (
            " HTTPS://EXAMPLE.COM/a?b=c#d ",
            "https://example.com/a?b=c#d",
        ),
    ] {
        assert_eq!(normalize_browser_url(input).unwrap().as_str(), expected);
    }
}

#[test]
fn rejects_privileged_or_ambiguous_addresses() {
    for input in [
        "",
        "file:///C:/private.txt",
        "javascript:alert(1)",
        "data:text/html,hello",
        "blob:https://example.com/id",
        "about:blank",
        "https://user:password@example.com",
        "https://example.com/line\nbreak",
        "http://",
    ] {
        assert!(normalize_browser_url(input).is_err(), "accepted {input:?}");
    }
    let too_long = format!("https://{}.com", "a".repeat(2048));
    assert!(normalize_browser_url(&too_long).is_err());
}

#[test]
fn validates_canonical_browser_ids_and_bounded_logical_geometry() {
    assert!(validate_browser_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
    for bad in [
        "",
        "../browser",
        "browser id",
        "550e8400_e29b_41d4_a716_446655440000",
    ] {
        assert!(validate_browser_id(bad).is_err(), "accepted {bad:?}");
    }

    assert!(
        validate_bounds(BrowserBounds {
            x: 180.0,
            y: 96.0,
            width: 900.0,
            height: 600.0,
        })
        .is_ok()
    );
    for bad in [
        BrowserBounds {
            x: -1.0,
            y: 0.0,
            width: 500.0,
            height: 500.0,
        },
        BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 500.0,
        },
        BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: f64::NAN,
            height: 500.0,
        },
        BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 20_000.0,
            height: 500.0,
        },
    ] {
        assert!(validate_bounds(bad).is_err(), "accepted {bad:?}");
    }
}
