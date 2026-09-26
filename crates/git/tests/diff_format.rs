//! Human-facing Git diff formatting must not change parsed content or line positions.
#![allow(clippy::expect_used)]

mod common;

use common::Fixture;
use kalcode_git::diff::{self, DiffOptions, DiffTarget, LineKind};
use kalcode_git::handles::HandleRegistry;
use kalcode_git::repo::Repo;

fn blank_context_scenario(target: DiffTarget) {
    let fx = Fixture::repo();
    fx.write("blank-context.txt", "first\n\nold\n\nlast\n");
    fx.commit_all("base");
    fx.write("blank-context.txt", "first\n\nnew\n\nlast\n");
    let plain_args = match &target {
        DiffTarget::WorkingTree => vec!["diff", "--no-color"],
        DiffTarget::Staged => {
            fx.git_plain(&["add", "blank-context.txt"]);
            vec!["diff", "--no-color", "--cached"]
        }
        DiffTarget::Commits { .. } => {
            fx.commit_all("changed");
            vec!["diff", "--no-color", "HEAD~1", "HEAD"]
        }
        _ => unreachable!("only exercised diff targets"),
    };
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repository");
    let handles = HandleRegistry::default();
    let options = DiffOptions::default();
    fx.git_plain(&["config", "diff.suppressBlankEmpty", "false"]);
    let baseline = diff::diff(&fx.git, &repo, &target, &[], &options, &handles).expect("baseline");

    fx.git_plain(&["config", "diff.suppressBlankEmpty", "true"]);
    let plain = fx.git_plain(&plain_args);
    assert!(
        plain.lines().any(str::is_empty),
        "control: plain Git suppresses the blank context prefix"
    );
    let config_before = fx.read(".git/config");
    let index_before = fx.read(".git/index");
    let parsed = diff::diff(&fx.git, &repo, &target, &[], &options, &handles).expect("configured");
    assert_eq!(fx.read(".git/config"), config_before);
    assert_eq!(fx.read(".git/index"), index_before);
    assert_eq!(parsed.files.len(), 1);
    assert_eq!(parsed.files[0].meta.path, "blank-context.txt");
    assert_eq!(parsed.files[0].hunks, baseline.files[0].hunks);
    assert_eq!(
        parsed.files[0].hunks[0]
            .lines
            .iter()
            .map(|line| (line.kind, line.old_line, line.new_line, line.text.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (LineKind::Context, Some(1), Some(1), "first"),
            (LineKind::Context, Some(2), Some(2), ""),
            (LineKind::Delete, Some(3), None, "old"),
            (LineKind::Add, None, Some(3), "new"),
            (LineKind::Context, Some(4), Some(4), ""),
            (LineKind::Context, Some(5), Some(5), "last"),
        ]
    );
}

#[test]
fn working_tree_preserves_blank_context_under_suppression_config() {
    blank_context_scenario(DiffTarget::WorkingTree);
}

#[test]
fn staged_diff_preserves_blank_context_under_suppression_config() {
    blank_context_scenario(DiffTarget::Staged);
}

#[test]
fn commit_diff_preserves_blank_context_under_suppression_config() {
    blank_context_scenario(DiffTarget::Commits {
        from: "HEAD~1".into(),
        to: "HEAD".into(),
    });
}
