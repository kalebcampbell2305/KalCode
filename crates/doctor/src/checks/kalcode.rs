//! KalCode's own health: database integrity and migrations, the data folder, disk space, logs
//! and the WebView runtime.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use kalcode_contracts::ids::new_id;

use super::{CheckDef, CheckOutput, FindingExt, bytes, count, def, finding};
use crate::context::{RunContext, VolumeRole, display, volume};
use crate::types::{DoctorArea, FindingSeverity};

/// Free space below which KalCode's data volume is a warning / critical.
pub const DATA_DISK_WARNING: u64 = 1024 * 1024 * 1024;
pub const DATA_DISK_CRITICAL: u64 = 200 * 1024 * 1024;
/// Log folder size worth mentioning.
pub const LOGS_LARGE: u64 = 512 * 1024 * 1024;
/// The oldest WebView2 major version KalCode is tested with.
pub const WEBVIEW_MINIMUM_MAJOR: u64 = 120;

pub fn checks() -> Vec<CheckDef> {
    vec![
        def(
            "kalcode.database",
            DoctorArea::KalCode,
            "Database integrity",
            database,
        ),
        def(
            "kalcode.migrations",
            DoctorArea::KalCode,
            "Database version",
            migrations,
        ),
        def(
            "kalcode.data_folder",
            DoctorArea::KalCode,
            "Data folder",
            data_folder,
        ),
        def(
            "kalcode.disk",
            DoctorArea::KalCode,
            "Space for KalCode's data",
            disk,
        ),
        def("kalcode.logs", DoctorArea::KalCode, "Logs", logs),
        def(
            "kalcode.local_reasoning",
            DoctorArea::KalCode,
            "KalVoice local reasoning",
            local_reasoning,
        ),
        def(
            "kalcode.webview",
            DoctorArea::KalCode,
            "WebView2 runtime",
            webview,
        ),
    ]
}

fn local_reasoning(ctx: &RunContext) -> CheckOutput {
    use crate::context::LocalVoiceState;
    let Some(source) = &ctx.local_voice else {
        return CheckOutput::could_not_check(
            "The desktop did not supply local KalVoice runtime state.",
        );
    };
    let (code, severity, title, detail) = match source.current() {
        LocalVoiceState::Ready => return CheckOutput::passed("Verified local runtime ready"),
        LocalVoiceState::Warming => (
            "warming",
            FindingSeverity::Info,
            "Local reasoning is starting",
            "Wait for KalVoice to finish starting. Deterministic app commands remain available.",
        ),
        LocalVoiceState::Installed => (
            "installed",
            FindingSeverity::Info,
            "Local reasoning is installed but not running",
            "Open Settings → KalVoice to start the verified local runtime. Deterministic app commands remain available.",
        ),
        LocalVoiceState::NotInstalled => (
            "not_installed",
            FindingSeverity::Info,
            "Local reasoning is not installed",
            "Open Settings → KalVoice to review and download the signed runtime and reasoning model. Deterministic app commands remain available.",
        ),
        LocalVoiceState::Unavailable => (
            "unavailable",
            FindingSeverity::Warning,
            "Local reasoning is unavailable",
            "Open Settings → KalVoice to check the signed components and retry local runtime startup. KalVoice does not fall back to provider inference.",
        ),
    };
    CheckOutput::with(
        title,
        vec![finding(
            format!("kalcode.local_reasoning.{code}"),
            severity,
            title,
            detail,
        )],
    )
}

/// `PRAGMA quick_check` on the core's read-only connection. The read connection never blocks the
/// writer (WAL); a check that runs out of time is interrupted.
fn database(ctx: &RunContext) -> CheckOutput {
    let conn = ctx.core.reader();
    let handle = conn.get_interrupt_handle();
    let done = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let done = Arc::clone(&done);
        let budget = ctx.budget.clone();
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if budget.should_stop() {
                    handle.interrupt();
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })
    };
    let result: Result<Vec<String>, rusqlite::Error> = (|| {
        let mut stmt = conn.prepare("PRAGMA quick_check(20)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    })();
    done.store(true, Ordering::SeqCst);
    drop(conn);
    let _ = watchdog.join();
    match result {
        Ok(rows) if rows.len() == 1 && rows[0] == "ok" => {
            CheckOutput::passed("No damage found (quick check)")
        }
        Ok(rows) => {
            let backups = display(&ctx.core.paths().backups);
            CheckOutput::with(
                format!("{} reported", count(rows.len(), "problem", "problems")),
                vec![
                    finding(
                        "kalcode.database.damaged",
                        FindingSeverity::Critical,
                        "KalCode's database reports damage",
                        "SQLite's integrity check found problems in KalCode's database. Your work may still open, but some history could be unreadable. Quit KalCode and keep a copy of the data folder; KalCode keeps a backup from before each upgrade.",
                    )
                    .detail("Backups", backups)
                    .subjects(rows),
                ],
            )
        }
        Err(e) if ctx.budget.should_stop() => {
            CheckOutput::could_not_check(format!("The check was stopped before it finished ({e})."))
        }
        Err(e) => CheckOutput::could_not_check(format!("SQLite couldn't run the check ({e}).")),
    }
}

/// The migrations the database recorded against the ones this build knows.
fn migrations(ctx: &RunContext) -> CheckOutput {
    let known = ctx.host.migrations;
    let rows: Result<Vec<(i64, String, String)>, rusqlite::Error> = (|| {
        let conn = ctx.core.reader();
        let mut stmt =
            conn.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect()
    })();
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => {
            return CheckOutput::could_not_check(format!(
                "KalCode couldn't read its migration history ({e})."
            ));
        }
    };
    let latest = known.last().map_or(0, |m| m.version);
    let current = rows.last().map_or(0, |r| r.0);
    let mut problems = Vec::new();
    for migration in known {
        match rows.iter().find(|r| r.0 == migration.version) {
            None => problems.push(format!(
                "v{} ({}) is not applied",
                migration.version, migration.name
            )),
            Some((_, _, checksum)) if *checksum != kalcode_core::db::checksum(migration.sql) => {
                problems.push(format!(
                    "v{} ({}) doesn't match this build",
                    migration.version, migration.name
                ));
            }
            Some(_) => {}
        }
    }
    for (version, name, _) in &rows {
        if !known.iter().any(|m| m.version == *version) {
            problems.push(format!("v{version} ({name}) is unknown to this build"));
        }
    }
    if problems.is_empty() {
        return CheckOutput::passed(format!("Schema v{current}, up to date"));
    }
    CheckOutput::with(
        format!("Schema v{current} of v{latest}"),
        vec![
            finding(
                "kalcode.migrations.mismatch",
                FindingSeverity::Critical,
                "KalCode's database history doesn't match this build",
                "The database records upgrade steps that differ from the ones this version of KalCode ships. This usually means the data folder was used by a different build. Keep a copy of the data folder before changing anything.",
            )
            .detail("Database version", format!("v{current}"))
            .detail("This build", format!("v{latest}"))
            .subjects(problems),
        ],
    )
}

/// Creates, writes, reads back and removes a small file in the data and log folders.
fn data_folder(ctx: &RunContext) -> CheckOutput {
    let paths = ctx.core.paths();
    let mut failures = Vec::new();
    for (label, dir) in [
        ("Data folder", &paths.data_dir),
        ("Logs folder", &paths.logs),
    ] {
        if let Err(e) = write_probe(dir) {
            failures.push(format!("{label} ({}): {e}", display(dir)));
        }
    }
    if failures.is_empty() {
        return CheckOutput::passed(format!("Writable ({})", display(&paths.data_dir)));
    }
    CheckOutput::with(
        "Not writable",
        vec![
            finding(
                "kalcode.data_folder.not_writable",
                FindingSeverity::Critical,
                "KalCode can't write to its data folder",
                "KalCode keeps its database, logs and settings here. If it can't write, changes may not be saved. Check that the folder isn't read-only, full, or blocked by security software.",
            )
            .detail("Data folder", display(&paths.data_dir))
            .subjects(failures),
        ],
    )
}

fn write_probe(dir: &Path) -> std::io::Result<()> {
    let path = dir.join(format!(".doctor-write-check-{}.tmp", new_id()));
    let payload = b"kalcode doctor";
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(payload)?;
        file.sync_all()?;
        drop(file);
        let mut back = Vec::new();
        std::fs::File::open(&path)?.read_to_end(&mut back)?;
        if back != payload {
            return Err(std::io::Error::other("read back different bytes"));
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&path);
    result
}

fn disk(ctx: &RunContext) -> CheckOutput {
    let facts = ctx.resources();
    let Some(v) = volume(facts, VolumeRole::Data) else {
        return CheckOutput::could_not_check(
            facts
                .volume_reason
                .clone()
                .unwrap_or_else(|| "Free space of the data folder's drive wasn't measured.".into()),
        );
    };
    let summary = format!("{} free on KalCode's data volume", bytes(v.free_bytes));
    if v.free_bytes >= DATA_DISK_WARNING {
        return CheckOutput::passed(summary);
    }
    let critical = v.free_bytes < DATA_DISK_CRITICAL;
    CheckOutput::with(
        summary,
        vec![
            finding(
                "kalcode.disk.low",
                if critical {
                    FindingSeverity::Critical
                } else {
                    FindingSeverity::Warning
                },
                "Little space left for KalCode's data",
                "KalCode's database, logs and backups need room to grow. When the drive fills up, KalCode can't save new work or upgrade its database safely. Free up space on this drive.",
            )
            .detail("Volume", "KalCode data")
            .detail("Free", bytes(v.free_bytes))
            .detail("Size", bytes(v.total_bytes))
            .detail("Data folder", display(&ctx.core.paths().data_dir)),
        ],
    )
}

fn logs(ctx: &RunContext) -> CheckOutput {
    let dir = &ctx.core.paths().logs;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            return CheckOutput::could_not_check(format!(
                "KalCode couldn't list its log folder ({e})."
            ));
        }
    };
    let mut total = 0u64;
    let mut files = 0usize;
    for entry in entries.flatten().take(10_000) {
        if let Ok(meta) = entry.metadata()
            && meta.is_file()
        {
            total += meta.len();
            files += 1;
        }
    }
    let summary = format!("{} in {}", bytes(total), count(files, "file", "files"));
    if total < LOGS_LARGE {
        return CheckOutput::passed(summary);
    }
    CheckOutput::with(
        summary,
        vec![
            finding(
                "kalcode.logs.large",
                FindingSeverity::Info,
                "KalCode's logs take a lot of space",
                "Old log files are safe to delete when KalCode is closed. They only help when you report a problem.",
            )
            .detail("Logs folder", display(dir))
            .detail("Size", bytes(total)),
        ],
    )
}

fn webview(ctx: &RunContext) -> CheckOutput {
    let version = match &ctx.host.webview_version {
        Ok(version) => version.clone(),
        Err(why) => return CheckOutput::could_not_check(why.clone()),
    };
    let major = version
        .split('.')
        .next()
        .and_then(|m| m.trim().parse::<u64>().ok());
    match major {
        Some(major) if major < WEBVIEW_MINIMUM_MAJOR => CheckOutput::with(
            format!("Version {version}"),
            vec![
                finding(
                    "kalcode.webview.outdated",
                    FindingSeverity::Warning,
                    "The WebView2 runtime is out of date",
                    "KalCode draws its window with Microsoft's WebView2 runtime. This version is older than the ones KalCode is tested with; Windows Update normally keeps it current.",
                )
                .detail("Installed", &version)
                .detail("Tested from", format!("{WEBVIEW_MINIMUM_MAJOR}.0")),
            ],
        ),
        Some(_) => CheckOutput::passed(format!("Version {version}")),
        None => CheckOutput::could_not_check(format!("Unrecognised version \"{version}\".")),
    }
}
