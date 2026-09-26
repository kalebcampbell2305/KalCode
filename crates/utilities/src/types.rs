//! Wire types of the Developer Utility Dock (UD).
//!
//! They follow the sketch in `docs/CONTRACTS_ADVANCED.md` §5.11 and live in this crate until the
//! lead moves them into `crates/contracts` (the JSON shapes are chosen so the move changes nothing
//! on the wire). Differences from the sketch are listed in `docs/campaigns/UD.md`.

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::permissions::ProcessSignalKind;
use kalcode_contracts::refs::FileRef;
use kalcode_contracts::resources::ProcessRole;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ---------------------------------------------------------------------------------------------
// API Inspector
// ---------------------------------------------------------------------------------------------

/// Request methods the API Inspector sends. `CONNECT` and `TRACE` are deliberately absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "UPPERCASE")]
#[ts(export)]
pub enum HttpMethod {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
}

impl HttpMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Head => "HEAD",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Options => "OPTIONS",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
    /// Marked sensitive (by the person, or natively for `Authorization`, `Cookie`, `*token*`, …):
    /// the value is never stored in history or saved requests.
    #[serde(default)]
    pub sensitive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HttpQueryParam {
    pub name: String,
    pub value: String,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
}

fn enabled_default() -> bool {
    true
}

/// What the person asked to send. Validated natively (method, URL, header names and values,
/// sizes); nothing is added implicitly — no cookies, no stored credentials, no proxy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HttpRequestSpec {
    pub method: HttpMethod,
    /// `http://` or `https://` only; user-info (`user:pass@`) is refused.
    pub url: String,
    /// Appended to the URL's own query, in order (disabled rows are skipped).
    #[serde(default)]
    pub query: Vec<HttpQueryParam>,
    #[serde(default)]
    pub headers: Vec<HttpHeader>,
    #[serde(default)]
    pub body: Option<String>,
    /// 1 000–60 000 ms; default 15 000.
    #[serde(default)]
    pub timeout_ms: Option<u32>,
    /// Follow up to 5 redirects; every hop is evaluated and confirmed like a new request.
    #[serde(default)]
    pub follow_redirects: bool,
}

/// Where a request's resolved address points. Decides the confirmation policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HttpDestination {
    /// This computer only (127.0.0.0/8, ::1).
    Loopback,
    /// The local network (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7).
    Private,
    /// The internet.
    External,
    /// Link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10, 100.100.100.200,
    /// fd00:ec2::254): blocked unless confirmed natively.
    LinkLocal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HttpBodyKind {
    Empty,
    Text,
    Json,
    /// Not UTF-8: `body` holds a hex preview of the first bytes.
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HttpTiming {
    /// Name resolution (0 for an IP literal).
    pub resolve_ms: u32,
    /// Until the response headers arrived (connect, TLS, send, server time).
    pub headers_ms: u32,
    /// Until the body was read (or the size cap was reached).
    pub total_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HttpRedirectHop {
    pub status: u16,
    /// The host the redirect pointed to (never its path or query).
    pub host: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HttpResponseView {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<HttpHeader>,
    /// UTF-8 text, or a hex preview for binary bodies. At most [`crate::http::MAX_RESPONSE_BYTES`].
    pub body: String,
    pub body_kind: HttpBodyKind,
    pub content_type: Option<String>,
    /// Bytes read (up to the cap + 1).
    pub bytes: u64,
    /// The body was longer than the cap; the rest was not read.
    pub truncated: bool,
    pub timing: HttpTiming,
    /// Final URL after redirects.
    pub url: String,
    pub redirects: Vec<HttpRedirectHop>,
    pub destination: HttpDestination,
    /// The address actually connected to (the pinned resolution).
    pub remote_address: String,
    /// The history row recorded for this request.
    pub history_id: String,
}

/// A request in this session's history. Secrets are redacted (sensitive header values dropped,
/// secret-looking query values and body spans replaced) before it is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HttpHistoryEntry {
    pub id: String,
    pub at: String,
    pub method: HttpMethod,
    pub host: String,
    pub destination: Option<HttpDestination>,
    pub status: Option<u16>,
    /// Why it wasn't sent or failed (`confirmation_declined`, `http_timeout`, …).
    pub error_code: Option<String>,
    pub elapsed_ms: u32,
    /// The request, redacted.
    pub request: HttpRequestSpec,
    /// How many values were removed or replaced by redaction.
    pub redactions: u32,
}

/// A saved request (schema v14). Sensitive header values are never stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HttpSavedRequest {
    pub id: String,
    pub name: String,
    pub request: HttpRequestSpec,
    /// Values KalCode left out when saving (sensitive headers, secret-looking values).
    pub redactions: u32,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------------------------
// Process Monitor
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProcessScope {
    /// KalCode's own tree, processes of open workspaces, and owners of listening ports.
    Related,
    /// Every process of the current user (and what else the OS lists).
    All,
}

/// Who a process belongs to. Decides whether and how it may be stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProcessOwner {
    /// KalCode itself, or part of its window (the WebView runtime).
    KalCode,
    /// Started by KalCode: a terminal shell, a provider CLI, or anything they started.
    KalCodeChild,
    /// Another program of the signed-in user.
    CurrentUser,
    OtherUser,
    System,
    /// Ownership couldn't be read (treated like another user's process).
    Unknown,
}

/// Whether a process may be stopped from KalCode, and with which confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Killability {
    /// Started by KalCode: confirm in KalCode.
    Confirm,
    /// Another program of the signed-in user: confirm in a native dialog.
    NativeConfirm,
    Refused {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    /// Executable name only (never the command line or environment).
    pub name: String,
    /// Opaque operating-system creation identity. With `pid` it identifies the exact sampled
    /// process; pids are reused, so a stop request for a replaced process is refused.
    pub start_time: String,
    /// Percent of the whole machine over the last interval; `None` on the first sample.
    pub cpu_percent: Option<f32>,
    pub memory_bytes: u64,
    pub owner: ProcessOwner,
    /// Its role in KalCode's process tree, when it belongs to it.
    pub role: Option<ProcessRole>,
    /// Short description ("Terminal shell", "KalCode window", "Listening on 3000").
    pub label: String,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub terminal_id: Option<String>,
    /// Registry generation for the terminal root. Descendants and unrelated processes have none.
    pub terminal_generation: Option<u64>,
    /// Listening ports this process owns.
    pub ports: Vec<u16>,
    pub killable: Killability,
    /// A KalCode terminal's shell: "Restart" restarts the terminal (Z1).
    pub can_restart: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProcessList {
    pub processes: Vec<ProcessInfo>,
    /// Every process the OS listed.
    pub total: u32,
    /// Processes not shown under the `related` scope.
    pub hidden: u32,
    /// False until a second sample makes CPU use measurable.
    pub cpu_ready: bool,
    pub sampled_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SignalOutcome {
    Stopped,
    /// A graceful stop was asked for; the process is still running (it may be saving, or it
    /// ignores the request — "Force stop" ends it).
    StillRunning,
    AlreadyExited,
    /// A KalCode terminal was restarted.
    Restarted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProcessSignalResult {
    pub pid: u32,
    pub signal: ProcessSignalKind,
    pub outcome: SignalOutcome,
    pub message: String,
}

// ---------------------------------------------------------------------------------------------
// Port Inspector
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TransportProtocol {
    Tcp,
    Udp,
}

/// Who can reach a listening socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PortExposure {
    /// Bound to loopback: this computer only.
    Loopback,
    /// Bound to every interface (`0.0.0.0`, `::`): reachable from the network unless a
    /// firewall blocks it.
    AllInterfaces,
    /// Bound to one specific address.
    Interface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ListeningPort {
    pub protocol: TransportProtocol,
    pub local_address: String,
    pub port: u16,
    pub exposure: PortExposure,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
    pub owner: Option<ProcessOwner>,
    /// "KalCode terminal", "Provider CLI", …
    pub label: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PortList {
    pub ports: Vec<ListeningPort>,
    /// The OS tool the listing came from (`netstat`, `lsof`, `ss`).
    pub source: String,
    pub sampled_at: String,
}

/// "What's using port 3000?"
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PortLookup {
    pub port: u16,
    pub matches: Vec<ListeningPort>,
    /// One sentence ("Port 3000 is used by node.exe (process 4120) from the KalCode workspace.").
    pub summary: String,
}

// ---------------------------------------------------------------------------------------------
// Environment Viewer
// ---------------------------------------------------------------------------------------------

/// Whose environment is shown: KalCode's own, what a new terminal receives, or what a provider
/// CLI receives after KalCode's sanitization.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum EnvSource {
    KalCode,
    Terminal,
    Provider { provider_id: ProviderId },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EnvValueKind {
    Empty,
    PathList,
    Path,
    Number,
    Flag,
    Url,
    Text,
    /// The name or the value looks like a credential.
    Secret,
}

/// One variable. The value is never included — only its shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EnvEntry {
    pub name: String,
    /// Always true in a listing: values are shown only through a native confirmation.
    pub redacted: bool,
    pub kind: EnvValueKind,
    /// Length in characters.
    pub length: u32,
    /// "40 characters, looks like a token", "12 folders", …
    pub hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EnvListing {
    pub source: EnvSource,
    pub entries: Vec<EnvEntry>,
    /// Names present in KalCode's environment that this source does **not** receive.
    pub withheld: Vec<String>,
    /// One sentence on how this source's environment is built.
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EnvReveal {
    pub name: String,
    pub value: String,
}

// ---------------------------------------------------------------------------------------------
// SQLite Viewer
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SqliteObjectKind {
    Table,
    View,
    Index,
    Trigger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SqliteColumn {
    pub name: String,
    pub decl_type: String,
    pub not_null: bool,
    /// 1-based position in the primary key, 0 when not part of it.
    pub primary_key: u32,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SqliteObject {
    pub kind: SqliteObjectKind,
    pub name: String,
    /// The table an index or trigger belongs to.
    pub table: Option<String>,
    pub sql: Option<String>,
    pub columns: Vec<SqliteColumn>,
}

/// An open database. Read-only; its id is valid for this session only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SqliteHandle {
    pub id: String,
    /// The file name, or the workspace-relative path.
    pub display_name: String,
    pub workspace_id: Option<String>,
    pub bytes: u64,
    pub objects: Vec<SqliteObject>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum SqliteCell {
    Null,
    Integer { value: i64 },
    Real { value: f64 },
    Text { value: String, truncated: bool },
    Blob { bytes: u32, preview_hex: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SqliteQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqliteCell>>,
    /// More rows follow: pass `next_cursor` for the next page.
    pub truncated: bool,
    pub next_cursor: Option<String>,
    pub offset: u32,
    pub elapsed_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SqliteWriteResult {
    pub changes: u64,
    pub elapsed_ms: u32,
}

/// Wire outcome of a consequential Utility Dock command. Preparation never performs the effect;
/// the WebView receives only an approval id and later continues by that id alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum UtilityEffectOutcome {
    AwaitingApproval { approval_id: String },
    HttpCompleted { response: HttpResponseView },
    ProcessCompleted { result: ProcessSignalResult },
    SqliteCompleted { result: SqliteWriteResult },
}

// ---------------------------------------------------------------------------------------------
// Regex Lab
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegexFlags {
    #[serde(default)]
    pub case_insensitive: bool,
    #[serde(default)]
    pub multi_line: bool,
    #[serde(default)]
    pub dot_matches_new_line: bool,
    #[serde(default)]
    pub ignore_whitespace: bool,
    /// Match only the first occurrence.
    #[serde(default)]
    pub first_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegexGroup {
    pub index: u32,
    pub name: Option<String>,
    /// UTF-16 offsets (what JavaScript strings index by); `None` when the group didn't take part.
    pub start: Option<u32>,
    pub end: Option<u32>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegexMatch {
    /// UTF-16 offsets into the sample text.
    pub start: u32,
    pub end: u32,
    pub text: String,
    pub groups: Vec<RegexGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegexError {
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegexResult {
    pub matches: Vec<RegexMatch>,
    /// Matches found (at most the cap).
    pub total: u32,
    /// Stopped at the match cap.
    pub truncated: bool,
    pub group_count: u32,
    pub group_names: Vec<Option<String>>,
    pub elapsed_us: u32,
    pub error: Option<RegexError>,
}

// ---------------------------------------------------------------------------------------------
// Diff Tool (workspace files) and scratchpads
// ---------------------------------------------------------------------------------------------

/// A workspace text file read by handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TextFile {
    pub file: FileRef,
    pub text: String,
    pub bytes: u64,
    /// Cut at [`crate::files::MAX_TEXT_BYTES`].
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Scratchpad {
    pub id: String,
    pub workspace_id: Option<String>,
    pub title: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScratchpadList {
    pub items: Vec<Scratchpad>,
    /// False when scratchpads last only for this session (schema v14 not installed).
    pub persistent: bool,
}

/// What the dock knows about this build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UtilityStatus {
    /// Scratchpads and saved requests are stored (schema v14 installed).
    pub persistent: bool,
    /// The OS tool the Port Inspector uses, or `None` where none is available.
    pub port_source: Option<String>,
}
