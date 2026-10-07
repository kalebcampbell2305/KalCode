//! Version parsing for provider CLIs.
//!
//! Provider `--version` output is free-form text (`2.1.282 (Claude Code)`, `codex-cli 0.155.1`,
//! `0.9.0`). We extract the first `MAJOR.MINOR.PATCH` token and compare numerically; any
//! pre-release and build suffixes are retained for display, and pre-releases follow SemVer
//! precedence rather than being confused with ordinary stable releases.

use std::cmp::Ordering;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// Anything directly attached after the patch number (`-beta.1`, `+abc`), for display only.
    pub suffix: String,
}

impl Version {
    pub const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
            suffix: String::new(),
        }
    }

    /// Parses a bare version such as `2.1.259`. Returns `None` for anything else.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let text = text
            .strip_prefix('v')
            .or_else(|| text.strip_prefix('V'))
            .unwrap_or(text);
        let (version, rest) = take_version(text)?;
        rest.is_empty().then_some(version)
    }

    /// Finds the first `MAJOR.MINOR.PATCH` token anywhere in `output`.
    pub fn find_in(output: &str) -> Option<Self> {
        let bytes = output.as_bytes();
        let mut start = 0;
        while start < bytes.len() {
            let prefixed_by_bare_v = start > 0
                && matches!(bytes[start - 1], b'v' | b'V')
                && (start == 1 || !is_semver_token_char(bytes[start - 2]));
            if bytes[start].is_ascii_digit()
                && (start == 0 || !is_semver_token_char(bytes[start - 1]) || prefixed_by_bare_v)
                && let Some((version, rest)) = take_version(&output[start..])
                && rest
                    .as_bytes()
                    .first()
                    .is_none_or(|byte| !is_semver_token_char(*byte))
            {
                return Some(version);
            }
            start += 1;
        }
        None
    }

    /// SemVer pre-release identifiers without the leading `-`.
    pub fn prerelease(&self) -> Option<&str> {
        self.suffix
            .strip_prefix('-')
            .map(|suffix| suffix.split_once('+').map_or(suffix, |(pre, _)| pre))
    }

    /// SemVer build metadata without the leading `+`.
    pub fn build_metadata(&self) -> Option<&str> {
        self.suffix
            .split_once('+')
            .map(|(_, build)| build)
            .filter(|build| !build.is_empty())
    }

    pub fn is_prerelease(&self) -> bool {
        self.prerelease().is_some()
    }

    fn as_semver(&self) -> semver::Version {
        // Every public constructor and parser creates valid SemVer. Building the value directly
        // keeps comparisons allocation-free while retaining this crate's small display type.
        semver::Version {
            major: self.major,
            minor: self.minor,
            patch: self.patch,
            pre: self
                .prerelease()
                .and_then(|pre| semver::Prerelease::new(pre).ok())
                .unwrap_or(semver::Prerelease::EMPTY),
            build: self
                .build_metadata()
                .and_then(|build| semver::BuildMetadata::new(build).ok())
                .unwrap_or(semver::BuildMetadata::EMPTY),
        }
    }
}

/// Characters that can keep a candidate embedded in an invalid SemVer-shaped token. A bare
/// `v`/`V` prefix is handled explicitly by [`Version::find_in`].
fn is_semver_token_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"._+-".contains(&byte)
}

/// Parses `MAJOR.MINOR.PATCH[suffix]` at the start of `text`, returning the rest after the token.
fn take_version(text: &str) -> Option<(Version, &str)> {
    let mut parts = [0u64; 3];
    let mut rest = text;
    for (index, slot) in parts.iter_mut().enumerate() {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        if digits > 1 && rest.as_bytes().first() == Some(&b'0') {
            return None;
        }
        *slot = rest[..digits].parse().ok()?;
        rest = &rest[digits..];
        if index < 2 {
            rest = rest.strip_prefix('.')?;
        }
    }
    let suffix_len = if rest.starts_with(['-', '+']) {
        rest.bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || b"-+.".contains(b))
            .count()
    } else {
        0
    };
    let (suffix, rest) = rest.split_at(suffix_len);
    let token_len = text.len() - rest.len();
    let parsed = semver::Version::parse(&text[..token_len]).ok()?;
    Some((
        Version {
            major: parsed.major,
            minor: parsed.minor,
            patch: parsed.patch,
            suffix: suffix.to_owned(),
        },
        rest,
    ))
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.as_semver()
            .cmp(&other.as_semver())
            // SemVer precedence ignores build metadata. Complete the total ordering so it stays
            // consistent with this type's exact-value equality.
            .then_with(|| self.suffix.cmp(&other.suffix))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}.{}.{}{}",
            self.major, self.minor, self.patch, self.suffix
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_versions_in_real_cli_output() {
        let cases = [
            ("2.1.282 (Claude Code)", "2.1.282"),
            ("codex-cli 0.155.1", "0.155.1"),
            ("0.9.0\n", "0.9.0"),
            ("gemini v0.12.3-nightly.20260901", "0.12.3-nightly.20260901"),
            ("Version: 10.20.30+build.7 extra", "10.20.30+build.7"),
        ];
        for (output, expected) in cases {
            let found = Version::find_in(output).expect(output);
            assert_eq!(found.to_string(), expected, "{output:?}");
        }
    }

    #[test]
    fn ignores_text_without_a_full_version() {
        for output in [
            "",
            "no version here",
            "1.2",
            "version 3",
            "x1.2.3",
            "dev1.2.3",
            "0.161.0.1",
            "0.161.0alpha",
            "0.161.0-alpha..1",
            "0.161.0-beta_1",
            "0.161.0+build..1",
            "0.161.0+build_1",
            "00.161.0",
            "0.0161.0",
            "0.161.00",
            "999999999999999999999999.1.1",
        ] {
            assert_eq!(Version::find_in(output), None, "{output:?}");
        }
    }

    #[test]
    fn compares_numerically_not_lexically() {
        let v = |s| Version::parse(s).expect(s);
        assert!(v("2.1.282") > v("2.1.259"));
        assert!(v("2.10.0") > v("2.9.99"));
        assert!(v("10.0.0") > v("9.99.99"));
        assert_eq!(v("2.1.259"), v("v2.1.259"));
        assert!(v("2.1.259-beta.1") < v("2.1.259"));
        assert!(v("2.1.259-alpha.16") < v("2.1.259-beta.1"));
        assert!(v("2.1.259-beta.1") < v("2.1.259-rc.1"));
    }

    #[test]
    fn parse_is_strict() {
        assert!(Version::parse("2.1.259").is_some());
        assert!(Version::parse("2.1.259 (Claude Code)").is_none());
        assert!(Version::parse("2.1").is_none());
        assert!(Version::parse("a.b.c").is_none());
        assert!(Version::parse("0.01.0").is_none());
        assert!(Version::parse("vv0.161.0").is_none());
        assert!(Version::parse("0.161.0-alpha..1").is_none());
        assert!(Version::parse("0.161.0-beta_1").is_none());
        assert!(Version::parse("0.161.0+build..1").is_none());
        assert!(Version::parse("0.161.0+build_1").is_none());
    }

    #[test]
    fn semver_prerelease_and_build_metadata_are_distinct() {
        let stable = Version::parse("0.161.0").expect("stable");
        let built = Version::parse("0.161.0+windows.7").expect("stable build");
        let alpha = Version::parse("0.162.0-alpha.16").expect("alpha");
        let beta = Version::parse("0.162.0-beta.1").expect("beta");
        let rc = Version::parse("0.162.0-rc.1").expect("rc");

        assert!(!stable.is_prerelease());
        assert!(!built.is_prerelease(), "build metadata is not a prerelease");
        assert_eq!(alpha.prerelease(), Some("alpha.16"));
        assert_eq!(beta.prerelease(), Some("beta.1"));
        assert_eq!(rc.prerelease(), Some("rc.1"));
        assert_eq!(built.build_metadata(), Some("windows.7"));
    }
}
