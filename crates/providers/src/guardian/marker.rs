use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    DesktopGeneration, GuardianError, ProcessIdentity, ProfileCapability, ProfileIdentity,
};

const MARKER_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct JobId(Uuid);

impl JobId {
    pub const fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub const fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl Default for JobId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarkerState {
    Clean,
    Prepared,
    Running,
    Quiescing,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CapabilityHolder {
    lease_id: Uuid,
    capability: ProfileCapability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobRecord {
    id: JobId,
    lease_id: Uuid,
    name: String,
    root: Option<ProcessIdentity>,
    state: MarkerState,
}

impl JobRecord {
    pub const fn id(&self) -> JobId {
        self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn state(&self) -> MarkerState {
        self.state
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileMarker {
    schema_version: u16,
    boot_id: Uuid,
    desktop_generation: DesktopGeneration,
    profile: ProfileIdentity,
    desktop_process: ProcessIdentity,
    guardian_process: ProcessIdentity,
    sealed: bool,
    state: MarkerState,
    holders: Vec<CapabilityHolder>,
    jobs: BTreeMap<JobId, JobRecord>,
}

impl ProfileMarker {
    pub fn new(
        boot_id: Uuid,
        desktop_generation: DesktopGeneration,
        profile: ProfileIdentity,
        desktop_process: ProcessIdentity,
        guardian_process: ProcessIdentity,
    ) -> Self {
        Self {
            schema_version: MARKER_SCHEMA_VERSION,
            boot_id,
            desktop_generation,
            profile,
            desktop_process,
            guardian_process,
            sealed: false,
            state: MarkerState::Clean,
            holders: Vec::new(),
            jobs: BTreeMap::new(),
        }
    }

    pub const fn state(&self) -> MarkerState {
        self.state
    }

    pub const fn profile(&self) -> &ProfileIdentity {
        &self.profile
    }

    pub(crate) const fn desktop_generation(&self) -> DesktopGeneration {
        self.desktop_generation
    }

    pub(crate) const fn owner_processes(&self) -> [ProcessIdentity; 2] {
        [self.desktop_process, self.guardian_process]
    }

    pub fn jobs(&self) -> impl Iterator<Item = &JobRecord> {
        self.jobs.values()
    }

    pub fn acquire(
        &mut self,
        lease_id: Uuid,
        capability: ProfileCapability,
    ) -> Result<(), GuardianError> {
        if self.sealed {
            return Err(GuardianError::Sealed);
        }
        if self
            .holders
            .iter()
            .any(|holder| holder.lease_id == lease_id)
        {
            return Err(GuardianError::Replay);
        }
        let conflicts = match capability {
            ProfileCapability::SharedSession => self
                .holders
                .iter()
                .any(|holder| holder.capability != ProfileCapability::SharedSession),
            ProfileCapability::ExclusiveAuth | ProfileCapability::ExclusiveLifecycle => {
                !self.holders.is_empty()
            }
        };
        if conflicts {
            return Err(GuardianError::ProfileInUse);
        }
        self.holders.push(CapabilityHolder {
            lease_id,
            capability,
        });
        Ok(())
    }

    pub fn release(&mut self, lease_id: Uuid) {
        self.holders.retain(|holder| holder.lease_id != lease_id);
    }

    pub fn seal(&mut self) {
        self.sealed = true;
    }

    pub fn prepare_job(
        &mut self,
        lease_id: Uuid,
        profile: ProfileIdentity,
        job: JobId,
        name: String,
    ) -> Result<(), GuardianError> {
        self.require_profile(&profile)?;
        if self.sealed {
            return Err(GuardianError::Sealed);
        }
        if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
            return Err(GuardianError::InvalidIdentity);
        }
        if !self
            .holders
            .iter()
            .any(|holder| holder.lease_id == lease_id)
        {
            return Err(GuardianError::LeaseExpired);
        }
        if self.jobs.contains_key(&job) {
            return Err(GuardianError::Replay);
        }
        self.jobs.insert(
            job,
            JobRecord {
                id: job,
                lease_id,
                name,
                root: None,
                state: MarkerState::Prepared,
            },
        );
        self.state = MarkerState::Prepared;
        Ok(())
    }

    pub fn commit_root(
        &mut self,
        profile: ProfileIdentity,
        job: JobId,
        root: ProcessIdentity,
    ) -> Result<(), GuardianError> {
        self.require_profile(&profile)?;
        let record = self.jobs.get_mut(&job).ok_or(GuardianError::UnknownJob)?;
        if record.state != MarkerState::Prepared || record.root.is_some() {
            return Err(GuardianError::InvalidTransition);
        }
        record.root = Some(root);
        record.state = MarkerState::Running;
        self.state = MarkerState::Running;
        Ok(())
    }

    pub(crate) fn begin_quiescence(
        &mut self,
        profile: ProfileIdentity,
        job: JobId,
    ) -> Result<(), GuardianError> {
        self.require_profile(&profile)?;
        let record = self.jobs.get_mut(&job).ok_or(GuardianError::UnknownJob)?;
        if !matches!(record.state, MarkerState::Prepared | MarkerState::Running) {
            return Err(GuardianError::InvalidTransition);
        }
        record.state = MarkerState::Quiescing;
        self.state = MarkerState::Quiescing;
        Ok(())
    }

    pub(crate) fn prove_clean(
        &mut self,
        profile: ProfileIdentity,
        job: JobId,
    ) -> Result<(), GuardianError> {
        self.require_profile(&profile)?;
        let record = self.jobs.get_mut(&job).ok_or(GuardianError::UnknownJob)?;
        if record.state != MarkerState::Quiescing {
            return Err(GuardianError::InvalidTransition);
        }
        record.state = MarkerState::Clean;
        if self
            .jobs
            .values()
            .all(|record| record.state == MarkerState::Clean)
        {
            self.state = MarkerState::Clean;
            // A job's CLEAN proof ends process custody, not the enclosing session
            // lease. Keep account exclusion and multi-turn admission until the
            // owner explicitly releases its lease (or seals the generation).
        }
        Ok(())
    }

    pub fn block(&mut self) {
        self.sealed = true;
        self.state = MarkerState::Blocked;
    }

    pub(crate) fn job_state(&self, job: JobId) -> Result<MarkerState, GuardianError> {
        self.jobs
            .get(&job)
            .map(|record| record.state)
            .ok_or(GuardianError::UnknownJob)
    }

    pub(crate) fn retire_clean(&mut self, job: JobId) -> Result<(), GuardianError> {
        let record = self.jobs.get(&job).ok_or(GuardianError::UnknownJob)?;
        if record.state != MarkerState::Clean {
            return Err(GuardianError::InvalidTransition);
        }
        self.jobs.remove(&job);
        if self
            .jobs
            .values()
            .all(|record| record.state == MarkerState::Clean)
        {
            self.state = MarkerState::Clean;
        }
        Ok(())
    }

    fn require_profile(&self, profile: &ProfileIdentity) -> Result<(), GuardianError> {
        if &self.profile == profile {
            Ok(())
        } else {
            Err(GuardianError::ObjectMismatch)
        }
    }

    fn validate(&self) -> Result<(), GuardianError> {
        if self.schema_version != MARKER_SCHEMA_VERSION {
            return Err(GuardianError::UnknownSchema(self.schema_version));
        }
        self.profile.validate()?;
        if matches!(
            self.profile.subject_kind(),
            super::GuardianSubjectKind::InternalTerminal
                | super::GuardianSubjectKind::InternalProbe
        ) && self.profile.account_id() != self.desktop_generation.as_uuid()
        {
            return Err(GuardianError::InvalidIdentity);
        }
        if self.boot_id.is_nil()
            || self.desktop_generation.as_uuid().is_nil()
            || !self.desktop_process.is_valid()
            || !self.guardian_process.is_valid()
        {
            return Err(GuardianError::InvalidIdentity);
        }
        if self.state == MarkerState::Clean
            && self
                .jobs
                .values()
                .any(|job| job.state != MarkerState::Clean)
        {
            return Err(GuardianError::CorruptMarker);
        }
        Ok(())
    }
}

pub fn encode_marker(marker: &ProfileMarker) -> Result<Vec<u8>, GuardianError> {
    marker.validate()?;
    serde_json::to_vec(marker).map_err(GuardianError::MarkerEncoding)
}

pub fn decode_marker(bytes: &[u8]) -> Result<ProfileMarker, GuardianError> {
    let marker: ProfileMarker =
        serde_json::from_slice(bytes).map_err(GuardianError::MarkerEncoding)?;
    marker.validate()?;
    Ok(marker)
}

#[cfg(test)]
mod tests {
    use kalcode_contracts::agent::ProviderId;

    use super::*;
    use crate::guardian::{ProfileGeneration, ProfileIdentity};

    fn profile() -> ProfileIdentity {
        ProfileIdentity::new(
            ProviderId::new(ProviderId::CODEX),
            Uuid::new_v4(),
            ProfileGeneration::from_uuid(Uuid::new_v4()),
        )
        .expect("profile")
    }

    fn process(pid: u32) -> ProcessIdentity {
        ProcessIdentity::new(pid, u64::from(pid) + 1).expect("process")
    }

    #[test]
    fn clean_transition_is_object_bound_and_not_publicly_fabricated() {
        let profile = profile();
        let mut marker = ProfileMarker::new(
            Uuid::new_v4(),
            DesktopGeneration::from_uuid(Uuid::new_v4()),
            profile.clone(),
            process(10),
            process(20),
        );
        let lease = Uuid::new_v4();
        let job = JobId::new();
        marker
            .acquire(lease, ProfileCapability::SharedSession)
            .expect("lease");
        marker
            .prepare_job(lease, profile.clone(), job, "fixture".into())
            .expect("prepared");
        let swapped = ProfileIdentity::new(
            ProviderId::new(ProviderId::CODEX),
            Uuid::new_v4(),
            ProfileGeneration::from_uuid(Uuid::new_v4()),
        )
        .expect("swapped");
        assert!(marker.commit_root(swapped, job, process(30)).is_err());
        marker
            .commit_root(profile.clone(), job, process(30))
            .expect("running");
        marker
            .begin_quiescence(profile.clone(), job)
            .expect("quiescing");
        marker.prove_clean(profile, job).expect("clean");
        assert_eq!(marker.state(), MarkerState::Clean);
    }

    #[test]
    fn completed_job_preserves_live_session_lease_and_exclusive_account_fence() {
        let profile = profile();
        let mut marker = ProfileMarker::new(
            Uuid::new_v4(),
            DesktopGeneration::from_uuid(Uuid::new_v4()),
            profile.clone(),
            process(10),
            process(20),
        );
        let lease = Uuid::new_v4();
        marker
            .acquire(lease, ProfileCapability::SharedSession)
            .expect("session lease");
        for turn in 0..2 {
            let job = JobId::new();
            marker
                .prepare_job(lease, profile.clone(), job, format!("turn-{turn}"))
                .expect("live lease admits next turn");
            marker
                .commit_root(profile.clone(), job, process(30))
                .unwrap();
            marker.begin_quiescence(profile.clone(), job).unwrap();
            marker.prove_clean(profile.clone(), job).unwrap();
            marker.retire_clean(job).unwrap();
            assert!(
                marker
                    .acquire(Uuid::new_v4(), ProfileCapability::ExclusiveAuth)
                    .is_err(),
                "a finished process must not release its still-live session's account fence"
            );
        }
        marker.release(lease);
        assert!(
            marker
                .prepare_job(lease, profile.clone(), JobId::new(), "expired".into())
                .is_err()
        );
        marker
            .acquire(Uuid::new_v4(), ProfileCapability::ExclusiveAuth)
            .expect("explicit session release permits sign-in");
    }
}
