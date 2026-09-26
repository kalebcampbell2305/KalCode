//! The Regex Lab's native engine: Rust's `regex` crate, which matches in time linear in the input
//! for every pattern — there is no backtracking, so no pattern can hang KalCode. Compiled
//! programs are size-limited, the sample is capped, and at most [`MAX_MATCHES`] matches are
//! reported. (The Lab's JavaScript engine runs in a Web Worker with a time budget instead.)

use std::time::Instant;

use regex::RegexBuilder;

use crate::types::{RegexError, RegexFlags, RegexGroup, RegexMatch, RegexResult};

pub const MAX_PATTERN_BYTES: usize = 16 * 1024;
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_MATCHES: usize = 1_000;
/// Compiled program and lazy-DFA cache limits.
const SIZE_LIMIT: usize = 8 * 1024 * 1024;
const DFA_SIZE_LIMIT: usize = 8 * 1024 * 1024;

/// Converts increasing byte offsets of one text to UTF-16 offsets (JavaScript indexes strings by
/// UTF-16 units) in one forward pass.
struct Utf16Cursor<'t> {
    text: &'t str,
    byte: usize,
    units: u32,
}

fn units(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

impl<'t> Utf16Cursor<'t> {
    fn new(text: &'t str) -> Self {
        Self {
            text,
            byte: 0,
            units: 0,
        }
    }

    /// `byte` must not be before the previous call's.
    fn advance(&mut self, byte: usize) -> u32 {
        if byte >= self.byte {
            self.units += units(&self.text[self.byte..byte]);
            self.byte = byte;
            self.units
        } else {
            units(&self.text[..byte])
        }
    }
}

fn error(message: impl Into<String>, started: Instant) -> RegexResult {
    RegexResult {
        matches: Vec::new(),
        total: 0,
        truncated: false,
        group_count: 0,
        group_names: Vec::new(),
        elapsed_us: elapsed_us(started),
        error: Some(RegexError {
            message: message.into(),
        }),
    }
}

fn elapsed_us(started: Instant) -> u32 {
    u32::try_from(started.elapsed().as_micros()).unwrap_or(u32::MAX)
}

/// Matches `pattern` against `text`. Pattern errors are part of the result (with the parser's
/// own explanation), not a failure.
pub fn run(pattern: &str, flags: RegexFlags, text: &str) -> RegexResult {
    let started = Instant::now();
    if pattern.len() > MAX_PATTERN_BYTES {
        return error("The pattern is longer than 16 KiB.", started);
    }
    if text.len() > MAX_TEXT_BYTES {
        return error("The sample text is longer than 1 MiB.", started);
    }
    let compiled = RegexBuilder::new(pattern)
        .case_insensitive(flags.case_insensitive)
        .multi_line(flags.multi_line)
        .dot_matches_new_line(flags.dot_matches_new_line)
        .ignore_whitespace(flags.ignore_whitespace)
        .size_limit(SIZE_LIMIT)
        .dfa_size_limit(DFA_SIZE_LIMIT)
        .build();
    let re = match compiled {
        Ok(re) => re,
        Err(regex::Error::CompiledTooBig(_)) => {
            return error(
                "The pattern is too large to compile (it expands past 8 MiB). Reduce repetition counts.",
                started,
            );
        }
        Err(e) => return error(e.to_string(), started),
    };
    let mut cursor = Utf16Cursor::new(text);
    let names: Vec<Option<String>> = re
        .capture_names()
        .skip(1)
        .map(|n| n.map(str::to_owned))
        .collect();
    let mut matches = Vec::new();
    let mut truncated = false;
    for caps in re.captures_iter(text) {
        if matches.len() >= MAX_MATCHES {
            truncated = true;
            break;
        }
        let Some(whole) = caps.get(0) else {
            continue;
        };
        let start = cursor.advance(whole.start());
        // Groups lie inside the match: measured from its start.
        let within = |byte: usize| start + units(&text[whole.start()..byte]);
        let groups = (1..caps.len())
            .map(|i| {
                let group = caps.get(i);
                RegexGroup {
                    index: i as u32,
                    name: names.get(i - 1).cloned().flatten(),
                    start: group.map(|g| within(g.start())),
                    end: group.map(|g| within(g.end())),
                    text: group.map(|g| g.as_str().to_owned()),
                }
            })
            .collect();
        matches.push(RegexMatch {
            start,
            end: within(whole.end()),
            text: whole.as_str().to_owned(),
            groups,
        });
        if flags.first_only {
            break;
        }
    }
    RegexResult {
        total: matches.len() as u32,
        truncated,
        group_count: names.len() as u32,
        group_names: names,
        matches,
        elapsed_us: elapsed_us(started),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_and_groups_use_utf16_offsets() {
        let text = "héllo 🙂 world 42 and 7";
        let r = run(r"(?P<word>[a-z]+) (\d+)", RegexFlags::default(), text);
        assert!(r.error.is_none());
        assert_eq!(r.total, 2);
        assert_eq!(r.matches[1].text, "and 7");
        let m = &r.matches[0];
        assert_eq!(m.text, "world 42");
        // "héllo " = 6 units, "🙂" = 2 units, " " = 1 → "world" starts at 9.
        assert_eq!(m.start, 9);
        assert_eq!(m.end, 17);
        assert_eq!(m.groups[0].name.as_deref(), Some("word"));
        assert_eq!(m.groups[0].start, Some(9));
        assert_eq!(m.groups[1].text.as_deref(), Some("42"));
        assert_eq!(r.group_names, vec![Some("word".to_owned()), None]);
        let all = run(r"\d+", RegexFlags::default(), text);
        assert_eq!(all.total, 2);
        let first = run(
            r"\d+",
            RegexFlags {
                first_only: true,
                ..RegexFlags::default()
            },
            text,
        );
        assert_eq!(first.total, 1);
    }

    #[test]
    fn flags_apply() {
        let r = run(
            "^b.c$",
            RegexFlags {
                case_insensitive: true,
                multi_line: true,
                dot_matches_new_line: false,
                ..RegexFlags::default()
            },
            "a\nB-C\nd",
        );
        assert_eq!(r.total, 1);
        assert_eq!(r.matches[0].start, 2);
    }

    #[test]
    fn catastrophic_patterns_finish_in_linear_time() {
        // Exponential for a backtracking engine; linear here.
        let text = format!("{}!", "a".repeat(100_000));
        let started = Instant::now();
        let r = run("^(a+)+$", RegexFlags::default(), &text);
        assert!(r.error.is_none());
        assert_eq!(r.total, 0);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn errors_are_explained_and_limits_hold() {
        let bad = run("(unclosed", RegexFlags::default(), "x");
        assert!(bad.error.expect("error").message.contains("unclosed"));
        let unsupported = run(r"(a)\1", RegexFlags::default(), "aa");
        assert!(
            unsupported.error.is_some(),
            "backreferences are not supported"
        );
        let huge = run(r"\w{1000}{1000}", RegexFlags::default(), "x");
        assert!(huge.error.is_some());
        let many = run(".", RegexFlags::default(), &"x".repeat(5_000));
        assert!(many.truncated);
        assert_eq!(many.total as usize, MAX_MATCHES);
        let long = run("x", RegexFlags::default(), &"x".repeat(MAX_TEXT_BYTES + 1));
        assert!(long.error.is_some());
    }
}
