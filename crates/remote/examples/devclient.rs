//! A minimal device for checking a running dev host (or desktop) end to end.
//!
//! ```text
//! cargo run -p kalcode-remote --example devclient -- --data <devhost data dir> [--addr ip:port]
//! ```
//!
//! Reads `<data>/pairing-link.txt`, pairs on first run (its own key is kept in
//! `<data>/devclient-key.b64` and the workstation, without the code, in
//! `<data>/devclient-workstation.json`, so later runs reconnect without a code even after the
//! dev host deletes the redeemed link), then checks: snapshot,
//! a patch, `launch.options`, `agent.diff`, `needs.decide` on an open approval, and ping/pong.
//! Exits non-zero on any failure.

use std::error::Error as StdError;
use std::path::PathBuf;
use std::time::Duration;

use kalcode_remote::client::{self, ClientConnection};
use kalcode_remote::noise::{StaticKeypair, decode_public_key};
use kalcode_remote::ops;
use kalcode_remote::wire::{DeviceHello, DeviceMessage, HostMessage, PairingPayload, Response};
use serde_json::{Value, json};
use tokio::net::TcpStream;

type BoxError = Box<dyn StdError + Send + Sync>;

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    let mut data = None;
    let mut addr = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data" => data = args.next().map(PathBuf::from),
            "--addr" => addr = args.next(),
            other => return Err(format!("unknown argument {other}").into()),
        }
    }
    let data = data.ok_or("--data <dir> is required")?;
    let workstation_path = data.join("devclient-workstation.json");
    let key_path = data.join("devclient-key.b64");
    let paired_before = std::fs::read(&workstation_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PairingPayload>(&bytes).ok())
        .filter(|_| key_path.exists());
    let (payload, first_run) = match paired_before {
        Some(payload) => (payload, false),
        None => {
            let link = std::fs::read_to_string(data.join("pairing-link.txt"))
                .map_err(|_| "no pairing link: type `pair` in the dev host first")?;
            (PairingPayload::parse_link(&link)?, true)
        }
    };
    let key = if first_run {
        let key = StaticKeypair::generate()?;
        std::fs::write(&key_path, key.private_base64().as_str())?;
        key
    } else {
        StaticKeypair::from_private_base64(&std::fs::read_to_string(&key_path)?)?
    };
    let addr = addr
        .or_else(|| payload.addrs.last().cloned())
        .ok_or("no address")?;
    let hello = DeviceHello {
        v: 1,
        device: "devclient".into(),
        platform: "test".into(),
        model: std::env::consts::OS.into(),
        app: "devclient".into(),
        pair: first_run.then(|| payload.code.clone()),
        ts: time::OffsetDateTime::now_utc().unix_timestamp(),
    };
    let stream = TcpStream::connect(&addr).await?;
    let mut conn = client::connect(stream, &key, &decode_public_key(&payload.pk)?, &hello).await?;
    println!(
        "connected to {} ({}) as {}",
        conn.accepted.name, conn.accepted.wid, conn.accepted.device_id
    );
    if first_run {
        let mut remembered = payload.clone();
        remembered.code.clear();
        std::fs::write(&workstation_path, serde_json::to_vec_pretty(&remembered)?)?;
    }

    let HostMessage::Snapshot { rev, state } = next(&mut conn).await? else {
        return Err("expected a snapshot".into());
    };
    println!(
        "snapshot rev {rev}: {} agents, {} need you, {} runs, {} services, {} environments",
        state.agents.len(),
        state.needs_you.len(),
        state.runs.len(),
        state.services.len(),
        state.environments.len()
    );
    let mut expected_rev = rev + 1;

    let patch = loop {
        match next(&mut conn).await? {
            HostMessage::Patch(patch) => break patch,
            HostMessage::Notify(n) => println!("notify: {:?} {} ({})", n.kind, n.title, n.link),
            other => println!("(other) {other:?}"),
        }
    };
    if patch.rev != expected_rev {
        return Err(format!("rev gap: expected {expected_rev}, got {}", patch.rev).into());
    }
    expected_rev += 1;
    println!(
        "patch rev {}: upsert {} agents / {} needs, remove {} needs",
        patch.rev,
        patch.upsert.agents.len(),
        patch.upsert.needs_you.len(),
        patch.remove.needs_you.len()
    );

    let options = call(
        &mut conn,
        &mut expected_rev,
        "c1",
        ops::LAUNCH_OPTIONS,
        Value::Null,
    )
    .await?;
    let providers: Vec<&str> = options["providers"]
        .as_array()
        .ok_or("providers")?
        .iter()
        .filter_map(|p| p["name"].as_str())
        .collect();
    println!("launch.options: providers {providers:?}");

    let agent = state.agents.first().ok_or("no agents")?;
    let diff = call(
        &mut conn,
        &mut expected_rev,
        "c2",
        ops::AGENT_DIFF,
        json!({"agentId": agent.id}),
    )
    .await?;
    println!(
        "agent.diff {}: {} files",
        agent.id,
        diff["files"].as_array().map_or(0, Vec::len)
    );

    if let Some(approval) = state.needs_you.iter().find_map(|n| n.approval_id.clone()) {
        let decided = call_raw(
            &mut conn,
            &mut expected_rev,
            "c3",
            ops::NEEDS_DECIDE,
            json!({"approvalId": approval, "decision": "approve_once"}),
        )
        .await?;
        println!(
            "needs.decide {approval}: ok={} {:?}",
            decided.ok,
            decided.result.or(decided.error.map(|e| json!(e)))
        );
    }

    conn.send(&DeviceMessage::Ping { n: 42 }).await?;
    loop {
        match next(&mut conn).await? {
            HostMessage::Pong { n: 42 } => break,
            HostMessage::Patch(p) if p.rev == expected_rev => expected_rev += 1,
            HostMessage::Patch(p) => {
                return Err(format!("rev gap: expected {expected_rev}, got {}", p.rev).into());
            }
            _ => {}
        }
    }
    println!("ping/pong ok; end-to-end session verified");
    Ok(())
}

async fn next(conn: &mut ClientConnection<TcpStream>) -> Result<HostMessage, BoxError> {
    Ok(tokio::time::timeout(Duration::from_secs(15), conn.recv()).await??)
}

async fn call_raw(
    conn: &mut ClientConnection<TcpStream>,
    rev: &mut u64,
    id: &str,
    op: &str,
    args: Value,
) -> Result<Response, BoxError> {
    conn.send(&DeviceMessage::Req {
        id: id.into(),
        op: op.into(),
        args,
    })
    .await?;
    loop {
        match next(conn).await? {
            HostMessage::Res(res) if res.id == id => return Ok(res),
            HostMessage::Patch(p) => {
                if p.rev != *rev {
                    return Err(format!("rev gap: expected {rev}, got {}", p.rev).into());
                }
                *rev += 1;
            }
            HostMessage::Bye { reason } => return Err(format!("bye {reason:?}").into()),
            _ => {}
        }
    }
}

async fn call(
    conn: &mut ClientConnection<TcpStream>,
    rev: &mut u64,
    id: &str,
    op: &str,
    args: Value,
) -> Result<Value, BoxError> {
    let res = call_raw(conn, rev, id, op, args).await?;
    match (res.ok, res.result, res.error) {
        (true, Some(result), _) => Ok(result),
        (_, _, Some(error)) => Err(format!("{op} failed: {error}").into()),
        _ => Err(format!("{op}: malformed response").into()),
    }
}
