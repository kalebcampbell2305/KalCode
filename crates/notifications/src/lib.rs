//! KalCode notification center (campaign Z7-W3; ADVANCED.md §4, §16.4; CONTRACTS_ADVANCED.md
//! §5.10, §9 v10).
//!
//! One notification store for every system that notifies. Today it derives notifications from
//! runtime events (a thread completed or failed, a permission request, a provider signed out,
//! threads recoverable after KalCode closed); later systems (missions, automations, the doctor,
//! provider health, continuity, hand-offs) call [`NotificationCenter::raise`] with a [`Draft`].
//!
//! - **Actionable:** every notification names the entity it navigates to (thread, provider…).
//! - **Deduplicated and rate-limited:** repeats coalesce into one unread row (with a count); a
//!   repeat within 10 s re-raises a read row; at most 30 new rows a minute; the newest 500 kept.
//! - **Persisted:** read and dismissed state live in the v10 `notifications` table
//!   ([`NOTIFICATIONS_MIGRATION`], registered in `kalcode_core::db::MIGRATIONS`); a database
//!   without it (an older build's) falls back to in-memory notifications.
//! - **Honest:** text is KalCode's own structured facts, never model prose.

pub mod center;
pub mod derive;
pub mod store;

pub use center::{Clock, Listener, NotificationCenter, SystemClock};
pub use derive::{Derived, Draft, Lookup, ThreadInfo, default_provider_name, derive};
pub use store::{Key, NOTIFICATIONS_MIGRATION};
