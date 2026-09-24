//! Version parsing for provider CLIs.
//!
//! Provider `--version` output is free-form text (`2.1.282 (Claude Code)`, `codex-cli 0.155.1`,
//! `0.9.0`). We extract the first `MAJOR.MINOR.PATCH` token and compare numerically; any
//! pre-release or build suffix is kept for display but ignored for ordering, so a pre-release of
//! the minimum version counts as meeting it.

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
        let text = text.trim().trim_start_matches(['v', 'V']);
        let (version, rest) = take_version(text)?;
        rest.is_empty().then_some(version)
    }

    /// Finds the first `MAJOR.MINOR.PATCH` token anywhere in `output`.
    pub fn find_in(output: &str) -> Option<Self> {
        let bytes = output.as_bytes();
        let mut start = 0;
        while start < bytes.len() {
            if bytes[start].is_ascii_digit()
                && (start == 0 || !is_token_char(bytes[start - 1]))
                && let Some((version, _)) = take_version(&output[start..])
            {
                return Some(version);
            }
            start += 1;
        }
        None
    }

    fn numeric(&self) -> (u64, u64, u64) {
        (self.major, self.minor, self.patch)
    }
}

/// A letter or dot directly before a digit means we're inside another token (`x1.2.3`, `1.2.3.4`
/// is still found at its start). `v1.2.3` is allowed.
fn is_token_char(byte: u8) -> bool {
    (byte.is_ascii_alphanumeric() && byte != b'v' && byte != b'V') || byte == b'.'
}

/// Parses `MAJOR.MINOR.PATCH[suffix]` at the start of `text`, returning the rest after the token.
fn take_version(text: &str) -> Option<(Version, &str)> {
    let mut parts = [0u64; 3];
    let mut rest = text;
    for (index, slot) in parts.iter_mut().enumerate() {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || digits > 9 {
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
    Some((
        Version {
            major: parts[0],
            minor: parts[1],
            patch: parts[2],
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
        self.numeric().cmp(&other.numeric())
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
            "99999999999.1.1",
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
        // A pre-release of the minimum is treated as meeting it (ordering ignores the suffix).
        assert_eq!(
            v("2.1.259-beta.1").cmp(&v("2.1.259")),
            std::cmp::Ordering::Equal
        );
    }

    #[test]
    fn parse_is_strict() {
        assert!(Version::parse("2.1.259").is_some());
        assert!(Version::parse("2.1.259 (Claude Code)").is_none());
        assert!(Version::parse("2.1").is_none());
        assert!(Version::parse("a.b.c").is_none());
    }
}
