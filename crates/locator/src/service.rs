//! The running locator: owns the store, keeps the index current from the event bus on a
//! background thread (never the UI thread, never while the event bus holds the writer), and
//! answers search, rail, home and recent-work requests.
//!
//! Failure isolation (ADVANCED.md §11): the app holds `Option<Arc<Locator>>`; if it fails to
//! start the app logs it and carries on. A damaged index is dropped and rebuilt from Z1/Z3/Z2
//! without touching anything else.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kalcode_contracts::events::{EventEnvelope, EventPayload};
use kalcode_contracts::ids::is_valid_id;
use kalcode_contracts::refs::{Page, PageRequest, page_of};
use kalcode_contracts::threads::ThreadSummary;
use kalcode_core::events::SubscriptionId;
use kalcode_core::settings::{state_get, state_set};
use kalcode_core::time::{format_rfc3339, now_rfc3339};
use kalcode_core::workspaces::Workspace;
use kalcode_core::{Core, KalError, Result};
use serde_json::Value;
use time::OffsetDateTime;

use crate::entries::{
    ACTIVITY_TYPES, ProviderInfo, activity_entry, activity_thread_id, provider_entry,
    terminal_entry, thread_entry, workspace_entry,
};
use crate::home;
use crate::index::{self, Filters, IndexEntry};
use crate::query::{self, ParsedQuery};
use crate::rail::{self, RailRow};
use crate::recent;
use crate::store::{Store, invalid_id};
use crate::types::{
    HomeSummary, LocatorEntityKind, LocatorIndexState, LocatorOpenTarget, LocatorQuery,
    LocatorRecency, LocatorResponse, LocatorVia, RailSection, RailState, RailUpdate,
    RecentWorkItem, RecentWorkWhen, WorkspaceGroup, WorkspaceRailEntry,
};

/// What the locator reads from systems it doesn't own (Z3 threads, Z2 providers). Workspaces
/// and terminals are read from the core (Z1) directly.
pub trait LocatorSources: Send + Sync + 'static {
    /// Every thread, archived ones included.
    fn threads(&self) -> Result<Vec<ThreadSummary>>;
    fn thread(&self, id: &str) -> Result<Option<ThreadSummary>>;
    /// A thread's message text, newest last, at most `max_bytes` (only called for workspaces
    /// that turned message-text search on).
    fn thread_text(&self, id: &str, max_bytes: usize) -> Result<String>;
    fn providers(&self) -> Vec<ProviderInfo>;
}

const KEY_SECTIONS: &str = "rail.collapsedSections";
const KEY_GREETINGS: &str = "home.greetingHistory";
const KEY_LAST_SEEN: &str = "home.lastSeenSeq";
/// Entries written per transaction during a rebuild (keeps the writer lock short).
const REBUILD_CHUNK: usize = 400;
/// Events collected into one indexing batch.
const BATCH_WINDOW: Duration = Duration::from_millis(40);
/// Default and largest result page.
const DEFAULT_PAGE: u32 = 20;
const MAX_PAGE: u32 = 100;

enum Work {
    Event(Box<EventEnvelope>),
    Rebuild {
        clear: bool,
    },
    Workspace(String),
    /// Acknowledged once everything queued before it was applied.
    Flush(Sender<()>),
    Stop,
}

struct Inner {
    core: Arc<Core>,
    store: Store,
    sources: Arc<dyn LocatorSources>,
    ready: AtomicBool,
    rebuilding: AtomicBool,
    /// The "finished since your last visit" baseline for this app session.
    home_baseline: Mutex<Option<i64>>,
}

pub struct Locator {
    inner: Arc<Inner>,
    tx: Mutex<Option<Sender<Work>>>,
    subscription: Mutex<Option<SubscriptionId>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Locator {
    /// Opens the store, subscribes to the event bus and starts the indexing thread (which
    /// begins with a full index).
    pub fn start(core: Arc<Core>, sources: Arc<dyn LocatorSources>) -> Result<Arc<Self>> {
        let store = Store::open(&core)?;
        Self::start_with_store(core, sources, store)
    }

    /// As [`Locator::start`] with an explicit store (tests).
    pub fn start_with_store(
        core: Arc<Core>,
        sources: Arc<dyn LocatorSources>,
        store: Store,
    ) -> Result<Arc<Self>> {
        let inner = Arc::new(Inner {
            core: Arc::clone(&core),
            store,
            sources,
            ready: AtomicBool::new(false),
            rebuilding: AtomicBool::new(false),
            home_baseline: Mutex::new(None),
        });
        let (tx, rx) = mpsc::channel();
        let worker_inner = Arc::clone(&inner);
        let worker = std::thread::Builder::new()
            .name("kalcode-locator".into())
            .spawn(move || run_worker(&worker_inner, &rx))
            .map_err(|e| {
                KalError::internal("locator_unavailable", "Search couldn't start.").with_source(e)
            })?;
        let _ = tx.send(Work::Rebuild { clear: false });
        let bus_tx = Mutex::new(tx.clone());
        // Called while the core holds its writer: only hand the event to the worker.
        let subscription = core.subscribe(move |event| {
            lock(&bus_tx)
                .send(Work::Event(Box::new(event.clone())))
                .is_ok()
        });
        Ok(Arc::new(Self {
            inner,
            tx: Mutex::new(Some(tx)),
            subscription: Mutex::new(Some(subscription)),
            worker: Mutex::new(Some(worker)),
        }))
    }

    fn send(&self, work: Work) {
        if let Some(tx) = lock(&self.tx).as_ref() {
            let _ = tx.send(work);
        }
    }

    /// Stops indexing (app exit). Safe to call more than once.
    pub fn shutdown(&self) {
        if let Some(id) = lock(&self.subscription).take() {
            self.inner.core.unsubscribe(id);
        }
        if let Some(tx) = lock(&self.tx).take() {
            let _ = tx.send(Work::Stop);
        }
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }

    /// Waits until the first full index finished (tests, E2E hooks). Returns readiness.
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        let start = Instant::now();
        while !self.inner.ready.load(Ordering::SeqCst) {
            if start.elapsed() > timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        true
    }

    /// Waits until every piece of work queued before this call was applied (tests, E2E).
    pub fn flush(&self, timeout: Duration) -> bool {
        let (done_tx, done_rx) = mpsc::channel();
        self.send(Work::Flush(done_tx));
        done_rx.recv_timeout(timeout).is_ok()
    }

    pub fn index_state(&self) -> Result<LocatorIndexState> {
        Ok(LocatorIndexState {
            entries: self.inner.store.read(index::count)?,
            ready: self.inner.ready.load(Ordering::SeqCst),
            persistent: self.inner.store.persistent(),
        })
    }

    // ---------------------------------------------------------------------------------------
    // Search
    // ---------------------------------------------------------------------------------------

    /// Runs a search. The query text is never stored or logged.
    pub fn search(&self, query: &LocatorQuery) -> Result<LocatorResponse> {
        self.search_at(query, OffsetDateTime::now_utc())
    }

    pub fn search_at(&self, query: &LocatorQuery, now: OffsetDateTime) -> Result<LocatorResponse> {
        let page = query.page.clone().unwrap_or(PageRequest {
            limit: DEFAULT_PAGE,
            cursor: None,
        });
        if page.limit == 0 || page.limit > MAX_PAGE {
            return Err(KalError::validation(
                "invalid_page_size",
                "Page size must be between 1 and 100.",
            ));
        }
        if let Some(workspace) = &query.workspace_id
            && !is_valid_id(workspace)
        {
            return Err(invalid_id());
        }
        if !(-840..=840).contains(&query.tz_offset_minutes) {
            return Err(KalError::validation(
                "invalid_offset",
                "That time zone offset isn't valid.",
            ));
        }
        let since = match &query.since {
            Some(since) => Some(
                OffsetDateTime::parse(since, &time::format_description::well_known::Rfc3339)
                    .map(format_rfc3339)
                    .map_err(|_| KalError::validation("invalid_time", "That time isn't valid."))?,
            ),
            None => None,
        };
        let parsed = query::parse(&query.text);
        let filters = |parsed: &ParsedQuery| {
            let mut kinds = query.kinds.clone();
            for kind in &parsed.kinds {
                if !kinds.contains(kind) {
                    kinds.push(*kind);
                }
            }
            let mut statuses = query.statuses.clone();
            for status in &parsed.statuses {
                if !statuses.contains(status) {
                    statuses.push(*status);
                }
            }
            let recency: Option<LocatorRecency> = query.recency.or(parsed.recency);
            let (mut from, mut until) = (since.clone(), None);
            if let Some(recency) = recency {
                let (start, end) = index::recency_window(recency, now, query.tz_offset_minutes);
                let start = format_rfc3339(start);
                from = Some(match from {
                    Some(f) if f > start => f,
                    _ => start,
                });
                until = Some(format_rfc3339(end));
            }
            Filters {
                kinds,
                statuses,
                provider_id: query
                    .provider_id
                    .clone()
                    .or_else(|| parsed.provider_id.clone())
                    .map(|p| p.as_str().to_owned()),
                workspace_id: query.workspace_id.clone(),
                since: from,
                until,
                active_only: query.active_only || parsed.active_only,
            }
        };
        let run = |parsed: &ParsedQuery| {
            self.inner
                .store
                .read(|conn| index::search(conn, parsed, &filters(parsed), query.sort, now))
        };
        let mut used = parsed.clone();
        let mut results = match run(&parsed) {
            Ok(results) => results,
            Err(error) if index::is_corruption(&error) => {
                tracing::warn!(event = "locator.index_damaged", error_code = error.code);
                self.inner.ready.store(false, Ordering::SeqCst);
                self.send(Work::Rebuild { clear: true });
                Vec::new()
            }
            Err(error) => return Err(error),
        };
        // Filter words can be part of a title ("failed login page"): when a filtered search
        // finds nothing, retry with every word as a search term, then with the filter words
        // dropped ("failed error handling" → "error handling").
        if results.is_empty() && !parsed.filter_words.is_empty() {
            let as_terms = query::without_filters(&parsed);
            let dropped = ParsedQuery {
                groups: parsed.groups.clone(),
                ..ParsedQuery::default()
            };
            for retry in [as_terms, dropped] {
                if retry.groups.is_empty() {
                    continue;
                }
                if let Ok(found) = run(&retry)
                    && !found.is_empty()
                {
                    results = found;
                    used = retry;
                    break;
                }
            }
        }
        let mut interpreted = used.interpretation();
        let applied = filters(&used);
        interpreted.kinds = applied.kinds;
        interpreted.statuses = applied.statuses;
        interpreted.recency = query.recency.or(used.recency);
        interpreted.active_only = applied.active_only;
        interpreted.provider_id = query.provider_id.clone().or(used.provider_id.clone());
        let page = page_of(&results, &page)
            .map_err(|e| KalError::validation(e.code(), "That page of results isn't available."))?;
        Ok(LocatorResponse {
            results: page,
            interpreted,
            index: self.index_state()?,
        })
    }

    /// Resolves an entry to open. Records that it was opened (never the query).
    pub fn open(
        &self,
        kind: LocatorEntityKind,
        entity_id: &str,
        via: LocatorVia,
    ) -> Result<LocatorOpenTarget> {
        let not_found = || KalError::validation("not_found", "That item no longer exists.");
        let target = match kind {
            LocatorEntityKind::Thread => {
                let thread = self
                    .inner
                    .sources
                    .thread(entity_id)?
                    .ok_or_else(not_found)?;
                LocatorOpenTarget {
                    kind,
                    entity_id: thread.id.clone(),
                    workspace_id: Some(thread.workspace_id.clone()),
                    thread_id: Some(thread.id),
                    terminal_id: thread.terminal_id,
                    provider_id: Some(thread.provider_id.as_str().to_owned()),
                }
            }
            LocatorEntityKind::Workspace => {
                let workspace = self.workspace(entity_id)?.ok_or_else(not_found)?;
                LocatorOpenTarget {
                    kind,
                    entity_id: workspace.id.clone(),
                    workspace_id: Some(workspace.id),
                    thread_id: None,
                    terminal_id: None,
                    provider_id: None,
                }
            }
            LocatorEntityKind::Terminal => {
                if !is_valid_id(entity_id) {
                    return Err(invalid_id());
                }
                let terminal = self.inner.core.terminal(entity_id)?;
                LocatorOpenTarget {
                    kind,
                    entity_id: terminal.id.clone(),
                    workspace_id: Some(terminal.workspace_id),
                    thread_id: None,
                    terminal_id: Some(terminal.id),
                    provider_id: None,
                }
            }
            LocatorEntityKind::Provider => {
                let provider = self
                    .inner
                    .sources
                    .providers()
                    .into_iter()
                    .find(|p| p.id == entity_id)
                    .ok_or_else(not_found)?;
                LocatorOpenTarget {
                    kind,
                    entity_id: provider.id.clone(),
                    workspace_id: None,
                    thread_id: None,
                    terminal_id: None,
                    provider_id: Some(provider.id),
                }
            }
            LocatorEntityKind::Activity => {
                let found = self.inner.store.read(|conn| {
                    use rusqlite::OptionalExtension;
                    Ok(conn
                        .query_row(
                            "SELECT workspace_id, provider_id FROM locator_entries
                             WHERE entity_kind = 'activity' AND entity_id = ?1",
                            [entity_id],
                            |r| {
                                Ok((
                                    r.get::<_, Option<String>>(0)?,
                                    r.get::<_, Option<String>>(1)?,
                                ))
                            },
                        )
                        .optional()?)
                })?;
                let (workspace_id, provider_id) = found.ok_or_else(not_found)?;
                LocatorOpenTarget {
                    kind,
                    entity_id: entity_id.to_owned(),
                    workspace_id,
                    thread_id: None,
                    terminal_id: None,
                    provider_id,
                }
            }
            _ => return Err(not_found()),
        };
        // `session.located` (CONTRACTS_ADVANCED §3.3) is not in the event catalog yet; the fact
        // is logged without the query until the lead adds the variant.
        tracing::info!(
            event = "session.located",
            entity_kind = kind.as_str(),
            via = ?via
        );
        Ok(target)
    }

    fn workspace(&self, id: &str) -> Result<Option<Workspace>> {
        if !is_valid_id(id) {
            return Err(invalid_id());
        }
        Ok(self
            .inner
            .core
            .workspaces()?
            .into_iter()
            .find(|w| w.id == id))
    }

    // ---------------------------------------------------------------------------------------
    // Rail
    // ---------------------------------------------------------------------------------------

    pub fn rail_state(&self) -> Result<RailState> {
        let core = &self.inner.core;
        let workspaces = core.workspaces()?;
        let active = core.active_workspace()?.map(|w| w.id);
        let threads = self.inner.sources.threads()?;
        let (rows, groups) = self
            .inner
            .store
            .read(|conn| Ok((rail::load_rows(conn)?, rail::load_groups(conn)?)))?;
        Ok(rail::build_state(
            &workspaces,
            active.as_deref(),
            &threads,
            &rows,
            &groups,
            self.collapsed_sections()?,
            self.inner.store.persistent(),
        ))
    }

    fn collapsed_sections(&self) -> Result<Vec<RailSection>> {
        let value = state_get(&self.inner.core.reader(), KEY_SECTIONS)?;
        Ok(value
            .and_then(|v| serde_json::from_value::<Vec<RailSection>>(v).ok())
            .unwrap_or_default())
    }

    pub fn set_section_collapsed(
        &self,
        section: RailSection,
        collapsed: bool,
    ) -> Result<RailState> {
        let mut sections = self.collapsed_sections()?;
        sections.retain(|s| *s != section);
        if collapsed {
            sections.push(section);
        }
        let value = serde_json::to_value(&sections)?;
        self.inner
            .core
            .write_with_events(|tx| Ok((state_set(tx, KEY_SECTIONS, &value)?, Vec::new())))?;
        self.rail_state()
    }

    /// One rail change for one workspace; returns its new entry.
    pub fn rail_update(&self, update: &RailUpdate) -> Result<WorkspaceRailEntry> {
        let workspace = self.workspace(&update.workspace_id)?.ok_or_else(|| {
            KalError::validation("workspace_unknown", "That workspace no longer exists.")
        })?;
        let fields = self
            .inner
            .store
            .write(|tx| rail::apply_update(tx, update))?;
        if !fields.is_empty() {
            // `workspace.updated` / `.archived` (CONTRACTS_ADVANCED §3.3) aren't in the event
            // catalog yet; logged meanwhile.
            tracing::info!(event = "workspace.updated", workspace_id = %workspace.id, fields = ?fields);
            self.send(Work::Workspace(workspace.id.clone()));
        }
        self.entry(&workspace)
    }

    fn entry(&self, workspace: &Workspace) -> Result<WorkspaceRailEntry> {
        let row = self
            .inner
            .store
            .read(|conn| rail::load_row(conn, &workspace.id))?;
        let threads = self.inner.sources.threads()?;
        let own: Vec<&ThreadSummary> = threads
            .iter()
            .filter(|t| t.workspace_id == workspace.id && t.archived_at.is_none())
            .collect();
        let active = self.inner.core.active_workspace()?.map(|w| w.id);
        Ok(rail::entry_for(workspace, &row, &own, active.as_deref()))
    }

    pub fn group_create(&self, name: &str) -> Result<WorkspaceGroup> {
        self.inner.store.write(|tx| rail::create_group(tx, name))
    }

    pub fn group_update(
        &self,
        id: &str,
        name: Option<&str>,
        collapsed: Option<bool>,
    ) -> Result<WorkspaceGroup> {
        self.inner
            .store
            .write(|tx| rail::update_group(tx, id, name, collapsed))
    }

    pub fn group_delete(&self, id: &str) -> Result<()> {
        self.inner.store.write(|tx| rail::delete_group(tx, id))
    }

    pub fn group_reorder(&self, ids: &[String]) -> Result<Vec<WorkspaceGroup>> {
        if ids.iter().any(|id| !is_valid_id(id)) {
            return Err(invalid_id());
        }
        self.inner.store.write(|tx| rail::reorder_groups(tx, ids))
    }

    // ---------------------------------------------------------------------------------------
    // Home and recent work
    // ---------------------------------------------------------------------------------------

    /// The returning-user home for a person whose local hour is `local_hour`.
    pub fn home_summary(&self, local_hour: u8) -> Result<HomeSummary> {
        if local_hour > 23 {
            return Err(KalError::validation(
                "invalid_hour",
                "That hour isn't valid.",
            ));
        }
        let core = &self.inner.core;
        let display_name = core.settings()?.display_name;
        let workspaces = core.workspaces()?;
        let threads = self.inner.sources.threads()?;
        let first_run = workspaces.is_empty() && threads.is_empty();

        // The greeting (history of the last shown ids in `settings`).
        let mut history: Vec<String> = state_get(&core.reader(), KEY_GREETINGS)?
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        let seed = OffsetDateTime::now_utc()
            .unix_timestamp_nanos()
            .unsigned_abs() as u64;
        let (greeting_id, greeting) = home::choose(
            local_hour,
            display_name.as_deref(),
            first_run,
            &history,
            seed ^ (history.len() as u64).wrapping_mul(0x9E37_79B9),
        );
        if let Some(id) = greeting_id {
            home::remember(&mut history, id);
            let value = serde_json::to_value(&history)?;
            core.write_with_events(|tx| Ok((state_set(tx, KEY_GREETINGS, &value)?, Vec::new())))?;
        }

        let by_id: HashMap<&str, &ThreadSummary> =
            threads.iter().map(|t| (t.id.as_str(), t)).collect();
        let ws_by_id: HashMap<&str, &Workspace> =
            workspaces.iter().map(|w| (w.id.as_str(), w)).collect();

        // What was I working on: the previous session's work, from the event log.
        let last_session = match recent::previous_session(core)? {
            Some((start, end)) => {
                let events = recent::work_events(core, None, None, Some(start), Some(end))?;
                recent::items_from_events(&events, &by_id, &ws_by_id)
                    .into_iter()
                    .filter(|i| i.kind != crate::types::RecentWorkKind::File)
                    .take(8)
                    .collect()
            }
            None => Vec::new(),
        };

        // What finished since the last visit: a per-session baseline, so the list stays stable
        // while this session runs; the watermark for the next session moves to now.
        let baseline = {
            let mut guard = lock(&self.inner.home_baseline);
            match *guard {
                Some(seq) => seq,
                None => {
                    let stored = state_get(&core.reader(), KEY_LAST_SEEN)?
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    *guard = Some(stored);
                    stored
                }
            }
        };
        let finished: Vec<RecentWorkItem> = recent::completed_after(core, baseline)?
            .into_iter()
            .filter_map(|(id, at)| {
                by_id.get(id.as_str()).map(|t| {
                    let mut item = home::thread_item(t);
                    item.last_activity_at = at;
                    item
                })
            })
            .take(8)
            .collect();
        let latest = recent::latest_seq(core)?;
        core.write_with_events(|tx| {
            Ok((
                state_set(tx, KEY_LAST_SEEN, &Value::from(latest))?,
                Vec::new(),
            ))
        })?;

        let (running, needs_you, resumable) = home::live_lists(&threads, 8);
        let rail = self.rail_state()?;
        let mut recent_workspaces: Vec<WorkspaceRailEntry> = rail
            .pinned
            .into_iter()
            .chain(rail.groups.into_iter().flat_map(|g| g.workspaces))
            .chain(rail.recent)
            .collect();
        recent_workspaces.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.last_activity_at.cmp(&a.last_activity_at))
        });
        recent_workspaces.truncate(6);
        Ok(HomeSummary {
            greeting,
            display_name,
            first_run,
            last_session,
            running,
            needs_you,
            finished_since_last_visit: finished,
            resumable,
            recent_workspaces,
            workspace_count: u32::try_from(workspaces.len()).unwrap_or(u32::MAX),
            thread_count: u32::try_from(threads.iter().filter(|t| t.archived_at.is_none()).count())
                .unwrap_or(u32::MAX),
        })
    }

    /// Threads, files and workspaces touched in a local-calendar window, newest first.
    pub fn recent_work(
        &self,
        when: RecentWorkWhen,
        tz_offset_minutes: i32,
        page: &PageRequest,
    ) -> Result<Page<RecentWorkItem>> {
        self.recent_work_at(when, tz_offset_minutes, page, OffsetDateTime::now_utc())
    }

    pub fn recent_work_at(
        &self,
        when: RecentWorkWhen,
        tz_offset_minutes: i32,
        page: &PageRequest,
        now: OffsetDateTime,
    ) -> Result<Page<RecentWorkItem>> {
        if !(-840..=840).contains(&tz_offset_minutes) {
            return Err(KalError::validation(
                "invalid_offset",
                "That time zone offset isn't valid.",
            ));
        }
        let recency = match when {
            RecentWorkWhen::Today => LocatorRecency::Today,
            RecentWorkWhen::Yesterday => LocatorRecency::Yesterday,
            RecentWorkWhen::ThisWeek => LocatorRecency::ThisWeek,
        };
        let (from, to) = index::recency_window(recency, now, tz_offset_minutes);
        let core = &self.inner.core;
        let events = recent::work_events(
            core,
            Some(&format_rfc3339(from)),
            Some(&format_rfc3339(to)),
            None,
            None,
        )?;
        let threads = self.inner.sources.threads()?;
        let workspaces = core.workspaces()?;
        let by_id: HashMap<&str, &ThreadSummary> =
            threads.iter().map(|t| (t.id.as_str(), t)).collect();
        let ws_by_id: HashMap<&str, &Workspace> =
            workspaces.iter().map(|w| (w.id.as_str(), w)).collect();
        let items = recent::items_from_events(&events, &by_id, &ws_by_id);
        page_of(&items, page)
            .map_err(|e| KalError::validation(e.code(), "That page isn't available."))
    }
}

impl Drop for Locator {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// -------------------------------------------------------------------------------------------
// The indexing worker
// -------------------------------------------------------------------------------------------

#[derive(Default)]
struct Dirty {
    threads: HashSet<String>,
    workspaces: HashSet<String>,
    removed_workspaces: HashSet<String>,
    terminals_of: HashSet<String>,
    providers: bool,
    activity: Vec<EventEnvelope>,
    rebuild: Option<bool>,
}

impl Dirty {
    fn is_empty(&self) -> bool {
        self.threads.is_empty()
            && self.workspaces.is_empty()
            && self.removed_workspaces.is_empty()
            && self.terminals_of.is_empty()
            && !self.providers
            && self.activity.is_empty()
            && self.rebuild.is_none()
    }

    fn add(&mut self, event: EventEnvelope) {
        let ws = event.correlation.workspace_id.clone();
        match &event.event {
            EventPayload::ThreadCreated { thread_id, .. }
            | EventPayload::ThreadStarted { thread_id }
            | EventPayload::ThreadStatusChanged { thread_id, .. }
            | EventPayload::ThreadRenamed { thread_id, .. }
            | EventPayload::ThreadCompleted { thread_id }
            | EventPayload::ThreadFailed { thread_id, .. }
            | EventPayload::ThreadArchived { thread_id }
            | EventPayload::AgentMessage { thread_id, .. }
            | EventPayload::ApprovalRequested { thread_id, .. }
            | EventPayload::ApprovalApproved { thread_id, .. }
            | EventPayload::ApprovalDenied { thread_id, .. }
            | EventPayload::ApprovalExpired { thread_id, .. } => {
                self.threads.insert(thread_id.clone());
            }
            EventPayload::WorkspaceCreated { workspace_id, .. }
            | EventPayload::WorkspaceOpened { workspace_id, .. } => {
                self.workspaces.insert(workspace_id.clone());
                self.terminals_of.insert(workspace_id.clone());
            }
            EventPayload::WorkspaceRemoved { workspace_id, .. } => {
                self.removed_workspaces.insert(workspace_id.clone());
            }
            EventPayload::ShellStarted { .. }
            | EventPayload::ShellCompleted { .. }
            | EventPayload::ShellFailed { .. } => {
                if let Some(ws) = ws {
                    self.terminals_of.insert(ws);
                }
            }
            EventPayload::ProviderDetected { .. }
            | EventPayload::ProviderConnected { .. }
            | EventPayload::ProviderDisconnected { .. }
            | EventPayload::ProviderError { .. } => self.providers = true,
            _ => {}
        }
        if ACTIVITY_TYPES.contains(&event.event.type_name()) {
            self.activity.push(event);
        }
    }
}

#[derive(Default)]
struct Batch {
    dirty: Dirty,
    stop: bool,
    acks: Vec<Sender<()>>,
}

impl Batch {
    fn take(&mut self, work: Work) {
        match work {
            Work::Event(event) => self.dirty.add(*event),
            Work::Rebuild { clear } => {
                self.dirty.rebuild = Some(self.dirty.rebuild.unwrap_or(false) || clear);
            }
            Work::Workspace(id) => {
                if is_valid_id(&id) {
                    self.dirty.workspaces.insert(id);
                }
            }
            Work::Flush(ack) => self.acks.push(ack),
            Work::Stop => self.stop = true,
        }
    }
}

fn run_worker(inner: &Arc<Inner>, rx: &Receiver<Work>) {
    loop {
        let Ok(first) = rx.recv() else { return };
        let mut batch = Batch::default();
        batch.take(first);
        let deadline = Instant::now() + BATCH_WINDOW;
        while !batch.stop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(work) => batch.take(work),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => batch.stop = true,
            }
        }
        let Batch { dirty, stop, acks } = batch;
        if !dirty.is_empty()
            && let Err(error) = apply(inner, dirty)
        {
            tracing::warn!(event = "locator.index_failed", error_code = error.code, error = %error.diagnostic());
            if index::is_corruption(&error) {
                inner.ready.store(false, Ordering::SeqCst);
                if let Err(error) = rebuild(inner, true) {
                    tracing::error!(event = "locator.rebuild_failed", error = %error.diagnostic());
                }
            }
        }
        for ack in acks {
            let _ = ack.send(());
        }
        if stop {
            return;
        }
    }
}

fn apply(inner: &Arc<Inner>, dirty: Dirty) -> Result<()> {
    if let Some(clear) = dirty.rebuild {
        return rebuild(inner, clear);
    }
    let core = &inner.core;
    let rows = inner.store.read(rail::load_rows)?;
    let mut upserts: Vec<IndexEntry> = Vec::new();
    let mut removals: Vec<(LocatorEntityKind, String)> = Vec::new();

    let need_threads = !dirty.threads.is_empty() || !dirty.activity.is_empty();
    let threads = if need_threads {
        inner.sources.threads()?
    } else {
        Vec::new()
    };
    let by_id: HashMap<&str, &ThreadSummary> = threads.iter().map(|t| (t.id.as_str(), t)).collect();
    for id in &dirty.threads {
        match by_id.get(id.as_str()) {
            Some(thread) => {
                let body = body_for(inner, thread, &rows);
                upserts.push(thread_entry(thread, body));
            }
            None => removals.push((LocatorEntityKind::Thread, id.clone())),
        }
    }
    let workspaces = core.workspaces()?;
    let ws_by_id: HashMap<&str, &Workspace> =
        workspaces.iter().map(|w| (w.id.as_str(), w)).collect();
    for id in &dirty.workspaces {
        if let Some(workspace) = ws_by_id.get(id.as_str()) {
            let row = rows.get(id).cloned().unwrap_or_default();
            upserts.push(workspace_entry(workspace, &row));
        }
    }
    for id in &dirty.terminals_of {
        if let Some(workspace) = ws_by_id.get(id.as_str()) {
            for terminal in core.terminals(id)? {
                upserts.push(terminal_entry(&terminal, workspace));
            }
        }
    }
    if dirty.providers {
        let now = now_rfc3339();
        for provider in inner.sources.providers() {
            upserts.push(provider_entry(&provider, &now));
        }
    }
    for event in &dirty.activity {
        let thread = activity_thread_id(event).and_then(|id| by_id.get(id).copied());
        let ws_name = event
            .correlation
            .workspace_id
            .as_deref()
            .and_then(|id| ws_by_id.get(id))
            .map(|w| w.name.as_str());
        if let Some(entry) = activity_entry(event, thread, ws_name) {
            upserts.push(entry);
        }
    }
    let removed: Vec<String> = dirty.removed_workspaces.into_iter().collect();
    inner.store.write(|tx| {
        for entry in &upserts {
            index::upsert(tx, entry)?;
        }
        for (kind, id) in &removals {
            index::remove(tx, *kind, id)?;
        }
        for id in &removed {
            index::remove(tx, LocatorEntityKind::Workspace, id)?;
            // Its terminals went with it (Z1 cascades); drop their entries.
            let terminals: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT entity_id FROM locator_entries WHERE entity_kind = 'terminal' AND workspace_id = ?1",
                )?;
                let rows = stmt.query_map([id], |r| r.get(0))?;
                rows.collect::<std::result::Result<_, _>>()?
            };
            for terminal in terminals {
                index::remove(tx, LocatorEntityKind::Terminal, &terminal)?;
            }
            tx.execute("DELETE FROM workspace_rail WHERE workspace_id = ?1", [id])?;
        }
        if !dirty.activity.is_empty() {
            index::prune_activity(tx)?;
        }
        Ok(())
    })
}

fn body_for(
    inner: &Inner,
    thread: &ThreadSummary,
    rows: &HashMap<String, RailRow>,
) -> Option<String> {
    let opted_in = rows
        .get(&thread.workspace_id)
        .is_some_and(|row| row.index_messages);
    if !opted_in {
        return None;
    }
    match inner.sources.thread_text(&thread.id, index::MAX_BODY_BYTES) {
        Ok(text) if !text.is_empty() => Some(text),
        Ok(_) => None,
        Err(error) => {
            tracing::warn!(
                event = "locator.thread_text_failed",
                error_code = error.code
            );
            None
        }
    }
}

/// Reconciles the whole index with Z1/Z3/Z2 (and backfills activity on an empty index).
fn rebuild(inner: &Arc<Inner>, clear: bool) -> Result<()> {
    inner.rebuilding.store(true, Ordering::SeqCst);
    let started = Instant::now();
    let result = rebuild_inner(inner, clear);
    inner.rebuilding.store(false, Ordering::SeqCst);
    if result.is_ok() {
        inner.ready.store(true, Ordering::SeqCst);
        tracing::info!(
            event = "locator.indexed",
            ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
        );
    }
    result
}

fn rebuild_inner(inner: &Arc<Inner>, clear: bool) -> Result<()> {
    let core = &inner.core;
    if clear {
        inner.store.write(index::clear)?;
    }
    let empty = inner.store.read(index::count)? == 0;
    let rows = inner.store.read(rail::load_rows)?;
    let threads = inner.sources.threads()?;
    let workspaces = core.workspaces()?;
    let now = now_rfc3339();

    let mut entries: Vec<IndexEntry> = Vec::with_capacity(threads.len() + workspaces.len() * 2);
    for thread in &threads {
        entries.push(thread_entry(thread, body_for(inner, thread, &rows)));
    }
    for workspace in &workspaces {
        let row = rows.get(&workspace.id).cloned().unwrap_or_default();
        entries.push(workspace_entry(workspace, &row));
        for terminal in core.terminals(&workspace.id)? {
            entries.push(terminal_entry(&terminal, workspace));
        }
    }
    for provider in inner.sources.providers() {
        entries.push(provider_entry(&provider, &now));
    }
    if empty {
        let by_id: HashMap<&str, &ThreadSummary> =
            threads.iter().map(|t| (t.id.as_str(), t)).collect();
        let ws_by_id: HashMap<&str, &Workspace> =
            workspaces.iter().map(|w| (w.id.as_str(), w)).collect();
        let page = core.query_events(&kalcode_contracts::events::EventQuery {
            types: ACTIVITY_TYPES.iter().map(|t| (*t).to_owned()).collect(),
            limit: 300,
            ..Default::default()
        })?;
        for event in &page.events {
            let thread = activity_thread_id(event).and_then(|id| by_id.get(id).copied());
            let ws_name = event
                .correlation
                .workspace_id
                .as_deref()
                .and_then(|id| ws_by_id.get(id))
                .map(|w| w.name.as_str());
            if let Some(entry) = activity_entry(event, thread, ws_name) {
                entries.push(entry);
            }
        }
    }

    let mut live: HashMap<LocatorEntityKind, HashSet<String>> = HashMap::new();
    for entry in &entries {
        live.entry(entry.kind)
            .or_default()
            .insert(entry.entity_id.clone());
    }
    for chunk in entries.chunks(REBUILD_CHUNK) {
        inner.store.write(|tx| {
            for entry in chunk {
                index::upsert(tx, entry)?;
            }
            Ok(())
        })?;
    }
    // Remove what no longer exists (activity entries age out on their own).
    for kind in [
        LocatorEntityKind::Thread,
        LocatorEntityKind::Workspace,
        LocatorEntityKind::Terminal,
        LocatorEntityKind::Provider,
    ] {
        let indexed = inner.store.read(|conn| index::ids_of_kind(conn, kind))?;
        let keep = live.remove(&kind).unwrap_or_default();
        let stale: Vec<String> = indexed
            .into_iter()
            .filter(|id| !keep.contains(id))
            .collect();
        for chunk in stale.chunks(REBUILD_CHUNK) {
            inner.store.write(|tx| {
                for id in chunk {
                    index::remove(tx, kind, id)?;
                }
                Ok(())
            })?;
        }
    }
    let known: HashSet<&str> = workspaces.iter().map(|w| w.id.as_str()).collect();
    inner.store.write(|tx| {
        rail::prune(tx, &known)?;
        index::prune_activity(tx)?;
        Ok(())
    })?;
    Ok(())
}
