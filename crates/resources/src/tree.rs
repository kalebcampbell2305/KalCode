//! The KalCode-owned process tree, derived from a flat process list (pure).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::model::{
    MAX_TREE_PROCESSES, ProcessRole, ProcessTreeReading, SessionUsage, TrackedProcess,
};

/// A process KalCode started and registered (provider CLI, terminal shell).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedRoot {
    pub pid: u32,
    pub role: ProcessRole,
}

/// One row of the machine-wide process list, as a probe sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcEntry {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    /// Start time in seconds since the Unix epoch (0 = unknown). Used to reject stale parent
    /// links after pid reuse: a child cannot start before its parent.
    pub start_time: u64,
    /// Percent of the whole machine; `None` when not yet measurable.
    pub cpu_percent: Option<f32>,
    pub rss_bytes: u64,
}

/// Result of [`build_tree`].
#[derive(Debug, Clone, PartialEq)]
pub struct TreeResult {
    pub tree: ProcessTreeReading,
    /// Registered roots that no longer exist; the governor stops tracking them (their pids may
    /// be reused by unrelated processes).
    pub vanished_roots: Vec<u32>,
}

/// Collects KalCode's process tree: `self_pid` and its descendants, plus every registered root
/// and its descendants. A process takes the role of its nearest registered ancestor; descendants
/// of KalCode that no root claims are [`ProcessRole::Descendant`].
pub fn build_tree(entries: &[ProcEntry], self_pid: u32, roots: &[TrackedRoot]) -> TreeResult {
    let by_pid: HashMap<u32, &ProcEntry> = entries.iter().map(|e| (e.pid, e)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for entry in entries {
        let Some(parent_pid) = entry.parent else {
            continue;
        };
        if parent_pid == entry.pid {
            continue;
        }
        let Some(parent) = by_pid.get(&parent_pid) else {
            continue;
        };
        let plausible = parent.start_time == 0
            || entry.start_time == 0
            || entry.start_time >= parent.start_time;
        if plausible {
            children.entry(parent_pid).or_default().push(entry.pid);
        }
    }
    for list in children.values_mut() {
        list.sort_unstable();
    }

    let registered: BTreeMap<u32, &ProcessRole> =
        roots.iter().map(|root| (root.pid, &root.role)).collect();
    let mut assigned: BTreeMap<u32, (ProcessRole, u32)> = BTreeMap::new();
    let mut visited: BTreeSet<u32> = BTreeSet::new();

    // Walk from KalCode itself first, then from registered roots it does not reach.
    let mut starts: Vec<(u32, ProcessRole)> = vec![(self_pid, ProcessRole::KalCodeSelf)];
    starts.extend(roots.iter().map(|root| (root.pid, root.role.clone())));
    for (start, start_role) in starts {
        if visited.contains(&start) || !by_pid.contains_key(&start) {
            continue;
        }
        let mut stack = vec![(start, start_role, start)];
        while let Some((pid, inherited, inherited_root)) = stack.pop() {
            if !visited.insert(pid) {
                continue;
            }
            let (role, root_pid) = match registered.get(&pid) {
                Some(role) if pid != self_pid => ((*role).clone(), pid),
                _ if pid == self_pid => (ProcessRole::KalCodeSelf, pid),
                _ => {
                    let role = if inherited == ProcessRole::KalCodeSelf {
                        ProcessRole::Descendant
                    } else {
                        inherited
                    };
                    (role, inherited_root)
                }
            };
            if let Some(kids) = children.get(&pid) {
                for kid in kids.iter().rev() {
                    stack.push((*kid, role.clone(), root_pid));
                }
            }
            assigned.insert(pid, (role, root_pid));
        }
    }

    let mut processes = Vec::with_capacity(assigned.len().min(MAX_TREE_PROCESSES));
    let mut total_cpu = 0.0f32;
    let mut total_rss = 0u64;
    let mut sessions: BTreeMap<u32, SessionUsage> = BTreeMap::new();
    for (pid, (role, root_pid)) in &assigned {
        let Some(entry) = by_pid.get(pid) else {
            continue;
        };
        let cpu = entry.cpu_percent.unwrap_or(0.0);
        total_cpu += cpu;
        total_rss = total_rss.saturating_add(entry.rss_bytes);
        if registered.contains_key(root_pid) && *root_pid != self_pid {
            let session = sessions.entry(*root_pid).or_insert_with(|| SessionUsage {
                root_pid: *root_pid,
                role: registered
                    .get(root_pid)
                    .map(|r| (*r).clone())
                    .unwrap_or(role.clone()),
                processes: 0,
                cpu_percent: 0.0,
                rss_bytes: 0,
            });
            session.processes += 1;
            session.cpu_percent += cpu;
            session.rss_bytes = session.rss_bytes.saturating_add(entry.rss_bytes);
        }
        if processes.len() < MAX_TREE_PROCESSES {
            processes.push(TrackedProcess {
                pid: *pid,
                parent_pid: entry.parent,
                name: entry.name.clone(),
                role: role.clone(),
                cpu_percent: entry.cpu_percent,
                rss_bytes: entry.rss_bytes,
                root_pid: *root_pid,
            });
        }
    }
    let truncated = assigned.len() > processes.len();
    let provider_sessions = sessions
        .into_values()
        .filter(|s| s.role.provider().is_some())
        .collect();
    let vanished_roots = roots
        .iter()
        .map(|r| r.pid)
        .filter(|pid| !by_pid.contains_key(pid))
        .collect();

    TreeResult {
        tree: ProcessTreeReading {
            processes,
            truncated,
            total_cpu_percent: total_cpu,
            total_rss_bytes: total_rss,
            provider_sessions,
        },
        vanished_roots,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::agent::ProviderId;

    fn entry(pid: u32, parent: Option<u32>, start: u64, rss: u64) -> ProcEntry {
        ProcEntry {
            pid,
            parent,
            name: format!("p{pid}"),
            start_time: start,
            cpu_percent: Some(1.0),
            rss_bytes: rss,
        }
    }

    fn provider(pid: u32, id: &str) -> TrackedRoot {
        TrackedRoot {
            pid,
            role: ProcessRole::Provider {
                provider: ProviderId::new(id),
                thread_id: None,
            },
        }
    }

    #[test]
    fn labels_self_descendants_and_registered_subtrees() {
        let entries = vec![
            entry(1, None, 1, 10),          // unrelated system process
            entry(100, Some(1), 10, 100),   // KalCode
            entry(101, Some(100), 11, 50),  // WebView (unregistered child)
            entry(200, Some(100), 12, 300), // provider root
            entry(201, Some(200), 13, 40),  // tool started by the provider
            entry(300, Some(100), 12, 20),  // terminal shell
            entry(301, Some(300), 14, 5),   // command in the terminal
            entry(400, Some(1), 12, 999),   // unrelated
        ];
        let roots = vec![
            provider(200, "claude-code"),
            TrackedRoot {
                pid: 300,
                role: ProcessRole::Terminal {
                    terminal_id: "t1".into(),
                },
            },
        ];
        let result = build_tree(&entries, 100, &roots);
        let pids: Vec<u32> = result.tree.processes.iter().map(|p| p.pid).collect();
        assert_eq!(pids, vec![100, 101, 200, 201, 300, 301]);
        let role = |pid| {
            result
                .tree
                .processes
                .iter()
                .find(|p| p.pid == pid)
                .unwrap()
                .role
                .clone()
        };
        assert_eq!(role(100), ProcessRole::KalCodeSelf);
        assert_eq!(role(101), ProcessRole::Descendant);
        assert_eq!(role(201), roots[0].role);
        assert_eq!(role(301), roots[1].role);
        assert_eq!(result.tree.total_rss_bytes, 100 + 50 + 300 + 40 + 20 + 5);
        assert_eq!(result.tree.provider_sessions.len(), 1);
        let session = &result.tree.provider_sessions[0];
        assert_eq!(
            (session.root_pid, session.processes, session.rss_bytes),
            (200, 2, 340)
        );
        assert!(result.vanished_roots.is_empty());
        assert!(!result.tree.truncated);
    }

    #[test]
    fn registered_roots_outside_kalcode_are_included_and_vanished_roots_reported() {
        let entries = vec![
            entry(100, None, 10, 1),
            entry(500, Some(1), 20, 7),
            entry(501, Some(500), 21, 3),
        ];
        let roots = vec![provider(500, "codex"), provider(900, "codex")];
        let result = build_tree(&entries, 100, &roots);
        let pids: Vec<u32> = result.tree.processes.iter().map(|p| p.pid).collect();
        assert_eq!(pids, vec![100, 500, 501]);
        assert_eq!(result.vanished_roots, vec![900]);
    }

    #[test]
    fn stale_parent_links_after_pid_reuse_are_ignored() {
        // Process 150 claims KalCode (started at 10) as parent but started before it: the parent
        // pid was reused.
        let entries = vec![entry(100, None, 10, 1), entry(150, Some(100), 5, 1)];
        let result = build_tree(&entries, 100, &[]);
        assert_eq!(result.tree.processes.len(), 1);
    }

    #[test]
    fn cycles_and_self_parents_terminate() {
        let entries = vec![
            entry(100, Some(101), 0, 1),
            entry(101, Some(100), 0, 1),
            entry(102, Some(102), 0, 1),
        ];
        let result = build_tree(&entries, 100, &[]);
        assert_eq!(result.tree.processes.len(), 2);
    }

    #[test]
    fn missing_self_yields_an_empty_tree() {
        let result = build_tree(&[entry(1, None, 0, 1)], 100, &[]);
        assert!(result.tree.processes.is_empty());
        assert_eq!(result.tree.total_rss_bytes, 0);
    }

    #[test]
    fn large_trees_are_truncated_but_totals_cover_everything() {
        let mut entries = vec![entry(1, None, 1, 1)];
        for pid in 2..(MAX_TREE_PROCESSES as u32 + 50) {
            entries.push(entry(pid, Some(1), 2, 1));
        }
        let result = build_tree(&entries, 1, &[]);
        assert!(result.tree.truncated);
        assert_eq!(result.tree.processes.len(), MAX_TREE_PROCESSES);
        assert_eq!(result.tree.total_rss_bytes, entries.len() as u64);
    }
}
