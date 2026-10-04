use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use kalcode_entitlements::{Tier, Verifier};
use kalcode_secure_store::SecretStore;
use serde::Serialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::api::{
    AccountApi, ApiAccount, ApiError, BillingInterval, BrowserDestination, EntitlementResponse,
    PaidTier, PkcePair, PollResponse, RetryClass, SocialCompleteResponse, UsageResponse,
    retry_delay, validate_browser_destination,
};
use super::model::{
    AccountAuthority, AccountPhase, AccountSnapshot, AccountTier, AccountUsageSnapshot,
    PendingAuthSecret, PublicAccount, SessionSecret,
};
use super::session_store::{
    AccountSessionStore, CachedAccountSecret, PendingCheckoutSecret, SessionStoreError,
    SignedUsageReceipt,
};
use super::social::{
    SocialCallback, SocialProvider, parse_social_callback, validate_social_authorize_url,
};

const RETRY_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_SOCIAL_PENDING_SECONDS: i64 = 15 * 60;

pub trait Clock: Send + Sync {
    fn now_unix(&self) -> i64;
    fn sleep(&self, duration: Duration);
}

#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> i64 {
        OffsetDateTime::now_utc().unix_timestamp()
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRuntimeError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
}

impl std::fmt::Display for AccountRuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for AccountRuntimeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserLaunch {
    pub snapshot: AccountSnapshot,
    pub url: String,
    generation: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SocialBrowserLaunch {
    pub snapshot: AccountSnapshot,
    url: String,
    provider: SocialProvider,
    state: String,
    generation: u64,
}

impl std::fmt::Debug for SocialBrowserLaunch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SocialBrowserLaunch")
            .field("provider", &self.provider)
            .field("payload", &"[REDACTED]")
            .finish()
    }
}

/// Redacted native authority truth for the primary-owned startup coordinator. The watch slot is
/// bounded to one latest value, so a slow observer cannot grow a queue and always converges to the
/// newest authority after rapid sign-in/sign-out transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthorityUpdate {
    pub revision: u64,
    pub generation: u64,
    pub authority: AccountAuthority,
    pub phase: AccountPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthorityLease {
    generation: u64,
    revision: u64,
}

/// Native-only verified quota authority. No bearer or signed token crosses this boundary.
pub(crate) struct KalVoiceAuthority {
    pub(crate) entitlement: kalcode_entitlements::Entitlement,
    pub(crate) receipt: Option<kalcode_entitlements::UsageReceipt>,
    pub(crate) lease: AuthorityLease,
    pub(crate) offline: bool,
    pub(crate) now_unix: i64,
}

pub(crate) enum KalVoiceRecord {
    Confirmed {
        allowed: bool,
    },
    Unavailable,
    /// The service never counted the request: KalCode refused before sending it (lost account
    /// authority, no session), or the service rejected it outright (HTTP 4xx other than 429).
    Refused(AccountRuntimeError),
}

impl AuthorityLease {
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

struct AuthorityWatchSlot {
    latest: Mutex<AuthorityUpdate>,
    changed: Condvar,
}

pub struct AuthoritySubscription {
    slot: Arc<AuthorityWatchSlot>,
    seen_revision: Option<u64>,
}

impl AuthoritySubscription {
    pub fn current(&mut self) -> AuthorityUpdate {
        let update = *self
            .slot
            .latest
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.seen_revision = Some(update.revision);
        update
    }

    pub fn wait_for_change(&mut self, timeout: Duration) -> Option<AuthorityUpdate> {
        let mut latest = self
            .slot
            .latest
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let seen = self.seen_revision;
        if seen == Some(latest.revision) {
            let waited = self.slot.changed.wait_timeout(latest, timeout).ok()?;
            latest = waited.0;
            if waited.1.timed_out() && seen == Some(latest.revision) {
                return None;
            }
        }
        self.seen_revision = Some(latest.revision);
        Some(*latest)
    }
}

struct RuntimeState {
    snapshot: AccountSnapshot,
    authority_generation: u64,
    authority_revision: u64,
    session: Option<SessionSecret>,
    pending: Option<PendingAuthSecret>,
    cached: Option<CachedAccountSecret>,
    usage_receipt: Option<SignedUsageReceipt>,
    checkout: Option<PendingCheckoutSecret>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            snapshot: AccountSnapshot::bootstrapping(),
            authority_generation: 0,
            authority_revision: 0,
            session: None,
            pending: None,
            cached: None,
            usage_receipt: None,
            checkout: None,
        }
    }
}

/// Sign-outs in progress, and whether an exit has committed. Exit waits for running sign-outs
/// (not a lifecycle lease, so a sign-out's own drain never waits on itself), then seals so none
/// starts that the exit would cut off before credentials are cleared.
#[derive(Default)]
struct SignOutGate {
    running: usize,
    sealed_for_exit: bool,
}

/// Held for one sign-out's credential clearing and revocation; releasing it wakes the exit.
#[cfg(any(test, feature = "e2e"))]
struct SignOutObligation<'a>(&'a AccountRuntime);

#[cfg(any(test, feature = "e2e"))]
impl Drop for SignOutObligation<'_> {
    fn drop(&mut self) {
        self.0.finish_sign_out();
    }
}

/// An account-command sign-out admitted before it is dispatched to the blocking pool.
///
/// Owning the runtime keeps both the admission and its release valid if the async command is
/// cancelled before its blocking body starts. The only way to execute this permit is against the
/// runtime that issued it, so callers cannot swap an admission between account runtimes.
pub(crate) struct SignOutPermit(Arc<AccountRuntime>);

impl SignOutPermit {
    pub(crate) fn logout(self) -> Result<AccountSnapshot, AccountRuntimeError> {
        let runtime = Arc::clone(&self.0);
        let result = runtime.logout_admitted();
        drop(self);
        result
    }
}

impl Drop for SignOutPermit {
    fn drop(&mut self) {
        self.0.finish_sign_out();
    }
}

pub struct AccountRuntime {
    api: Arc<dyn AccountApi>,
    store: Arc<dyn SecretStore>,
    verifier: Verifier,
    clock: Arc<dyn Clock>,
    bootstrap_started: AtomicBool,
    generation: AtomicU64,
    revision: AtomicU64,
    generation_effect_lane: Mutex<()>,
    request_lane: Mutex<()>,
    state: Mutex<RuntimeState>,
    authority_subscribers: Mutex<Vec<Weak<AuthorityWatchSlot>>>,
    sign_outs: Mutex<SignOutGate>,
    sign_outs_settled: Condvar,
}

impl AccountRuntime {
    pub fn production(store: Arc<dyn SecretStore>) -> Self {
        Self::with_dependencies(
            Arc::new(super::api::HttpAccountApi::new()),
            store,
            Verifier::embedded(),
            Arc::new(SystemClock),
        )
    }

    pub fn with_dependencies(
        api: Arc<dyn AccountApi>,
        store: Arc<dyn SecretStore>,
        verifier: Verifier,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            api,
            store,
            verifier,
            clock,
            bootstrap_started: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            revision: AtomicU64::new(0),
            generation_effect_lane: Mutex::new(()),
            request_lane: Mutex::new(()),
            state: Mutex::new(RuntimeState::default()),
            authority_subscribers: Mutex::new(Vec::new()),
            sign_outs: Mutex::new(SignOutGate::default()),
            sign_outs_settled: Condvar::new(),
        }
    }

    pub fn subscribe_authority(&self) -> AuthoritySubscription {
        let state = self.lock_state();
        let slot = Arc::new(AuthorityWatchSlot {
            latest: Mutex::new(AuthorityUpdate {
                revision: state.authority_revision,
                generation: state.authority_generation,
                authority: state.snapshot.authority(),
                phase: state.snapshot.phase,
            }),
            changed: Condvar::new(),
        });
        self.authority_subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(Arc::downgrade(&slot));
        AuthoritySubscription {
            slot,
            seen_revision: None,
        }
    }

    pub fn snapshot(&self) -> AccountSnapshot {
        self.lock_state().snapshot.clone()
    }

    pub fn authority(&self) -> AccountAuthority {
        self.lock_state().snapshot.authority()
    }

    /// Returns one state-locked observer tuple. Generation and revision are those published with
    /// this exact snapshot, never independently sampled atomics from an in-progress transition.
    /// This is lifecycle notification data, not action admission: callers must acquire and then
    /// revalidate an [`AuthorityLease`] because live generation can already be invalidating it.
    pub fn current_authority_update(&self) -> AuthorityUpdate {
        let state = self.lock_state();
        AuthorityUpdate {
            revision: state.authority_revision,
            generation: state.authority_generation,
            authority: state.snapshot.authority(),
            phase: state.snapshot.phase,
        }
    }

    /// Captures active authority for a queued native operation. Callers must invoke
    /// `validate_active_lease` again immediately before every external or privileged effect.
    pub fn acquire_active_lease(&self) -> Result<AuthorityLease, AccountRuntimeError> {
        loop {
            let update = self.current_authority_update();
            let lease = AuthorityLease {
                generation: update.generation,
                revision: update.revision,
            };
            if !self.validate_active_lease(&lease) {
                return Err(authentication_required());
            }
            if update == self.current_authority_update() {
                return Ok(lease);
            }
        }
    }

    pub fn validate_active_lease(&self, lease: &AuthorityLease) -> bool {
        if lease.generation != self.generation.load(Ordering::SeqCst)
            || lease.revision != self.revision.load(Ordering::SeqCst)
        {
            return false;
        }
        let state = self.lock_state();
        if state.authority_generation != lease.generation
            || state.authority_revision != lease.revision
        {
            return false;
        }
        if state.snapshot.authority() != AccountAuthority::Active {
            return false;
        }
        let (Some(cached), Some(account), Some(tier)) = (
            state.cached.as_ref(),
            state.snapshot.account.as_ref(),
            state.snapshot.tier,
        ) else {
            return false;
        };
        self.verifier
            .verify(cached.entitlement_token(), self.clock.now_unix())
            .is_ok_and(|entitlement| {
                entitlement.account_id == account.id
                    && cached.account().id == account.id
                    && account_tier(entitlement.tier) == tier
            })
    }

    pub fn bootstrap(&self) -> Result<AccountSnapshot, AccountRuntimeError> {
        if self.bootstrap_started.swap(true, Ordering::SeqCst) {
            return Ok(self.snapshot());
        }
        let result = self.bootstrap_once();
        if result.is_err() {
            self.bootstrap_started.store(false, Ordering::SeqCst);
        }
        result
    }

    fn bootstrap_once(&self) -> Result<AccountSnapshot, AccountRuntimeError> {
        // Bootstrap is invoked off-thread. Keep the account lane through verification so logout
        // can revoke immediately and then wait for the old account operation to leave the lane.
        let _lane = self.lock_lane()?;
        let generation = self.advance_generation();
        let stored = match self.session_store()?.load() {
            Ok(value) => value,
            Err(_) => {
                let _ = self.session_store()?.clear();
                return Ok(self.publish_degraded(generation, "stored_session_invalid"));
            }
        };
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        let Some(stored) = stored else {
            return Ok(self.publish_signed_out(generation));
        };

        let session = stored.session().cloned();
        let pending = stored.pending().cloned();
        let cached = stored.cached().cloned();
        let usage_receipt = stored.usage_receipt().cloned();
        let checkout = stored.checkout().cloned();
        let now = self.clock.now_unix();
        if session
            .as_ref()
            .is_some_and(|value| value.is_expired_at(now))
        {
            // A stored session that ran out: the sign-in screen says it expired.
            self.session_store()?.clear().map_err(store_error)?;
            return Ok(self.publish_session_expired(generation));
        }
        if session.is_none()
            && pending
                .as_ref()
                .is_some_and(|value| value.is_expired_at(now))
        {
            self.session_store()?.clear().map_err(store_error)?;
            return Ok(self.publish_signed_out(generation));
        }
        {
            if !self.is_current(generation) {
                return Ok(self.snapshot());
            }
            let mut state = self.lock_state();
            state.session = session;
            state.pending = pending;
            state.cached = cached;
            state.usage_receipt = usage_receipt;
            state.checkout = checkout;
        }

        if self.lock_state().session.is_some() {
            return self.fetch_authority(generation);
        }
        // Do not keep the temporary state guard alive across this branch: the branch publishes
        // the restored pending snapshot under the same mutex.
        let pending = { self.lock_state().pending.clone() };
        if let Some(pending) = pending {
            if !self.is_current(generation) {
                return Ok(self.snapshot());
            }
            let snapshot = pending_snapshot(&pending);
            let mut state = self.lock_state();
            state.snapshot = snapshot.clone();
            self.notify_authority_locked(&mut state, generation);
            return Ok(snapshot);
        }
        Ok(self.publish_signed_out(generation))
    }

    pub fn start_email(&self, email: &str) -> Result<AccountSnapshot, AccountRuntimeError> {
        if !valid_email(email) {
            return Err(AccountRuntimeError {
                code: "invalid_email",
                message: "Enter a valid email address.",
                retryable: false,
            });
        }
        let generation = self.advance_generation();
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        self.session_store()?.clear().map_err(store_error)?;
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        self.publish_signed_out(generation);

        let pair = PkcePair::generate().map_err(api_error)?;
        let response = self
            .api
            .start_email(email, pair.challenge())
            .map_err(api_error)?;
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        let expires_at = parse_iso_epoch(&response.expires_at)?;
        let pending = PendingAuthSecret::new(
            response.poll_token,
            pair.expose_verifier().to_owned(),
            expires_at,
            email.to_owned(),
        )
        .map_err(|_| invalid_response())?;
        if pending.is_expired_at(self.clock.now_unix()) {
            return Err(terminal_auth_error());
        }
        self.session_store()?
            .save(None, Some(&pending))
            .map_err(store_error)?;
        if !self.is_current(generation) {
            self.session_store()?.clear().map_err(store_error)?;
            return Ok(self.snapshot());
        }
        let snapshot = pending_snapshot(&pending);
        let _effect = self.lock_generation_effect();
        if !self.is_current(generation) {
            drop(_effect);
            self.session_store()?.clear().map_err(store_error)?;
            return Ok(self.snapshot());
        }
        let mut state = self.lock_state();
        state.pending = Some(pending);
        state.snapshot = snapshot.clone();
        self.notify_authority_locked(&mut state, generation);
        Ok(snapshot)
    }

    pub fn start_social(
        &self,
        provider: SocialProvider,
    ) -> Result<SocialBrowserLaunch, AccountRuntimeError> {
        let generation = self.advance_generation();
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) {
            return Err(cancelled());
        }
        self.session_store()?.clear().map_err(store_error)?;
        self.publish_signed_out(generation);

        let pair = PkcePair::generate().map_err(api_error)?;
        let response = self
            .api
            .start_social(provider, pair.challenge())
            .map_err(api_error)?;
        if !self.is_current(generation) {
            return Err(cancelled());
        }
        let state = validate_social_authorize_url(
            &response.authorize_url,
            provider,
            pair.challenge(),
            &response.nonce,
        )
        .map_err(api_error)?;
        let expires_at = parse_iso_epoch(&response.expires_at)?;
        let pending = PendingAuthSecret::social(
            provider,
            state.clone(),
            pair.expose_verifier().to_owned(),
            response.nonce,
            expires_at,
        )
        .map_err(|_| invalid_response())?;
        let now = self.clock.now_unix();
        if pending.is_expired_at(now)
            || pending.expires_at() > now.saturating_add(MAX_SOCIAL_PENDING_SECONDS)
        {
            return Err(terminal_auth_error());
        }
        self.session_store()?
            .save(None, Some(&pending))
            .map_err(store_error)?;
        let snapshot = pending_snapshot(&pending);
        let _effect = self.lock_generation_effect();
        if !self.is_current(generation) {
            drop(_effect);
            self.session_store()?.clear().map_err(store_error)?;
            return Err(cancelled());
        }
        let mut account = self.lock_state();
        account.pending = Some(pending);
        account.snapshot = snapshot.clone();
        self.notify_authority_locked(&mut account, generation);
        Ok(SocialBrowserLaunch {
            snapshot,
            url: response.authorize_url,
            provider,
            state,
            generation,
        })
    }

    pub fn commit_social_browser_launch<T>(
        &self,
        launch: &SocialBrowserLaunch,
        open: impl FnOnce(&str) -> Result<T, AccountRuntimeError>,
    ) -> Result<T, AccountRuntimeError> {
        let _effect = self.lock_generation_effect();
        let account = self.lock_state();
        let matches = account.pending.as_ref().is_some_and(|pending| {
            pending.social_provider() == Some(launch.provider)
                && pending.expose_state() == Some(launch.state.as_str())
                && !pending.is_expired_at(self.clock.now_unix())
        });
        if !self.is_current(launch.generation) || !matches {
            return Err(cancelled());
        }
        drop(account);
        open(&launch.url)
    }

    pub fn handle_social_callback_url(
        &self,
        raw: &str,
    ) -> Result<AccountSnapshot, AccountRuntimeError> {
        let callback = parse_social_callback(raw).map_err(|_| invalid_auth_callback())?;
        let generation = self.generation.load(Ordering::SeqCst);
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        let Some(pending) = self.lock_state().pending.clone() else {
            return Err(unexpected_auth_callback());
        };
        if pending.is_expired_at(self.clock.now_unix()) {
            self.session_store()?.clear().map_err(store_error)?;
            self.publish_signed_out(generation);
            return Err(terminal_auth_error());
        }
        if pending.social_provider() != Some(callback.provider())
            || pending.expose_state() != Some(callback.state())
        {
            return Err(invalid_auth_callback());
        }
        match callback {
            SocialCallback::Canceled { .. } => {
                self.session_store()?.clear().map_err(store_error)?;
                Ok(self.publish_signed_out(generation))
            }
            SocialCallback::Failed { .. } => {
                self.session_store()?.clear().map_err(store_error)?;
                self.publish_signed_out(generation);
                Err(terminal_auth_error())
            }
            SocialCallback::Success {
                provider,
                state,
                code,
            } => {
                let nonce = pending.expose_nonce().ok_or_else(invalid_auth_callback)?;
                let response = self.api.complete_social(
                    provider,
                    &state,
                    &code,
                    pending.expose_code_verifier(),
                    nonce,
                );
                if !self.is_current(generation) {
                    return Ok(self.snapshot());
                }
                let response = match response {
                    Ok(response) => response,
                    Err(error) if error.status() == Some(400) => {
                        self.session_store()?.clear().map_err(store_error)?;
                        self.publish_signed_out(generation);
                        return Err(terminal_auth_error());
                    }
                    Err(error) => return Err(api_error(error)),
                };
                self.accept_social_session(response, generation)
            }
        }
    }

    fn accept_social_session(
        &self,
        response: SocialCompleteResponse,
        generation: u64,
    ) -> Result<AccountSnapshot, AccountRuntimeError> {
        if response.account_id.is_empty()
            || response.account_id.len() > 128
            || response.account_id.chars().any(char::is_control)
        {
            return Err(invalid_response());
        }
        let expected_account_id = response.account_id;
        let session = session_from_response(super::api::SignedInResponse {
            token: response.token,
            expires_at: response.expires_at,
        })?;
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        self.session_store()?
            .save(Some(&session), None)
            .map_err(store_error)?;
        if !self.is_current(generation) {
            self.session_store()?.clear().map_err(store_error)?;
            return Ok(self.snapshot());
        }
        {
            let _effect = self.lock_generation_effect();
            if !self.is_current(generation) {
                drop(_effect);
                self.session_store()?.clear().map_err(store_error)?;
                return Ok(self.snapshot());
            }
            let mut account = self.lock_state();
            account.session = Some(session);
            account.pending = None;
            account.cached = None;
            account.usage_receipt = None;
            account.checkout = None;
        }
        self.fetch_authority_expected(generation, Some(&expected_account_id))
    }

    pub fn poll_email(&self) -> Result<AccountSnapshot, AccountRuntimeError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        let pending = self
            .lock_state()
            .pending
            .clone()
            .ok_or_else(authentication_required)?;
        let poll_token = pending
            .expose_poll_token()
            .ok_or_else(authentication_required)?;
        if pending.is_expired_at(self.clock.now_unix()) {
            self.session_store()?.clear().map_err(store_error)?;
            return Ok(self.publish_signed_out(generation));
        }
        let response = self
            .api
            .poll_email(poll_token, pending.expose_code_verifier());
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        let response = match response {
            Ok(value) => value,
            Err(error) if error.status() == Some(400) => {
                self.session_store()?.clear().map_err(store_error)?;
                return Ok(self.publish_signed_out(generation));
            }
            Err(error) => return Err(api_error(error)),
        };
        match response {
            PollResponse::Pending => Ok(self.snapshot()),
            PollResponse::SignedIn(response) => {
                let session = session_from_response(response)?;
                if !self.is_current(generation) {
                    return Ok(self.snapshot());
                }
                self.session_store()?
                    .save(Some(&session), None)
                    .map_err(store_error)?;
                if !self.is_current(generation) {
                    self.session_store()?.clear().map_err(store_error)?;
                    return Ok(self.snapshot());
                }
                {
                    let _effect = self.lock_generation_effect();
                    if !self.is_current(generation) {
                        drop(_effect);
                        self.session_store()?.clear().map_err(store_error)?;
                        return Ok(self.snapshot());
                    }
                    let mut state = self.lock_state();
                    state.session = Some(session);
                    state.pending = None;
                    state.cached = None;
                    state.usage_receipt = None;
                    state.checkout = None;
                }
                self.fetch_authority(generation)
            }
        }
    }

    pub fn cancel_auth(&self) -> Result<AccountSnapshot, AccountRuntimeError> {
        let state = self.lock_state();
        if state.pending.is_none()
            && matches!(
                state.snapshot.authority(),
                AccountAuthority::Active | AccountAuthority::AuthenticatedUnactivated
            )
        {
            return Ok(state.snapshot.clone());
        }
        drop(state);
        let generation = self.advance_generation();
        if self.lock_state().pending.is_none() && self.snapshot().phase != AccountPhase::SignedOut {
            return Ok(self.snapshot());
        }
        self.session_store()?.clear().map_err(store_error)?;
        Ok(self.publish_signed_out(generation))
    }

    pub fn activate_free(&self) -> Result<AccountSnapshot, AccountRuntimeError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        self.require_unactivated()?;
        let token = self.session_token()?;
        let response = self.api.activate_free(&token);
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        match response {
            Ok(()) => self.fetch_authority(generation),
            Err(error) if error.status() == Some(401) => self.clear_unauthorized(),
            Err(error) => Err(api_error(error)),
        }
    }

    pub fn start_checkout(
        &self,
        tier: PaidTier,
        interval: BillingInterval,
    ) -> Result<BrowserLaunch, AccountRuntimeError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) {
            return Err(cancelled());
        }
        self.require_unactivated()?;
        let token = self.session_token()?;
        let checkout = {
            let mut state = self.lock_state();
            if let Some(existing) = state.checkout.clone() {
                // A pending checkout is never silently reused for another plan or interval.
                if existing.tier() != tier || existing.interval() != interval {
                    return Err(AccountRuntimeError {
                        code: "checkout_in_progress",
                        message: "KalCode is confirming your existing checkout.",
                        retryable: true,
                    });
                }
                existing
            } else {
                let created = PendingCheckoutSecret::new(request_id()?, tier, interval)
                    .map_err(|_| invalid_response())?;
                state.checkout = Some(created.clone());
                self.persist_locked(&state)?;
                created
            }
        };
        {
            let mut state = self.lock_state();
            let account = state
                .snapshot
                .account
                .clone()
                .ok_or_else(authentication_required)?;
            state.snapshot = authenticated_snapshot(
                AccountPhase::ConfirmingPlan,
                account,
                state.session.as_ref(),
            );
            self.notify_authority_locked(&mut state, generation);
        }
        let response = self.retry(generation, RetryClass::CheckoutSameRequest, || {
            self.api.checkout(
                &token,
                checkout.tier(),
                checkout.interval(),
                checkout.request_id(),
            )
        });
        let (response, expected_destination) = match response {
            Ok(response) => (response, BrowserDestination::Checkout),
            Err(error) if error.code == "manage_existing_subscription" => {
                let portal = self.retry(generation, RetryClass::CheckoutSameRequest, || {
                    self.api.portal(&token, checkout.request_id())
                })?;
                (portal, BrowserDestination::Portal)
            }
            Err(error) => return Err(error),
        };
        if !self.is_current(generation) {
            return Err(cancelled());
        }
        if validate_browser_destination(&response.url).map_err(api_error)? != expected_destination {
            return Err(invalid_response());
        }
        let snapshot = {
            let mut state = self.lock_state();
            let account = state
                .snapshot
                .account
                .clone()
                .ok_or_else(authentication_required)?;
            let snapshot = authenticated_snapshot(
                AccountPhase::ConfirmingPlan,
                account,
                state.session.as_ref(),
            );
            state.snapshot = snapshot.clone();
            snapshot
        };
        Ok(BrowserLaunch {
            snapshot,
            url: response.url,
            generation,
        })
    }

    pub fn portal(&self) -> Result<BrowserLaunch, AccountRuntimeError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) || self.acquire_active_lease().is_err() {
            return Err(authentication_required());
        }
        let token = self.session_token()?;
        let request_id = request_id()?;
        let response = self.retry(generation, RetryClass::CheckoutSameRequest, || {
            self.api.portal(&token, &request_id)
        })?;
        if validate_browser_destination(&response.url).map_err(api_error)?
            != BrowserDestination::Portal
        {
            return Err(invalid_response());
        }
        Ok(BrowserLaunch {
            snapshot: self.snapshot(),
            url: response.url,
            generation,
        })
    }

    /// Linearizes a browser side effect with account revocation. If logout wins the generation
    /// lane, the callback is never invoked. If opening wins, logout waits for the bounded native
    /// opener call to return before it advances authority.
    pub fn commit_browser_launch<T>(
        &self,
        launch: &BrowserLaunch,
        open: impl FnOnce(&str) -> Result<T, AccountRuntimeError>,
    ) -> Result<T, AccountRuntimeError> {
        let _effect = self.lock_generation_effect();
        if !self.is_current(launch.generation) {
            return Err(cancelled());
        }
        open(&launch.url)
    }

    pub fn refresh(&self) -> Result<AccountSnapshot, AccountRuntimeError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        let old_token = self.session_token()?;
        let response = self.retry(generation, RetryClass::Read, || {
            self.api.refresh_session(&old_token)
        });
        let response = match response {
            Ok(value) => value,
            Err(error) if error.code == "authentication_required" => {
                return self.clear_unauthorized();
            }
            Err(error) => {
                if !self.is_current(generation) {
                    return Ok(self.snapshot());
                }
                if let Some(offline) = self.offline_snapshot(generation) {
                    return Ok(offline);
                }
                let _ = error;
                return Ok(self.publish_degraded(generation, "account_service_unavailable"));
            }
        };
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        let session = session_from_response(response)?;
        {
            let mut state = self.lock_state();
            state.session = Some(session);
            self.persist_locked(&state)?;
        }
        self.fetch_authority(generation)
    }

    #[cfg(any(test, feature = "e2e"))]
    pub fn logout(&self) -> Result<AccountSnapshot, AccountRuntimeError> {
        // Registered before revoking, so an exit preflight either waits for this sign-out to
        // clear credentials or has already sealed and this sign-out never starts.
        let _obligation = self.begin_sign_out()?;
        self.logout_admitted()
    }

    /// Performs the sign-out after the caller has registered an obligation with the exit gate.
    fn logout_admitted(&self) -> Result<AccountSnapshot, AccountRuntimeError> {
        let generation = self.advance_generation();
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        let token = self.lock_state().session.clone();
        self.session_store()?.clear().map_err(store_error)?;
        let snapshot = self.publish_signed_out(generation);
        if let Some(token) = token {
            let _ = self.api.logout(token.expose_token());
        }
        Ok(snapshot)
    }

    fn lock_sign_outs(&self) -> MutexGuard<'_, SignOutGate> {
        self.sign_outs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(any(test, feature = "e2e"))]
    fn begin_sign_out(&self) -> Result<SignOutObligation<'_>, AccountRuntimeError> {
        self.admit_sign_out()?;
        Ok(SignOutObligation(self))
    }

    /// Command-boundary admission. This is synchronous so an accepted IPC sign-out is visible to
    /// exit before dispatch, coordinator draining, or credential work can race with it.
    pub(crate) fn begin_sign_out_command(
        self: &Arc<Self>,
    ) -> Result<SignOutPermit, AccountRuntimeError> {
        self.admit_sign_out()?;
        Ok(SignOutPermit(Arc::clone(self)))
    }

    fn admit_sign_out(&self) -> Result<(), AccountRuntimeError> {
        let mut gate = self.lock_sign_outs();
        if gate.sealed_for_exit {
            return Err(AccountRuntimeError {
                code: "account_exit_in_progress",
                message: "KalCode is closing. Sign out after it reopens.",
                retryable: true,
            });
        }
        gate.running = gate.running.checked_add(1).ok_or(AccountRuntimeError {
            code: "account_runtime_unavailable",
            message: "The account service is unavailable. Restart KalCode and try again.",
            retryable: false,
        })?;
        Ok(())
    }

    fn finish_sign_out(&self) {
        let mut gate = self.lock_sign_outs();
        debug_assert!(gate.running > 0, "sign-out obligation released twice");
        gate.running -= 1;
        self.sign_outs_settled.notify_all();
    }

    /// Exit preflight: waits up to `timeout` for every running sign-out to finish clearing
    /// credentials, then seals so no sign-out starts that the exit would interrupt. `false`
    /// means one is still running; nothing is sealed and the exit must not proceed.
    pub fn seal_sign_outs_for_exit(&self, timeout: Duration) -> bool {
        let gate = self.lock_sign_outs();
        let (mut gate, _) = self
            .sign_outs_settled
            .wait_timeout_while(gate, timeout, |gate| gate.running > 0)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if gate.running > 0 {
            return false;
        }
        gate.sealed_for_exit = true;
        true
    }

    /// Reopens sign-out after an exit preflight that sealed it did not complete.
    pub fn reopen_sign_outs(&self) {
        self.lock_sign_outs().sealed_for_exit = false;
    }

    pub fn usage(&self) -> Result<AccountUsageSnapshot, AccountRuntimeError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) || self.acquire_active_lease().is_err() {
            return Err(authentication_required());
        }
        let token = self.session_token()?;
        let mut usage = match self.retry(generation, RetryClass::Read, || self.api.usage(&token)) {
            Ok(response) => self.accept_usage(response),
            Err(error) => self.cached_usage().ok_or(error),
        }?;
        drop(_lane);
        let paid = matches!(
            self.snapshot().tier,
            Some(AccountTier::Pro | AccountTier::Max | AccountTier::Max2x)
        );
        let interval = if paid {
            self.api.billing_interval(&token).ok().flatten()
        } else {
            None
        };
        let mut state = self.lock_state();
        if !self.is_current(generation) || state.snapshot.authority() != AccountAuthority::Active {
            return Err(authentication_required());
        }
        state.snapshot.billing_interval = interval;
        usage.billing_interval = interval;
        Ok(usage)
    }

    /// Sets (`Some`) or clears (`None`) the KalCode account's cosmetic display name.
    ///
    /// Only the name changes: account id, email, session, entitlement and authority revision
    /// stay exactly as they are, so no lease or running work is disturbed. The server validates
    /// and normalizes; the returned name is published and cached for offline restarts.
    pub fn set_display_name(
        &self,
        display_name: Option<String>,
    ) -> Result<AccountSnapshot, AccountRuntimeError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _lane = self.lock_lane()?;
        if !self.is_current(generation) {
            return Err(cancelled());
        }
        if display_name
            .as_ref()
            .is_some_and(|name| name.len() > MAX_DISPLAY_NAME_REQUEST_BYTES)
        {
            return Err(invalid_display_name());
        }
        let account_id = self
            .snapshot()
            .account
            .map(|account| account.id)
            .ok_or_else(authentication_required)?;
        let token = self.session_token()?;
        let response = self.api.set_display_name(&token, display_name.as_deref());
        if !self.is_current(generation) {
            return Err(cancelled());
        }
        let updated = match response {
            Ok(account) => public_account(account)?,
            Err(error) if error.status() == Some(401) => {
                self.clear_unauthorized()?;
                return Err(authentication_required());
            }
            Err(error) => return Err(display_name_error(error)),
        };
        if updated.id != account_id {
            return Err(account_identity_mismatch());
        }
        let mut state = self.lock_state();
        if !self.is_current(generation) {
            return Err(cancelled());
        }
        let Some(account) = state
            .snapshot
            .account
            .as_mut()
            .filter(|account| account.id == updated.id)
        else {
            return Err(cancelled());
        };
        account.display_name = updated.display_name.clone();
        if let Some(cached) = state
            .cached
            .as_ref()
            .filter(|cached| cached.account().id == updated.id)
        {
            let mut cached_account = cached.account().clone();
            cached_account.display_name = updated.display_name;
            if let Ok(next) =
                CachedAccountSecret::new(cached.entitlement_token().to_owned(), cached_account)
            {
                state.cached = Some(next);
            }
        }
        // The server already holds the name; a local cache write failure only costs the name on
        // an offline restart, so it never turns a saved name into an error.
        if self.persist_locked(&state).is_err() {
            tracing::warn!(event = "account.display_name_cache_write_failed");
        }
        Ok(state.snapshot.clone())
    }

    /// Revalidates the current account's signed entitlement on every metering decision. The
    /// expected identity was captured by the native account-owned runtime, never by the WebView.
    pub(crate) fn kalvoice_authority(
        &self,
        expected_account_id: &str,
    ) -> Result<KalVoiceAuthority, AccountRuntimeError> {
        let lease = self.acquire_active_lease()?;
        let now_unix = self.clock.now_unix();
        let state = self.lock_state();
        let cached = state.cached.as_ref().ok_or_else(authentication_required)?;
        let entitlement = self
            .verifier
            .verify(cached.entitlement_token(), now_unix)
            .map_err(|_| invalid_entitlement())?;
        if entitlement.account_id != expected_account_id
            || cached.account().id != expected_account_id
        {
            return Err(account_identity_mismatch());
        }
        let receipt = state
            .usage_receipt
            .as_ref()
            .and_then(|receipt| {
                self.verifier
                    .verify_usage_receipt(receipt.expose_receipt(), now_unix)
                    .ok()
            })
            .filter(|receipt| {
                receipt.account_id == entitlement.account_id && receipt.tier == entitlement.tier
            });
        let offline = state.snapshot.phase == AccountPhase::OfflineGrace;
        drop(state);
        if !self.validate_active_lease(&lease) {
            return Err(authentication_required());
        }
        Ok(KalVoiceAuthority {
            entitlement,
            receipt,
            lease,
            offline,
            now_unix,
        })
    }

    /// A single bounded idempotent metering call. Unknown transport outcomes remain caller-owned
    /// durable pending claims; invalid receipts and lost account authority never grant execution.
    /// A request that was never counted (refused before sending, or a definitive 4xx) is
    /// [`KalVoiceRecord::Refused`]; an outcome KalCode can't know stays an error.
    pub(crate) fn record_kalvoice(
        &self,
        lease: &AuthorityLease,
        request_id: &str,
        offline: bool,
    ) -> Result<KalVoiceRecord, AccountRuntimeError> {
        if !kalcode_contracts::ids::is_valid_id(request_id) || !self.validate_active_lease(lease) {
            return Ok(KalVoiceRecord::Refused(authentication_required()));
        }
        let _lane = match self.request_lane.try_lock() {
            Ok(lane) => lane,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(KalVoiceRecord::Unavailable),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Ok(KalVoiceRecord::Refused(authentication_required()));
            }
        };
        if !self.validate_active_lease(lease) {
            return Ok(KalVoiceRecord::Refused(authentication_required()));
        }
        let token = match self.session_token() {
            Ok(token) => token,
            Err(error) => return Ok(KalVoiceRecord::Refused(error)),
        };
        let result = self.api.record_kalvoice(&token, request_id, offline);
        let _effect = self.lock_generation_effect();
        if !self.validate_active_lease(lease) {
            return Err(authentication_required());
        }
        match result {
            Ok(response) => {
                self.accept_usage(response.usage)?;
                Ok(KalVoiceRecord::Confirmed {
                    allowed: response.allowed,
                })
            }
            Err(ApiError::Transport) => Ok(KalVoiceRecord::Unavailable),
            Err(ApiError::Http {
                status: 429 | 500..=599,
                ..
            }) => Ok(KalVoiceRecord::Unavailable),
            Err(
                error @ ApiError::Http {
                    status: 400..=499, ..
                },
            ) => Ok(KalVoiceRecord::Refused(api_error(error))),
            Err(error) => Err(api_error(error)),
        }
    }

    fn fetch_authority(&self, generation: u64) -> Result<AccountSnapshot, AccountRuntimeError> {
        self.fetch_authority_expected(generation, None)
    }

    fn fetch_authority_expected(
        &self,
        generation: u64,
        expected_account_id: Option<&str>,
    ) -> Result<AccountSnapshot, AccountRuntimeError> {
        let token = self.session_token()?;
        let account = match self.retry(generation, RetryClass::Read, || self.api.account(&token)) {
            Ok(account) => account,
            Err(error) if error.code == "authentication_required" => {
                return self.clear_unauthorized();
            }
            Err(error) => {
                if !self.is_current(generation) {
                    return Ok(self.snapshot());
                }
                if let Some(offline) = self.offline_snapshot(generation) {
                    return Ok(offline);
                }
                let _ = error;
                return Ok(self.publish_degraded(generation, "account_service_unavailable"));
            }
        };
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        let account = public_account(account)?;
        if expected_account_id.is_some_and(|expected| expected != account.id) {
            self.session_store()?.clear().map_err(store_error)?;
            {
                let mut state = self.lock_state();
                state.session = None;
                state.pending = None;
                state.cached = None;
                state.usage_receipt = None;
                state.checkout = None;
            }
            self.publish_signed_out(generation);
            return Err(account_identity_mismatch());
        }
        let switched_account = self
            .lock_state()
            .cached
            .as_ref()
            .is_some_and(|cached| cached.account().id != account.id);
        if switched_account {
            if !self.is_current(generation) {
                return Ok(self.snapshot());
            }
            let mut state = self.lock_state();
            state.cached = None;
            state.usage_receipt = None;
            state.checkout = None;
            state.snapshot = AccountSnapshot {
                phase: AccountPhase::Degraded,
                degraded_reason: Some("account_changed".into()),
                ..AccountSnapshot::signed_out()
            };
            self.notify_authority_locked(&mut state, generation);
            self.persist_locked(&state)?;
        }
        if account.activated_at.is_none() {
            let mut state = self.lock_state();
            let phase = if state.snapshot.phase == AccountPhase::ConfirmingPlan
                || state.checkout.is_some()
            {
                AccountPhase::ConfirmingPlan
            } else {
                AccountPhase::AuthenticatedUnactivated
            };
            state.cached = None;
            state.usage_receipt = None;
            state.snapshot = authenticated_snapshot(phase, account, state.session.as_ref());
            self.notify_authority_locked(&mut state, generation);
            self.persist_locked(&state)?;
            return Ok(state.snapshot.clone());
        }
        let response = match self.retry(generation, RetryClass::Read, || {
            self.api.entitlement(&token)
        }) {
            Ok(response) => response,
            Err(error) if error.code == "authentication_required" => {
                return self.clear_unauthorized();
            }
            Err(_) => {
                if let Some(offline) = self.offline_snapshot(generation) {
                    return Ok(offline);
                }
                return Ok(self.publish_degraded(generation, "entitlement_unavailable"));
            }
        };
        self.accept_entitlement(account, response, generation)
    }

    fn accept_entitlement(
        &self,
        account: PublicAccount,
        response: EntitlementResponse,
        generation: u64,
    ) -> Result<AccountSnapshot, AccountRuntimeError> {
        if !self.is_current(generation) {
            return Ok(self.snapshot());
        }
        let entitlement = self
            .verifier
            .verify(&response.token, self.clock.now_unix())
            .map_err(|_| invalid_entitlement());
        let entitlement = match entitlement {
            Ok(entitlement) => entitlement,
            Err(error) => {
                if let Some(offline) = self.offline_snapshot(generation) {
                    return Ok(offline);
                }
                if !self.is_current(generation) {
                    return Ok(self.snapshot());
                }
                self.publish_degraded(generation, "entitlement_unverified");
                return Err(error);
            }
        };
        if entitlement.account_id != account.id {
            {
                if !self.is_current(generation) {
                    return Ok(self.snapshot());
                }
                let mut state = self.lock_state();
                state.cached = None;
                state.usage_receipt = None;
                state.checkout = None;
                self.persist_locked(&state)?;
            }
            self.publish_degraded(generation, "entitlement_account_mismatch");
            return Err(invalid_entitlement());
        }
        let tier = account_tier(entitlement.tier);
        let cached = CachedAccountSecret::new(response.token, account.clone())
            .map_err(|_| invalid_entitlement())?;
        let snapshot = AccountSnapshot {
            phase: AccountPhase::Ready,
            account: Some(account),
            tier: Some(tier),
            billing_interval: None,
            session_expires_at: self.session_expiry_iso(),
            entitlement_expires_at: Some(entitlement.expires_at),
            offline_grace_until: None,
            pending_email: None,
            pending_expires_at: None,
            degraded_reason: None,
        };
        let mut state = self.lock_state();
        state.cached = Some(cached);
        state.checkout = None;
        state.snapshot = snapshot.clone();
        self.notify_authority_locked(&mut state, generation);
        self.persist_locked(&state)?;
        Ok(snapshot)
    }

    fn offline_snapshot(&self, generation: u64) -> Option<AccountSnapshot> {
        let mut state = self.lock_state();
        if !self.is_current(generation) {
            return None;
        }
        if state
            .session
            .as_ref()
            .is_none_or(|session| session.is_expired_at(self.clock.now_unix()))
        {
            return None;
        }
        let cached = state.cached.as_ref()?;
        let entitlement = self
            .verifier
            .verify(cached.entitlement_token(), self.clock.now_unix())
            .ok()?;
        if entitlement.account_id != cached.account().id {
            return None;
        }
        let snapshot = AccountSnapshot {
            phase: AccountPhase::OfflineGrace,
            account: Some(cached.account().clone()),
            tier: Some(account_tier(entitlement.tier)),
            billing_interval: state.snapshot.billing_interval,
            session_expires_at: state
                .session
                .as_ref()
                .and_then(|session| epoch_iso(session.expires_at())),
            entitlement_expires_at: Some(entitlement.expires_at),
            offline_grace_until: Some(entitlement.expires_at),
            pending_email: None,
            pending_expires_at: None,
            degraded_reason: Some("account_service_unavailable".into()),
        };
        if !self.is_current(generation) {
            return None;
        }
        state.snapshot = snapshot.clone();
        self.notify_authority_locked(&mut state, generation);
        Some(snapshot)
    }

    fn accept_usage(
        &self,
        response: UsageResponse,
    ) -> Result<AccountUsageSnapshot, AccountRuntimeError> {
        let receipt = self
            .verifier
            .verify_usage_receipt(&response.receipt, self.clock.now_unix())
            .map_err(|_| invalid_entitlement())?;
        let snapshot = self.snapshot();
        let account_id = snapshot.account.as_ref().map(|account| account.id.as_str());
        if account_id != Some(receipt.account_id.as_str())
            || snapshot.tier != Some(account_tier(receipt.tier))
            || response.usage.used != receipt.used
            || response.usage.allowance != receipt.allowance
            || response.usage.period_start != receipt.period_start
            || response.usage.resets_at != receipt.resets_at
        {
            return Err(invalid_entitlement());
        }
        let signed =
            SignedUsageReceipt::new(response.receipt).map_err(|_| invalid_entitlement())?;
        let usage = AccountUsageSnapshot {
            billing_interval: None,
            used: receipt.used,
            allowance: receipt.allowance,
            period_start: receipt.period_start,
            resets_at: receipt.resets_at,
        };
        let mut state = self.lock_state();
        state.usage_receipt = Some(signed);
        // Only verified unlimited OWNER usage is independent of receipt durability. Metered
        // requests must retain their pending journal claim when persistence fails, otherwise
        // an offline restart could combine an older receipt with already-acknowledged claims.
        if let Err(error) = self.persist_locked(&state) {
            if receipt.tier != Tier::Owner || receipt.allowance.is_some() {
                return Err(error);
            }
            tracing::warn!(event = "account.usage_receipt_cache_write_failed");
        }
        Ok(usage)
    }

    fn cached_usage(&self) -> Option<AccountUsageSnapshot> {
        let state = self.lock_state();
        let receipt = state.usage_receipt.as_ref()?;
        let verified = self
            .verifier
            .verify_usage_receipt(receipt.expose_receipt(), self.clock.now_unix())
            .ok()?;
        let account_id = state
            .snapshot
            .account
            .as_ref()
            .map(|account| account.id.as_str());
        if account_id != Some(verified.account_id.as_str())
            || state.snapshot.tier != Some(account_tier(verified.tier))
        {
            return None;
        }
        Some(AccountUsageSnapshot {
            billing_interval: None,
            used: verified.used,
            allowance: verified.allowance,
            period_start: verified.period_start,
            resets_at: verified.resets_at,
        })
    }

    fn retry<T>(
        &self,
        generation: u64,
        class: RetryClass,
        mut request: impl FnMut() -> Result<T, ApiError>,
    ) -> Result<T, AccountRuntimeError> {
        let mut completed = 0_u8;
        loop {
            if !self.is_current(generation) {
                return Err(cancelled());
            }
            let response = request();
            if !self.is_current(generation) {
                return Err(cancelled());
            }
            match response {
                Ok(value) => return Ok(value),
                Err(error) if error.status() == Some(401) => {
                    return Err(authentication_required());
                }
                Err(error) if error.is_retryable() && error.status().is_some() => {
                    let Some(delay) = retry_delay(class, completed, error.retry_after_seconds())
                    else {
                        return Err(api_error(error));
                    };
                    completed = completed.saturating_add(1);
                    let delay = jitter(delay);
                    if !self.wait_while_current(generation, delay) {
                        return Err(cancelled());
                    }
                }
                Err(error) => return Err(api_error(error)),
            }
        }
    }

    fn wait_while_current(&self, generation: u64, duration: Duration) -> bool {
        let mut remaining = duration;
        while !remaining.is_zero() {
            if !self.is_current(generation) {
                return false;
            }
            let slice = remaining.min(RETRY_POLL_INTERVAL);
            self.clock.sleep(slice);
            remaining = remaining.saturating_sub(slice);
        }
        self.is_current(generation)
    }

    /// The server rejected the session (401): signed out, and the sign-in screen says it expired.
    fn clear_unauthorized(&self) -> Result<AccountSnapshot, AccountRuntimeError> {
        let generation = self.advance_generation();
        self.session_store()?.clear().map_err(store_error)?;
        Ok(self.publish_session_expired(generation))
    }

    fn publish_signed_out(&self, generation: u64) -> AccountSnapshot {
        self.publish_signed_out_as(generation, AccountSnapshot::signed_out())
    }

    fn publish_session_expired(&self, generation: u64) -> AccountSnapshot {
        self.publish_signed_out_as(generation, AccountSnapshot::session_expired())
    }

    fn publish_signed_out_as(&self, generation: u64, snapshot: AccountSnapshot) -> AccountSnapshot {
        let _effect = self.lock_generation_effect();
        if !self.is_current(generation) {
            return self.snapshot();
        }
        let mut state = self.lock_state();
        *state = RuntimeState {
            snapshot: snapshot.clone(),
            ..RuntimeState::default()
        };
        self.notify_authority_locked(&mut state, generation);
        snapshot
    }

    fn publish_degraded(&self, generation: u64, reason: &str) -> AccountSnapshot {
        let _effect = self.lock_generation_effect();
        if !self.is_current(generation) {
            return self.snapshot();
        }
        let snapshot = AccountSnapshot {
            phase: AccountPhase::Degraded,
            degraded_reason: Some(reason.into()),
            ..AccountSnapshot::signed_out()
        };
        let mut state = self.lock_state();
        state.snapshot = snapshot.clone();
        self.notify_authority_locked(&mut state, generation);
        snapshot
    }

    fn require_unactivated(&self) -> Result<(), AccountRuntimeError> {
        if self.authority() == AccountAuthority::AuthenticatedUnactivated {
            Ok(())
        } else {
            Err(AccountRuntimeError {
                code: "account_not_activated",
                message: "Choose a KalCode plan to continue.",
                retryable: false,
            })
        }
    }

    fn session_token(&self) -> Result<String, AccountRuntimeError> {
        let session = self
            .lock_state()
            .session
            .clone()
            .ok_or_else(authentication_required)?;
        if session.is_expired_at(self.clock.now_unix()) {
            let generation = self.advance_generation();
            self.session_store()?.clear().map_err(store_error)?;
            self.publish_session_expired(generation);
            return Err(authentication_required());
        }
        Ok(session.expose_token().to_owned())
    }

    fn session_expiry_iso(&self) -> Option<String> {
        self.lock_state()
            .session
            .as_ref()
            .and_then(|session| epoch_iso(session.expires_at()))
    }

    fn persist_locked(&self, state: &RuntimeState) -> Result<(), AccountRuntimeError> {
        self.session_store()?
            .save_complete(
                state.session.as_ref(),
                state.pending.as_ref(),
                state.cached.as_ref(),
                state.usage_receipt.as_ref(),
                state.checkout.as_ref(),
            )
            .map_err(store_error)
    }

    fn session_store(&self) -> Result<AccountSessionStore<'_>, AccountRuntimeError> {
        AccountSessionStore::new(self.store.as_ref()).map_err(store_error)
    }

    fn lock_state(&self) -> MutexGuard<'_, RuntimeState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_lane(&self) -> Result<MutexGuard<'_, ()>, AccountRuntimeError> {
        self.request_lane.lock().map_err(|_| AccountRuntimeError {
            code: "account_runtime_unavailable",
            message: "The account service is unavailable. Restart KalCode and try again.",
            retryable: false,
        })
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn advance_generation(&self) -> u64 {
        let _effect = self.lock_generation_effect();
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn lock_generation_effect(&self) -> MutexGuard<'_, ()> {
        self.generation_effect_lane
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn notify_authority_locked(&self, state: &mut RuntimeState, generation: u64) {
        let update = AuthorityUpdate {
            revision: self.revision.fetch_add(1, Ordering::SeqCst) + 1,
            generation,
            authority: state.snapshot.authority(),
            phase: state.snapshot.phase,
        };
        state.authority_generation = update.generation;
        state.authority_revision = update.revision;
        let mut subscribers = self
            .authority_subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        subscribers.retain(|weak| {
            let Some(slot) = weak.upgrade() else {
                return false;
            };
            *slot
                .latest
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = update;
            slot.changed.notify_all();
            true
        });
    }
}

/// The longest name the server accepts is 64 characters (at most 4 UTF-8 bytes each); anything
/// longer than this bound can never be valid and is refused without a request.
const MAX_DISPLAY_NAME_REQUEST_BYTES: usize = 1024;

/// A display name the WebView may show: what the server accepts (1–64 characters, already
/// trimmed, no control characters).
fn valid_display_name(value: &str) -> bool {
    let count = value.chars().count();
    (1..=64).contains(&count) && value == value.trim() && !value.chars().any(char::is_control)
}

fn public_account(value: ApiAccount) -> Result<PublicAccount, AccountRuntimeError> {
    let id_valid =
        !value.id.is_empty() && value.id.len() <= 128 && !value.id.chars().any(char::is_control);
    let email_valid = !value.email.is_empty()
        && value.email.len() <= 320
        && value.email == value.email.trim()
        && value.email.contains('@')
        && !value.email.chars().any(char::is_control);
    let activation_valid = value
        .activated_at
        .as_ref()
        .is_none_or(|time| parse_iso_epoch(time).is_ok());
    let display_name_valid = value.display_name.as_deref().is_none_or(valid_display_name);
    if !id_valid || !email_valid || !activation_valid || !display_name_valid {
        return Err(invalid_response());
    }
    Ok(PublicAccount {
        id: value.id,
        email: value.email,
        activated_at: value.activated_at,
        display_name: value.display_name,
    })
}

fn valid_email(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 320
        && value == value.trim()
        && value.contains('@')
        && !value.chars().any(char::is_control)
}

fn session_from_response(
    response: super::api::SignedInResponse,
) -> Result<SessionSecret, AccountRuntimeError> {
    let expires_at = parse_iso_epoch(&response.expires_at)?;
    SessionSecret::new(response.token, expires_at).map_err(|_| invalid_response())
}

fn pending_snapshot(pending: &PendingAuthSecret) -> AccountSnapshot {
    AccountSnapshot {
        phase: if pending.is_email() {
            AccountPhase::EmailPending
        } else {
            AccountPhase::SocialPending
        },
        pending_email: pending.email().map(str::to_owned),
        pending_expires_at: epoch_iso(pending.expires_at()),
        ..AccountSnapshot::signed_out()
    }
}

fn authenticated_snapshot(
    phase: AccountPhase,
    account: PublicAccount,
    session: Option<&SessionSecret>,
) -> AccountSnapshot {
    AccountSnapshot {
        phase,
        account: Some(account),
        tier: None,
        billing_interval: None,
        session_expires_at: session.and_then(|value| epoch_iso(value.expires_at())),
        entitlement_expires_at: None,
        offline_grace_until: None,
        pending_email: None,
        pending_expires_at: None,
        degraded_reason: None,
    }
}

fn account_tier(tier: Tier) -> AccountTier {
    match tier {
        Tier::Free => AccountTier::Free,
        Tier::Pro => AccountTier::Pro,
        Tier::Max => AccountTier::Max,
        Tier::Max2x => AccountTier::Max2x,
        Tier::Owner => AccountTier::Owner,
    }
}

fn parse_iso_epoch(value: &str) -> Result<i64, AccountRuntimeError> {
    if value.len() > 64 {
        return Err(invalid_response());
    }
    OffsetDateTime::parse(value, &Rfc3339)
        .map(OffsetDateTime::unix_timestamp)
        .map_err(|_| invalid_response())
}

fn epoch_iso(value: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp(value)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

fn request_id() -> Result<String, AccountRuntimeError> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| AccountRuntimeError {
        code: "randomness_unavailable",
        message: "KalCode could not safely prepare the billing request.",
        retryable: true,
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn jitter(delay: Duration) -> Duration {
    let mut byte = [0_u8; 1];
    let millis = if getrandom::fill(&mut byte).is_ok() {
        u64::from(byte[0]).min(250)
    } else {
        0
    };
    delay.saturating_add(Duration::from_millis(millis))
}

fn api_error(error: ApiError) -> AccountRuntimeError {
    match (error.status(), error.code()) {
        (None, Some("social_sign_in_unavailable")) => AccountRuntimeError {
            code: "social_sign_in_unavailable",
            message: "Social sign-in is unavailable in this build. Sign in with email instead.",
            retryable: false,
        },
        (Some(401), _) => authentication_required(),
        (Some(409), Some("account_not_activated")) => AccountRuntimeError {
            code: "account_not_activated",
            message: "Choose a KalCode plan to continue.",
            retryable: false,
        },
        (Some(409), Some("manage_existing_subscription")) => AccountRuntimeError {
            code: "manage_existing_subscription",
            message: "Manage your existing plan from the billing portal.",
            retryable: false,
        },
        (Some(409), Some("checkout_in_progress")) => AccountRuntimeError {
            code: "checkout_in_progress",
            message: "KalCode is confirming your existing checkout.",
            retryable: true,
        },
        (Some(429), _) => AccountRuntimeError {
            code: "rate_limited",
            message: "Too many account requests. Try again shortly.",
            retryable: true,
        },
        (Some(503), _) | (None, None) if error.is_retryable() => AccountRuntimeError {
            code: "account_service_unavailable",
            message: "KalCode could not reach the account service.",
            retryable: true,
        },
        _ => invalid_response(),
    }
}

#[test]
fn unavailable_social_sign_in_reports_the_build_limitation() {
    let error = api_error(ApiError::Local("social_sign_in_unavailable"));
    assert_eq!(error.code, "social_sign_in_unavailable");
    assert!(error.message.contains("Sign in with email"));
    assert!(!error.retryable);
}

fn invalid_display_name() -> AccountRuntimeError {
    AccountRuntimeError {
        code: "invalid_display_name",
        message: "Use 1–64 characters, without control or invisible formatting characters.",
        retryable: false,
    }
}

/// Saving a display name only ever fails as: invalid, rate limited, or not reachable now.
fn display_name_error(error: ApiError) -> AccountRuntimeError {
    match (error.status(), error.code()) {
        (Some(400), Some("invalid_display_name")) => invalid_display_name(),
        (Some(429), _) => api_error(error),
        // 404 is a service that predates display names: like an outage, it passes.
        (Some(status), _) if status != 404 && (400..=499).contains(&status) => invalid_response(),
        _ => AccountRuntimeError {
            code: "account_service_unavailable",
            message: "KalCode could not reach the account service.",
            retryable: true,
        },
    }
}

fn store_error(_: SessionStoreError) -> AccountRuntimeError {
    AccountRuntimeError {
        code: "secure_store_unavailable",
        message: "KalCode could not access the protected account session.",
        retryable: true,
    }
}

fn authentication_required() -> AccountRuntimeError {
    AccountRuntimeError {
        code: "authentication_required",
        message: "Sign in to continue.",
        retryable: false,
    }
}

fn terminal_auth_error() -> AccountRuntimeError {
    AccountRuntimeError {
        code: "authentication_expired",
        message: "That verification request expired. Start again.",
        retryable: false,
    }
}

fn invalid_auth_callback() -> AccountRuntimeError {
    AccountRuntimeError {
        code: "invalid_auth_callback",
        message: "KalCode rejected an invalid sign-in callback.",
        retryable: false,
    }
}

fn unexpected_auth_callback() -> AccountRuntimeError {
    AccountRuntimeError {
        code: "auth_callback_not_expected",
        message: "Start sign-in from KalCode before returning from the browser.",
        retryable: false,
    }
}

fn account_identity_mismatch() -> AccountRuntimeError {
    AccountRuntimeError {
        code: "account_identity_mismatch",
        message: "KalCode rejected a sign-in result for a different account.",
        retryable: false,
    }
}

fn invalid_response() -> AccountRuntimeError {
    AccountRuntimeError {
        code: "invalid_account_response",
        message: "KalCode could not verify the account response.",
        retryable: false,
    }
}

fn invalid_entitlement() -> AccountRuntimeError {
    AccountRuntimeError {
        code: "invalid_entitlement",
        message: "KalCode could not verify this account's plan.",
        retryable: false,
    }
}

fn cancelled() -> AccountRuntimeError {
    AccountRuntimeError {
        code: "account_request_cancelled",
        message: "The account request was cancelled.",
        retryable: true,
    }
}
