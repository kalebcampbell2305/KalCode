//! Snapshot differ: previous + next [`RemoteState`] → [`Patch`].

use std::collections::{HashMap, HashSet};

use crate::wire::{Keyed, Patch, RemoteState};

/// The patch that turns `prev` into `next`, or `None` when they are identical.
///
/// Items are matched by id; an item is upserted when it is new or differs in any field, and
/// removed when its id is gone. `workstation` is included only when it changed. The returned
/// patch has `rev = 0`; the connection driver stamps the real revision.
pub fn diff(prev: &RemoteState, next: &RemoteState) -> Option<Patch> {
    let mut patch = Patch::default();
    let mut changed = false;
    changed |= collection(
        &prev.agents,
        &next.agents,
        &mut patch.upsert.agents,
        &mut patch.remove.agents,
    );
    changed |= collection(
        &prev.needs_you,
        &next.needs_you,
        &mut patch.upsert.needs_you,
        &mut patch.remove.needs_you,
    );
    changed |= collection(
        &prev.runs,
        &next.runs,
        &mut patch.upsert.runs,
        &mut patch.remove.runs,
    );
    changed |= collection(
        &prev.services,
        &next.services,
        &mut patch.upsert.services,
        &mut patch.remove.services,
    );
    changed |= collection(
        &prev.environments,
        &next.environments,
        &mut patch.upsert.environments,
        &mut patch.remove.environments,
    );
    changed |= collection(
        &prev.workspaces,
        &next.workspaces,
        &mut patch.upsert.workspaces,
        &mut patch.remove.workspaces,
    );
    if prev.workstation != next.workstation {
        patch.workstation = Some(next.workstation.clone());
        changed = true;
    }
    changed.then_some(patch)
}

fn collection<T: Keyed + PartialEq + Clone>(
    prev: &[T],
    next: &[T],
    upsert: &mut Vec<T>,
    remove: &mut Vec<String>,
) -> bool {
    let before: HashMap<&str, &T> = prev.iter().map(|item| (item.key(), item)).collect();
    let after: HashSet<&str> = next.iter().map(Keyed::key).collect();
    upsert.extend(
        next.iter()
            .filter(|item| before.get(item.key()) != Some(item))
            .cloned(),
    );
    let mut seen = HashSet::new();
    remove.extend(
        prev.iter()
            .map(Keyed::key)
            .filter(|id| !after.contains(id) && seen.insert(*id))
            .map(str::to_owned),
    );
    !upsert.is_empty() || !remove.is_empty()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use super::*;
    use crate::wire::{RemoteService, Workstation};

    fn service(id: &str, status: &str) -> RemoteService {
        RemoteService {
            id: id.into(),
            name: id.into(),
            status: status.into(),
            url: None,
        }
    }

    fn state(services: Vec<RemoteService>) -> RemoteState {
        RemoteState {
            workstation: Workstation {
                id: "ws_1".into(),
                name: "WS".into(),
                platform: "windows".into(),
                version: "0.1.9".into(),
                build: 1,
                active_workspace_id: None,
            },
            workspaces: vec![],
            agents: vec![],
            needs_you: vec![],
            runs: vec![],
            services,
            environments: vec![],
        }
    }

    #[test]
    fn identical_states_produce_nothing() {
        let a = state(vec![service("web", "running")]);
        assert_eq!(diff(&a, &a.clone()), None);
    }

    #[test]
    fn upserts_changed_and_new_removes_missing() {
        let prev = state(vec![
            service("web", "running"),
            service("api", "running"),
            service("db", "running"),
        ]);
        let next = state(vec![
            service("web", "running"),
            service("api", "stopped"),
            service("queue", "starting"),
        ]);
        let patch = diff(&prev, &next).unwrap();
        assert_eq!(
            patch.upsert.services,
            vec![service("api", "stopped"), service("queue", "starting")]
        );
        assert_eq!(patch.remove.services, vec!["db".to_owned()]);
        assert!(patch.workstation.is_none());
        assert!(patch.upsert.agents.is_empty() && patch.remove.agents.is_empty());
    }

    #[test]
    fn workstation_change_is_included() {
        let prev = state(vec![]);
        let mut next = prev.clone();
        next.workstation.active_workspace_id = Some("wsp_1".into());
        let patch = diff(&prev, &next).unwrap();
        assert_eq!(patch.workstation, Some(next.workstation.clone()));
    }

    #[test]
    fn applying_the_patch_reproduces_next() {
        let prev = state(vec![
            service("a", "1"),
            service("b", "1"),
            service("c", "1"),
        ]);
        let next = state(vec![
            service("c", "2"),
            service("d", "1"),
            service("a", "1"),
        ]);
        let patch = diff(&prev, &next).unwrap();
        let mut applied: Vec<RemoteService> = prev.services.clone();
        applied.retain(|s| !patch.remove.services.contains(&s.id));
        for item in patch.upsert.services {
            match applied.iter_mut().find(|s| s.id == item.id) {
                Some(slot) => *slot = item,
                None => applied.push(item),
            }
        }
        let key = |v: &mut Vec<RemoteService>| v.sort_by(|x, y| x.id.cmp(&y.id));
        let mut expected = next.services.clone();
        key(&mut applied);
        key(&mut expected);
        assert_eq!(applied, expected);
    }
}
