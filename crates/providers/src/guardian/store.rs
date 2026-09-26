use std::ffi::{OsStr, OsString};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::marker::{ProfileMarker, encode_marker};
use super::platform::{AnchoredDirectory, RecoveryLock, RecoveryLockRole};
use super::{GuardianError, MarkerStore, ProfileIdentity};

const SLOT_SCHEMA_VERSION: u16 = 1;
const MAX_MARKER_BYTES: u64 = 1024 * 1024;
const EPOCH_SLOT_NAMES: [&str; 2] = ["runtime-epoch.v1.0.json", "runtime-epoch.v1.1.json"];

#[derive(Debug, Serialize, Deserialize)]
struct SlotEnvelope {
    schema_version: u16,
    sequence: u64,
    marker: ProfileMarker,
    checksum: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum EpochState {
    Running,
    Clean,
    RebootRecovered,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct EpochRecord {
    desktop_generation: super::DesktopGeneration,
    boot_identifier: String,
    state: EpochState,
}

#[derive(Debug, Serialize, Deserialize)]
struct EpochEnvelope {
    schema_version: u16,
    sequence: u64,
    record: EpochRecord,
    checksum: u64,
}

#[derive(Debug)]
pub(crate) struct FileMarkerStore {
    root: PathBuf,
    directory: Arc<AnchoredDirectory>,
    write_lock: Mutex<()>,
    root_was_new: bool,
}

impl FileMarkerStore {
    pub fn open(root: PathBuf) -> Result<Self, GuardianError> {
        if !root.is_absolute() {
            return Err(GuardianError::Unavailable(
                "marker storage must be absolute".into(),
            ));
        }
        let root_was_new = !root.exists();
        std::fs::create_dir_all(&root).map_err(io_unavailable)?;
        let metadata = std::fs::symlink_metadata(&root).map_err(io_unavailable)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(GuardianError::Unavailable(
                "marker storage is not an ordinary directory".into(),
            ));
        }
        let root = std::fs::canonicalize(root).map_err(io_unavailable)?;
        let directory = Arc::new(AnchoredDirectory::open(&root)?);
        Ok(Self {
            root,
            directory,
            write_lock: Mutex::new(()),
            root_was_new,
        })
    }

    pub(crate) fn recovery_root(&self) -> &std::path::Path {
        &self.root
    }

    pub(crate) fn root_identity(&self) -> &str {
        self.directory.identity_token()
    }

    pub(crate) fn acquire_recovery_lock(
        &self,
        role: RecoveryLockRole,
    ) -> Result<RecoveryLock, GuardianError> {
        RecoveryLock::acquire_anchored(Arc::clone(&self.directory), role)
    }

    /// Durably fences one desktop generation before any helper or provider process is admitted.
    /// A RUNNING record from the same Windows boot blocks. A different boot identifier is the only
    /// automatic recovery witness because processes cannot survive an operating-system restart.
    pub(crate) fn begin_epoch(
        &self,
        desktop_generation: super::DesktopGeneration,
        boot_identifier: &str,
    ) -> Result<(), GuardianError> {
        validate_boot_identifier(boot_identifier)?;
        let _guard = self.lock()?;
        let slots = self.load_epoch_slots()?;
        let newest = slots.into_iter().flatten().max_by_key(|slot| slot.sequence);
        let mut sequence = newest.as_ref().map_or(0, |slot| slot.sequence);
        match newest {
            None if !self.root_was_new => {
                return Err(GuardianError::Unavailable(
                    "provider guardian epoch evidence is missing from an existing data root".into(),
                ));
            }
            Some(slot) if slot.record.state == EpochState::Running => {
                if slot.record.boot_identifier == boot_identifier {
                    return Err(GuardianError::Unavailable(
                        "a prior provider runtime is unclean on this Windows boot; restart Windows before retrying"
                            .into(),
                    ));
                }
                sequence = sequence
                    .checked_add(1)
                    .ok_or(GuardianError::CorruptMarker)?;
                self.write_epoch_slot(
                    sequence,
                    &EpochRecord {
                        state: EpochState::RebootRecovered,
                        ..slot.record
                    },
                )?;
            }
            Some(_) | None => {}
        }
        sequence = sequence
            .checked_add(1)
            .ok_or(GuardianError::CorruptMarker)?;
        self.write_epoch_slot(
            sequence,
            &EpochRecord {
                desktop_generation,
                boot_identifier: boot_identifier.to_owned(),
                state: EpochState::Running,
            },
        )
    }

    pub(crate) fn prove_epoch_clean(
        &self,
        desktop_generation: super::DesktopGeneration,
        boot_identifier: &str,
    ) -> Result<(), GuardianError> {
        validate_boot_identifier(boot_identifier)?;
        let _guard = self.lock()?;
        let slots = self.load_epoch_slots()?;
        let newest = slots
            .into_iter()
            .flatten()
            .max_by_key(|slot| slot.sequence)
            .ok_or_else(|| {
                GuardianError::Unavailable("guardian epoch evidence is missing".into())
            })?;
        if newest.record.desktop_generation != desktop_generation
            || newest.record.boot_identifier != boot_identifier
        {
            return Err(GuardianError::ObjectMismatch);
        }
        if newest.record.state == EpochState::Clean {
            return Ok(());
        }
        if newest.record.state != EpochState::Running {
            return Err(GuardianError::InvalidTransition);
        }
        let sequence = newest
            .sequence
            .checked_add(1)
            .ok_or(GuardianError::CorruptMarker)?;
        self.write_epoch_slot(
            sequence,
            &EpochRecord {
                state: EpochState::Clean,
                ..newest.record
            },
        )
    }

    fn load_epoch_slots(&self) -> Result<[Option<EpochEnvelope>; 2], GuardianError> {
        Ok([self.read_epoch_slot(0)?, self.read_epoch_slot(1)?])
    }

    fn read_epoch_slot(&self, index: usize) -> Result<Option<EpochEnvelope>, GuardianError> {
        let name = OsStr::new(EPOCH_SLOT_NAMES[index]);
        let Some(mut file) = self.directory.open_existing(name)? else {
            return Ok(None);
        };
        if file.metadata().map_err(io_unavailable)?.len() > MAX_MARKER_BYTES {
            return Err(GuardianError::CorruptMarker);
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(io_unavailable)?;
        let slot: EpochEnvelope =
            serde_json::from_slice(&bytes).map_err(|_| GuardianError::CorruptMarker)?;
        let record_bytes =
            serde_json::to_vec(&slot.record).map_err(GuardianError::MarkerEncoding)?;
        if slot.schema_version != SLOT_SCHEMA_VERSION
            || slot.sequence == 0
            || checksum(slot.sequence, &record_bytes) != slot.checksum
            || validate_boot_identifier(&slot.record.boot_identifier).is_err()
        {
            return Err(GuardianError::CorruptMarker);
        }
        Ok(Some(slot))
    }

    fn write_epoch_slot(&self, sequence: u64, record: &EpochRecord) -> Result<(), GuardianError> {
        let record_bytes = serde_json::to_vec(record).map_err(GuardianError::MarkerEncoding)?;
        let envelope = EpochEnvelope {
            schema_version: SLOT_SCHEMA_VERSION,
            sequence,
            record: record.clone(),
            checksum: checksum(sequence, &record_bytes),
        };
        let bytes = serde_json::to_vec(&envelope).map_err(GuardianError::MarkerEncoding)?;
        if bytes.len() as u64 > MAX_MARKER_BYTES {
            return Err(GuardianError::CorruptMarker);
        }
        let mut file = self
            .directory
            .open_or_create(OsStr::new(EPOCH_SLOT_NAMES[(sequence & 1) as usize]))?;
        file.set_len(0).map_err(io_unavailable)?;
        file.seek(SeekFrom::Start(0)).map_err(io_unavailable)?;
        file.write_all(&bytes).map_err(io_unavailable)?;
        file.sync_all().map_err(io_unavailable)?;
        drop(file);
        let verified = self
            .read_epoch_slot((sequence & 1) as usize)?
            .ok_or(GuardianError::CorruptMarker)?;
        if verified.sequence != sequence || verified.record != *record {
            return Err(GuardianError::CorruptMarker);
        }
        Ok(())
    }

    #[cfg(test)]
    fn load(&self, profile: &ProfileIdentity) -> Result<ProfileMarker, GuardianError> {
        let _guard = self.lock()?;
        let slots = self.load_slots(profile)?;
        slots
            .into_iter()
            .flatten()
            .max_by_key(|slot| slot.sequence)
            .map(|slot| slot.marker)
            .ok_or_else(|| GuardianError::Unavailable("guardian marker is missing".into()))
    }

    fn lock(&self) -> Result<MutexGuard<'_, ()>, GuardianError> {
        self.write_lock.lock().map_err(|_| GuardianError::Poisoned)
    }

    fn load_slots(
        &self,
        profile: &ProfileIdentity,
    ) -> Result<[Option<SlotEnvelope>; 2], GuardianError> {
        Ok([
            self.read_slot(&self.slot_name(profile, 0)?, profile)?,
            self.read_slot(&self.slot_name(profile, 1)?, profile)?,
        ])
    }

    fn read_slot(
        &self,
        name: &OsStr,
        profile: &ProfileIdentity,
    ) -> Result<Option<SlotEnvelope>, GuardianError> {
        let Some(mut file) = self.directory.open_existing(name)? else {
            return Ok(None);
        };
        if file.metadata().map_err(io_unavailable)?.len() > MAX_MARKER_BYTES {
            return Err(GuardianError::CorruptMarker);
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(io_unavailable)?;
        let slot: SlotEnvelope =
            serde_json::from_slice(&bytes).map_err(|_| GuardianError::CorruptMarker)?;
        if slot.schema_version != SLOT_SCHEMA_VERSION || slot.sequence == 0 {
            return Err(GuardianError::CorruptMarker);
        }
        let marker_bytes = encode_marker(&slot.marker)?;
        if slot.marker.profile() != profile
            || checksum(slot.sequence, &marker_bytes) != slot.checksum
        {
            return Err(GuardianError::CorruptMarker);
        }
        Ok(Some(slot))
    }

    fn slot_name(
        &self,
        profile: &ProfileIdentity,
        sequence: u64,
    ) -> Result<OsString, GuardianError> {
        let provider = profile.provider_id().as_str();
        if provider.is_empty()
            || !provider
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(GuardianError::InvalidIdentity);
        }
        let key = format!(
            "{provider}-{}-{}-{}.json",
            profile.account_id(),
            profile.generation().as_uuid(),
            sequence & 1
        );
        Ok(OsString::from(key))
    }

    fn write_slot(
        &self,
        profile: &ProfileIdentity,
        sequence: u64,
        marker: &ProfileMarker,
    ) -> Result<(), GuardianError> {
        let marker_bytes = encode_marker(marker)?;
        let slot = SlotEnvelope {
            schema_version: SLOT_SCHEMA_VERSION,
            sequence,
            marker: marker.clone(),
            checksum: checksum(sequence, &marker_bytes),
        };
        let bytes = serde_json::to_vec(&slot).map_err(GuardianError::MarkerEncoding)?;
        if bytes.len() as u64 > MAX_MARKER_BYTES {
            return Err(GuardianError::CorruptMarker);
        }
        let name = self.slot_name(profile, sequence)?;
        let mut file = self.directory.open_or_create(&name)?;
        file.set_len(0).map_err(io_unavailable)?;
        file.seek(SeekFrom::Start(0)).map_err(io_unavailable)?;
        file.write_all(&bytes).map_err(io_unavailable)?;
        file.sync_all().map_err(io_unavailable)?;
        drop(file);

        let verified = self
            .read_slot(&name, profile)?
            .ok_or(GuardianError::CorruptMarker)?;
        if verified.sequence != sequence || verified.marker != *marker {
            return Err(GuardianError::CorruptMarker);
        }
        Ok(())
    }
}

impl MarkerStore for FileMarkerStore {
    fn persist(&self, marker: &ProfileMarker) -> Result<(), GuardianError> {
        let _guard = self.lock()?;
        let slots = self.load_slots(marker.profile())?;
        let sequence = slots
            .iter()
            .flatten()
            .map(|slot| slot.sequence)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(GuardianError::CorruptMarker)?;
        self.write_slot(marker.profile(), sequence, marker)
    }
}

fn checksum(sequence: u64, bytes: &[u8]) -> u64 {
    let mut value = 0xcbf2_9ce4_8422_2325_u64;
    for byte in sequence.to_le_bytes().iter().chain(bytes) {
        value ^= u64::from(*byte);
        value = value.wrapping_mul(0x0000_0100_0000_01b3);
    }
    value
}

fn validate_boot_identifier(value: &str) -> Result<(), GuardianError> {
    if value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && value.bytes().any(|byte| byte != b'0')
    {
        Ok(())
    } else {
        Err(GuardianError::CorruptMarker)
    }
}

fn io_unavailable(error: std::io::Error) -> GuardianError {
    GuardianError::Unavailable(error.to_string())
}

#[cfg(test)]
mod tests {
    use kalcode_contracts::agent::ProviderId;
    use uuid::Uuid;

    use super::*;
    use crate::guardian::marker::JobId;
    use crate::guardian::{
        DesktopGeneration, ProcessIdentity, ProfileCapability, ProfileGeneration,
    };

    fn profile() -> ProfileIdentity {
        ProfileIdentity::new(
            ProviderId::new(ProviderId::CODEX),
            Uuid::parse_str("0199aaaa-0000-7000-8000-000000000003").expect("account"),
            ProfileGeneration::from_uuid(
                Uuid::parse_str("0199aaaa-0000-7000-8000-000000000002")
                    .expect("profile generation"),
            ),
        )
        .expect("profile")
    }

    fn process(pid: u32, birth_time_100ns: u64) -> ProcessIdentity {
        ProcessIdentity::new(pid, birth_time_100ns).expect("process")
    }

    fn boot(byte: &str) -> String {
        byte.repeat(16)
    }

    fn clean_marker(profile: ProfileIdentity) -> ProfileMarker {
        ProfileMarker::new(
            Uuid::parse_str("0199aaaa-0000-7000-8000-000000000005").expect("boot"),
            DesktopGeneration::from_uuid(
                Uuid::parse_str("0199aaaa-0000-7000-8000-000000000001")
                    .expect("desktop generation"),
            ),
            profile,
            process(100, 101),
            process(200, 201),
        )
    }

    #[test]
    fn never_falls_back_to_an_older_clean_slot_after_corruption() {
        let temp = tempfile::tempdir().expect("temp");
        let store = FileMarkerStore::open(temp.path().join("markers")).expect("marker store");
        let profile = profile();
        let mut marker = clean_marker(profile.clone());
        store.persist(&marker).expect("initial clean marker");
        let lease_id = Uuid::new_v4();
        marker
            .acquire(lease_id, ProfileCapability::SharedSession)
            .expect("lease");
        marker
            .prepare_job(
                lease_id,
                profile.clone(),
                JobId::new(),
                "fixture-job".into(),
            )
            .expect("prepared");
        store.persist(&marker).expect("prepared marker");

        let newest = std::fs::read_dir(temp.path().join("markers"))
            .expect("marker files")
            .map(|entry| entry.expect("marker entry").path())
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().ends_with("-0.json"))
            })
            .expect("newest slot path");
        std::fs::write(newest, b"partial-write").expect("inject torn write");
        assert!(matches!(
            store.load(&profile),
            Err(GuardianError::CorruptMarker)
        ));
    }

    #[test]
    fn clean_marker_survives_an_anchored_store_restart() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("markers");
        let profile = profile();
        let marker = clean_marker(profile.clone());
        FileMarkerStore::open(root.clone())
            .expect("first store")
            .persist(&marker)
            .expect("persist marker");

        let reopened = FileMarkerStore::open(root).expect("reopened store");
        assert_eq!(reopened.load(&profile).expect("restart load"), marker);
    }

    #[test]
    fn same_boot_running_epoch_blocks_replacement_until_clean_is_durable() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("markers");
        let first_generation = DesktopGeneration::from_uuid(Uuid::new_v4());
        let first = FileMarkerStore::open(root.clone()).expect("first store");
        first
            .begin_epoch(first_generation, &boot("11"))
            .expect("running epoch");
        drop(first);

        let replacement = FileMarkerStore::open(root.clone()).expect("replacement store");
        assert!(
            replacement
                .begin_epoch(DesktopGeneration::from_uuid(Uuid::new_v4()), &boot("11"))
                .is_err(),
            "same-boot RUNNING evidence must fail closed"
        );
        replacement
            .prove_epoch_clean(first_generation, &boot("11"))
            .expect("durable clean witness");
        replacement
            .begin_epoch(DesktopGeneration::from_uuid(Uuid::new_v4()), &boot("11"))
            .expect("clean prior epoch admits replacement");
    }

    #[test]
    fn changed_boot_identifier_recovers_an_unclean_prior_epoch() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("markers");
        FileMarkerStore::open(root.clone())
            .expect("first store")
            .begin_epoch(DesktopGeneration::from_uuid(Uuid::new_v4()), &boot("22"))
            .expect("running epoch");

        FileMarkerStore::open(root)
            .expect("replacement store")
            .begin_epoch(DesktopGeneration::from_uuid(Uuid::new_v4()), &boot("33"))
            .expect("a different kernel boot id proves prior processes cannot survive");
    }

    #[test]
    fn epoch_clean_retry_is_idempotent_after_durable_write_ack_loss() {
        let temp = tempfile::tempdir().expect("temp");
        let store = FileMarkerStore::open(temp.path().join("markers")).expect("store");
        let generation = DesktopGeneration::from_uuid(Uuid::new_v4());
        let boot = boot("55");
        store.begin_epoch(generation, &boot).expect("running");
        store
            .prove_epoch_clean(generation, &boot)
            .expect("first clean write");
        store
            .prove_epoch_clean(generation, &boot)
            .expect("retry after caller did not observe first success");
    }

    #[test]
    fn missing_or_malformed_epoch_evidence_in_existing_root_fails_closed() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("markers");
        std::fs::create_dir(&root).expect("pre-existing marker root");
        let store = FileMarkerStore::open(root).expect("store");
        assert!(
            store
                .begin_epoch(DesktopGeneration::from_uuid(Uuid::new_v4()), &boot("44"))
                .is_err()
        );
        assert!(
            store
                .begin_epoch(DesktopGeneration::from_uuid(Uuid::new_v4()), "invalid")
                .is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_reparse_slot_without_mutating_its_target() {
        use std::os::windows::fs::symlink_file;

        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("markers");
        let store = FileMarkerStore::open(root.clone()).expect("store");
        let profile = profile();
        let marker = clean_marker(profile.clone());
        store.persist(&marker).expect("first slot");

        let target = temp.path().join("outside-marker.json");
        std::fs::write(&target, b"outside-must-remain-unchanged").expect("outside target");
        let next_slot = root.join(store.slot_name(&profile, 2).expect("next slot name"));
        symlink_file(&target, &next_slot).expect("slot symlink fixture");

        assert!(store.persist(&marker).is_err());
        assert_eq!(
            std::fs::read(target).expect("outside target read"),
            b"outside-must-remain-unchanged"
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_reparse_marker_root() {
        use std::os::windows::fs::symlink_dir;

        let temp = tempfile::tempdir().expect("temp");
        let target = temp.path().join("marker-target");
        std::fs::create_dir(&target).expect("target directory");
        let root = temp.path().join("marker-root-link");
        symlink_dir(&target, &root).expect("root reparse fixture");

        assert!(
            FileMarkerStore::open(root).is_err(),
            "a reparse-backed marker root must never become storage authority"
        );
        assert_eq!(
            std::fs::read_dir(target)
                .expect("target remains readable")
                .count(),
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_multiply_linked_marker_slot() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("markers");
        let store = FileMarkerStore::open(root.clone()).expect("store");
        let profile = profile();
        let marker = clean_marker(profile.clone());
        store.persist(&marker).expect("first slot");

        let first_slot = root.join(store.slot_name(&profile, 1).expect("first slot name"));
        std::fs::hard_link(&first_slot, temp.path().join("linked-marker.json"))
            .expect("hardlink fixture");
        assert!(store.persist(&marker).is_err());
    }
}
