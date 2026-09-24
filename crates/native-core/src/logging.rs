//! Structured logging: JSON lines to rotating files in the app log directory, plus compact
//! stderr output in development. Every line passes through [`redact`] before it is written.

use std::borrow::Cow;
use std::io::{self, Write};
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::error::{ErrorCategory, KalError, Result};

/// Number of daily log files retained.
pub const LOG_FILES_RETAINED: usize = 14;
pub const LOG_FILE_PREFIX: &str = "kalcode";

const REDACTED: &str = "[REDACTED]";

static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let rules: [(&str, &'static str); 9] = [
        // PEM private keys (multi-line)
        (
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            REDACTED,
        ),
        // Credentials embedded in URLs: scheme://user:pass@host
        (
            r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@",
            "${1}[REDACTED]@",
        ),
        // Authorization: Bearer <token>
        (r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}", "${1}[REDACTED]"),
        // Common provider key formats
        (r"\bsk-[A-Za-z0-9_-]{16,}", REDACTED),
        (
            r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})",
            REDACTED,
        ),
        (r"\bAKIA[0-9A-Z]{16}\b", REDACTED),
        (r"\bAIza[0-9A-Za-z_-]{35}\b", REDACTED),
        (r"\bxox[abprs]-[A-Za-z0-9-]{10,}", REDACTED),
        // key=value / "key": "value" pairs with sensitive names
        (
            r#"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)["']?\s*[:=]\s*["']?)[^\s"',;}&]{6,}"#,
            "${1}[REDACTED]",
        ),
    ];
    rules
        .into_iter()
        .filter_map(|(pattern, replacement)| Regex::new(pattern).ok().map(|re| (re, replacement)))
        .collect()
});

/// Removes credential-shaped content from `input`.
pub fn redact(input: &str) -> Cow<'_, str> {
    let mut output = Cow::Borrowed(input);
    for (re, replacement) in PATTERNS.iter() {
        if re.is_match(&output) {
            output = Cow::Owned(re.replace_all(&output, *replacement).into_owned());
        }
    }
    output
}

/// Writer wrapper that redacts each formatted log line before writing it.
#[derive(Clone)]
pub struct RedactingMakeWriter<M> {
    inner: M,
}

impl<M> RedactingMakeWriter<M> {
    pub fn new(inner: M) -> Self {
        Self { inner }
    }
}

pub struct RedactingWriter<W> {
    inner: W,
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        self.inner.write_all(redact(&text).as_bytes())?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<'a, M: MakeWriter<'a>> MakeWriter<'a> for RedactingMakeWriter<M> {
    type Writer = RedactingWriter<M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter {
            inner: self.inner.make_writer(),
        }
    }
}

/// Keeps the background log writer alive; drop it on shutdown to flush.
pub struct LogGuard {
    _guard: WorkerGuard,
}

/// Initializes global logging. `KALCODE_LOG` overrides the filter (default `info`).
pub fn init(log_dir: &Path, console: bool) -> Result<LogGuard> {
    // The appender prunes old files on startup and fails noisily if the folder is missing.
    std::fs::create_dir_all(log_dir).map_err(|e| {
        KalError::new(
            ErrorCategory::Filesystem,
            "log_dir_unavailable",
            "KalCode couldn't create its log folder.",
        )
        .with_source(e)
    })?;
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .filename_suffix("log")
        .max_log_files(LOG_FILES_RETAINED)
        .build(log_dir)
        .map_err(|e| {
            KalError::new(
                ErrorCategory::Filesystem,
                "log_dir_unavailable",
                "KalCode couldn't open its log folder.",
            )
            .with_source(e)
        })?;
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let filter =
        || EnvFilter::try_from_env("KALCODE_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let file_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_current_span(true)
        .with_span_list(false)
        .with_target(true)
        .with_writer(RedactingMakeWriter::new(writer))
        .with_filter(filter());
    let console_layer = console.then(|| {
        tracing_subscriber::fmt::layer()
            .compact()
            .with_writer(RedactingMakeWriter::new(io::stderr))
            .with_filter(filter())
    });

    tracing_subscriber::registry()
        .with(file_layer)
        .with(console_layer)
        .try_init()
        .map_err(|e| {
            KalError::internal("logging_init_failed", "KalCode couldn't start logging.")
                .with_source(e.to_string())
        })?;
    Ok(LogGuard { _guard: guard })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_known_secret_shapes() {
        let cases = [
            (
                "key sk-ant-api03-abcdefghijklmnopqrstuvwx used",
                "sk-ant-api03",
            ),
            (
                "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
                "eyJhbGci",
            ),
            (
                "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                "ghp_abcdef",
            ),
            ("aws AKIAABCDEFGHIJKLMNOP", "AKIAABCD"),
            (
                "google AIzaSyA1234567890abcdefghijklmnopqrstuv",
                "AIzaSyA12",
            ),
            ("https://user:hunter22@example.com/repo.git", "hunter22"),
            (r#"{"api_key":"abc123def456"}"#, "abc123def456"),
            ("password=correcthorse", "correcthorse"),
            (
                "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
                "MIIEow",
            ),
        ];
        for (input, secret) in cases {
            let output = redact(input);
            assert!(!output.contains(secret), "{input:?} -> {output:?}");
            assert!(output.contains("[REDACTED]"), "{input:?} -> {output:?}");
        }
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        let text =
            r#"{"level":"INFO","fields":{"event":"app.started","version":"0.1.0","seq":42}}"#;
        assert!(matches!(redact(text), Cow::Borrowed(_)));
    }

    #[test]
    fn redacting_writer_scrubs_before_writing() {
        let mut out = Vec::new();
        {
            let mut writer = RedactingWriter { inner: &mut out };
            writer
                .write_all(b"leaked sk-proj-ABCDEFGHIJKLMNOPQRSTUV here\n")
                .expect("write");
        }
        let written = String::from_utf8(out).expect("utf8");
        assert_eq!(written, "leaked [REDACTED] here\n");
    }
}
