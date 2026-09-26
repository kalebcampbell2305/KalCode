//! Short aliases participate in the same AND groups and filters as FTS matches.
#![allow(clippy::unwrap_used)]

use kalcode_locator::index::{self, Filters, IndexEntry, MAX_CANDIDATES, SHORT_TERM_SCAN};
use kalcode_locator::query;
use kalcode_locator::store::Store;
use kalcode_locator::{LocatorEntityKind, LocatorSort, LocatorStatusFilter};
use time::OffsetDateTime;

fn entry(id: &str, title: &str) -> IndexEntry {
    IndexEntry {
        kind: LocatorEntityKind::Thread,
        entity_id: id.into(),
        workspace_id: Some("atlas".into()),
        provider_id: Some("codex".into()),
        title: title.into(),
        subtitle: None,
        status: Some("idle".into()),
        updated_at: "2026-09-25T12:00:00Z".into(),
        body: None,
    }
}

fn store(entries: &[IndexEntry]) -> Store {
    let store = Store::memory().unwrap();
    store
        .write(|tx| {
            for entry in entries {
                index::upsert(tx, entry)?;
            }
            Ok(())
        })
        .unwrap();
    store
}

fn ids(store: &Store, text: &str, filters: &Filters) -> Vec<String> {
    store
        .read(|conn| {
            index::search(
                conn,
                &query::parse(text),
                filters,
                LocatorSort::Relevance,
                OffsetDateTime::now_utc(),
            )
        })
        .unwrap()
        .into_iter()
        .map(|r| r.entity_id)
        .collect()
}

#[test]
fn database_finds_db_and_frontend_finds_ui() {
    let store = store(&[entry("db", "DB connections"), entry("ui", "UI polish")]);
    assert_eq!(ids(&store, "database", &Filters::default()), ["db"]);
    assert_eq!(ids(&store, "frontend", &Filters::default()), ["ui"]);
}

#[test]
fn short_aliases_keep_and_groups_and_explicit_filters() {
    let good = entry("good", "DB connections");
    let mut elsewhere = good.clone();
    elsewhere.entity_id = "elsewhere".into();
    elsewhere.workspace_id = Some("other".into());
    let mut wrong_provider = good.clone();
    wrong_provider.entity_id = "wrong-provider".into();
    wrong_provider.provider_id = Some("claude-code".into());
    let mut wrong_status = good.clone();
    wrong_status.entity_id = "wrong-status".into();
    wrong_status.status = Some("done".into());
    let mut wrong_kind = good.clone();
    wrong_kind.entity_id = "wrong-kind".into();
    wrong_kind.kind = LocatorEntityKind::Workspace;
    let store = store(&[
        good,
        elsewhere,
        wrong_provider,
        wrong_status,
        wrong_kind,
        entry("missing-second", "DB cleanup"),
        entry("missing-first", "Connections overview"),
    ]);
    let filters = Filters {
        workspace_id: Some("atlas".into()),
        provider_id: Some("codex".into()),
        statuses: vec![LocatorStatusFilter::Idle],
        kinds: vec![LocatorEntityKind::Thread],
        ..Filters::default()
    };
    assert_eq!(ids(&store, "database connections", &filters), ["good"]);
}

#[test]
fn mixed_alias_groups_can_each_match_a_short_alternative() {
    let store = store(&[entry("both", "DB UI"), entry("one", "DB only")]);
    assert_eq!(
        ids(&store, "database frontend", &Filters::default()),
        ["both"]
    );
}

#[test]
fn short_alias_scan_uses_only_visible_fields_and_keeps_long_body_matches() {
    let mut body_short = entry("body-short", "Connections overview");
    body_short.body = Some("db".into());
    let mut body_long = entry("body-long", "DB overview");
    body_long.body = Some("connections".into());
    let mut subtitle = entry("subtitle", "Overview");
    subtitle.subtitle = Some("DB connections".into());
    let store = store(&[body_short, body_long, subtitle]);
    let found = ids(&store, "database connections", &Filters::default());
    assert_eq!(found.len(), 2);
    assert!(found.contains(&"body-long".into()));
    assert!(found.contains(&"subtitle".into()));
    assert!(!found.contains(&"body-short".into()));
}

#[test]
fn short_alias_results_remain_bounded() {
    let entries: Vec<_> = (0..MAX_CANDIDATES + 20)
        .map(|n| entry(&n.to_string(), "DB connections"))
        .collect();
    let store = store(&entries);
    let found = ids(&store, "database", &Filters::default());
    assert!(!found.is_empty());
    assert!(found.len() <= MAX_CANDIDATES);
}

#[test]
fn scan_bound_applies_to_short_aliases_but_not_long_fts_aliases() {
    let mut long = entry("old-long", "Interface archive");
    long.updated_at = "2020-01-01T00:00:00Z".into();
    let mut short = entry("old-short", "UI archive");
    short.updated_at = long.updated_at.clone();
    let store = store(&[long, short]);
    store
        .write(|tx| {
            for n in 0..SHORT_TERM_SCAN {
                index::upsert(tx, &entry(&n.to_string(), "Unrelated"))?;
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(ids(&store, "frontend", &Filters::default()), ["old-long"]);
}
