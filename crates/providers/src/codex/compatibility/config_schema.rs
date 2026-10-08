use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;

use serde_json::Value;

const CONFIG_SCHEMA_FILE: &str = "ConfigReadResponse.json";
const MAX_CONFIG_SCHEMA_BYTES: u64 = 128 * 1024;
const MAX_SCHEMA_DEPTH: usize = 16;
const MAX_SCHEMA_NODES: usize = 1_024;
const DRAFT_07_SCHEMA: &str = "http://json-schema.org/draft-07/schema#";

/// Normalized proof of the CLI's `model_reasoning_effort` config contract. The sampled values are
/// diagnostic; [`Self::supports`] remains authoritative for an open string schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReasoningEffortSchema {
    constraint: Constraint,
    sampled_values: BTreeSet<String>,
}

impl ReasoningEffortSchema {
    pub(super) fn read(output_dir: &Path, baseline: &[&str]) -> Option<Self> {
        let v2_dir = output_dir.join("v2");
        if !ordinary_directory(output_dir) || !ordinary_directory(&v2_dir) {
            return None;
        }
        let output_canonical = std::fs::canonicalize(output_dir).ok()?;
        let v2_canonical = std::fs::canonicalize(&v2_dir).ok()?;
        if v2_canonical.parent() != Some(output_canonical.as_path()) {
            return None;
        }
        let bytes =
            read_bounded_ordinary_file(&v2_dir.join(CONFIG_SCHEMA_FILE), &v2_dir, &v2_canonical)?;
        let document = serde_json::from_slice::<Value>(&bytes).ok()?;
        if document
            .get("$schema")
            .is_some_and(|dialect| dialect.as_str() != Some(DRAFT_07_SCHEMA))
        {
            return None;
        }
        let property = document.pointer("/definitions/Config/properties/model_reasoning_effort")?;
        let constraint = normalize(&document, property, 0, &mut NormalizeBudget::new())?;
        let candidates = match constraint.domain() {
            StringDomain::Finite(values) => values,
            StringDomain::Open => baseline.iter().map(|value| (*value).to_owned()).collect(),
            StringDomain::Empty => return None,
        };
        let sampled_values = candidates
            .into_iter()
            .filter(|candidate| {
                crate::codex::argv::valid_effort_name(candidate) && constraint.matches(candidate)
            })
            .collect::<BTreeSet<_>>();
        if sampled_values.is_empty() {
            return None;
        }
        Some(Self {
            constraint,
            sampled_values,
        })
    }

    pub(super) fn supports(&self, effort: &str) -> bool {
        crate::codex::argv::valid_effort_name(effort) && self.constraint.matches(effort)
    }

    pub(super) fn sampled_values(&self) -> &BTreeSet<String> {
        &self.sampled_values
    }

    #[cfg(test)]
    pub(super) fn open_for_test(baseline: &[&str]) -> Self {
        let constraint = Constraint::All(vec![
            Constraint::String,
            Constraint::Length {
                minimum: Some(1),
                maximum: None,
            },
        ]);
        let sampled_values = baseline
            .iter()
            .copied()
            .filter(|value| constraint.matches(value))
            .map(str::to_owned)
            .collect();
        Self {
            constraint,
            sampled_values,
        }
    }

    #[cfg(test)]
    pub(super) fn closed_for_test(values: &[&str]) -> Self {
        let sampled_values = values
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<BTreeSet<_>>();
        Self {
            constraint: Constraint::Values(sampled_values.clone()),
            sampled_values,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Constraint {
    String,
    Null,
    Values(BTreeSet<String>),
    Length {
        minimum: Option<u64>,
        maximum: Option<u64>,
    },
    Any(Vec<Self>),
    One(Vec<Self>),
    All(Vec<Self>),
    Never,
}

impl Constraint {
    fn matches(&self, candidate: &str) -> bool {
        match self {
            Self::String => true,
            Self::Null | Self::Never => false,
            Self::Values(values) => values.contains(candidate),
            Self::Length { minimum, maximum } => {
                let len = candidate.chars().count() as u64;
                minimum.is_none_or(|minimum| len >= minimum)
                    && maximum.is_none_or(|maximum| len <= maximum)
            }
            Self::Any(branches) => branches.iter().any(|branch| branch.matches(candidate)),
            Self::One(branches) => {
                branches
                    .iter()
                    .filter(|branch| branch.matches(candidate))
                    .count()
                    == 1
            }
            Self::All(branches) => branches.iter().all(|branch| branch.matches(candidate)),
        }
    }

    fn domain(&self) -> StringDomain {
        match self {
            Self::String | Self::Length { .. } => StringDomain::Open,
            Self::Null | Self::Never => StringDomain::Empty,
            Self::Values(values) => StringDomain::Finite(values.clone()),
            Self::Any(branches) | Self::One(branches) => {
                let mut values = BTreeSet::new();
                for branch in branches {
                    match branch.domain() {
                        StringDomain::Open => return StringDomain::Open,
                        StringDomain::Finite(branch_values) => values.extend(branch_values),
                        StringDomain::Empty => {}
                    }
                }
                if values.is_empty() {
                    StringDomain::Empty
                } else {
                    StringDomain::Finite(values)
                }
            }
            Self::All(branches) => {
                let mut finite = None;
                for branch in branches {
                    match branch.domain() {
                        StringDomain::Empty => return StringDomain::Empty,
                        StringDomain::Finite(values) if finite.is_none() => finite = Some(values),
                        StringDomain::Finite(_) | StringDomain::Open => {}
                    }
                }
                finite.map_or(StringDomain::Open, StringDomain::Finite)
            }
        }
    }
}

enum StringDomain {
    Finite(BTreeSet<String>),
    Open,
    Empty,
}

struct NormalizeBudget {
    remaining: usize,
    active_references: BTreeSet<String>,
}

impl NormalizeBudget {
    fn new() -> Self {
        Self {
            remaining: MAX_SCHEMA_NODES,
            active_references: BTreeSet::new(),
        }
    }

    fn take_node(&mut self) -> Option<()> {
        self.remaining = self.remaining.checked_sub(1)?;
        Some(())
    }
}

/// Normalizes the vocabulary Codex uses. Every keyword participates, so `$ref` and combinator
/// siblings remain an AND; an unknown validation keyword fails closed.
fn normalize(
    root: &Value,
    schema: &Value,
    depth: usize,
    budget: &mut NormalizeBudget,
) -> Option<Constraint> {
    if depth >= MAX_SCHEMA_DEPTH {
        return None;
    }
    budget.take_node()?;
    let object = schema.as_object()?;
    let mut constraints = Vec::new();
    for (keyword, value) in object {
        let constraint = match keyword.as_str() {
            "$ref" => {
                let reference = value.as_str()?;
                if !budget.active_references.insert(reference.to_owned()) {
                    return None;
                }
                let normalized = resolve_local_reference(root, reference)
                    .and_then(|target| normalize(root, target, depth + 1, budget));
                budget.active_references.remove(reference);
                Some(normalized?)
            }
            "type" => Some(normalize_type(value)?),
            "enum" => Some(normalize_enum(value)?),
            "const" => Some(value.as_str().map_or(Constraint::Never, |value| {
                Constraint::Values([value.to_owned()].into_iter().collect())
            })),
            "minLength" => Some(Constraint::Length {
                minimum: Some(value.as_u64()?),
                maximum: None,
            }),
            "maxLength" => Some(Constraint::Length {
                minimum: None,
                maximum: Some(value.as_u64()?),
            }),
            "anyOf" => Some(Constraint::Any(normalize_branches(
                root, value, depth, budget,
            )?)),
            "oneOf" => Some(Constraint::One(normalize_branches(
                root, value, depth, budget,
            )?)),
            "allOf" => Some(Constraint::All(normalize_branches(
                root, value, depth, budget,
            )?)),
            "$comment" | "title" | "description" | "default" | "examples" | "deprecated"
            | "readOnly" | "writeOnly" => None,
            _ => return None,
        };
        if let Some(constraint) = constraint {
            constraints.push(constraint);
        }
    }
    match constraints.len() {
        0 => None,
        1 => constraints.pop(),
        _ => Some(Constraint::All(constraints)),
    }
}

fn normalize_type(value: &Value) -> Option<Constraint> {
    let kinds = match value {
        Value::String(kind) => vec![kind.as_str()],
        Value::Array(kinds) if !kinds.is_empty() => kinds
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()?,
        _ => return None,
    };
    let mut constraints = Vec::new();
    for kind in kinds {
        match kind {
            "string" => constraints.push(Constraint::String),
            "null" => constraints.push(Constraint::Null),
            "array" | "boolean" | "integer" | "number" | "object" => {}
            _ => return None,
        }
    }
    match constraints.len() {
        0 => Some(Constraint::Never),
        1 => constraints.pop(),
        _ => Some(Constraint::Any(constraints)),
    }
}

fn normalize_enum(value: &Value) -> Option<Constraint> {
    let values = value.as_array().filter(|values| !values.is_empty())?;
    let strings = values
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    if strings.is_empty() {
        Some(Constraint::Never)
    } else {
        Some(Constraint::Values(strings))
    }
}

fn normalize_branches(
    root: &Value,
    value: &Value,
    depth: usize,
    budget: &mut NormalizeBudget,
) -> Option<Vec<Constraint>> {
    let branches = value.as_array().filter(|branches| !branches.is_empty())?;
    let mut normalized = Vec::with_capacity(branches.len());
    for branch in branches {
        normalized.push(normalize(root, branch, depth + 1, budget)?);
    }
    Some(normalized)
}

fn resolve_local_reference<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    let pointer = reference.strip_prefix('#')?;
    if pointer.is_empty() || !pointer.starts_with('/') {
        return None;
    }
    root.pointer(pointer)
}

fn ordinary_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !is_link_or_reparse(&metadata))
}

fn read_bounded_ordinary_file(
    path: &Path,
    expected_parent: &Path,
    expected_parent_canonical: &Path,
) -> Option<Vec<u8>> {
    let before = std::fs::symlink_metadata(path).ok()?;
    if !before.is_file() || is_link_or_reparse(&before) || before.len() > MAX_CONFIG_SCHEMA_BYTES {
        return None;
    }
    let file = open_without_following(path).ok()?;
    let opened = file.metadata().ok()?;
    if !opened.is_file() || is_link_or_reparse(&opened) || opened.len() > MAX_CONFIG_SCHEMA_BYTES {
        return None;
    }
    let opened_length = opened.len();
    let opened = same_file::Handle::from_file(file).ok()?;
    if !ordinary_directory(expected_parent)
        || std::fs::canonicalize(expected_parent).ok()?.as_path() != expected_parent_canonical
        || same_file::Handle::from_path(path).ok()? != opened
    {
        return None;
    }
    let mut bytes = Vec::with_capacity(usize::try_from(opened_length).ok()?);
    opened
        .as_file()
        .take(MAX_CONFIG_SCHEMA_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 == opened_length && bytes.len() as u64 <= MAX_CONFIG_SCHEMA_BYTES)
        .then_some(bytes)
}

#[cfg(unix)]
fn open_without_following(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt as _;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(windows)]
fn open_without_following(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt as _;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_without_following(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASELINE: &[&str] = &["minimal", "low", "medium", "high", "xhigh"];

    fn document(property: Value, effort: Value) -> Value {
        serde_json::json!({
            "$schema": DRAFT_07_SCHEMA,
            "definitions": {
                "Config": {"properties": {"model_reasoning_effort": property}},
                "ReasoningEffort": effort
            }
        })
    }

    fn write_schema(output: &Path, schema: &Value) {
        let v2 = output.join("v2");
        std::fs::create_dir(&v2).expect("v2 directory");
        std::fs::write(
            v2.join(CONFIG_SCHEMA_FILE),
            serde_json::to_vec(schema).expect("serialize schema"),
        )
        .expect("write schema");
    }

    #[test]
    fn native_open_schema_accepts_safe_future_values() {
        let output = tempfile::tempdir().expect("schema output");
        write_schema(
            output.path(),
            &document(
                serde_json::json!({
                    "anyOf": [
                        {"$ref": "#/definitions/ReasoningEffort"},
                        {"type": "null"}
                    ]
                }),
                serde_json::json!({"type": "string", "minLength": 1}),
            ),
        );
        let schema = ReasoningEffortSchema::read(output.path(), BASELINE).expect("schema");
        assert_eq!(
            schema.sampled_values(),
            &BASELINE.iter().map(|value| (*value).to_owned()).collect()
        );
        assert!(schema.supports("ultra"));
        assert!(!schema.supports("bad'value"));
    }

    #[test]
    fn closed_enum_preserves_all_safe_advertised_values() {
        let output = tempfile::tempdir().expect("schema output");
        write_schema(
            output.path(),
            &document(
                serde_json::json!({"$ref": "#/definitions/ReasoningEffort"}),
                serde_json::json!({
                    "type": "string",
                    "enum": ["minimal", "low", "medium", "high", "xhigh", "ultra", "bad'value"]
                }),
            ),
        );
        let schema = ReasoningEffortSchema::read(output.path(), BASELINE).expect("schema");
        assert!(schema.sampled_values().contains("ultra"));
        assert!(!schema.sampled_values().contains("bad'value"));
        assert!(schema.supports("ultra"));
    }

    #[test]
    fn ref_and_combinator_sibling_constraints_are_not_ignored() {
        let output = tempfile::tempdir().expect("schema output");
        write_schema(
            output.path(),
            &document(
                serde_json::json!({
                    "$ref": "#/definitions/ReasoningEffort",
                    "enum": ["low"]
                }),
                serde_json::json!({"type": "string", "minLength": 1}),
            ),
        );
        let schema = ReasoningEffortSchema::read(output.path(), BASELINE).expect("schema");
        assert!(schema.supports("low"));
        assert!(!schema.supports("high"));

        let output = tempfile::tempdir().expect("schema output");
        write_schema(
            output.path(),
            &document(
                serde_json::json!({"anyOf": [{"type": "string"}], "maxLength": 3}),
                serde_json::json!({"type": "string"}),
            ),
        );
        let schema = ReasoningEffortSchema::read(output.path(), BASELINE).expect("schema");
        assert!(schema.supports("low"));
        assert!(!schema.supports("high"));
    }

    #[test]
    fn missing_malformed_or_unknown_validation_constraints_fail_closed() {
        let output = tempfile::tempdir().expect("schema output");
        assert!(ReasoningEffortSchema::read(output.path(), BASELINE).is_none());

        let v2 = output.path().join("v2");
        std::fs::create_dir(&v2).expect("v2 directory");
        let path = v2.join(CONFIG_SCHEMA_FILE);
        std::fs::write(&path, b"not-json").expect("write malformed schema");
        assert!(ReasoningEffortSchema::read(output.path(), BASELINE).is_none());

        for effort in [
            serde_json::json!({"type": "string", "pattern": "^high$"}),
            serde_json::json!({"type": "string", "if": {"minLength": 2}}),
            serde_json::json!({
                "$id": "https://example.invalid/nested",
                "$ref": "#/definitions/ReasoningEffort"
            }),
            serde_json::json!({"$schema": DRAFT_07_SCHEMA, "type": "string"}),
            serde_json::json!({"$ref": "#/definitions/Missing"}),
            serde_json::json!({"type": "string", "enum": "high"}),
            serde_json::json!({"type": "string", "minLength": -1}),
        ] {
            std::fs::write(
                &path,
                serde_json::to_vec(&document(
                    serde_json::json!({"$ref": "#/definitions/ReasoningEffort"}),
                    effort,
                ))
                .expect("serialize schema"),
            )
            .expect("write schema");
            assert!(ReasoningEffortSchema::read(output.path(), BASELINE).is_none());
        }

        let mut unsupported_dialect = document(
            serde_json::json!({"$ref": "#/definitions/ReasoningEffort"}),
            serde_json::json!({"type": "string", "minLength": 1}),
        );
        unsupported_dialect["$schema"] =
            Value::String("https://json-schema.org/draft/2020-12/schema".into());
        std::fs::write(
            &path,
            serde_json::to_vec(&unsupported_dialect).expect("serialize unsupported dialect"),
        )
        .expect("write unsupported dialect");
        assert!(ReasoningEffortSchema::read(output.path(), BASELINE).is_none());
    }

    #[test]
    fn recursive_and_high_fanout_references_stay_within_the_parser_budget() {
        let output = tempfile::tempdir().expect("schema output");
        let recursive = serde_json::json!({
            "definitions": {
                "Config": {
                    "properties": {
                        "model_reasoning_effort": {"$ref": "#/definitions/ReasoningEffort"}
                    }
                },
                "ReasoningEffort": {
                    "anyOf": [
                        {"$ref": "#/definitions/ReasoningEffort"},
                        {"$ref": "#/definitions/ReasoningEffort"},
                        {"$ref": "#/definitions/ReasoningEffort"},
                        {"$ref": "#/definitions/ReasoningEffort"},
                        {"$ref": "#/definitions/ReasoningEffort"},
                        {"$ref": "#/definitions/ReasoningEffort"},
                        {"$ref": "#/definitions/ReasoningEffort"},
                        {"$ref": "#/definitions/ReasoningEffort"}
                    ]
                }
            }
        });
        write_schema(output.path(), &recursive);
        assert!(ReasoningEffortSchema::read(output.path(), BASELINE).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn linked_v2_ancestor_is_rejected() {
        use std::os::unix::fs::symlink;
        let output = tempfile::tempdir().expect("schema output");
        let outside = tempfile::tempdir().expect("outside");
        write_schema(
            outside.path(),
            &document(
                serde_json::json!({"$ref": "#/definitions/ReasoningEffort"}),
                serde_json::json!({"type": "string", "minLength": 1}),
            ),
        );
        symlink(outside.path().join("v2"), output.path().join("v2")).expect("v2 symlink");
        assert!(ReasoningEffortSchema::read(output.path(), BASELINE).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn linked_final_schema_file_is_rejected() {
        use std::os::unix::fs::symlink;
        let output = tempfile::tempdir().expect("schema output");
        let outside = tempfile::tempdir().expect("outside");
        write_schema(
            outside.path(),
            &document(
                serde_json::json!({"$ref": "#/definitions/ReasoningEffort"}),
                serde_json::json!({"type": "string", "minLength": 1}),
            ),
        );
        let v2 = output.path().join("v2");
        std::fs::create_dir(&v2).expect("v2 directory");
        symlink(
            outside.path().join("v2").join(CONFIG_SCHEMA_FILE),
            v2.join(CONFIG_SCHEMA_FILE),
        )
        .expect("schema symlink");
        assert!(ReasoningEffortSchema::read(output.path(), BASELINE).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn linked_v2_ancestor_is_rejected_when_symlink_creation_is_permitted() {
        use std::os::windows::fs::symlink_dir;
        let output = tempfile::tempdir().expect("schema output");
        let outside = tempfile::tempdir().expect("outside");
        write_schema(
            outside.path(),
            &document(
                serde_json::json!({"$ref": "#/definitions/ReasoningEffort"}),
                serde_json::json!({"type": "string", "minLength": 1}),
            ),
        );
        match symlink_dir(outside.path().join("v2"), output.path().join("v2")) {
            Ok(()) => assert!(ReasoningEffortSchema::read(output.path(), BASELINE).is_none()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                eprintln!("skipping privileged directory-symlink assertion")
            }
            Err(error) => panic!("v2 symlink fixture: {error}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn junction_v2_ancestor_is_rejected_without_symlink_privilege() {
        use std::os::windows::process::CommandExt as _;

        let output = tempfile::tempdir().expect("schema output");
        let outside = tempfile::tempdir().expect("outside");
        write_schema(
            outside.path(),
            &document(
                serde_json::json!({"$ref": "#/definitions/ReasoningEffort"}),
                serde_json::json!({"type": "string", "minLength": 1}),
            ),
        );
        let link = output.path().join("v2");
        let mut command = std::process::Command::new("cmd");
        command.creation_flags(0x0800_0000);
        let created = command
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path().join("v2"))
            .output()
            .expect("mklink junction");
        assert!(created.status.success(), "junction fixture");
        assert!(ReasoningEffortSchema::read(output.path(), BASELINE).is_none());
        std::fs::remove_dir(link).expect("remove junction");
    }

    #[cfg(windows)]
    #[test]
    fn linked_final_schema_file_is_rejected_when_symlink_creation_is_permitted() {
        use std::os::windows::fs::symlink_file;
        let output = tempfile::tempdir().expect("schema output");
        let outside = tempfile::tempdir().expect("outside");
        write_schema(
            outside.path(),
            &document(
                serde_json::json!({"$ref": "#/definitions/ReasoningEffort"}),
                serde_json::json!({"type": "string", "minLength": 1}),
            ),
        );
        let v2 = output.path().join("v2");
        std::fs::create_dir(&v2).expect("v2 directory");
        match symlink_file(
            outside.path().join("v2").join(CONFIG_SCHEMA_FILE),
            v2.join(CONFIG_SCHEMA_FILE),
        ) {
            Ok(()) => assert!(ReasoningEffortSchema::read(output.path(), BASELINE).is_none()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                eprintln!("skipping privileged final-file symlink assertion")
            }
            Err(error) => panic!("schema symlink fixture: {error}"),
        }
    }
}
