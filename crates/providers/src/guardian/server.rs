use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Write};
use std::time::{Duration, Instant};

use super::marker::JobId;
use super::platform::{RecoveryLock, RecoveryLockRole, WindowsJob};
use super::protocol::{
    Envelope, InboundGuard, ProtocolError, Request, Response, read_frame, write_frame,
};
use super::store::FileMarkerStore;
use super::{DesktopGeneration, GuardianError};

const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
const DRAIN_POLL: Duration = Duration::from_millis(10);
const RETAIN_RETRY_DELAY: Duration = Duration::from_millis(100);

trait DrainJob {
    fn terminate(&self) -> Result<(), GuardianError>;
    fn active_processes(&self) -> Result<u32, GuardianError>;
}

impl DrainJob for WindowsJob {
    fn terminate(&self) -> Result<(), GuardianError> {
        WindowsJob::terminate(self)
    }

    fn active_processes(&self) -> Result<u32, GuardianError> {
        WindowsJob::active_processes(self)
    }
}

/// Production helper entry point. The helper's file lease is acquired before the health handshake
/// and retained until `serve` has drained and dropped every admitted Job Object.
pub fn serve_with_recovery_root<R: Read, W: Write>(
    input: &mut R,
    output: &mut W,
    recovery_root: &std::path::Path,
    recovery_root_identity: &str,
) -> Result<(), GuardianError> {
    let _recovery = RecoveryLock::acquire_expected(
        recovery_root,
        recovery_root_identity,
        RecoveryLockRole::HelperDrain,
    )?;
    let marker_store = FileMarkerStore::open(recovery_root.to_path_buf())?;
    if marker_store.root_identity() != recovery_root_identity {
        return Err(GuardianError::ObjectMismatch);
    }
    let boot_identifier = super::platform::current_boot_identifier()?;
    serve_with_clean_witness(input, output, move |desktop_generation| {
        marker_store.prove_epoch_clean(desktop_generation, &boot_identifier)
    })
}

pub fn serve<R: Read, W: Write>(input: &mut R, output: &mut W) -> Result<(), GuardianError> {
    serve_with_clean_witness(input, output, |_| Ok(()))
}

fn serve_with_clean_witness<R: Read, W: Write>(
    input: &mut R,
    output: &mut W,
    publish_clean: impl FnOnce(DesktopGeneration) -> Result<(), GuardianError>,
) -> Result<(), GuardianError> {
    let first: Envelope<Request> = read_frame(input).map_err(protocol_unavailable)?;
    let mut inbound = InboundGuard::new(first.nonce, first.desktop_generation);
    inbound.accept(&first).map_err(protocol_unavailable)?;
    let mut jobs = BTreeMap::<JobId, WindowsJob>::new();
    let result = if first.body != Request::Health {
        Err(GuardianError::Unavailable(
            "guardian channel did not begin with a health handshake".into(),
        ))
    } else {
        respond(output, &first, Response::Healthy)
            .and_then(|()| serve_authenticated(input, output, &mut inbound, &mut jobs))
    };
    // Every post-handshake exit, including a broken response pipe, passes through this cleanup.
    // The helper must retain its Job Object handles until termination and a zero count are proved.
    // A bounded command response may report that quiescence is still pending. Once the control
    // channel is gone, however, this helper is the surviving crash authority and must never drop
    // its job handles merely because one terminate/query attempt failed or timed out.
    retain_jobs_drop_and_publish_clean(
        jobs,
        DRAIN_TIMEOUT,
        DRAIN_POLL,
        RETAIN_RETRY_DELAY,
        || publish_clean(first.desktop_generation),
    )?;
    result
}

fn serve_authenticated<R: Read, W: Write>(
    input: &mut R,
    output: &mut W,
    inbound: &mut InboundGuard,
    jobs: &mut BTreeMap<JobId, WindowsJob>,
) -> Result<(), GuardianError> {
    let mut sealed = false;
    loop {
        let request: Envelope<Request> = match read_frame(input) {
            Ok(request) => request,
            Err(ProtocolError::Io(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                return Ok(());
            }
            Err(error) => return Err(protocol_unavailable(error)),
        };
        if let Err(error) = inbound.accept(&request) {
            return Err(protocol_unavailable(error));
        }

        let response = match &request.body {
            Request::Health => Response::Healthy,
            Request::HoldJob { job, handle } => {
                // Take ownership even on denial so every successfully duplicated remote handle is
                // closed exactly once in this process.
                let transferred = WindowsJob::from_transferred_handle(*handle);
                if sealed {
                    drop(transferred);
                    Response::Denied {
                        code: "generation_sealed".into(),
                    }
                } else if jobs.contains_key(job) {
                    drop(transferred);
                    Response::Denied {
                        code: "job_replay".into(),
                    }
                } else {
                    match transferred {
                        Ok(owned) => {
                            jobs.insert(*job, owned);
                            Response::Accepted
                        }
                        Err(_) => Response::Denied {
                            code: "job_unavailable".into(),
                        },
                    }
                }
            }
            Request::ReleaseJob { job } => match jobs.get(job) {
                Some(owned) => match owned.active_processes() {
                    Ok(0) => {
                        jobs.remove(job);
                        Response::Accepted
                    }
                    Ok(_) => Response::Denied {
                        code: "job_not_quiescent".into(),
                    },
                    Err(_) => Response::Denied {
                        code: "job_query_failed".into(),
                    },
                },
                // Release is idempotent: a lost Accepted response must not strand the desktop's
                // duplicate after this helper has already removed its zero-process handle.
                None => Response::Accepted,
            },
            Request::Seal => {
                sealed = true;
                Response::Accepted
            }
            Request::Drain => {
                sealed = true;
                match drain_jobs(jobs, DRAIN_TIMEOUT) {
                    Ok(()) => Response::Clean,
                    Err(_) => Response::Denied {
                        code: "quiescence_unproved".into(),
                    },
                }
            }
            Request::Shutdown => {
                let response = match drain_jobs(jobs, DRAIN_TIMEOUT) {
                    Ok(()) => Response::Clean,
                    Err(_) => Response::Denied {
                        code: "quiescence_unproved".into(),
                    },
                };
                respond(output, &request, response.clone())?;
                return if response == Response::Clean {
                    Ok(())
                } else {
                    Err(GuardianError::QuiescencePending)
                };
            }
        };
        respond(output, &request, response)?;
    }
}

fn respond<W: Write>(
    output: &mut W,
    request: &Envelope<Request>,
    body: Response,
) -> Result<(), GuardianError> {
    write_frame(
        output,
        &Envelope::new(
            request.nonce,
            request.desktop_generation,
            request.sequence,
            request.request_id,
            body,
        ),
    )
    .map_err(protocol_unavailable)
}

fn drain_jobs<K: Ord, J: DrainJob>(
    jobs: &BTreeMap<K, J>,
    timeout: Duration,
) -> Result<(), GuardianError> {
    drain_jobs_with_poll(jobs, timeout, DRAIN_POLL)
}

fn drain_jobs_with_poll<K: Ord, J: DrainJob>(
    jobs: &BTreeMap<K, J>,
    timeout: Duration,
    poll: Duration,
) -> Result<(), GuardianError> {
    let mut first_error = None;
    for job in jobs.values() {
        if let Err(error) = job.terminate() {
            first_error.get_or_insert(error);
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }

    let deadline = Instant::now() + timeout;
    loop {
        let mut active = 0_u32;
        for job in jobs.values() {
            active = active
                .checked_add(job.active_processes()?)
                .ok_or_else(|| GuardianError::Unavailable("job process count overflowed".into()))?;
        }
        if active == 0 {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(GuardianError::QuiescencePending);
        }
        std::thread::sleep(poll);
    }
}

fn retain_jobs_until_clean<K: Ord, J: DrainJob>(
    jobs: &BTreeMap<K, J>,
    attempt_timeout: Duration,
    poll: Duration,
    retry_delay: Duration,
) {
    while drain_jobs_with_poll(jobs, attempt_timeout, poll).is_err() {
        std::thread::sleep(retry_delay);
    }
}

fn retain_jobs_drop_and_publish_clean<K: Ord, J: DrainJob>(
    jobs: BTreeMap<K, J>,
    attempt_timeout: Duration,
    poll: Duration,
    retry_delay: Duration,
    publish_clean: impl FnOnce() -> Result<(), GuardianError>,
) -> Result<(), GuardianError> {
    retain_jobs_until_clean(&jobs, attempt_timeout, poll, retry_delay);
    drop(jobs);
    publish_clean()
}

fn protocol_unavailable(error: ProtocolError) -> GuardianError {
    GuardianError::Unavailable(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    /// Hang guard for observing the worker thread on a loaded machine: never a latency assertion.
    const HANG_GUARD: Duration = Duration::from_secs(30);

    struct DelayedZeroJob {
        active: Arc<AtomicBool>,
        dropped: Arc<AtomicBool>,
        terminations: Arc<AtomicUsize>,
    }

    impl DrainJob for DelayedZeroJob {
        fn terminate(&self) -> Result<(), GuardianError> {
            self.terminations.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }

        fn active_processes(&self) -> Result<u32, GuardianError> {
            Ok(u32::from(self.active.load(Ordering::Acquire)))
        }
    }

    impl Drop for DelayedZeroJob {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::Release);
        }
    }

    #[test]
    fn channel_loss_retains_job_authority_until_zero_is_proved() {
        let active = Arc::new(AtomicBool::new(true));
        let dropped = Arc::new(AtomicBool::new(false));
        let terminations = Arc::new(AtomicUsize::new(0));
        let mut jobs = BTreeMap::new();
        jobs.insert(
            "job".to_owned(),
            DelayedZeroJob {
                active: Arc::clone(&active),
                dropped: Arc::clone(&dropped),
                terminations: Arc::clone(&terminations),
            },
        );
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let callback_dropped = Arc::clone(&dropped);
        let worker = std::thread::spawn(move || {
            retain_jobs_drop_and_publish_clean(
                jobs,
                Duration::from_millis(10),
                Duration::from_millis(1),
                Duration::from_millis(1),
                || {
                    assert!(
                        callback_dropped.load(Ordering::Acquire),
                        "clean witness published before job handles were dropped"
                    );
                    Ok(())
                },
            )
            .expect("publish clean witness");
            done_tx.send(()).expect("completion signal");
        });

        // Under a parallel workspace test run the worker may not receive a time
        // slice within 40ms. Wait for the observable retry, while keeping the
        // fake process active, instead of assuming wall time proves scheduling.
        let retry_deadline = std::time::Instant::now() + HANG_GUARD;
        while terminations.load(Ordering::Acquire) < 2 && std::time::Instant::now() < retry_deadline
        {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(
            done_rx.try_recv().is_err(),
            "cleanup returned without a zero-process witness"
        );
        assert!(
            !dropped.load(Ordering::Acquire),
            "job authority was dropped while its process count remained nonzero"
        );
        assert!(
            terminations.load(Ordering::Acquire) >= 2,
            "cleanup did not retry after the bounded attempt expired"
        );

        active.store(false, Ordering::Release);
        done_rx
            .recv_timeout(HANG_GUARD)
            .expect("cleanup after zero");
        worker.join().expect("cleanup worker");
        assert!(dropped.load(Ordering::Acquire));
    }
}
