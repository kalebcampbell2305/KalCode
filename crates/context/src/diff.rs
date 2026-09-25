//! Unified-diff handling: the changes to never-share files are withheld section by section
//! before the rest of the diff is scanned for secrets.

/// One file section of a unified diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffSection {
    /// Byte range of the section in the diff text.
    pub start: usize,
    pub end: usize,
    /// Paths named by the section (old and new; `a/` and `b/` prefixes removed).
    pub paths: Vec<String>,
}

/// Splits a diff into file sections. Git diffs split at `diff --git`; plain unified diffs split
/// at a `--- ` line followed by a `+++ ` line. Text before the first section (for example a
/// commit message) is not a section.
pub fn split_sections(diff: &str) -> Vec<DiffSection> {
    let lines = line_starts(diff);
    let git_style = lines
        .iter()
        .any(|(start, _)| diff[*start..].starts_with("diff --git "));
    let mut starts: Vec<usize> = Vec::new();
    for (index, (start, _)) in lines.iter().enumerate() {
        let line = &diff[*start..];
        if git_style {
            if line.starts_with("diff --git ") {
                starts.push(*start);
            }
        } else if line.starts_with("--- ")
            && lines
                .get(index + 1)
                .is_some_and(|(next, _)| diff[*next..].starts_with("+++ "))
        {
            starts.push(*start);
        }
    }
    let mut sections = Vec::with_capacity(starts.len());
    for (i, start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(diff.len());
        let text = &diff[*start..end];
        sections.push(DiffSection {
            start: *start,
            end,
            paths: section_paths(text),
        });
    }
    sections
}

/// `(start, end)` byte offsets of every line (end excludes the line break).
fn line_starts(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            out.push((start, i));
            start = i + 1;
        }
    }
    if start < text.len() {
        out.push((start, text.len()));
    }
    out
}

fn section_paths(section: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in section.lines().take(12) {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("diff --git ") {
            paths.extend(parse_git_header(rest));
        } else if let Some(rest) = line
            .strip_prefix("--- ")
            .or_else(|| line.strip_prefix("+++ "))
        {
            let path = rest.split('\t').next().unwrap_or(rest);
            if path != "/dev/null" {
                paths.push(strip_side(&unquote(path)));
            }
        } else if let Some(rest) = line
            .strip_prefix("rename from ")
            .or_else(|| line.strip_prefix("rename to "))
            .or_else(|| line.strip_prefix("copy from "))
            .or_else(|| line.strip_prefix("copy to "))
        {
            paths.push(unquote(rest));
        } else if line.starts_with("@@") {
            break;
        }
    }
    paths.retain(|p| !p.is_empty());
    paths.sort();
    paths.dedup();
    paths
}

/// `a/x b/y`, `"a/x y" "b/x y"`.
fn parse_git_header(rest: &str) -> Vec<String> {
    let rest = rest.trim();
    if rest.starts_with('"') {
        let parts: Vec<String> = rest
            .split('"')
            .filter(|p| !p.trim().is_empty())
            .map(strip_side)
            .collect();
        return parts;
    }
    // Unquoted: split at " b/" (paths may contain spaces).
    if let Some(index) = rest.find(" b/") {
        return vec![strip_side(&rest[..index]), strip_side(&rest[index + 1..])];
    }
    rest.split_whitespace().map(strip_side).collect()
}

fn strip_side(path: &str) -> String {
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path)
        .to_owned()
}

fn unquote(text: &str) -> String {
    text.trim().trim_matches('"').to_owned()
}

/// Replaces the listed sections with a one-line notice, keeping the section's first line (the
/// file header) so the reader sees which file was withheld.
pub fn withhold(diff: &str, sections: &[(&DiffSection, String)]) -> String {
    let mut out = String::with_capacity(diff.len());
    let mut cursor = 0;
    let mut ordered: Vec<&(&DiffSection, String)> = sections.iter().collect();
    ordered.sort_by_key(|(s, _)| s.start);
    for (section, notice) in ordered {
        if section.start < cursor {
            continue;
        }
        out.push_str(&diff[cursor..section.start]);
        let body = &diff[section.start..section.end];
        let first_line_end = body.find('\n').map_or(body.len(), |i| i + 1);
        out.push_str(&body[..first_line_end]);
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(notice);
        out.push('\n');
        cursor = section.end;
    }
    out.push_str(&diff[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_git_diffs_and_finds_paths() {
        let diff = "commit message\n\ndiff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/.env b/.env\nnew file mode 100644\n--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+K=V\n";
        let sections = split_sections(diff);
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].paths, vec!["src/a.rs".to_owned()]);
        assert_eq!(sections[1].paths, vec![".env".to_owned()]);
        let out = withhold(diff, &[(&sections[1], "[withheld]".to_owned())]);
        assert!(out.contains("diff --git a/.env b/.env\n[withheld]\n"));
        assert!(!out.contains("+K=V"));
        assert!(out.contains("+y"));
    }

    #[test]
    fn splits_plain_unified_diffs_and_renames() {
        let diff = "--- a/x.txt\n+++ b/x.txt\n@@\n-a\n+b\n--- a/secrets.json\n+++ b/secrets.json\n@@\n+s\n";
        let sections = split_sections(diff);
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[1].paths, vec!["secrets.json".to_owned()]);
        let renamed = "diff --git a/old.txt b/keys/id_rsa\nsimilarity index 100%\nrename from old.txt\nrename to keys/id_rsa\n";
        let sections = split_sections(renamed);
        assert!(sections[0].paths.contains(&"keys/id_rsa".to_owned()));
        assert!(sections[0].paths.contains(&"old.txt".to_owned()));
    }
}
