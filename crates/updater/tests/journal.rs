use kalcode_updater::{
    InstallAttempt, InstallBinding, InstallKind, InstallOutcome, MAX_UPDATE_STATE_BYTES,
    MacSwapAttempt, MacSwapPhase, UpdateChannel, UpdateJournal, UpdateTarget,
};

fn binding() -> InstallBinding {
    InstallBinding {
        target: UpdateTarget::WindowsX86_64,
        source_sha256: "c".repeat(64),
        signing_requirement_sha256: "d".repeat(64),
    }
}

fn attempt() -> InstallAttempt {
    InstallAttempt {
        kind: InstallKind::Upgrade,
        from_version: "0.1.5".into(),
        to_version: "0.1.6".into(),
        sha256: "a".repeat(64),
        binding: Some(binding()),
        mac_swap: None,
        started_at: "2026-09-25T12:00:00Z".into(),
    }
}

fn rollback_attempt() -> InstallAttempt {
    InstallAttempt {
        kind: InstallKind::Rollback,
        from_version: "0.1.6".into(),
        to_version: "0.1.5".into(),
        sha256: "b".repeat(64),
        binding: Some(binding()),
        mac_swap: None,
        started_at: "2026-09-25T12:01:00Z".into(),
    }
}

#[test]
fn new_install_attempt_requires_target_source_and_signing_identity_binding() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    let mut journal = UpdateJournal::load(&path).unwrap();
    let mut unbound = attempt();
    unbound.binding = None;

    assert_eq!(
        journal.record_install_attempt(unbound).unwrap_err().code(),
        "update_install_record_invalid"
    );
    journal.record_install_attempt(attempt()).unwrap();
    let reopened = UpdateJournal::load(&path).unwrap();
    let stored = reopened.state().install_attempt.as_ref().unwrap();
    assert_eq!(
        stored.binding.as_ref().unwrap().target,
        UpdateTarget::WindowsX86_64
    );
}

#[test]
fn mac_swap_transitions_are_durable_ordered_and_rollbackable_after_launch_fault() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    let mut mac_attempt = attempt();
    mac_attempt.binding = Some(InstallBinding {
        target: UpdateTarget::DarwinAarch64,
        source_sha256: "c".repeat(64),
        signing_requirement_sha256: "d".repeat(64),
    });
    mac_attempt.mac_swap = Some(MacSwapAttempt {
        current_app: temp.path().join("KalCode.app"),
        staged_app: temp.path().join(".KalCode-update-test.app"),
        parent_pid: 42,
        parent_identity_sha256: "e".repeat(64),
        phase: MacSwapPhase::Prepared,
    });

    let mut journal = UpdateJournal::load(&path).unwrap();
    journal.record_install_attempt(mac_attempt).unwrap();
    assert_eq!(
        journal
            .mark_mac_swap_phase(MacSwapPhase::Swapped, MacSwapPhase::Launched)
            .unwrap_err()
            .code(),
        "update_install_record_invalid"
    );
    journal
        .mark_mac_swap_phase(MacSwapPhase::Prepared, MacSwapPhase::Swapped)
        .unwrap();
    let mut reopened = UpdateJournal::load(&path).unwrap();
    assert_eq!(
        reopened
            .state()
            .install_attempt
            .as_ref()
            .unwrap()
            .mac_swap
            .as_ref()
            .unwrap()
            .phase,
        MacSwapPhase::Swapped
    );
    reopened
        .mark_mac_swap_phase(MacSwapPhase::Swapped, MacSwapPhase::Launched)
        .unwrap();
    reopened
        .cancel_install_attempt("mac_update_health_check_failed")
        .unwrap();
    let recovered = UpdateJournal::load(&path).unwrap();
    assert!(recovered.state().install_attempt.is_none());
    assert_eq!(
        recovered.state().last_failure.as_deref(),
        Some("mac_update_health_check_failed")
    );
}

#[test]
fn mac_power_loss_reconciles_each_durable_swap_boundary() {
    for (name, phase, running_version, expected) in [
        (
            "before-swap",
            MacSwapPhase::Prepared,
            "0.1.5",
            InstallOutcome::PreviousVersionPreserved,
        ),
        (
            "after-unrecorded-swap",
            MacSwapPhase::Prepared,
            "0.1.6",
            InstallOutcome::Updated,
        ),
        (
            "after-swap",
            MacSwapPhase::Swapped,
            "0.1.6",
            InstallOutcome::Updated,
        ),
        (
            "after-launch",
            MacSwapPhase::Launched,
            "0.1.6",
            InstallOutcome::Updated,
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(format!("{name}.json"));
        let mut mac_attempt = attempt();
        mac_attempt.binding = Some(InstallBinding {
            target: UpdateTarget::DarwinAarch64,
            source_sha256: "c".repeat(64),
            signing_requirement_sha256: "d".repeat(64),
        });
        mac_attempt.mac_swap = Some(MacSwapAttempt {
            current_app: temp.path().join("KalCode.app"),
            staged_app: temp.path().join(".KalCode-update-test.app"),
            parent_pid: 42,
            parent_identity_sha256: "e".repeat(64),
            phase: MacSwapPhase::Prepared,
        });
        let mut journal = UpdateJournal::load(&path).unwrap();
        journal.record_install_attempt(mac_attempt).unwrap();
        if matches!(phase, MacSwapPhase::Swapped | MacSwapPhase::Launched) {
            journal
                .mark_mac_swap_phase(MacSwapPhase::Prepared, MacSwapPhase::Swapped)
                .unwrap();
        }
        if phase == MacSwapPhase::Launched {
            journal
                .mark_mac_swap_phase(MacSwapPhase::Swapped, MacSwapPhase::Launched)
                .unwrap();
        }

        let mut restarted = UpdateJournal::load(&path).unwrap();
        assert_eq!(
            restarted.reconcile_startup(running_version).unwrap(),
            expected
        );
        assert!(restarted.state().install_attempt.is_none());
    }
}

#[test]
fn mac_install_attempt_can_only_be_created_in_prepared_phase() {
    let temp = tempfile::tempdir().unwrap();
    let mut invalid = attempt();
    invalid.binding = Some(InstallBinding {
        target: UpdateTarget::DarwinAarch64,
        source_sha256: "c".repeat(64),
        signing_requirement_sha256: "d".repeat(64),
    });
    invalid.mac_swap = Some(MacSwapAttempt {
        current_app: temp.path().join("KalCode.app"),
        staged_app: temp.path().join(".KalCode-update-test.app"),
        parent_pid: 42,
        parent_identity_sha256: "e".repeat(64),
        phase: MacSwapPhase::Swapped,
    });
    let mut journal = UpdateJournal::load(temp.path().join("updater.json")).unwrap();
    assert_eq!(
        journal.record_install_attempt(invalid).unwrap_err().code(),
        "update_install_record_invalid"
    );
}

#[test]
fn forward_only_mac_fence_changes_legacy_attempt_identity_and_is_restart_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    let mut mac_attempt = attempt();
    mac_attempt.binding = Some(InstallBinding {
        target: UpdateTarget::DarwinAarch64,
        source_sha256: "c".repeat(64),
        signing_requirement_sha256: "d".repeat(64),
    });
    mac_attempt.mac_swap = Some(MacSwapAttempt {
        current_app: temp.path().join("KalCode.app"),
        staged_app: temp.path().join(".KalCode-update-test.app"),
        parent_pid: 42,
        parent_identity_sha256: "e".repeat(64),
        phase: MacSwapPhase::Prepared,
    });
    let mut journal = UpdateJournal::load(&path).unwrap();
    journal.record_install_attempt(mac_attempt).unwrap();
    journal
        .mark_mac_swap_phase(MacSwapPhase::Prepared, MacSwapPhase::Swapped)
        .unwrap();
    journal
        .mark_mac_swap_phase(MacSwapPhase::Swapped, MacSwapPhase::Launched)
        .unwrap();
    let captured_by_legacy_helper = journal.state().install_attempt.clone().unwrap();

    journal.fence_forward_only_mac_install("0.1.6").unwrap();
    let fenced = journal.state().install_attempt.clone().unwrap();
    assert_ne!(fenced, captured_by_legacy_helper);
    assert!(
        fenced
            .started_at
            .starts_with(&captured_by_legacy_helper.started_at)
    );

    let mut reopened = UpdateJournal::load(&path).unwrap();
    let first_fence = reopened.state().install_attempt.clone().unwrap();
    reopened.fence_forward_only_mac_install("0.1.6").unwrap();
    assert_eq!(
        reopened.state().install_attempt.as_ref(),
        Some(&first_fence)
    );

    assert_eq!(
        reopened.reconcile_startup("0.1.6").unwrap(),
        InstallOutcome::Updated
    );
    assert!(reopened.state().install_attempt.is_none());
    assert_eq!(
        reopened.state().last_successful_version.as_deref(),
        Some("0.1.6")
    );
}

#[test]
fn forward_only_mac_fence_rejects_the_wrong_target_phase_or_version() {
    let temp = tempfile::tempdir().unwrap();
    let mut journal = UpdateJournal::load(temp.path().join("updater.json")).unwrap();
    journal.record_install_attempt(attempt()).unwrap();
    assert_eq!(
        journal
            .fence_forward_only_mac_install("0.1.6")
            .unwrap_err()
            .code(),
        "update_install_record_invalid"
    );
}

#[test]
fn journal_defaults_to_stable_and_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    let mut journal = UpdateJournal::load(&path).unwrap();
    assert_eq!(journal.state().channel, UpdateChannel::Stable);
    journal.set_channel(UpdateChannel::Beta).unwrap();

    let reopened = UpdateJournal::load(&path).unwrap();
    assert_eq!(reopened.state().channel, UpdateChannel::Beta);
}

#[test]
fn install_attempt_reconciles_success_or_preserved_previous_version() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    let mut journal = UpdateJournal::load(&path).unwrap();
    journal.record_install_attempt(attempt()).unwrap();

    assert_eq!(
        journal.reconcile_startup("0.1.6").unwrap(),
        InstallOutcome::Updated
    );
    assert!(journal.state().install_attempt.is_none());
    assert_eq!(
        journal.state().last_successful_version.as_deref(),
        Some("0.1.6")
    );

    journal.record_install_attempt(attempt()).unwrap();
    assert_eq!(
        journal.reconcile_startup("0.1.5").unwrap(),
        InstallOutcome::PreviousVersionPreserved
    );
    assert!(journal.state().install_attempt.is_none());
    assert_eq!(
        journal.state().last_failure.as_deref(),
        Some("install_did_not_advance")
    );
}

#[test]
fn same_public_version_build_attempts_are_ordered_and_reconciled_exactly() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    let mut journal = UpdateJournal::load(&path).unwrap();
    let mut build = attempt();
    build.from_version = "0.1.7+217".into();
    build.to_version = "0.1.7+218".into();

    journal.record_install_attempt(build.clone()).unwrap();
    let mut reopened = UpdateJournal::load(&path).unwrap();
    assert_eq!(
        reopened.reconcile_startup("0.1.7+218").unwrap(),
        InstallOutcome::Updated
    );
    assert_eq!(
        reopened.state().last_successful_version.as_deref(),
        Some("0.1.7+218")
    );

    std::mem::swap(&mut build.from_version, &mut build.to_version);
    assert_eq!(
        reopened.record_install_attempt(build).unwrap_err().code(),
        "update_install_record_invalid"
    );
}

#[test]
fn rollback_attempt_is_durable_and_reconciles_only_the_exact_previous_version() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    let mut journal = UpdateJournal::load(&path).unwrap();
    journal.record_install_attempt(rollback_attempt()).unwrap();

    let mut reopened = UpdateJournal::load(&path).unwrap();
    assert_eq!(
        reopened.reconcile_startup("0.1.5").unwrap(),
        InstallOutcome::RolledBack
    );
    assert_eq!(
        reopened.state().last_successful_version.as_deref(),
        Some("0.1.5")
    );

    let mut invalid = rollback_attempt();
    invalid.to_version = "0.1.7".into();
    assert_eq!(
        reopened.record_install_attempt(invalid).unwrap_err().code(),
        "update_install_record_invalid"
    );
}

#[test]
fn corrupt_authoritative_journal_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    std::fs::write(&path, b"not json").unwrap();
    let error = UpdateJournal::load(&path).unwrap_err();
    assert_eq!(error.code(), "update_journal_corrupt");
}

#[test]
fn legacy_journal_cannot_smuggle_target_or_swap_authority() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    let malicious = serde_json::json!({
        "schemaVersion": 1,
        "channel": "stable",
        "installAttempt": {
            "kind": "upgrade",
            "fromVersion": "0.1.5",
            "toVersion": "0.1.6",
            "sha256": "a".repeat(64),
            "binding": {
                "target": "darwin-aarch64",
                "sourceSha256": "b".repeat(64),
                "signingRequirementSha256": "c".repeat(64)
            },
            "macSwap": {
                "currentApp": temp.path().join("KalCode.app"),
                "stagedApp": temp.path().join(".KalCode-update-test.app"),
                "parentPid": 42,
                "parentIdentitySha256": "d".repeat(64),
                "phase": "prepared"
            },
            "startedAt": "1"
        },
        "lastSuccessfulVersion": null,
        "lastFailure": null
    });
    std::fs::write(&path, serde_json::to_vec(&malicious).unwrap()).unwrap();
    assert_eq!(
        UpdateJournal::load(&path).unwrap_err().code(),
        "update_journal_corrupt"
    );
}

#[test]
fn oversized_authoritative_journal_is_rejected_before_json_parsing() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(MAX_UPDATE_STATE_BYTES + 1)
        .unwrap();

    let error = UpdateJournal::load(&path).unwrap_err();
    assert_eq!(error.code(), "update_journal_corrupt");
}

#[test]
fn interrupted_atomic_replace_recovers_the_last_valid_state() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("updater.json");
    let mut journal = UpdateJournal::load(&path).unwrap();
    journal.set_channel(UpdateChannel::Dev).unwrap();
    let previous = path.with_extension("json.previous");
    std::fs::rename(&path, &previous).unwrap();
    std::fs::write(path.with_extension("json.next"), b"partial").unwrap();

    let recovered = UpdateJournal::load(&path).unwrap();
    assert_eq!(recovered.state().channel, UpdateChannel::Dev);
    assert!(path.exists());
}
