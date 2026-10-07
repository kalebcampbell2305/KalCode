//! Launch Recipes: a saved working desk (coding agents, terminals, Browser pages, Services,
//! widgets, layout and an optional Squad) that recreates in one action.
//!
//! A Recipe only REFERENCES canonical objects by id (workspace, provider account, Service,
//! Squad); it never copies their state and never stores credentials. Launching reads the Recipe
//! and starts fresh sessions, so editing a Recipe never touches anything already running.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Current definition version. Older stored versions are upgraded on read; newer ones are
/// refused with an actionable error instead of being misread.
pub const LAUNCH_RECIPE_SCHEMA_VERSION: u32 = 1;

/// A value the person can change per launch (`{{branch}}`, `{{url}}`, `{{task}}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecipeVariable {
    /// `[a-z][a-z0-9_]{0,31}`, referenced as `{{key}}`.
    pub key: String,
    pub label: String,
    pub default_value: String,
    /// Shown in the launch sheet. Variables that aren't asked use their default silently.
    pub ask_at_launch: bool,
}

/// One part of the desk. `key` is stable within the Recipe and names the part in results.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum RecipeComponent {
    /// A real coding-agent terminal with an exact provider account, model and effort.
    #[serde(rename_all = "camelCase")]
    Agent {
        key: String,
        provider_id: String,
        /// `None` uses the provider's remembered/default account at launch.
        provider_account_id: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        name: Option<String>,
        /// Optional first message, sent once the agent is ready.
        task: Option<String>,
    },
    /// A shell terminal in the project folder, optionally running a startup command.
    #[serde(rename_all = "camelCase")]
    Terminal {
        key: String,
        name: Option<String>,
        command: Option<String>,
    },
    /// A Browser pane at an HTTP(S) address.
    #[serde(rename_all = "camelCase")]
    Browser { key: String, url: String },
    /// A long-running Development Service, started as a canonical Operations `service` run in
    /// the project. One already running under the same name is reused, never duplicated.
    #[serde(rename_all = "camelCase")]
    Service {
        key: String,
        name: String,
        command: String,
    },
    /// A built-in Code widget pane (for example `git`, `files`, `notes`).
    #[serde(rename_all = "camelCase")]
    Widget { key: String, widget: String },
    /// Launches a saved Squad through canonical Operations orchestration.
    #[serde(rename_all = "camelCase")]
    Squad {
        key: String,
        squad_id: String,
        goal: Option<String>,
    },
}

impl RecipeComponent {
    pub fn key(&self) -> &str {
        match self {
            Self::Agent { key, .. }
            | Self::Terminal { key, .. }
            | Self::Browser { key, .. }
            | Self::Service { key, .. }
            | Self::Widget { key, .. }
            | Self::Squad { key, .. } => key,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Agent { .. } => "agent",
            Self::Terminal { .. } => "terminal",
            Self::Browser { .. } => "browser",
            Self::Service { .. } => "service",
            Self::Widget { .. } => "widget",
            Self::Squad { .. } => "squad",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LaunchRecipe {
    pub id: String,
    pub name: String,
    pub schema_version: u32,
    /// Project the desk belongs to. `None` launches in whichever project is active.
    pub workspace_id: Option<String>,
    pub pinned: bool,
    /// Manual order (ascending). Pinned Recipes sort first.
    pub position: u32,
    pub variables: Vec<RecipeVariable>,
    pub components: Vec<RecipeComponent>,
    /// Code layout preset applied before panes open (`two`, `three`, `four`, `six`), or none.
    pub layout: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LaunchRecipesSnapshot {
    pub recipes: Vec<LaunchRecipe>,
    /// Plan limit on saved Recipes; `None` means KalCode imposes none.
    pub limit: Option<u32>,
}
