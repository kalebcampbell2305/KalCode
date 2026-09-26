use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::PathBuf;

use super::*;

fn valid_spec() -> GuardedWorkerSpec {
    #[cfg(windows)]
    let (executable, current_dir) = (
        PathBuf::from(r"C:\KalCode\runtime\llama-server.exe"),
        PathBuf::from(r"C:\KalCode\runtime"),
    );
    #[cfg(not(windows))]
    let (executable, current_dir) = (
        PathBuf::from("/Applications/KalCode.app/Contents/Resources/llama/llama-server"),
        PathBuf::from("/Applications/KalCode.app/Contents/Resources/llama"),
    );
    let mut environment = BTreeMap::new();
    environment.insert(
        OsString::from("LLAMA_API_KEY"),
        OsString::from("redacted-fixture"),
    );
    #[cfg(windows)]
    environment.insert(OsString::from("SystemRoot"), OsString::from(r"C:\Windows"));
    GuardedWorkerSpec {
        executable,
        current_dir,
        args: vec![OsString::from("--offline")],
        environment,
        endpoint: SocketAddrV4::new(Ipv4Addr::LOCALHOST, 41_337),
    }
}

#[test]
fn accepts_only_absolute_loopback_reasoner_specs() {
    assert_eq!(valid_spec().validate(), Ok(()));

    let mut candidate = valid_spec();
    candidate.endpoint = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 41_337);
    assert_eq!(
        candidate.validate(),
        Err(GuardedWorkerError::InvalidSpecification)
    );

    let mut candidate = valid_spec();
    candidate.executable = PathBuf::from("llama-server");
    assert_eq!(
        candidate.validate(),
        Err(GuardedWorkerError::InvalidSpecification)
    );
}

#[test]
fn rejects_inherited_or_provider_environment_authority() {
    for forbidden in [
        "PATH",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
    ] {
        let mut candidate = valid_spec();
        candidate
            .environment
            .insert(OsString::from(forbidden), OsString::from("must-not-cross"));
        assert_eq!(
            candidate.validate(),
            Err(GuardedWorkerError::InvalidSpecification),
            "accepted {forbidden}"
        );
    }
}

#[test]
fn debug_output_redacts_environment_values() {
    let output = format!("{:?}", valid_spec());
    assert!(output.contains("LLAMA_API_KEY"));
    assert!(!output.contains("redacted-fixture"));
}
