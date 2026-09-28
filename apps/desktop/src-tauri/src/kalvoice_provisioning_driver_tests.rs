//! The zero-setup driver against a scripted host: no network, catalog, keychain or process.
use super::*;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

struct FakeHost {
    choices: Mutex<Choices>,
    speech: AtomicBool,
    reasoning: AtomicBool,
    stopping: AtomicBool,
    /// Scripted results per download (default: success, which installs the component).
    script: Mutex<VecDeque<Result<(), ComponentManagerError>>>,
    downloads: Mutex<Vec<Component>>,
    installed: Mutex<Vec<Component>>,
    changes: Mutex<usize>,
}

impl FakeHost {
    fn new(speech_installed: bool) -> Arc<Self> {
        Arc::new(Self {
            choices: Mutex::new(Choices {
                speech: true,
                intelligence: true,
                paused: false,
            }),
            speech: AtomicBool::new(speech_installed),
            reasoning: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            script: Mutex::new(VecDeque::new()),
            downloads: Mutex::new(Vec::new()),
            installed: Mutex::new(Vec::new()),
            changes: Mutex::new(0),
        })
    }

    fn script(&self, results: impl IntoIterator<Item = Result<(), ComponentManagerError>>) {
        self.script.lock().unwrap().extend(results);
    }

    fn downloads(&self) -> Vec<Component> {
        self.downloads.lock().unwrap().clone()
    }
}

impl ProvisioningHost for FakeHost {
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }
    fn choices(&self) -> Option<Choices> {
        Some(*self.choices.lock().unwrap())
    }
    fn speech_installed(&self) -> bool {
        self.speech.load(Ordering::SeqCst)
    }
    fn reasoning_installed(&self) -> bool {
        self.reasoning.load(Ordering::SeqCst)
    }
    fn download(&self, component: Component) -> Result<(), ComponentManagerError> {
        self.downloads.lock().unwrap().push(component);
        let result = self.script.lock().unwrap().pop_front().unwrap_or(Ok(()));
        if result.is_ok() {
            match component {
                Component::Speech => self.speech.store(true, Ordering::SeqCst),
                Component::Intelligence => self.reasoning.store(true, Ordering::SeqCst),
            }
        }
        result
    }
    fn installed(&self, component: Component) {
        self.installed.lock().unwrap().push(component);
    }
    fn changed(&self) {
        *self.changes.lock().unwrap() += 1;
    }
}

fn eventually(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn short(round: u32) -> Duration {
    Duration::from_millis(15 * u64::from(round))
}

fn an_hour(_: u32) -> Duration {
    Duration::from_secs(60 * 60)
}

#[test]
fn an_installed_speech_model_is_reused_and_never_downloaded() {
    // The owner's machine: tiny.en installed and in use. Intelligence off to isolate speech.
    let host = FakeHost::new(true);
    host.choices.lock().unwrap().intelligence = false;
    Provisioner::default().run(host.as_ref());
    assert!(host.downloads().is_empty());
    assert!(host.installed.lock().unwrap().is_empty());
}

#[test]
fn a_fresh_install_downloads_the_default_speech_model_once_then_local_intelligence() {
    let host = FakeHost::new(false);
    let provisioner = Provisioner::default();
    provisioner.run(host.as_ref());
    assert_eq!(
        host.downloads(),
        vec![Component::Speech, Component::Intelligence]
    );
    assert_eq!(
        *host.installed.lock().unwrap(),
        vec![Component::Speech, Component::Intelligence]
    );
    // Nothing is pending once both are installed; a second run fetches nothing.
    assert!(provisioner.snapshot(&[], || (0, 0)).is_empty());
    provisioner.run(host.as_ref());
    assert_eq!(host.downloads().len(), 2);
    assert_eq!(Component::Speech.model_id(), "tiny.en");
    assert_eq!(Component::Intelligence.model_id(), "local-reasoning");
}

#[test]
fn a_speech_model_the_owner_removed_is_not_downloaded_again() {
    let host = FakeHost::new(false);
    host.choices.lock().unwrap().speech = false;
    Provisioner::default().run(host.as_ref());
    assert!(host.downloads().is_empty());
    // Local intelligence follows only a ready speech model.
    assert!(!host.reasoning_installed());
}

#[test]
fn local_intelligence_waits_for_a_ready_speech_model_and_honours_its_preference() {
    let host = FakeHost::new(true);
    host.choices.lock().unwrap().intelligence = false;
    let provisioner = Provisioner::default();
    provisioner.run(host.as_ref());
    assert!(host.downloads().is_empty());
    host.choices.lock().unwrap().intelligence = true;
    provisioner.run(host.as_ref());
    assert_eq!(host.downloads(), vec![Component::Intelligence]);
}

#[test]
fn a_paused_download_stays_paused_across_runs_until_resumed() {
    let host = FakeHost::new(true);
    host.choices.lock().unwrap().paused = true;
    let provisioner = Provisioner::default();
    provisioner.run(host.as_ref());
    assert!(host.downloads().is_empty());
    assert!(provisioner.paused());
    let items = provisioner.snapshot(&[], || (212, 852));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].model_id, "local-reasoning");
    assert_eq!(items[0].phase, ProvisioningPhase::Paused);
    assert_eq!((items[0].received_bytes, items[0].total_bytes), (212, 852));
    // A restart (a new driver over the same stored choice) is still paused.
    let restarted = Provisioner::default();
    restarted.run(host.as_ref());
    assert!(host.downloads().is_empty());
    // Resume.
    host.choices.lock().unwrap().paused = false;
    restarted.run(host.as_ref());
    assert_eq!(host.downloads(), vec![Component::Intelligence]);
    assert!(!restarted.paused());
}

#[test]
fn pausing_mid_download_stops_without_scheduling_a_retry() {
    let host = FakeHost::new(true);
    host.script([Err(ComponentManagerError::Cancelled)]);
    // The pause is stored before the cancel reaches the download.
    host.choices.lock().unwrap().paused = false;
    let provisioner = Provisioner::with_delay(an_hour);
    let paused_host = PauseOnDownload(host.clone());
    provisioner.run(&paused_host);
    assert_eq!(host.downloads(), vec![Component::Intelligence]);
    assert!(provisioner.paused());
}

/// Records the owner's pause at the moment the first download starts.
struct PauseOnDownload(Arc<FakeHost>);
impl ProvisioningHost for PauseOnDownload {
    fn stopping(&self) -> bool {
        self.0.stopping()
    }
    fn choices(&self) -> Option<Choices> {
        self.0.choices()
    }
    fn speech_installed(&self) -> bool {
        self.0.speech_installed()
    }
    fn reasoning_installed(&self) -> bool {
        self.0.reasoning_installed()
    }
    fn download(&self, component: Component) -> Result<(), ComponentManagerError> {
        self.0.choices.lock().unwrap().paused = true;
        self.0.download(component)
    }
    fn installed(&self, component: Component) {
        self.0.installed(component);
    }
    fn changed(&self) {
        self.0.changed();
    }
}

#[test]
fn failures_retry_on_the_backoff_schedule_without_a_click() {
    let host = FakeHost::new(false);
    host.script([
        Err(ComponentManagerError::CatalogUnavailable),
        Err(ComponentManagerError::AcquisitionFailed(
            crate::kalvoice_components::ComponentAcquisitionFailure::Network,
        )),
    ]);
    let provisioner = Provisioner::with_delay(short);
    let started = Instant::now();
    provisioner.run(host.as_ref());
    // Two failed speech attempts, then speech and intelligence install.
    assert_eq!(
        host.downloads(),
        vec![
            Component::Speech,
            Component::Speech,
            Component::Speech,
            Component::Intelligence
        ]
    );
    assert!(started.elapsed() >= short(1) + short(2));
    assert!(host.reasoning_installed());
}

#[test]
fn a_scheduled_retry_is_reported_truthfully_and_focus_retries_at_once() {
    let host = FakeHost::new(false);
    host.script([Err(ComponentManagerError::CatalogUnavailable)]);
    let provisioner = Arc::new(Provisioner::with_delay(an_hour));
    let driver = {
        let provisioner = provisioner.clone();
        let host = host.clone();
        std::thread::spawn(move || provisioner.run(host.as_ref()))
    };
    eventually("the scheduled retry", || {
        provisioner
            .snapshot(&[], || (0, 0))
            .first()
            .is_some_and(|item| item.phase == ProvisioningPhase::RetryScheduled)
    });
    let items = provisioner.snapshot(&[], || (0, 0));
    assert_eq!(items[0].model_id, "tiny.en");
    assert!(items[0].automatic);
    assert_eq!(
        items[0].reason.as_deref(),
        Some("component_catalog_unavailable")
    );
    let seconds = items[0].retry_in_seconds.unwrap();
    assert!((3590..=3600).contains(&seconds), "{seconds}");
    // KalCode comes back to the front: the waiting driver retries now, not in an hour.
    provisioner.nudge();
    driver.join().unwrap();
    assert_eq!(
        host.downloads(),
        vec![
            Component::Speech,
            Component::Speech,
            Component::Intelligence
        ]
    );
}

#[test]
fn a_second_request_wakes_the_running_driver_instead_of_starting_another() {
    let host = FakeHost::new(false);
    host.script([Err(ComponentManagerError::CatalogUnavailable)]);
    let provisioner = Arc::new(Provisioner::with_delay(an_hour));
    let driver = {
        let provisioner = provisioner.clone();
        let host = host.clone();
        std::thread::spawn(move || provisioner.run(host.as_ref()))
    };
    eventually("the scheduled retry", || host.downloads().len() == 1);
    std::thread::sleep(Duration::from_millis(30));
    // keep_warm after a manual install calls run() again: it returns at once and nudges.
    provisioner.run(host.as_ref());
    driver.join().unwrap();
    assert_eq!(host.downloads().len(), 3);
}

#[test]
fn a_driver_waiting_out_its_backoff_stops_promptly_at_shutdown() {
    let host = FakeHost::new(false);
    host.script([Err(ComponentManagerError::CatalogUnavailable)]);
    let provisioner = Arc::new(Provisioner::with_delay(an_hour));
    let driver = {
        let provisioner = provisioner.clone();
        let host = host.clone();
        std::thread::spawn(move || provisioner.run(host.as_ref()))
    };
    eventually("the scheduled retry", || host.downloads().len() == 1);
    let stopped = Instant::now();
    host.stopping.store(true, Ordering::SeqCst);
    driver.join().unwrap();
    assert!(stopped.elapsed() < Duration::from_secs(2));
    assert_eq!(host.downloads().len(), 1);
}

#[test]
fn an_owner_started_download_is_left_to_finish_on_its_own() {
    let host = FakeHost::new(false);
    host.script([Err(ComponentManagerError::AlreadyDownloading)]);
    let provisioner = Provisioner::with_delay(an_hour);
    provisioner.run(host.as_ref());
    assert_eq!(host.downloads(), vec![Component::Speech]);
    assert!(provisioner.snapshot(&[], || (0, 0)).is_empty());
}

#[test]
fn running_downloads_report_their_observed_phase_and_consent() {
    let provisioner = Provisioner::default();
    let snapshot = |phase, consent| DownloadSnapshot {
        model_id: "tiny.en".into(),
        consent,
        phase,
        received_bytes: 31,
        total_bytes: 78,
    };
    for (phase, expected, reason) in [
        (DownloadPhase::Preparing, ProvisioningPhase::Preparing, None),
        (
            DownloadPhase::WaitingForResources("memory"),
            ProvisioningPhase::WaitingForResources,
            Some("memory"),
        ),
        (
            DownloadPhase::WaitingForTalk,
            ProvisioningPhase::WaitingForTalk,
            Some("push_to_talk"),
        ),
        (
            DownloadPhase::Downloading,
            ProvisioningPhase::Downloading,
            None,
        ),
        (DownloadPhase::Verifying, ProvisioningPhase::Verifying, None),
    ] {
        let items = provisioner.snapshot(
            &[snapshot(phase, DownloadConsent::AutomaticDefault)],
            || panic!("paused bytes are read only while paused"),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].phase, expected);
        assert_eq!(items[0].reason.as_deref(), reason);
        assert!(items[0].automatic);
        assert_eq!((items[0].received_bytes, items[0].total_bytes), (31, 78));
    }
    let manual = provisioner.snapshot(
        &[snapshot(DownloadPhase::Downloading, DownloadConsent::User)],
        || (0, 0),
    );
    assert!(!manual[0].automatic);
}

#[test]
fn progress_is_throttled_but_phase_changes_publish_at_once() {
    let provisioner = Provisioner::default();
    let item = |phase, received| ComponentProvisioning {
        model_id: "tiny.en".into(),
        automatic: true,
        phase,
        received_bytes: received,
        total_bytes: 100,
        reason: None,
        retry_in_seconds: None,
    };
    assert!(provisioner.should_publish(&[item(ProvisioningPhase::Downloading, 1)]));
    assert!(!provisioner.should_publish(&[item(ProvisioningPhase::Downloading, 2)]));
    assert!(provisioner.should_publish(&[item(ProvisioningPhase::Verifying, 100)]));
    assert!(provisioner.should_publish(&[]));
    assert!(!provisioner.should_publish(&[]));
    std::thread::sleep(PROGRESS_INTERVAL);
    assert!(provisioner.should_publish(&[item(ProvisioningPhase::Downloading, 3)]));
    assert!(!provisioner.should_publish(&[item(ProvisioningPhase::Downloading, 4)]));
    std::thread::sleep(PROGRESS_INTERVAL);
    assert!(provisioner.should_publish(&[item(ProvisioningPhase::Downloading, 5)]));
}

#[test]
fn a_permanent_failure_stops_automatic_attempts_with_a_truthful_reason() {
    for (error, reason) in [
        (
            ComponentManagerError::CatalogInvalid,
            "components_unverified",
        ),
        (
            ComponentManagerError::AcquisitionFailed(
                crate::kalvoice_components::ComponentAcquisitionFailure::WrongTarget,
            ),
            "components_unsupported",
        ),
        (ComponentManagerError::ConsentRequired, "consent_required"),
    ] {
        let host = FakeHost::new(false);
        host.script([Err(error)]);
        // An hour-long backoff would hang this test if a permanent failure were retried.
        let provisioner = Provisioner::with_delay(an_hour);
        provisioner.run(host.as_ref());
        assert_eq!(host.downloads(), vec![Component::Speech], "{error:?}");
        let items = provisioner.snapshot(&[], || (0, 0));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].phase, ProvisioningPhase::Unavailable);
        assert_eq!(items[0].reason.as_deref(), Some(reason));
        assert_eq!(items[0].retry_in_seconds, None);
        // Focus, preference changes and keep_warm do not restart it in this runtime.
        provisioner.nudge();
        provisioner.run(host.as_ref());
        assert_eq!(host.downloads().len(), 1);
        // The next launch (a new runtime) tries again.
        Provisioner::default().run(host.as_ref());
        assert_eq!(
            host.downloads(),
            vec![
                Component::Speech,
                Component::Speech,
                Component::Intelligence
            ]
        );
    }
}

#[test]
fn a_manual_install_after_a_permanent_stop_continues_with_the_next_component() {
    let host = FakeHost::new(false);
    host.script([Err(ComponentManagerError::CatalogInvalid)]);
    let provisioner = Provisioner::with_delay(an_hour);
    provisioner.run(host.as_ref());
    // The owner downloads the speech model manually; its completion asks for the next step.
    host.speech.store(true, Ordering::SeqCst);
    provisioner.run(host.as_ref());
    assert_eq!(
        host.downloads(),
        vec![Component::Speech, Component::Intelligence]
    );
}
