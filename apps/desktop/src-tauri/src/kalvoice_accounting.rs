//! Account-bound KalVoice allowance and offline request reconciliation. Only the native account
//! runtime can produce authority; the renderer never supplies an account, tier, or usage count.
use crate::account::runtime::{
    AccountRuntime, AccountRuntimeError, KalVoiceAuthority, KalVoiceRecord,
};
use kalcode_contracts::kalvoice::KalVoiceUsage;
use kalcode_core::{Core, KalError, Result};
use kalcode_entitlements::{Limit, limits};
use kalcode_kalvoice::accounting::{self, MeterDecision, RequestAccounting};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(crate) struct AccountKalVoice {
    core: Arc<Core>,
    account: Arc<AccountRuntime>,
    account_id: String,
    generation: u64,
    stopping: AtomicBool,
    // Serialize our reservation/receipt/ack sequence. No core transaction spans HTTP.
    lane: Mutex<()>,
}

struct Cycle {
    usage: KalVoiceUsage,
    start: i64,
    end: i64,
    receipt: bool,
}

fn account_error(error: AccountRuntimeError) -> KalError {
    KalError::new(
        kalcode_core::ErrorCategory::Authentication,
        error.code,
        error.message,
    )
}

fn cycle(authority: &KalVoiceAuthority) -> Result<Cycle> {
    let now = OffsetDateTime::from_unix_timestamp(authority.now_unix).map_err(|_| {
        KalError::internal(
            "kalvoice_clock_invalid",
            "KalVoice could not read the current time.",
        )
    })?;
    let limit = match authority
        .entitlement
        .grants()
        .limit(limits::KALVOICE_REQUESTS_PER_MONTH)
    {
        Limit::Unlimited => None,
        Limit::AtMost(value) => Some(u32::try_from(value).unwrap_or(u32::MAX)),
    };
    if let Some(receipt) = &authority.receipt {
        let start = OffsetDateTime::parse(&receipt.period_start, &Rfc3339).ok();
        let end = OffsetDateTime::parse(&receipt.resets_at, &Rfc3339).ok();
        if let (Some(start), Some(end)) = (start, end)
            && start <= now
            && now < end
        {
            let allowance = limit.map(|limit| {
                receipt.allowance.map_or(limit, |value| {
                    limit.min(u32::try_from(value).unwrap_or(u32::MAX))
                })
            });
            return Ok(Cycle {
                usage: KalVoiceUsage {
                    used: u32::try_from(receipt.used).unwrap_or(u32::MAX),
                    allowance,
                    period_start: receipt.period_start.clone(),
                    resets_at: receipt.resets_at.clone(),
                },
                start: start.unix_timestamp(),
                end: end.unix_timestamp(),
                receipt: true,
            });
        }
    }
    // Existing documented offline policy: without a valid current receipt, use this account's
    // provisional device cycle. Do not infer a billing anchor from a clamped month-end date.
    let period = kalcode_kalvoice::ledger::Period::containing(now, 1);
    Ok(Cycle {
        usage: KalVoiceUsage {
            used: 0,
            allowance: limit,
            period_start: period.start_rfc3339(),
            resets_at: period.resets_at_rfc3339(),
        },
        start: period.start.unix_timestamp(),
        end: period.resets_at.unix_timestamp(),
        receipt: false,
    })
}

impl AccountKalVoice {
    pub(crate) fn new(core: Arc<Core>, account: Arc<AccountRuntime>) -> Result<Arc<Self>> {
        let lease = account.acquire_active_lease().map_err(account_error)?;
        let account_id = account
            .snapshot()
            .account
            .ok_or_else(|| {
                KalError::validation(
                    "authentication_required",
                    "Sign in to use KalVoice Requests.",
                )
            })?
            .id;
        account
            .kalvoice_authority(&account_id)
            .map_err(account_error)?;
        if !account.validate_active_lease(&lease) {
            return Err(KalError::validation(
                "authentication_required",
                "Sign in to use KalVoice Requests.",
            ));
        }
        Ok(Arc::new(Self {
            core,
            account,
            account_id,
            generation: lease.generation(),
            stopping: AtomicBool::new(false),
            lane: Mutex::new(()),
        }))
    }

    fn authority(&self) -> Result<KalVoiceAuthority> {
        let authority = self
            .account
            .kalvoice_authority(&self.account_id)
            .map_err(account_error)?;
        if self.stopping.load(Ordering::SeqCst) || authority.lease.generation() != self.generation {
            return Err(KalError::validation(
                "runtime_not_ready",
                "This KalVoice runtime has stopped.",
            ));
        }
        Ok(authority)
    }

    pub(crate) fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
    }

    fn usage_inner(&self, authority: &KalVoiceAuthority) -> Result<KalVoiceUsage> {
        let cycle = cycle(authority)?;
        self.core.read(|conn| {
            accounting::usage(
                conn,
                &self.account_id,
                &cycle.usage,
                cycle.start,
                cycle.end,
                cycle.receipt,
            )
        })
    }

    /// Bounded replay invoked only from a retained KalVoice background task. A lost account
    /// lease or unavailable service ends this pass, leaving every remaining claim durable.
    pub(crate) fn synchronize(&self) {
        for _ in 0..32 {
            let Ok(_lane) = self.lane.try_lock() else {
                return;
            };
            let Ok(authority) = self.authority() else {
                return;
            };
            if authority.offline {
                return;
            }
            let Ok(Some((request, offline))) = self
                .core
                .read(|conn| accounting::next_pending(conn, &self.account_id))
            else {
                return;
            };
            match self
                .account
                .record_kalvoice(&authority.lease, &request, offline)
            {
                Ok(KalVoiceRecord::Confirmed { allowed, .. }) => {
                    if self
                        .core
                        .transact(|conn| {
                            accounting::settle(conn, &self.account_id, &request, allowed)?;
                            Ok(((), Vec::new()))
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                _ => return,
            }
        }
    }
}

impl RequestAccounting for AccountKalVoice {
    fn account_id(&self) -> &str {
        &self.account_id
    }
    fn usage(&self) -> Result<KalVoiceUsage> {
        // During receipt persistence/ack this may conservatively show one pending reservation
        // twice; it never stalls dictation status behind a network call.
        self.usage_inner(&self.authority()?)
    }
    fn authorize(&self, request_id: &str) -> Result<MeterDecision> {
        let _lane = self.lane.lock().map_err(|_| {
            KalError::internal(
                "kalvoice_meter_unavailable",
                "KalVoice usage is unavailable.",
            )
        })?;
        let authority = self.authority()?;
        let cycle = cycle(&authority)?;
        // Last-unit admission and durable budget reservation happen in one SQLite transaction.
        let ((decision, provisional_exhausted), _) = self.core.transact(|conn| {
            let mut usage = accounting::usage(
                conn,
                &self.account_id,
                &cycle.usage,
                cycle.start,
                cycle.end,
                cycle.receipt,
            )?;
            let exhausted = usage.exhausted();
            // Without a current receipt the device cycle is only an estimate: the server's
            // cycle is anchored to the billing date, not the 1st, and may have reset. Online,
            // the server decides (and returns a fresh receipt); the estimate still applies if
            // the server can't be reached, and always offline.
            if exhausted && (cycle.receipt || authority.offline) {
                return Ok((
                    (
                        MeterDecision {
                            allowed: false,
                            usage,
                        },
                        true,
                    ),
                    Vec::new(),
                ));
            }
            accounting::reserve(
                conn,
                &self.account_id,
                request_id,
                authority.now_unix,
                authority.offline,
            )?;
            if !exhausted {
                usage.used = usage.used.saturating_add(1);
            }
            Ok((
                (
                    MeterDecision {
                        allowed: true,
                        usage,
                    },
                    exhausted,
                ),
                Vec::new(),
            ))
        })?;
        if !decision.allowed {
            return Ok(decision);
        }
        let result = if authority.offline {
            KalVoiceRecord::Unavailable
        } else {
            self.account
                .record_kalvoice(&authority.lease, request_id, false)
                .map_err(|error| {
                    KalError::new(
                        kalcode_core::ErrorCategory::Authentication,
                        error.code,
                        format!(
                            "{} This request may have been counted; its action did not run.",
                            error.message
                        ),
                    )
                })?
        };
        match result {
            KalVoiceRecord::Confirmed { allowed, .. } => {
                self.core.transact(|conn| {
                    accounting::settle(conn, &self.account_id, request_id, allowed)?;
                    Ok(((), Vec::new()))
                })?;
                Ok(MeterDecision {
                    allowed,
                    usage: self.usage_inner(&self.authority()?)?,
                })
            }
            KalVoiceRecord::Unavailable if provisional_exhausted => {
                // Only the server could have admitted this request past the device estimate.
                // Nothing runs, so the claim is not replayed later.
                self.core.transact(|conn| {
                    accounting::settle(conn, &self.account_id, request_id, false)?;
                    Ok(((), Vec::new()))
                })?;
                Ok(MeterDecision {
                    allowed: false,
                    usage: decision.usage,
                })
            }
            KalVoiceRecord::Unavailable => {
                // The verified local budget was reserved before the unknown online result.
                // Admit offline only while the same account authority remains valid.
                if !self.account.validate_active_lease(&authority.lease) {
                    return Err(KalError::validation(
                        "authentication_required",
                        "Your account changed before this request could run.",
                    ));
                }
                self.authority()?;
                self.core.transact(|conn| {
                    accounting::admit_offline(conn, &self.account_id, request_id)?;
                    Ok(((), Vec::new()))
                })?;
                Ok(decision)
            }
        }
    }
}
