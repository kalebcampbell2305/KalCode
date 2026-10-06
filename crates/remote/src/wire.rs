//! Wire types (§2–§4). Field names are camelCase; every application message carries a `t` tag;
//! timestamps are RFC 3339 strings.

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::Error;

// ---------------------------------------------------------------------------------------------
// §2 Pairing payload
// ---------------------------------------------------------------------------------------------

/// Scheme and host of the pairing link.
pub const PAIR_LINK_PREFIX: &str = "kalcode-remote://pair?";

/// The QR code / pairing link contents. `Debug` never prints the code.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingPayload {
    pub v: u32,
    /// Workstation id (`ws_...`).
    pub wid: String,
    /// Desktop machine name.
    pub name: String,
    /// Workstation static public key, standard base64 (32 bytes).
    pub pk: String,
    /// Single-use pairing code, standard base64 (32 bytes).
    pub code: String,
    /// Reachable `ipv4:port` addresses.
    pub addrs: Vec<String>,
    /// Expiry, Unix seconds.
    pub exp: i64,
}

impl fmt::Debug for PairingPayload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingPayload")
            .field("v", &self.v)
            .field("wid", &self.wid)
            .field("name", &self.name)
            .field("pk", &self.pk)
            .field("code", &"<redacted>")
            .field("addrs", &self.addrs)
            .field("exp", &self.exp)
            .finish()
    }
}

impl PairingPayload {
    /// `kalcode-remote://pair?d=<base64url(JSON)>` (unpadded base64url).
    pub fn to_link(&self) -> Result<String, Error> {
        let json = serde_json::to_vec(self)?;
        Ok(format!(
            "{PAIR_LINK_PREFIX}d={}",
            URL_SAFE_NO_PAD.encode(json)
        ))
    }

    /// Parses a pairing link. Accepts padded or unpadded base64url and ignores other query
    /// parameters.
    pub fn parse_link(link: &str) -> Result<Self, Error> {
        let query = link
            .trim()
            .strip_prefix(PAIR_LINK_PREFIX)
            .ok_or_else(|| Error::Malformed("not a kalcode-remote pairing link".into()))?;
        let data = query
            .split('&')
            .find_map(|pair| pair.strip_prefix("d="))
            .ok_or_else(|| Error::Malformed("pairing link has no d parameter".into()))?;
        let json = URL_SAFE_NO_PAD
            .decode(data.trim_end_matches('='))
            .map_err(|e| Error::Malformed(format!("pairing link: {e}")))?;
        Ok(serde_json::from_slice(&json)?)
    }
}

// ---------------------------------------------------------------------------------------------
// §3 Handshake payloads
// ---------------------------------------------------------------------------------------------

/// Payload of handshake message 1 (device → desktop). `Debug` never prints the pairing code.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceHello {
    pub v: u32,
    /// Device name, e.g. "Kaleb's iPhone".
    pub device: String,
    /// `ios` or `android`.
    pub platform: String,
    /// Hardware model, e.g. "iPhone17,1".
    pub model: String,
    /// App version, e.g. "1.0 (1)".
    pub app: String,
    /// Pairing code (standard base64) when pairing; omitted otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pair: Option<String>,
    /// Device clock, Unix seconds.
    pub ts: i64,
}

/// Longest `device`, `platform`, `model` or `app` string accepted in a [`DeviceHello`].
pub const MAX_HELLO_FIELD: usize = 64;

impl DeviceHello {
    /// Whether the descriptive fields are at most [`MAX_HELLO_FIELD`] characters and free of
    /// control characters (the handshake answers `invalid` otherwise).
    pub fn fields_are_valid(&self) -> bool {
        [&self.device, &self.platform, &self.model, &self.app]
            .iter()
            .all(|field| {
                field.chars().count() <= MAX_HELLO_FIELD && !field.chars().any(char::is_control)
            })
    }
}

impl fmt::Debug for DeviceHello {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceHello")
            .field("v", &self.v)
            .field("device", &self.device)
            .field("platform", &self.platform)
            .field("model", &self.model)
            .field("app", &self.app)
            .field("pair", &self.pair.as_ref().map(|_| "<redacted>"))
            .field("ts", &self.ts)
            .finish()
    }
}

/// Why the desktop refused a handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    Unpaired,
    Revoked,
    PairingExpired,
    NotEntitled,
    Busy,
    Version,
    /// The handshake payload's fields are too long or contain control characters.
    Invalid,
}

impl fmt::Display for RejectReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unpaired => "unpaired",
            Self::Revoked => "revoked",
            Self::PairingExpired => "pairing_expired",
            Self::NotEntitled => "not_entitled",
            Self::Busy => "busy",
            Self::Version => "version",
            Self::Invalid => "invalid",
        })
    }
}

/// The desktop's build, as shown on the device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostBuild {
    /// `windows` or `macos`.
    pub platform: String,
    pub version: String,
    pub build: u64,
}

/// Successful handshake message 2 payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeAccepted {
    pub wid: String,
    pub name: String,
    pub device_id: String,
    pub host: HostBuild,
}

/// Payload of handshake message 2 (desktop → device):
/// `{"ok":true,"wid",...}` or `{"ok":false,"error":"<reason>"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawReply", into = "RawReply")]
pub enum HandshakeReply {
    Accepted(HandshakeAccepted),
    Rejected(RejectReason),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReply {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host: Option<HostBuild>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<RejectReason>,
}

impl From<HandshakeReply> for RawReply {
    fn from(reply: HandshakeReply) -> Self {
        match reply {
            HandshakeReply::Accepted(a) => Self {
                ok: true,
                wid: Some(a.wid),
                name: Some(a.name),
                device_id: Some(a.device_id),
                host: Some(a.host),
                error: None,
            },
            HandshakeReply::Rejected(reason) => Self {
                ok: false,
                wid: None,
                name: None,
                device_id: None,
                host: None,
                error: Some(reason),
            },
        }
    }
}

impl TryFrom<RawReply> for HandshakeReply {
    type Error = String;

    fn try_from(raw: RawReply) -> Result<Self, String> {
        if !raw.ok {
            return raw
                .error
                .map(Self::Rejected)
                .ok_or_else(|| "rejection without error".into());
        }
        match (raw.wid, raw.name, raw.device_id, raw.host) {
            (Some(wid), Some(name), Some(device_id), Some(host)) => {
                Ok(Self::Accepted(HandshakeAccepted {
                    wid,
                    name,
                    device_id,
                    host,
                }))
            }
            _ => Err("acceptance is missing wid, name, deviceId or host".into()),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// §4 Application messages
// ---------------------------------------------------------------------------------------------

/// Device → desktop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum DeviceMessage {
    /// Sent once after the handshake; answered by `snapshot`.
    Hello {},
    /// Runs an operation (§5); answered by exactly one `res`.
    Req {
        id: String,
        op: String,
        #[serde(default)]
        args: Value,
    },
    /// Keepalive; answered by `pong` with the same `n`.
    Ping { n: u64 },
}

/// Desktop → device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum HostMessage {
    /// Full canonical state; replaces everything the device has.
    Snapshot { rev: u64, state: Box<RemoteState> },
    /// Incremental change.
    Patch(Box<Patch>),
    /// Result of a `req`.
    Res(Response),
    /// A notification-worthy event (§6).
    Notify(Notification),
    /// Keepalive reply.
    Pong { n: u64 },
    /// The desktop is closing the connection on purpose.
    Bye { reason: ByeReason },
}

/// Why the desktop closed a connection on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ByeReason {
    Revoked,
    Disabled,
    Shutdown,
    NotEntitled,
    /// The same device opened a newer session; this older one is closed.
    Replaced,
}

/// The patch collections.
pub const COLLECTIONS: [&str; 6] = [
    "agents",
    "needsYou",
    "runs",
    "services",
    "environments",
    "workspaces",
];

/// `patch`: upserts and removals by collection, plus `workstation` when it changed.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Patch {
    pub rev: u64,
    #[serde(default)]
    pub upsert: Upserts,
    #[serde(default)]
    pub remove: Removals,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workstation: Option<Workstation>,
}

/// Changed or new items, by collection. Empty collections are omitted.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upserts {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<RemoteAgent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub needs_you: Vec<NeedsYouItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runs: Vec<RemoteRun>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub services: Vec<RemoteService>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environments: Vec<RemoteEnvironment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspaces: Vec<RemoteWorkspace>,
}

/// Removed ids, by collection. Empty collections are omitted.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Removals {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub needs_you: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub services: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environments: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspaces: Vec<String>,
}

/// `res`: `{id, ok, result}` or `{id, ok:false, error:{code,message}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteError>,
}

impl Response {
    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            id: id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(id: impl Into<String>, error: RemoteError) -> Self {
        Self {
            id: id.into(),
            ok: false,
            result: None,
            error: Some(error),
        }
    }

    pub fn from_result(id: impl Into<String>, result: Result<Value, RemoteError>) -> Self {
        match result {
            Ok(value) => Self::success(id, value),
            Err(error) => Self::failure(id, error),
        }
    }
}

/// Operation error codes (§5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The target ended or no longer exists. Never act on a substitute.
    NotFound,
    /// State changed; refresh.
    Conflict,
    /// A safety rule declined; `message` says why.
    Refused,
    NotEntitled,
    Unavailable,
    Invalid,
    Internal,
}

/// An operation failure as it travels in `res.error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct RemoteError {
    pub code: ErrorCode,
    pub message: String,
}

impl RemoteError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }
    pub fn refused(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Refused, message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unavailable, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

/// What a `notify` is about (§6). Routine progress never notifies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyKind {
    /// An agent needs you (approval or question).
    NeedsYou,
    AgentFailed,
    AgentDone,
    RunFailed,
    /// A deployment changed.
    Deployment,
}

/// `notify` (§6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notification {
    pub id: String,
    pub kind: NotifyKind,
    pub title: String,
    pub body: String,
    /// A `kalcode-remote://` deep link.
    pub link: String,
}

/// Deep links (§6).
pub mod link {
    pub fn agent(agent_id: &str) -> String {
        format!("kalcode-remote://agent/{agent_id}")
    }
    pub fn needs(needs_you_id: &str) -> String {
        format!("kalcode-remote://needs/{needs_you_id}")
    }
    pub fn run(run_id: &str) -> String {
        format!("kalcode-remote://run/{run_id}")
    }
    pub fn diff(agent_id: &str) -> String {
        format!("kalcode-remote://diff/{agent_id}")
    }
    pub const FLEET: &str = "kalcode-remote://fleet";
}

// ---------------------------------------------------------------------------------------------
// §4.1 State
// ---------------------------------------------------------------------------------------------

/// The full canonical state a device mirrors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteState {
    pub workstation: Workstation,
    #[serde(default)]
    pub workspaces: Vec<RemoteWorkspace>,
    #[serde(default)]
    pub agents: Vec<RemoteAgent>,
    #[serde(default)]
    pub needs_you: Vec<NeedsYouItem>,
    #[serde(default)]
    pub runs: Vec<RemoteRun>,
    #[serde(default)]
    pub services: Vec<RemoteService>,
    #[serde(default)]
    pub environments: Vec<RemoteEnvironment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workstation {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub version: String,
    pub build: u64,
    /// Most recently active workspace, or null.
    pub active_workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspace {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_active_at: Option<OffsetDateTime>,
}

/// Provider-agnostic agent state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Starting,
    Ready,
    Working,
    Testing,
    Waiting,
    NeedsYou,
    Idle,
    Done,
    Failed,
    Stopped,
}

/// Where the agent runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntime {
    Pane,
    Headless,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgent {
    /// ThreadId.
    pub id: String,
    pub name: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub provider_id: String,
    pub provider_name: String,
    pub account_label: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub state: AgentState,
    /// Raw ThreadStatus (snake_case), for detail views.
    pub status: String,
    /// Current action, or null.
    pub activity: Option<String>,
    pub branch: Option<String>,
    pub worktree: bool,
    pub files_changed: u32,
    pub pending_approvals: u32,
    pub error: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub last_activity_at: OffsetDateTime,
    pub runtime: AgentRuntime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedsYouKind {
    Approval,
    Question,
    Failed,
    Auth,
    Stalled,
    Review,
}

/// What a device may offer for a needs-you item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedsYouAction {
    ApproveOnce,
    Deny,
    Open,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsYouItem {
    /// Stable: `<kind>:<source id>`.
    pub id: String,
    pub kind: NeedsYouKind,
    pub title: String,
    pub detail: String,
    pub agent_id: Option<String>,
    /// Only for `kind = approval`.
    pub approval_id: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub actions: Vec<NeedsYouAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRun {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub agent_id: Option<String>,
    pub branch: Option<String>,
    pub current_action: Option<String>,
    pub outcome: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteService {
    pub id: String,
    pub name: String,
    pub status: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEnvironment {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub deployment_status: String,
    pub health: Option<String>,
    pub url: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_deploy_at: Option<OffsetDateTime>,
}

/// An item of a patchable collection.
pub trait Keyed {
    fn key(&self) -> &str;
}

macro_rules! keyed {
    ($($t:ty),*) => {$(
        impl Keyed for $t {
            fn key(&self) -> &str {
                &self.id
            }
        }
    )*};
}
keyed!(
    RemoteAgent,
    NeedsYouItem,
    RemoteRun,
    RemoteService,
    RemoteEnvironment,
    RemoteWorkspace
);

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use serde_json::json;

    use super::*;

    #[test]
    fn pairing_link_round_trips() {
        let payload = PairingPayload {
            v: 1,
            wid: "ws_1".into(),
            name: "Kaleb's Workstation".into(),
            pk: "a".repeat(44),
            code: "b".repeat(44),
            addrs: vec!["192.168.1.20:47820".into()],
            exp: 1_791_234_567,
        };
        let link = payload.to_link().unwrap();
        assert!(link.starts_with("kalcode-remote://pair?d="));
        assert!(!link.ends_with('='));
        assert_eq!(PairingPayload::parse_link(&link).unwrap(), payload);
        assert_eq!(
            PairingPayload::parse_link(&format!("{link}==&x=1")).unwrap(),
            payload
        );
        assert!(PairingPayload::parse_link("https://example.com").is_err());
    }

    #[test]
    fn handshake_reply_shapes() {
        let ok = HandshakeReply::Accepted(HandshakeAccepted {
            wid: "ws_1".into(),
            name: "WS".into(),
            device_id: "dev_1".into(),
            host: HostBuild {
                platform: "windows".into(),
                version: "0.1.9".into(),
                build: 2007,
            },
        });
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            json!({"ok":true,"wid":"ws_1","name":"WS","deviceId":"dev_1",
                   "host":{"platform":"windows","version":"0.1.9","build":2007}})
        );
        let no = HandshakeReply::Rejected(RejectReason::PairingExpired);
        assert_eq!(
            serde_json::to_value(&no).unwrap(),
            json!({"ok":false,"error":"pairing_expired"})
        );
        assert_eq!(
            serde_json::from_value::<HandshakeReply>(json!({"ok":false,"error":"revoked"}))
                .unwrap(),
            HandshakeReply::Rejected(RejectReason::Revoked)
        );
        assert!(serde_json::from_value::<HandshakeReply>(json!({"ok":true})).is_err());
    }

    #[test]
    fn device_hello_omits_missing_code() {
        let hello = DeviceHello {
            v: 1,
            device: "Phone".into(),
            platform: "ios".into(),
            model: "iPhone17,1".into(),
            app: "1.0 (1)".into(),
            pair: None,
            ts: 5,
        };
        let value = serde_json::to_value(&hello).unwrap();
        assert!(value.get("pair").is_none());
    }

    #[test]
    fn messages_are_tagged() {
        assert_eq!(
            serde_json::to_value(DeviceMessage::Hello {}).unwrap(),
            json!({"t":"hello"})
        );
        assert_eq!(
            serde_json::from_value::<DeviceMessage>(json!({"t":"hello"})).unwrap(),
            DeviceMessage::Hello {}
        );
        assert_eq!(
            serde_json::from_value::<DeviceMessage>(
                json!({"t":"req","id":"1","op":"launch.options"})
            )
            .unwrap(),
            DeviceMessage::Req {
                id: "1".into(),
                op: "launch.options".into(),
                args: Value::Null
            }
        );
        assert_eq!(
            serde_json::to_value(HostMessage::Pong { n: 3 }).unwrap(),
            json!({"t":"pong","n":3})
        );
        assert_eq!(
            serde_json::to_value(HostMessage::Bye {
                reason: ByeReason::NotEntitled
            })
            .unwrap(),
            json!({"t":"bye","reason":"not_entitled"})
        );
        assert_eq!(
            serde_json::to_value(HostMessage::Res(Response::failure(
                "9",
                RemoteError::not_found("gone")
            )))
            .unwrap(),
            json!({"t":"res","id":"9","ok":false,"error":{"code":"not_found","message":"gone"}})
        );
        let patch = HostMessage::Patch(Box::new(Patch {
            rev: 2,
            remove: Removals {
                needs_you: vec!["approval:a".into()],
                ..Removals::default()
            },
            ..Patch::default()
        }));
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            json!({"t":"patch","rev":2,"upsert":{},"remove":{"needsYou":["approval:a"]}})
        );
    }

    #[test]
    fn state_uses_camel_case_and_rfc3339() {
        let at = OffsetDateTime::from_unix_timestamp(1_791_234_567).unwrap();
        let agent = RemoteAgent {
            id: "thr_1".into(),
            name: "Fix login".into(),
            workspace_id: "wsp_1".into(),
            workspace_name: "KalCode".into(),
            provider_id: "claude-code".into(),
            provider_name: "Claude Code".into(),
            account_label: None,
            model: Some("claude-opus-5-5".into()),
            effort: None,
            state: AgentState::NeedsYou,
            status: "running_command".into(),
            activity: None,
            branch: None,
            worktree: true,
            files_changed: 4,
            pending_approvals: 1,
            error: None,
            created_at: at,
            last_activity_at: at,
            runtime: AgentRuntime::Pane,
        };
        let value = serde_json::to_value(&agent).unwrap();
        assert_eq!(value["state"], "needs_you");
        assert_eq!(value["createdAt"], "2026-10-05T21:09:27Z");
        assert_eq!(value["accountLabel"], Value::Null);
        assert_eq!(value["filesChanged"], 4);
        assert_eq!(serde_json::from_value::<RemoteAgent>(value).unwrap(), agent);
    }
}
