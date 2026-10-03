//! Schema v9: per-workspace layouts round trip and stay isolated, invalid layouts are refused
//! before anything is written, stored rows that stop validating are ignored, presets keep only
//! their shape, and the tables' CHECK constraints hold.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use kalcode_contracts::ids::new_id;
use kalcode_contracts::workspace_ui::{PaneContent, PaneLayout, PaneNode, SplitAxis};
use kalcode_core::db::{MIGRATIONS, migrate, open_in_memory};
use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, Paths};
use kalcode_workspace_ui::store::{
    delete_layout, delete_preset, get_layout, list_presets, save_layout, save_preset, shape_only,
};
use kalcode_workspace_ui::{MAX_PRESETS, validate_layout};
use rusqlite::{Connection, params};

fn db() -> Connection {
    let mut conn = open_in_memory().expect("db");
    migrate(&mut conn, MIGRATIONS, None).expect("migrate");
    conn
}

fn leaf(id: &str, tabs: Vec<PaneContent>) -> PaneNode {
    PaneNode::Leaf {
        pane_id: id.into(),
        tabs,
        active_tab: 0,
        collapsed: false,
    }
}

fn layout(root: PaneNode) -> PaneLayout {
    PaneLayout {
        schema_version: 1,
        root,
        maximized_pane_id: None,
        dock: vec![],
    }
}

fn two_panes() -> PaneLayout {
    layout(PaneNode::Split {
        axis: SplitAxis::Horizontal,
        ratios: vec![600, 400],
        children: vec![
            leaf(
                "a",
                vec![PaneContent::Terminal {
                    terminal_id: new_id(),
                }],
            ),
            leaf(
                "b",
                vec![
                    PaneContent::Thread {
                        thread_id: new_id(),
                    },
                    PaneContent::Dashboard,
                ],
            ),
        ],
    })
}

#[test]
fn layouts_round_trip_per_workspace() {
    let conn = db();
    let (ws1, ws2) = (new_id(), new_id());
    assert_eq!(get_layout(&conn, &ws1).expect("get"), None);
    let first = two_panes();
    let saved = save_layout(&conn, &ws1, &first).expect("save");
    assert_eq!(saved.layout, first);
    assert_eq!(saved.schema_version, 1);
    let second = layout(leaf("only", vec![PaneContent::Dashboard]));
    save_layout(&conn, &ws2, &second).expect("save 2");

    let read = get_layout(&conn, &ws1).expect("get").expect("stored");
    assert_eq!(read.layout, first);
    assert_eq!(read.workspace_id, ws1);
    assert_eq!(
        get_layout(&conn, &ws2)
            .expect("get")
            .expect("stored")
            .layout,
        second
    );

    // Overwrite replaces the one row and moves updated_at forward.
    std::thread::sleep(std::time::Duration::from_millis(5));
    let mut maximized = first.clone();
    maximized.maximized_pane_id = Some("b".into());
    let again = save_layout(&conn, &ws1, &maximized).expect("overwrite");
    assert!(again.updated_at >= read.updated_at);
    assert_eq!(
        get_layout(&conn, &ws1)
            .expect("get")
            .expect("stored")
            .layout
            .maximized_pane_id
            .as_deref(),
        Some("b")
    );
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspace_layouts", [], |r| r.get(0))
        .expect("count");
    assert_eq!(rows, 2);

    assert!(delete_layout(&conn, &ws1).expect("delete"));
    assert!(!delete_layout(&conn, &ws1).expect("delete again"));
    assert_eq!(get_layout(&conn, &ws1).expect("get"), None);
    assert!(get_layout(&conn, &ws2).expect("get").is_some());
    assert_eq!(
        get_layout(&conn, "not an id").unwrap_err().code,
        "invalid_id"
    );
}

fn refused(conn: &Connection, bad: &PaneLayout) -> &'static str {
    let ws = new_id();
    let error = save_layout(conn, &ws, bad).expect_err("refused");
    assert!(
        get_layout(conn, &ws).expect("get").is_none(),
        "nothing written"
    );
    error.code
}

#[test]
fn coding_agent_tabs_and_dock_restore_without_becoming_threads() {
    let conn = db();
    let workspace_id = new_id();
    let agent_id = new_id();
    let mut original = layout(leaf(
        "code",
        vec![
            PaneContent::Agent {
                agent_id: agent_id.clone(),
            },
            PaneContent::Thread {
                thread_id: new_id(),
            },
        ],
    ));
    original.dock = vec![PaneContent::Agent { agent_id: new_id() }];
    save_layout(&conn, &workspace_id, &original).expect("persist agents");
    let restored = get_layout(&conn, &workspace_id)
        .expect("read layout")
        .expect("stored");
    assert_eq!(restored.layout, original);
    let encoded: String = conn
        .query_row(
            "SELECT layout FROM workspace_layouts WHERE workspace_id = ?1",
            [&workspace_id],
            |row| row.get(0),
        )
        .expect("stored JSON");
    assert!(encoded.contains(&format!("\"agentId\":\"{agent_id}\"")));
}

#[test]
fn invalid_layouts_are_refused_before_anything_is_written() {
    let conn = db();
    let mut cases: Vec<PaneLayout> = Vec::new();
    // Every structural LayoutError.
    let mut wrong_version = two_panes();
    wrong_version.schema_version = 2;
    cases.push(wrong_version);
    cases.push(layout(PaneNode::Split {
        axis: SplitAxis::Vertical,
        ratios: vec![1000],
        children: vec![leaf("a", vec![])],
    }));
    cases.push(layout(PaneNode::Split {
        axis: SplitAxis::Vertical,
        ratios: vec![700, 400],
        children: vec![leaf("a", vec![]), leaf("b", vec![])],
    }));
    let mut deep = leaf("x", vec![]);
    for i in 0..9 {
        deep = PaneNode::Split {
            axis: SplitAxis::Horizontal,
            ratios: vec![500, 500],
            children: vec![deep, leaf(&format!("p{i}"), vec![])],
        };
    }
    cases.push(layout(deep));
    cases.push(layout(leaf("a", vec![PaneContent::Dashboard; 33])));
    cases.push(layout(PaneNode::Split {
        axis: SplitAxis::Vertical,
        ratios: vec![500, 500],
        children: vec![leaf("a", vec![]), leaf("a", vec![])],
    }));
    cases.push(layout(PaneNode::Leaf {
        pane_id: "a".into(),
        tabs: vec![PaneContent::Dashboard],
        active_tab: 3,
        collapsed: false,
    }));
    let mut unknown_max = two_panes();
    unknown_max.maximized_pane_id = Some("zzz".into());
    cases.push(unknown_max);
    // Content checks, in tabs and in the dock.
    for content in [
        PaneContent::Agent {
            agent_id: "../etc".into(),
        },
        PaneContent::Thread {
            thread_id: "../etc".into(),
        },
        PaneContent::Terminal {
            terminal_id: String::new(),
        },
        PaneContent::Git {
            workspace_id: "C:\\Users".into(),
        },
        PaneContent::Widget {
            widget_id: "Bad Widget".into(),
        },
        PaneContent::Browser {
            browser_id: new_id(),
            url: Some("file:///C:/Windows/win.ini".into()),
        },
        PaneContent::Browser {
            browser_id: new_id(),
            url: Some(format!("https://{}", "a".repeat(2100))),
        },
        PaneContent::Browser {
            browser_id: new_id(),
            url: Some("https://example.com/callback?code=secret#access-token".into()),
        },
        PaneContent::Browser {
            browser_id: new_id(),
            url: Some("https://user:password@example.com/".into()),
        },
    ] {
        cases.push(layout(leaf("a", vec![content.clone()])));
        let mut docked = two_panes();
        docked.dock.push(content);
        cases.push(docked);
    }
    // Oversized (valid structure, too many bytes).
    let big = PaneContent::Browser {
        browser_id: new_id(),
        url: Some(format!("https://example.com/{}", "a".repeat(2000))),
    };
    let mut oversized = layout(leaf("a", vec![big.clone(); 32]));
    oversized.dock = vec![big; 32];
    cases.push(oversized);

    for bad in &cases {
        assert_eq!(refused(&conn, bad), "invalid_layout", "{bad:?}");
    }
    // The good ones pass.
    let ok = layout(leaf(
        "a",
        vec![
            PaneContent::Widget {
                widget_id: "dashboard-summary".into(),
            },
            PaneContent::Browser {
                browser_id: new_id(),
                url: Some("http://localhost:3000".into()),
            },
            PaneContent::Browser {
                browser_id: new_id(),
                url: None,
            },
            PaneContent::Git {
                workspace_id: new_id(),
            },
        ],
    ));
    validate_layout(&ok).expect("valid");

    let duplicate_browser_id = new_id();
    let duplicate_browser = PaneContent::Browser {
        browser_id: duplicate_browser_id,
        url: Some("https://example.com/preview".into()),
    };
    let duplicate = layout(PaneNode::Split {
        axis: SplitAxis::Horizontal,
        ratios: vec![500, 500],
        children: vec![
            leaf("a", vec![duplicate_browser.clone()]),
            leaf("b", vec![duplicate_browser.clone()]),
        ],
    });
    assert_eq!(refused(&conn, &duplicate), "invalid_layout");

    let mut duplicate_in_dock = layout(leaf("a", vec![duplicate_browser.clone()]));
    duplicate_in_dock.dock.push(duplicate_browser);
    assert_eq!(refused(&conn, &duplicate_in_dock), "invalid_layout");
}

#[test]
fn a_stored_row_that_no_longer_validates_is_ignored() {
    let conn = db();
    let ws = new_id();
    conn.execute(
        "INSERT INTO workspace_layouts VALUES (?1, 1, ?2, 'x')",
        params![ws, r#"{"schemaVersion":1,"root":{"kind":"hologram"}}"#],
    )
    .expect("insert");
    assert_eq!(get_layout(&conn, &ws).expect("get"), None);
    let ws2 = new_id();
    let mut bad = two_panes();
    bad.maximized_pane_id = Some("gone".into());
    conn.execute(
        "INSERT INTO workspace_layouts VALUES (?1, 1, ?2, 'x')",
        params![ws2, serde_json::to_string(&bad).expect("json")],
    )
    .expect("insert");
    assert_eq!(get_layout(&conn, &ws2).expect("get"), None);

    let secret_ws = new_id();
    let secret = layout(leaf(
        "secret-browser",
        vec![PaneContent::Browser {
            browser_id: new_id(),
            url: Some("https://example.com/callback?code=secret#access-token".into()),
        }],
    ));
    conn.execute(
        "INSERT INTO workspace_layouts VALUES (?1, 1, ?2, 'x')",
        params![secret_ws, serde_json::to_string(&secret).expect("json")],
    )
    .expect("insert secret layout");
    assert_eq!(get_layout(&conn, &secret_ws).expect("get"), None);

    let duplicate_ws = new_id();
    let browser_id = new_id();
    let browser = PaneContent::Browser {
        browser_id,
        url: Some("https://example.com/preview".into()),
    };
    let duplicate = layout(PaneNode::Split {
        axis: SplitAxis::Horizontal,
        ratios: vec![500, 500],
        children: vec![
            leaf("left", vec![browser.clone()]),
            leaf("right", vec![browser]),
        ],
    });
    conn.execute(
        "INSERT INTO workspace_layouts VALUES (?1, 1, ?2, 'x')",
        params![
            duplicate_ws,
            serde_json::to_string(&duplicate).expect("json")
        ],
    )
    .expect("insert duplicate layout");
    assert_eq!(get_layout(&conn, &duplicate_ws).expect("get"), None);
}

#[test]
fn presets_keep_only_their_shape() {
    let conn = db();
    let mut source = two_panes();
    source.maximized_pane_id = Some("a".into());
    source.dock.push(PaneContent::Dashboard);
    let saved = save_preset(&conn, "  Review  ", &source).expect("save");
    assert_eq!(saved.name, "Review");
    assert_eq!(saved.layout, shape_only(&source));
    assert_eq!(saved.layout.maximized_pane_id, None);
    assert!(saved.layout.dock.is_empty());
    let PaneNode::Split {
        ratios, children, ..
    } = &saved.layout.root
    else {
        panic!("split");
    };
    assert_eq!(ratios, &vec![600, 400]);
    for child in children {
        let PaneNode::Leaf {
            tabs,
            active_tab,
            collapsed,
            ..
        } = child
        else {
            panic!("leaf");
        };
        assert!(tabs.is_empty());
        assert_eq!((*active_tab, *collapsed), (0, false));
    }
    let stored: String = conn
        .query_row(
            "SELECT layout FROM layout_presets WHERE id = ?1",
            params![saved.id],
            |r| r.get(0),
        )
        .expect("stored");
    assert!(!stored.contains("terminal"), "{stored}");

    assert_eq!(list_presets(&conn).expect("list"), vec![saved.clone()]);
    assert_eq!(
        save_preset(&conn, "Review", &source).unwrap_err().code,
        "preset_name_taken"
    );
    assert_eq!(
        save_preset(&conn, "", &source).unwrap_err().code,
        "invalid_preset_name"
    );
    let mut bad = source.clone();
    bad.schema_version = 9;
    assert_eq!(
        save_preset(&conn, "Other", &bad).unwrap_err().code,
        "invalid_layout"
    );

    delete_preset(&conn, &saved.id).expect("delete");
    assert!(list_presets(&conn).expect("list").is_empty());
    assert_eq!(
        delete_preset(&conn, &saved.id).unwrap_err().code,
        "preset_not_found"
    );
    assert_eq!(delete_preset(&conn, "nope").unwrap_err().code, "invalid_id");
}

#[test]
fn presets_are_capped() {
    let conn = db();
    for i in 0..MAX_PRESETS {
        save_preset(&conn, &format!("Layout {i}"), &two_panes()).expect("save");
    }
    assert_eq!(
        save_preset(&conn, "One more", &two_panes())
            .unwrap_err()
            .code,
        "too_many_presets"
    );
    assert_eq!(list_presets(&conn).expect("list").len(), MAX_PRESETS);
}

#[test]
fn tables_refuse_bad_rows() {
    let conn = db();
    let ws = new_id();
    assert!(
        conn.execute(
            "INSERT INTO workspace_layouts VALUES (?1, 1, 'not json', 'x')",
            params![ws],
        )
        .is_err()
    );
    assert!(
        conn.execute(
            "INSERT INTO workspace_layouts VALUES (?1, 0, '{}', 'x')",
            params![ws],
        )
        .is_err()
    );
    let huge = format!("\"{}\"", "a".repeat(70_000));
    assert!(
        conn.execute(
            "INSERT INTO workspace_layouts VALUES (?1, 1, ?2, 'x')",
            params![ws, huge],
        )
        .is_err()
    );
    assert!(
        conn.execute(
            "INSERT INTO layout_presets (id, name, schema_version, layout, created_at) VALUES ('p', '', 1, '{}', 'x')",
            [],
        )
        .is_err()
    );
    assert!(
        conn.execute(
            "INSERT INTO layout_presets (id, name, schema_version, layout, created_at) VALUES ('p', ?1, 1, '{}', 'x')",
            params!["n".repeat(61)],
        )
        .is_err()
    );
    assert!(
        conn.execute(
            "INSERT INTO layout_presets (id, name, schema_version, layout, builtin, created_at) VALUES ('p', 'n', 1, '{}', 2, 'x')",
            [],
        )
        .is_err()
    );
    // STRICT: a text schema version is refused.
    assert!(
        conn.execute(
            "INSERT INTO workspace_layouts VALUES (?1, 'one', '{}', 'x')",
            params![ws],
        )
        .is_err()
    );
}

#[test]
fn layouts_persist_across_restart_through_core() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = || CoreConfig {
        paths: Paths::new(dir.path()),
        app_version: "0.1.0-test".into(),
        channel: BuildChannel::Development,
    };
    let ws = new_id();
    let layout = two_panes();
    {
        let core = Core::open(config()).expect("open");
        let (saved, events) = core
            .transact(|tx| Ok((save_layout(tx, &ws, &layout)?, Vec::new())))
            .expect("save");
        assert!(events.is_empty(), "layout saves emit no events");
        assert_eq!(saved.layout, layout);
        core.shutdown();
    }
    let core = Core::open(config()).expect("reopen");
    let read = core
        .read(|c| get_layout(c, &ws))
        .expect("read")
        .expect("restored");
    assert_eq!(read.layout, layout);
}

#[test]
fn legacy_browser_layout_keeps_other_panes_and_gets_a_persistable_identity() {
    let conn = db();
    let ws = new_id();
    let legacy = serde_json::json!({
        "schemaVersion": 1,
        "root": {"kind":"leaf", "paneId":"browser-pane", "tabs":[
            {"kind":"browser","url":"http://localhost:3000"}, {"kind":"dashboard"}
        ], "activeTab":0, "collapsed":false},
        "maximizedPaneId":null, "dock":[]
    });
    conn.execute(
        "INSERT INTO workspace_layouts VALUES (?1, 1, ?2, 'x')",
        params![ws, legacy.to_string()],
    )
    .unwrap();
    let restored = get_layout(&conn, &ws).unwrap().unwrap();
    let PaneNode::Leaf { tabs, .. } = &restored.layout.root else {
        panic!("leaf")
    };
    assert_eq!(tabs.len(), 2);
    let PaneContent::Browser { browser_id, .. } = &tabs[0] else {
        panic!("browser")
    };
    assert!(kalcode_contracts::ids::is_valid_id(browser_id));
    save_layout(&conn, &ws, &restored.layout).unwrap();
    assert_eq!(
        get_layout(&conn, &ws).unwrap().unwrap().layout,
        restored.layout
    );
}
