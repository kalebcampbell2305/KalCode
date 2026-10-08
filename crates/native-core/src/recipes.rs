//! Launch Recipes: durable, validated storage for saved working desks.
//!
//! A Recipe references canonical objects by id and never stores credentials. Launching is the
//! frontend's job (it recreates the desk through the same commands a person uses); this store
//! only guarantees that what is saved is bounded, secret-free and readable across versions.

use std::collections::HashSet;
use std::sync::Arc;

use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::recipes::{
    LAUNCH_RECIPE_SCHEMA_VERSION, LaunchRecipe, LaunchRecipesSnapshot, RecipeComponent,
    RecipeVariable,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::Core;
use crate::error::{KalError, Result};
use crate::plans::PlanLimit;
use crate::redact::secrets::{self, ScanContext};
use crate::time::now_rfc3339;

const MAX_COMPONENTS: usize = 32;
const MAX_VARIABLES: usize = 8;
const MAX_NAME_CHARS: usize = 120;
const MAX_TASK_BYTES: usize = 64 * 1024;
const MAX_COMMAND_BYTES: usize = 8 * 1024;
const MAX_GOAL_BYTES: usize = 16 * 1024;
const MAX_DEFAULT_BYTES: usize = 2 * 1024;
const MAX_URL_CHARS: usize = 2048;

/// The JSON stored in `definition_json`. Every field defaults so an older or newer shape still
/// decodes as far as it can.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    #[serde(default)]
    variables: Vec<RecipeVariable>,
    #[serde(default)]
    components: Vec<RecipeComponent>,
    #[serde(default)]
    layout: Option<String>,
}

pub struct LaunchRecipesStore {
    core: Arc<Core>,
}

impl LaunchRecipesStore {
    pub fn new(core: Arc<Core>) -> Self {
        Self { core }
    }

    pub fn snapshot(&self, limit: Option<u32>) -> Result<LaunchRecipesSnapshot> {
        let recipes = self.core.read(load_all)?;
        Ok(LaunchRecipesSnapshot { recipes, limit })
    }

    pub fn get(&self, id: &str) -> Result<LaunchRecipe> {
        validate_id(id, "invalid_launch_recipe_id")?;
        self.core.read(|conn| load_one(conn, id))
    }

    /// Exact id, else a unique case-insensitive name.
    pub fn resolve(&self, query: &str) -> Result<LaunchRecipe> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > MAX_NAME_CHARS || has_control(query) {
            return Err(KalError::validation(
                "invalid_launch_recipe_query",
                "Choose a saved Recipe by its name or identifier.",
            ));
        }
        self.core.read(|conn| {
            if is_valid_id(query)
                && let Ok(recipe) = load_one(conn, query)
            {
                return Ok(recipe);
            }
            let mut stmt = conn.prepare(
                "SELECT id FROM launch_recipes WHERE name = ?1 COLLATE NOCASE ORDER BY id",
            )?;
            let ids = stmt
                .query_map([query], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            match ids.as_slice() {
                [id] => load_one(conn, id),
                [] => Err(not_found()),
                _ => Err(KalError::validation(
                    "launch_recipe_name_ambiguous",
                    "More than one Recipe matches that name. Choose the Recipe by its exact identifier.",
                )),
            }
        })
    }

    pub fn save(&self, recipe: LaunchRecipe, limit: Option<PlanLimit>) -> Result<LaunchRecipe> {
        let recipe = normalize(recipe)?;
        let definition = serde_json::to_string(&Definition {
            variables: recipe.variables.clone(),
            components: recipe.components.clone(),
            layout: recipe.layout.clone(),
        })?;
        let updated_at = now_rfc3339();
        self.core
            .transact(|tx| {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM launch_recipes WHERE id = ?1)",
                    [&recipe.id],
                    |row| row.get(0),
                )?;
                if !exists && let Some(limit) = limit {
                    limit.admit(count_all_recipes(tx)?)?;
                }
                let conflicting: Option<String> = tx
                    .query_row(
                        "SELECT id FROM launch_recipes WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
                        params![recipe.name, recipe.id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if conflicting.is_some() {
                    return Err(KalError::validation(
                        "launch_recipe_name_conflict",
                        "A Recipe already uses that name. Choose a distinct name.",
                    ));
                }
                let next_position: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(position) + 1, 0) FROM launch_recipes",
                    [],
                    |row| row.get(0),
                )?;
                // The stored position wins on update: ordering belongs to `reorder`.
                tx.execute(
                    "INSERT INTO launch_recipes (
                       id, name, schema_version, workspace_id, pinned, position,
                       definition_json, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(id) DO UPDATE SET
                       name = excluded.name,
                       schema_version = excluded.schema_version,
                       workspace_id = excluded.workspace_id,
                       pinned = excluded.pinned,
                       definition_json = excluded.definition_json,
                       updated_at = excluded.updated_at",
                    params![
                        recipe.id,
                        recipe.name,
                        recipe.schema_version,
                        recipe.workspace_id,
                        recipe.pinned,
                        next_position,
                        definition,
                        updated_at
                    ],
                )?;
                Ok((load_one(tx, &recipe.id)?, Vec::new()))
            })
            .map(|result| result.0)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        validate_id(id, "invalid_launch_recipe_id")?;
        self.core
            .transact(|tx| {
                if tx.execute("DELETE FROM launch_recipes WHERE id = ?1", [id])? != 1 {
                    return Err(not_found());
                }
                Ok(((), Vec::new()))
            })
            .map(|result| result.0)
    }

    /// Persists a manual order. `ids` must be exactly the current set of Recipe ids.
    pub fn reorder(&self, ids: Vec<String>) -> Result<LaunchRecipesSnapshot> {
        self.core
            .transact(|tx| {
                let current: HashSet<String> = {
                    let mut stmt = tx.prepare("SELECT id FROM launch_recipes")?;
                    stmt.query_map([], |row| row.get::<_, String>(0))?
                        .collect::<std::result::Result<_, _>>()?
                };
                let requested: HashSet<&String> = ids.iter().collect();
                if requested.len() != ids.len()
                    || ids.len() != current.len()
                    || ids.iter().any(|id| !current.contains(id))
                {
                    return Err(KalError::validation(
                        "launch_recipes_changed",
                        "The Recipe list changed. Refresh and try again.",
                    ));
                }
                for (index, id) in ids.iter().enumerate() {
                    tx.execute(
                        "UPDATE launch_recipes SET position = ?1 WHERE id = ?2",
                        params![index as i64, id],
                    )?;
                }
                Ok((load_all(tx)?, Vec::new()))
            })
            .map(|result| LaunchRecipesSnapshot {
                recipes: result.0,
                limit: None,
            })
    }
}

/// Launch Recipes and Squad Recipes are both "Launch Recipes" in plan copy and share one cap.
pub(crate) fn count_all_recipes(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT (SELECT COUNT(*) FROM launch_recipes) + (SELECT COUNT(*) FROM squad_recipes)",
        [],
        |row| row.get(0),
    )?)
}

fn load_all(conn: &Connection) -> Result<Vec<LaunchRecipe>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT} ORDER BY pinned DESC, position, name COLLATE NOCASE, id"
    ))?;
    let rows = stmt
        .query_map([], read_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn load_one(conn: &Connection, id: &str) -> Result<LaunchRecipe> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], read_row)
        .optional()?
        .ok_or_else(not_found)
}

const SELECT: &str = "SELECT id, name, schema_version, workspace_id, pinned, position, \
                      definition_json, updated_at FROM launch_recipes";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LaunchRecipe> {
    let json: String = row.get(6)?;
    // A row written by a newer KalCode may not decode; keep it visible with no components so
    // the UI can say "Made by a newer KalCode" instead of failing the whole list.
    let definition = serde_json::from_str::<Definition>(&json).unwrap_or_default();
    Ok(LaunchRecipe {
        id: row.get(0)?,
        name: row.get(1)?,
        schema_version: row.get::<_, i64>(2)?.max(1) as u32,
        workspace_id: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        position: row.get::<_, i64>(5)?.max(0) as u32,
        variables: definition.variables,
        components: definition.components,
        layout: definition.layout,
        updated_at: row.get(7)?,
    })
}

fn normalize(mut recipe: LaunchRecipe) -> Result<LaunchRecipe> {
    if recipe.id.trim().is_empty() {
        recipe.id = new_id();
    }
    validate_id(&recipe.id, "invalid_launch_recipe_id")?;
    if recipe.schema_version != LAUNCH_RECIPE_SCHEMA_VERSION {
        return Err(KalError::validation(
            "launch_recipe_schema_unsupported",
            "Update KalCode to edit this Recipe.",
        ));
    }
    recipe.name = text(
        &recipe.name,
        MAX_NAME_CHARS,
        false,
        true,
        "invalid_launch_recipe_name",
        "Give the Recipe a name of up to 120 characters.",
    )?;
    secret(&recipe.name)?;
    if let Some(workspace) = &recipe.workspace_id {
        validate_id(workspace, "invalid_launch_recipe_workspace")?;
    }
    recipe.layout = match recipe.layout.take() {
        None => None,
        Some(layout) => match layout.trim() {
            "" => None,
            value @ ("two" | "three" | "four" | "six") => Some(value.to_owned()),
            _ => {
                return Err(KalError::validation(
                    "invalid_launch_recipe_layout",
                    "Choose a layout of two, three, four, or six panes.",
                ));
            }
        },
    };

    if recipe.variables.len() > MAX_VARIABLES {
        return Err(KalError::validation(
            "too_many_launch_recipe_variables",
            "A Recipe can have up to 8 variables.",
        ));
    }
    let mut keys = HashSet::new();
    for variable in &mut recipe.variables {
        variable.key = variable.key.trim().to_owned();
        if !valid_variable_key(&variable.key) {
            return Err(KalError::validation(
                "invalid_launch_recipe_variable",
                "Variable names start with a lowercase letter and use lowercase letters, numbers, or underscores (up to 32).",
            ));
        }
        if !keys.insert(variable.key.clone()) {
            return Err(KalError::validation(
                "duplicate_launch_recipe_variable",
                "Each variable needs a distinct name.",
            ));
        }
        let label = variable.label.trim();
        variable.label = if label.is_empty() {
            variable.key.clone()
        } else {
            text(
                label,
                80,
                false,
                true,
                "invalid_launch_recipe_variable",
                "Variable labels are single-line and up to 80 characters.",
            )?
        };
        variable.default_value = bounded(
            &variable.default_value,
            MAX_DEFAULT_BYTES,
            true,
            true,
            "invalid_launch_recipe_variable",
            "Variable defaults can be up to 2 KiB.",
        )?;
        secret(&variable.label)?;
        secret(&variable.default_value)?;
    }

    if recipe.components.len() > MAX_COMPONENTS {
        return Err(KalError::validation(
            "too_many_launch_recipe_components",
            "A Recipe can have up to 32 parts.",
        ));
    }
    let mut keys = HashSet::new();
    let components = std::mem::take(&mut recipe.components);
    for component in components {
        let component = normalize_component(component)?;
        if !keys.insert(component.key().to_owned()) {
            return Err(KalError::validation(
                "duplicate_launch_recipe_component",
                "Each part of a Recipe needs a distinct key.",
            ));
        }
        recipe.components.push(component);
    }
    Ok(recipe)
}

fn normalize_component(component: RecipeComponent) -> Result<RecipeComponent> {
    Ok(match component {
        RecipeComponent::Agent {
            key,
            provider_id,
            provider_account_id,
            model,
            effort,
            name,
            task,
        } => {
            if let Some(account) = &provider_account_id {
                validate_id(account, "invalid_launch_recipe_account")?;
            }
            let task = optional_bounded(task, MAX_TASK_BYTES, "launch_recipe_task")?;
            if let Some(task) = &task {
                secret(task)?;
            }
            RecipeComponent::Agent {
                key: slug(&key, "invalid_launch_recipe_key")?,
                provider_id: slug(&provider_id, "invalid_launch_recipe_provider")?,
                provider_account_id,
                model: optional_line(model, "launch_recipe_model")?,
                effort: optional_line(effort, "launch_recipe_effort")?,
                name: optional_line(name, "launch_recipe_name_part")?,
                task,
            }
        }
        RecipeComponent::Terminal { key, name, command } => {
            let command = optional_bounded(command, MAX_COMMAND_BYTES, "launch_recipe_command")?;
            if let Some(command) = &command {
                secret(command)?;
            }
            RecipeComponent::Terminal {
                key: slug(&key, "invalid_launch_recipe_key")?,
                name: optional_line(name, "launch_recipe_name_part")?,
                command,
            }
        }
        RecipeComponent::Browser { key, url } => RecipeComponent::Browser {
            key: slug(&key, "invalid_launch_recipe_key")?,
            url: normalize_url(&url)?,
        },
        RecipeComponent::Service { key, name, command } => {
            let name = text(
                &name,
                MAX_NAME_CHARS,
                false,
                true,
                "invalid_launch_recipe_service",
                "Services need a name of up to 120 characters.",
            )?;
            let command = bounded(
                &command,
                MAX_COMMAND_BYTES,
                false,
                false,
                "invalid_launch_recipe_service",
                "Services need a command of up to 8 KiB.",
            )?;
            secret(&name)?;
            secret(&command)?;
            RecipeComponent::Service {
                key: slug(&key, "invalid_launch_recipe_key")?,
                name,
                command,
            }
        }
        RecipeComponent::Widget { key, widget } => RecipeComponent::Widget {
            key: slug(&key, "invalid_launch_recipe_key")?,
            widget: widget_id(&widget)?,
        },
        RecipeComponent::Squad {
            key,
            squad_id,
            goal,
        } => {
            validate_id(&squad_id, "invalid_launch_recipe_squad")?;
            let goal = optional_bounded(goal, MAX_GOAL_BYTES, "launch_recipe_goal")?;
            if let Some(goal) = &goal {
                secret(goal)?;
            }
            RecipeComponent::Squad {
                key: slug(&key, "invalid_launch_recipe_key")?,
                squad_id,
                goal,
            }
        }
    })
}

fn url_error() -> KalError {
    KalError::validation(
        "invalid_launch_recipe_url",
        "Browser parts need an HTTP or HTTPS address without credentials or sign-in tokens.",
    )
}

fn normalize_url(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_URL_CHARS
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(url_error());
    }
    let lower = value.to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &value[8..]
    } else if lower.starts_with("http://") {
        &value[7..]
    } else {
        return Err(url_error());
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() || authority.contains('@') || authority.starts_with(':') {
        return Err(url_error());
    }
    let (before_fragment, fragment) = match rest[authority_end..].split_once('#') {
        Some((head, tail)) => (head, tail),
        None => (&rest[authority_end..], ""),
    };
    let query = before_fragment.split_once('?').map_or("", |(_, q)| q);
    // Sign-in tokens also travel in fragments (`#access_token=...`).
    let fragment_params = if fragment.contains('=') { fragment } else { "" };
    for pair in query.split('&').chain(fragment_params.split('&')) {
        let key = pair.split('=').next().unwrap_or("");
        if sensitive_query_key(key) {
            return Err(url_error());
        }
    }
    secret(value).map_err(|_| url_error())?;
    Ok(value.to_owned())
}

/// `%XX` escapes decoded, so `to%6Ben` is checked as `token`. Works on bytes: never panics.
fn percent_decoded(key: &str) -> String {
    let bytes = key.as_bytes();
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = (bytes[index] == b'%' && index + 2 < bytes.len())
            .then(|| Some(hex(bytes[index + 1])? * 16 + hex(bytes[index + 2])?))
            .flatten();
        if let Some(value) = escaped {
            out.push(value);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn sensitive_query_key(key: &str) -> bool {
    let key = percent_decoded(key).to_ascii_lowercase();
    let squashed: String = key.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    const CONTAINS: [&str; 7] = [
        "token",
        "secret",
        "password",
        "passwd",
        "apikey",
        "signature",
        "session",
    ];
    CONTAINS.iter().any(|needle| squashed.contains(needle))
        || squashed.starts_with("auth")
        || squashed.ends_with("auth")
        || matches!(squashed.as_str(), "sig" | "code")
        || key
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|part| matches!(part, "sig" | "code" | "auth"))
}

fn valid_variable_key(key: &str) -> bool {
    let mut chars = key.chars();
    key.len() <= 32
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn has_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn slug(value: &str, code: &'static str) -> Result<String> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value.chars().count() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
    if valid {
        Ok(value.to_owned())
    } else {
        Err(KalError::validation(
            code,
            "Keys, providers, and widgets use letters, numbers, dashes, or underscores (up to 64).",
        ))
    }
}

/// Same rule as pane widget ids (`apps/desktop/src/shell/panes/model.ts`).
fn widget_id(value: &str) -> Result<String> {
    let value = value.trim();
    let mut chars = value.chars();
    let valid = value.len() <= 64
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'));
    if valid {
        Ok(value.to_owned())
    } else {
        Err(KalError::validation(
            "invalid_launch_recipe_widget",
            "That widget isn't available. Choose a widget from the list.",
        ))
    }
}

fn text(
    value: &str,
    max_chars: usize,
    allow_empty: bool,
    single_line: bool,
    code: &'static str,
    message: &'static str,
) -> Result<String> {
    let value = value.trim();
    let valid = (allow_empty || !value.is_empty())
        && value.chars().count() <= max_chars
        && value
            .chars()
            .all(|c| !c.is_control() || (!single_line && c == '\t'));
    if valid {
        Ok(value.to_owned())
    } else {
        Err(KalError::validation(code, message))
    }
}

fn bounded(
    value: &str,
    max_bytes: usize,
    allow_empty: bool,
    single_line: bool,
    code: &'static str,
    message: &'static str,
) -> Result<String> {
    let value = value.trim();
    let valid = (allow_empty || !value.is_empty())
        && value.len() <= max_bytes
        && value
            .chars()
            .all(|c| !c.is_control() || (!single_line && matches!(c, '\n' | '\r' | '\t')));
    if valid {
        Ok(value.to_owned())
    } else {
        Err(KalError::validation(code, message))
    }
}

/// Optional single-line value; blank becomes `None`.
fn optional_line(value: Option<String>, code: &'static str) -> Result<Option<String>> {
    match value.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(value) => {
            let value = text(
                value,
                MAX_NAME_CHARS,
                false,
                true,
                code,
                "Values are single-line and up to 120 characters.",
            )?;
            secret(&value)?;
            Ok(Some(value))
        }
    }
}

/// Optional multi-line value; blank becomes `None`.
fn optional_bounded(
    value: Option<String>,
    max_bytes: usize,
    code: &'static str,
) -> Result<Option<String>> {
    match value.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(value) => Ok(Some(bounded(
            value,
            max_bytes,
            false,
            false,
            code,
            "That text is too long or contains unsupported characters.",
        )?)),
    }
}

fn secret(value: &str) -> Result<()> {
    if secrets::scan_with(
        value,
        ScanContext {
            file_name: None,
            no_entropy: false,
        },
    )
    .is_empty()
    {
        Ok(())
    } else {
        Err(KalError::validation(
            "launch_recipe_secret_detected",
            "Remove credentials or secret-shaped values before saving this Recipe.",
        ))
    }
}

fn validate_id(value: &str, code: &'static str) -> Result<()> {
    if is_valid_id(value) {
        Ok(())
    } else {
        Err(KalError::validation(code, "That identifier is invalid."))
    }
}

fn not_found() -> KalError {
    KalError::validation(
        "launch_recipe_not_found",
        "That Recipe no longer exists. Refresh and choose another Recipe.",
    )
}
