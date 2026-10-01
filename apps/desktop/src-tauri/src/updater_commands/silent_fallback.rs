//! Same-version builds install silently when KalCode closes, with no notice. If that ever fails
//! for a build, KalCode offers that build through the proven restart-and-install prompt instead,
//! so a fault in the silent path can never leave anyone on an old build.
//!
//! The record lives beside `updater.json`, not in it: the journal rejects unknown fields, so a
//! new journal field would make an older KalCode (after "Restore previous version") treat its
//! update record as damaged and refuse every update.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use semver::Version;
use serde::{Deserialize, Serialize};

pub(super) const RECORD_FILE: &str = "silent-install.json";

/// Staging failures, in separate sessions, after which a build is offered with the prompt.
const STAGING_FAILURE_LIMIT: u8 = 2;

/// What the silent path has done for one same-version build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SilentInstallRecord {
    pub version: String,
    /// KalCode closed and started this build's installer or helper.
    #[serde(default)]
    pub exit_attempted: bool,
    /// Sessions in a row whose staging of this build failed.
    #[serde(default)]
    pub staging_failures: u8,
}

/// Whether `version` must be offered through the restart prompt instead of installing silently:
/// a silent install of it was started and KalCode still isn't running it, or staging it failed
/// in `STAGING_FAILURE_LIMIT` sessions in a row.
pub(super) fn prompt_instead(record: Option<&SilentInstallRecord>, version: &str) -> bool {
    record.is_some_and(|record| {
        record.version == version
            && (record.exit_attempted || record.staging_failures >= STAGING_FAILURE_LIMIT)
    })
}

/// At launch: a record for the running build, or an older one, is settled and dropped. A record
/// for a newer build is kept, so that build is offered with the prompt.
pub(super) fn reconcile_at_launch(
    record: Option<SilentInstallRecord>,
    current_version: &str,
) -> Option<SilentInstallRecord> {
    let record = record?;
    let (Ok(recorded), Ok(current)) = (
        Version::parse(&record.version),
        Version::parse(current_version),
    ) else {
        return None;
    };
    (recorded > current).then_some(record)
}

pub(super) fn after_staging_failure(
    record: Option<SilentInstallRecord>,
    version: &str,
) -> SilentInstallRecord {
    match record {
        Some(mut record) if record.version == version => {
            record.staging_failures = record.staging_failures.saturating_add(1);
            record
        }
        _ => SilentInstallRecord {
            version: version.to_owned(),
            exit_attempted: false,
            staging_failures: 1,
        },
    }
}

pub(super) fn after_staging_success(
    record: Option<SilentInstallRecord>,
    version: &str,
) -> Option<SilentInstallRecord> {
    let mut record = record.filter(|record| record.version == version)?;
    record.staging_failures = 0;
    record.exit_attempted.then_some(record)
}

pub(super) fn after_exit_attempt(
    record: Option<SilentInstallRecord>,
    version: &str,
) -> SilentInstallRecord {
    let staging_failures = record
        .filter(|record| record.version == version)
        .map_or(0, |record| record.staging_failures);
    SilentInstallRecord {
        version: version.to_owned(),
        exit_attempted: true,
        staging_failures,
    }
}

/// A missing, unreadable or malformed record reads as none: the worst case is one more silent
/// attempt, which this record then catches.
pub(super) fn load(path: &Path) -> Option<SilentInstallRecord> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(4 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Replaces the record atomically; `None` removes it.
pub(super) fn save(path: &Path, record: Option<&SilentInstallRecord>) -> std::io::Result<()> {
    let Some(record) = record else {
        return match fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let next = path.with_extension("json.next");
    let mut file = fs::File::create(&next)?;
    file.write_all(&serde_json::to_vec(record).map_err(std::io::Error::other)?)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&next, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "0.1.8+5";
    const NEW: &str = "0.1.8+6";

    #[test]
    fn a_silent_install_that_did_not_take_offers_that_build_with_the_prompt() {
        // KalCode 0.1.8+5 closed and started the installer for 0.1.8+6.
        let record = after_exit_attempt(None, NEW);
        assert!(prompt_instead(Some(&record), NEW));

        // The next launch is still 0.1.8+5: the record survives and 0.1.8+6 gets the prompt.
        let kept = reconcile_at_launch(Some(record.clone()), OLD);
        assert_eq!(kept.as_ref(), Some(&record));
        assert!(prompt_instead(kept.as_ref(), NEW));
        // A later build gets its own silent chance.
        assert!(!prompt_instead(kept.as_ref(), "0.1.8+7"));

        // The next launch runs 0.1.8+6 (or something newer): settled.
        assert_eq!(reconcile_at_launch(Some(record.clone()), NEW), None);
        assert_eq!(reconcile_at_launch(Some(record), "0.1.8+7"), None);
    }

    #[test]
    fn staging_that_fails_in_two_sessions_offers_that_build_with_the_prompt() {
        let first = after_staging_failure(None, NEW);
        assert!(
            !prompt_instead(Some(&first), NEW),
            "one failure retries silently"
        );
        let first = reconcile_at_launch(Some(first), OLD);
        let second = after_staging_failure(first, NEW);
        assert!(prompt_instead(Some(&second), NEW));
        assert!(!prompt_instead(Some(&second), "0.1.8+7"));

        // A failure for another build starts that build's count over.
        let other = after_staging_failure(Some(second.clone()), "0.1.8+7");
        assert_eq!(other.staging_failures, 1);
        assert!(!prompt_instead(Some(&other), "0.1.8+7"));

        // Staging that succeeds resets the count; with no exit attempt nothing is left to track.
        let once = after_staging_failure(None, NEW);
        assert_eq!(after_staging_success(Some(once), NEW), None);
        // An exit attempt already recorded stays recorded.
        let attempted = after_exit_attempt(Some(second), NEW);
        assert_eq!(attempted.staging_failures, 2);
        let after = after_staging_success(Some(attempted), NEW).expect("attempt kept");
        assert!(after.exit_attempted);
        assert_eq!(after.staging_failures, 0);
    }

    #[test]
    fn the_record_survives_restarts_and_a_bad_record_reads_as_none() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("updates").join(RECORD_FILE);
        assert_eq!(load(&path), None);
        let record = after_exit_attempt(None, NEW);
        save(&path, Some(&record)).unwrap();
        assert_eq!(load(&path), Some(record));
        save(&path, None).unwrap();
        assert_eq!(load(&path), None);
        save(&path, None).unwrap();
        fs::write(&path, b"{not json").unwrap();
        assert_eq!(load(&path), None);
        assert_eq!(
            reconcile_at_launch(
                Some(SilentInstallRecord {
                    version: "not-a-version".into(),
                    exit_attempted: true,
                    staging_failures: 0,
                }),
                OLD
            ),
            None
        );
    }
}
