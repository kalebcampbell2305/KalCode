//! Structured logging: JSON lines to rotating files in the app log directory, plus compact
//! stderr output in development. Every line passes through [`redact`] (the shared redactor,
//! [`crate::redact`]) before it is written.

use std::borrow::Cow;
use std::io::{self, Write};
use std::path::Path;

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

/// Removes credential-shaped content from a formatted log line. Delegates to the shared
/// redactor ([`crate::redact::redact_log_line`]): plain `[REDACTED]` placeholders, high-signal
/// detectors only, borrowed when nothing matched. False positives (redacting something
/// harmless) are acceptable; false negatives are not.
pub fn redact(input: &str) -> Cow<'_, str> {
    crate::redact::redact_log_line(input)
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

    /// Runs `log` under a real JSON fmt layer writing through `RedactingMakeWriter`, exactly as
    /// the file sink is configured, and returns the written output.
    fn capture_json(log: impl FnOnce()) -> String {
        use std::sync::{Arc, Mutex};

        #[derive(Clone, Default)]
        struct Buffer(Arc<Mutex<Vec<u8>>>);
        impl Write for Buffer {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().expect("lock").extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let buffer = Buffer::default();
        let sink = buffer.clone();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_writer(RedactingMakeWriter::new(move || sink.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, log);
        let bytes = buffer.0.lock().expect("lock").clone();
        String::from_utf8(bytes).expect("utf8")
    }

    #[test]
    fn redacts_secrets_in_real_json_log_output() {
        #[derive(Debug)]
        #[allow(dead_code)]
        struct ProviderConfig {
            api_key: &'static str,
            region: &'static str,
        }
        let config = ProviderConfig {
            api_key: "sk_live_abcdef123456",
            region: "us",
        };
        let output = capture_json(|| {
            tracing::info!(r#"connecting with token="secretvalue123""#);
            tracing::info!(password = ?"hunter2222", "login attempt");
            tracing::info!(password = %"correcthorse99", "login attempt");
            tracing::info!(config = ?config, "provider configured");
            tracing::info!("header Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123");
        });
        for secret in [
            "secretvalue123",
            "hunter2222",
            "correcthorse99",
            "sk_live_abcdef123456",
            "abcdefghijklmnop",
        ] {
            assert!(!output.contains(secret), "{secret} leaked into: {output}");
        }
        assert!(output.contains("[REDACTED]"));
        assert!(output.contains("us"), "non-secret fields survive: {output}");
    }

    #[test]
    fn every_rule_compiles() {
        let (compiled, declared) = crate::redact::secrets::compiled_detector_count();
        assert_eq!(compiled, declared, "a redaction pattern failed to compile");
    }

    #[test]
    fn redacts_reviewer_bypass_samples() {
        let cases = [
            (
                "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY",
                "wJalrXUtnFEMI",
            ),
            ("secret_key: abcdef123456", "abcdef123456"),
            ("private_key = 'mysecretkeydata'", "mysecretkeydata"),
            (
                "Authorization: Basic dXNlcjpwYXNzd29yZA==",
                "dXNlcjpwYXNzd29yZA",
            ),
            ("stripe sk_live_51HxAbCdEfGhIjKlMn", "sk_live_51Hx"),
            (
                "git https://glpat-abcdefghijklmnopqrstu@gitlab.com/x.git",
                "glpat-abcdef",
            ),
            (
                "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w",
                "eyJzdWIi",
            ),
            (
                "key AIzaSyA1234567890abcdefghijklmnopqrstu- next",
                "AIzaSyA12345",
            ),
            ("slack xapp-1-A0123456789-abcdef", "xapp-1-A0123"),
            ("hub hf_abcdefghijklmnopqrstuvwxyz0123456", "hf_abcdefghij"),
            (
                "-----BEGIN PGP PRIVATE KEY BLOCK-----
lQOYBF
-----END PGP PRIVATE KEY BLOCK-----",
                "lQOYBF",
            ),
            (
                "-----BEGIN RSA PRIVATE KEY-----
MIIEtruncated",
                "MIIEtruncated",
            ),
            (
                r#"{\"api_key\":\"abc123def456ghi\",\"error\":\"bad\"}"#,
                "abc123def456ghi",
            ),
        ];
        for (input, secret) in cases {
            let output = redact(input);
            assert!(!output.contains(secret), "{input:?} -> {output:?}");
        }
    }

    #[test]
    fn init_writes_redacted_json_to_the_log_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let guard = init(dir.path(), false).expect("init");
        tracing::info!(body = %r#"{"api_key":"abc123def456ghi","error":"bad"}"#, event = "provider.error");
        tracing::info!(event = "cfg", "loaded config password=\"hunter2hunter2\"");
        drop(guard); // flushes the background writer
        let contents: String = std::fs::read_dir(dir.path())
            .expect("log dir")
            .filter_map(|e| e.ok())
            .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default())
            .collect();
        assert!(
            contents.contains("provider.error"),
            "log written: {contents}"
        );
        assert!(!contents.contains("abc123def456ghi"), "{contents}");
        assert!(!contents.contains("hunter2hunter2"), "{contents}");
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
